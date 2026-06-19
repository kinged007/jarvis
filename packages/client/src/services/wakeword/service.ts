/**
 * Wakeword service — openWakeWord-based implementation.
 *
 * Wraps the `WakeWordEngine` from `openwakeword-wasm-browser` and
 * adds the JARVIS-specific bits on top:
 *
 *   1. Pre-roll ring buffer (configurable seconds of audio captured
 *      before detection) that gets attached to the wake event so the
 *      STT pipeline has the audio leading up to the wake word.
 *
 *   2. A second, independent mic capture used for post-wakeword
 *      command recording. The engine owns the wakeword-detection mic
 *      internally — we can't tap into it — so we open a second
 *      MediaStream on the same device for the post-wake audio
 *      (browsers happily share the mic hardware across consumers).
 *
 *   3. RMS-based VAD + silence timer (configurable via
 *      `VITE_WAKEWORD_SILENCE_MS`) that ends command capture and
 *      ships the assembled pre-roll + command audio to the BFF STT
 *      pipeline as `voice:chunk` / `voice:end` frames.
 *
 * The service deliberately knows nothing about:
 *   - The agent — App.tsx listens for `onWake` and handles interrupt.
 *   - STT service — audio is shipped to the BFF, not to the client STT.
 *   - TTS service.
 *   - UI state.
 *
 * State machine:
 *   idle → starting → listening → capturing → shipping → listening (loop)
 *   listening → error → idle (recovery)
 *   listening → stopping → idle (user disabled)
 */

import WakeWordEngine, {
  MODEL_FILE_MAP,
  type KeywordName,
  type DetectEventPayload,
} from "openwakeword-wasm-browser";
import * as ort from "onnxruntime-web";
import { STT_AUDIO_FORMAT, STT_SAMPLES_PER_CHUNK, DEFAULT_CLIENT_CONFIG } from "@jarvis/shared";
import { sendBinary, sendMessage } from "../ws/sinks";
import type { WakewordService, WakewordState, WakewordListener } from "./types";

// ---------------------------------------------------------------------------
// ORT configuration: force main-thread WASM (no worker)
// ---------------------------------------------------------------------------
//
// ORT's Web build normally runs inference in a Web Worker. Under our
// Vite dev server (which sets `Cross-Origin-Embedder-Policy: require-corp`)
// the worker fails to load silently: ORT creates the worker from a
// Blob URL, and Blob-URL workers don't carry a
// `Cross-Origin-Resource-Policy` header, so Chrome refuses to spawn
// them. The first `ort.InferenceSession.create(...)` then hangs
// forever (no error, no timeout).
//
// Setting `proxy = false` makes ORT run inference on the main thread
// instead, avoiding the worker entirely. Our models are small
// (~5.5MB total) and run ~12.5 times per second, so main-thread cost
// is acceptable. `numThreads = 1` drops the SharedArrayBuffer
// requirement, which is also blocked by some hosting configs.
//
// These must be set BEFORE the engine creates its first session, and
// the engine doesn't expose a way to set them, so we configure the
// global ort env here.
ort.env.wasm.proxy = false;
ort.env.wasm.numThreads = 1;

// ---------------------------------------------------------------------------
// AudioContext auto-resume patch
// ---------------------------------------------------------------------------
//
// Chrome (and other browsers) create AudioContext instances in the
// "suspended" state unless they're constructed inside a user-activation
// scope. The WakeWordEngine creates its own AudioContext inside
// `start()` and does NOT call `.resume()` on it. When the context is
// suspended, the AudioWorkletNode doesn't process audio (no
// `process()` callbacks fire), so the wakeword model never sees any
// chunks and never scores anything. `e.start()` returns successfully
// so the service thinks it's listening, but the worklet sits idle.
//
// We patch the global AudioContext constructor so that any context
// created in this module is auto-resumed. This makes the engine's
// internal context start in the "running" state. The patch is a no-op
// if the browser already creates running contexts (e.g. inside a
// click handler's user-gesture scope).

type AudioContextCtor = typeof AudioContext;
type AudioContextPatched = AudioContextCtor & {
  __jarvisPatched?: boolean;
};

if (typeof window !== "undefined" && typeof window.AudioContext !== "undefined") {
  const Ctor = window.AudioContext as AudioContextPatched;
  if (!Ctor.__jarvisPatched) {
    const Original = Ctor;
    function PatchedAudioContext(this: unknown, ...args: ConstructorParameters<AudioContextCtor>): AudioContext {
      const ctx = new Original(...args);
      // Fire-and-forget resume. The promise may reject if the context
      // is closed before resume completes; we swallow that.
      void ctx.resume().then(
        () => console.info(`[wakeword] AudioContext resumed (state=${ctx.state}, sampleRate=${ctx.sampleRate}Hz)`),
        (err) => console.warn("[wakeword] AudioContext resume() rejected:", err),
      );
      return ctx;
    }
    PatchedAudioContext.prototype = Original.prototype;
    (PatchedAudioContext as unknown as AudioContextPatched).__jarvisPatched = true;
    window.AudioContext = PatchedAudioContext as unknown as AudioContextCtor;
  }
}

// ---------------------------------------------------------------------------
// Env-driven config (Vite env vars, fallback to DEFAULT_CLIENT_CONFIG)
// ---------------------------------------------------------------------------

const ENABLED = import.meta.env.VITE_OPENWAKEWORD_ENABLED === "true";
// baseAssetUrl: where the .onnx files are served. The postinstall script
// stages them under public/openwakeword/models/.
const BASE_ASSET_URL =
  import.meta.env.VITE_WAKEWORD_BASE_URL ?? "/openwakeword/models";
// ortWasmPath: where onnxruntime-web loads its WASM from. Self-hosted
// under public/openwakeword/ort/ because the dev server sets
// COEP=require-corp, which blocks the default ORT CDN.
const ORT_WASM_PATH = import.meta.env.VITE_WAKEWORD_ORT_PATH ?? "/openwakeword/ort/";
const KEYWORD: KeywordName = (import.meta.env.VITE_WAKEWORD_MODEL as KeywordName) ?? "hey_jarvis";
const THRESHOLD = Number.parseFloat(
  import.meta.env.VITE_WAKEWORD_THRESHOLD ?? "0.5",
);
const SILENCE_MS =
  Number(import.meta.env.VITE_WAKEWORD_SILENCE_MS) ||
  DEFAULT_CLIENT_CONFIG.wakewordSilenceMs ||
  3000;
// Defensive fallbacks: DEFAULT_CLIENT_CONFIG.wakewordPreRollSec can
// be undefined at runtime if the @jarvis/shared module isn't loaded
// yet (rare race during HMR) or if the value was ever accidentally
// stripped. Use 2s as a sane default.
const PRE_ROLL_SEC =
  DEFAULT_CLIENT_CONFIG.wakewordPreRollSec || 2;
const PRE_ROLL_SAMPLES = PRE_ROLL_SEC * (STT_AUDIO_FORMAT.sampleRate || 16000);
// Engine-reported cooldown (ms) is layered on top of our client-side
// check to be safe.
const ACTIVATION_COOLDOWN_MS = 600;

// ---------------------------------------------------------------------------
// VAD constants (RMS threshold shared with STT VAD, silence duration from env)
// ---------------------------------------------------------------------------

const VAD_RMS_THRESHOLD = 0.01;

// ---------------------------------------------------------------------------
// Secure context detection
// ---------------------------------------------------------------------------

function isSecureContext(): boolean {
  if (typeof window === "undefined") return false;
  if (window.isSecureContext === true) return true;
  const hostname = window.location.hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
  if (window.location.protocol === "https:") return true;
  return false;
}

function detectSupport(): boolean {
  if (!isSecureContext()) return false;
  if (typeof navigator === "undefined") return false;
  if (typeof AudioContext === "undefined") return false;
  // AudioWorkletNode + getUserMedia are the engine's only hard deps
  // (it uses an AudioWorklet for mic capture and createMediaStreamSource).
  const md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== "function") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Ring buffer — fixed-size circular buffer of Float32 samples
// ---------------------------------------------------------------------------

class RingBuffer {
  private buf: Float32Array;
  private writePtr = 0;
  private filled = false;
  private _capacity: number;

  constructor(capacity: number) {
    this._capacity = capacity;
    this.buf = new Float32Array(capacity);
  }

  get capacity(): number {
    return this._capacity;
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.writePtr] = samples[i]!;
      this.writePtr = (this.writePtr + 1) % this.capacity;
      if (this.writePtr === 0) this.filled = true;
    }
  }

  /** Return the last N seconds of audio as a contiguous Float32Array. */
  snapshot(): Float32Array {
    if (!this.filled && this.writePtr === this.capacity) {
      return new Float32Array(this.buf);
    }
    if (!this.filled) {
      return new Float32Array(this.buf.subarray(0, this.writePtr));
    }
    const out = new Float32Array(this.capacity);
    const tail = this.capacity - this.writePtr;
    out.set(this.buf.subarray(this.writePtr, this.capacity), 0);
    out.set(this.buf.subarray(0, this.writePtr), tail);
    return out;
  }

  clear(): void {
    this.writePtr = 0;
    this.filled = false;
    this.buf.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Audio capture + detection state machine
// ---------------------------------------------------------------------------

export function createWakewordService(): WakewordService {
  let state: WakewordState = {
    supported: detectSupport(),
    listening: false,
    error: null,
  };

  const listeners = new Set<WakewordListener>();

  // WakeWordEngine — owns the wakeword-detection mic + audio worklet
  let engine: WakeWordEngine | null = null;
  // Detach handles for engine event listeners
  let engineUnsubs: Array<() => void> = [];

  // Command-capture mic (separate from the engine's) — we need raw
  // audio for the pre-roll buffer and post-wakeword command shipping.
  let cmdStream: MediaStream | null = null;
  let cmdCtx: AudioContext | null = null;
  let cmdNode: ScriptProcessorNode | null = null;

  // Pre-roll ring buffer (filled from the command-capture mic)
  let preRoll: RingBuffer | null = null;

  // Command capture state
  let capturing = false;
  let capturedChunks: Float32Array[] = [];
  let capturedPreRoll: Float32Array | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;

  // Activation cooldown (defensive, on top of engine's own cooldownMs)
  let lastActivationMs = 0;

  // Lifecycle
  let starting = false;
  let active = false;

  // -----------------------------------------------------------------------
  // State helpers
  // -----------------------------------------------------------------------

  function setError(msg: string): void {
    console.warn(`[wakeword] error: ${msg}`);
    state = { ...state, error: msg, listening: false };
  }

  function fireWake(): void {
    for (const l of listeners) l();
  }

  // -----------------------------------------------------------------------
  // VAD helpers
  // -----------------------------------------------------------------------

  function computeRms(samples: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += (samples[i] ?? 0) ** 2;
    }
    return Math.sqrt(sum / samples.length);
  }

  function clearSilenceTimer(): void {
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Audio shipping — encode and send to BFF
  // -----------------------------------------------------------------------

  function shipAudio(preRollAudio: Float32Array, commandAudio: Float32Array): void {
    // Combine pre-roll + command into one buffer
    const combined = new Float32Array(preRollAudio.length + commandAudio.length);
    combined.set(preRollAudio, 0);
    combined.set(commandAudio, preRollAudio.length);

    // Convert Float32 → Int16
    const int16 = new Int16Array(combined.length);
    for (let i = 0; i < combined.length; i++) {
      const v = combined[i] ?? 0;
      const clamped = Math.max(-1, Math.min(1, v));
      int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }

    // Ship in STT_AUDIO_FORMAT chunks (100ms)
    const samplesPerChunk = STT_SAMPLES_PER_CHUNK;
    let offset = 0;
    while (offset < int16.length) {
      const end = Math.min(offset + samplesPerChunk, int16.length);
      const chunk = int16.slice(offset, end);
      sendBinary(chunk.buffer.slice(0));
      offset = end;
    }

    // Signal end of utterance
    sendMessage({ type: "voice:end" });
  }

  // -----------------------------------------------------------------------
  // Wakeword detection → start command capture
  // -----------------------------------------------------------------------

  function onWakewordDetected(payload: DetectEventPayload): void {
    const now = performance.now();
    if (now - lastActivationMs < ACTIVATION_COOLDOWN_MS) return;
    lastActivationMs = now;

    console.info(
      `[wakeword] detected "${payload.keyword}" (score=${payload.score.toFixed(3)})`,
    );

    if (capturing) return; // Already capturing from a prior wake; let it finish
    capturing = true;

    // Snapshot the pre-roll buffer (N seconds before the wakeword)
    capturedPreRoll = preRoll?.snapshot() ?? new Float32Array(0);

    // Notify the React side so it can interrupt any in-flight agent
    fireWake();

    // Reset accumulator; VAD silence timer will fire after SILENCE_MS
    capturedChunks = [];
    clearSilenceTimer();
  }

  function onCommandAudio(chunk: Float32Array): void {
    if (!capturing) return;
    capturedChunks.push(new Float32Array(chunk));

    const rms = computeRms(chunk);
    if (rms > VAD_RMS_THRESHOLD) {
      // Speech is active — keep waiting for silence
      clearSilenceTimer();
    } else if (silenceTimer === null) {
      // Start (or restart) the silence timer
      silenceTimer = setTimeout(() => {
        if (!capturing) return;
        capturing = false;
        clearSilenceTimer();

        // Assemble captured command audio
        const totalLen = capturedChunks.reduce((s, c) => s + c.length, 0);
        const commandAudio = new Float32Array(totalLen);
        let offset = 0;
        for (const c of capturedChunks) {
          commandAudio.set(c, offset);
          offset += c.length;
        }

        // Ship pre-roll + command audio to BFF
        const preRollAudio = capturedPreRoll ?? new Float32Array(0);
        shipAudio(preRollAudio, commandAudio);

        // Reset capture state
        capturedChunks = [];
        capturedPreRoll = null;
      }, SILENCE_MS);
    }
  }

  // -----------------------------------------------------------------------
  // Command-capture mic (separate from the engine's wakeword mic)
  // -----------------------------------------------------------------------

  async function startCommandMic(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: STT_AUDIO_FORMAT.sampleRate,
          channelCount: STT_AUDIO_FORMAT.channels,
          // The engine's demo disables all browser audio processing for
          // the same reason openWakeWord recommends it (don't distort
          // frequency content or add latency). We do the same here for
          // the command-capture mic.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      cmdStream = s;
      console.info(
        `[wakeword] command mic acquired: ${s.getAudioTracks().length} track(s)`,
      );

      const ctx = new AudioContext({ sampleRate: STT_AUDIO_FORMAT.sampleRate });
      cmdCtx = ctx;
      const source = ctx.createMediaStreamSource(s);

      const sn = ctx.createScriptProcessor(4096, 1, 1);
      cmdNode = sn;
      source.connect(sn);

      // ScriptProcessorNode needs a destination to actually fire.
      // Use a silent gain so the output doesn't get re-amplified.
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;
      silentGain.connect(ctx.destination);
      sn.connect(silentGain);

      sn.onaudioprocess = onAudioProcess;

      preRoll = new RingBuffer(PRE_ROLL_SAMPLES);
      console.info(
        `[wakeword] command mic ready (sampleRate=${ctx.sampleRate}Hz, preRoll=${PRE_ROLL_SAMPLES} samples = ${PRE_ROLL_SEC}s)`,
      );
      return { ok: true };
    } catch (err) {
      const msg = `command mic: ${(err as Error).message}`;
      console.error(`[wakeword] ${msg}`, err);
      return { ok: false, error: msg };
    }
  }

  function stopCommandMic(): void {
    clearSilenceTimer();
    if (cmdNode) {
      try { cmdNode.disconnect(); } catch { /* ignore */ }
      cmdNode = null;
    }
    if (cmdStream) {
      try { cmdStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      cmdStream = null;
    }
    if (cmdCtx) {
      try { void cmdCtx.close(); } catch { /* ignore */ }
      cmdCtx = null;
    }
    preRoll = null;
    capturedChunks = [];
    capturedPreRoll = null;
    capturing = false;
  }

  function onAudioProcess(ev: AudioProcessingEvent): void {
    if (!active) return;
    const input = ev.inputBuffer.getChannelData(0);
    const samples = new Float32Array(input);

    // Always feed the pre-roll ring buffer
    preRoll?.push(samples);

    // If we're currently capturing a command, run the command pipeline
    if (capturing) {
      onCommandAudio(samples);
    }
  }

  // -----------------------------------------------------------------------
  // Engine wiring
  // -----------------------------------------------------------------------

  function detachEngine(): void {
    for (const u of engineUnsubs) {
      try { u(); } catch { /* ignore */ }
    }
    engineUnsubs = [];
  }

  async function startEngine(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!(KEYWORD in MODEL_FILE_MAP)) {
      return {
        ok: false,
        error: `unknown wakeword keyword "${KEYWORD}". Known: ${Object.keys(MODEL_FILE_MAP).join(", ")}`,
      };
    }

    const e = new WakeWordEngine({
      baseAssetUrl: BASE_ASSET_URL,
      ortWasmPath: ORT_WASM_PATH,
      keywords: [KEYWORD],
      detectionThreshold: THRESHOLD,
      cooldownMs: 2000,
      // The default embeddingWindowSize (16) matches hey_jarvis. The
      // engine inspects session metadata to pick the right window
      // automatically; this is just a fallback.
      embeddingWindowSize: 16,
      // Enable internal debug logging from the engine — surfaces
      // chunk RMS, VAD confidences, per-keyword scores, and
      // detection-gating decisions in the console. Turn off once
      // detection is reliable.
      debug: true,
    });
    engine = e;

    e.on("ready", () => {
      console.info("[wakeword] engine ready (models loaded)");
    });
    e.on("detect", (payload) => onWakewordDetected(payload));
    e.on("error", (err) => {
      setError(err?.message || String(err));
    });
    // speech-start / speech-end are VAD transitions from the engine.
    // We don't currently surface them in the indicator but logging
    // them is useful when debugging detection gating.
    e.on("speech-start", () => {
      console.info("[wakeword] engine: speech-start (VAD active)");
    });
    e.on("speech-end", () => {
      console.info("[wakeword] engine: speech-end (VAD inactive)");
    });

    console.info("[wakeword] engine: calling load()...");
    try {
      await e.load();
      console.info("[wakeword] engine: load() resolved");
    } catch (err) {
      const msg = `engine load failed: ${(err as Error).message}`;
      console.error(`[wakeword] ${msg}`, err);
      return { ok: false, error: msg };
    }

    console.info("[wakeword] engine: calling start() (getUserMedia + AudioWorklet + AudioContext)...");
    try {
      await e.start();
      console.info("[wakeword] engine: start() resolved — mic + worklet running");
    } catch (err) {
      const msg = `engine start failed: ${(err as Error).message}`;
      console.error(`[wakeword] ${msg}`, err);
      return { ok: false, error: msg };
    }

    return { ok: true };
  }

  async function stopEngine(): Promise<void> {
    detachEngine();
    if (engine) {
      try {
        await engine.stop();
      } catch (err) {
        console.warn("[wakeword] engine.stop() error:", err);
      }
      engine = null;
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async function start(): Promise<void> {
    console.info("[wakeword] start() called");
    if (!ENABLED) {
      console.warn("[wakeword] start() aborted: VITE_OPENWAKEWORD_ENABLED not 'true'");
      return;
    }
    if (!state.supported) {
      console.warn(
        "[wakeword] start() aborted: not supported (secure context, AudioContext, or getUserMedia missing)",
      );
      return;
    }
    if (state.listening) {
      console.info("[wakeword] start() aborted: already listening");
      return;
    }
    if (starting) {
      console.info("[wakeword] start() aborted: already starting");
      return;
    }
    starting = true;
    state = { ...state, listening: false, error: null };

    try {
      // Open the command-capture mic first — this is the more likely
      // failure mode (user denies mic permission) and we want a clear
      // error before the engine spins up its own mic.
      console.info("[wakeword] acquiring command mic...");
      const cmd = await startCommandMic();
      if (!cmd.ok) {
        setError(cmd.error);
        starting = false;
        return;
      }

      // Spin up the wakeword engine (loads models, opens its own mic)
      console.info(`[wakeword] starting engine (keyword="${KEYWORD}", threshold=${THRESHOLD})...`);
      const eng = await startEngine();
      if (!eng.ok) {
        setError(eng.error);
        stopCommandMic();
        starting = false;
        return;
      }

      // Mark active
      active = true;
      state = { ...state, listening: true, error: null };
      console.info("[wakeword] listening started");
    } catch (err) {
      const msg = `wakeword start: ${(err as Error).message}`;
      console.error(`[wakeword] ${msg}`, err);
      setError(msg);
      await stopEngine();
      stopCommandMic();
    } finally {
      starting = false;
    }
  }

  async function stop(): Promise<void> {
    console.info("[wakeword] stop() called");
    state = { ...state, listening: false };
    active = false;
    clearSilenceTimer();
    await stopEngine();
    stopCommandMic();
  }

  return {
    getState: () => ({ ...state }),

    start,

    stop,

    onWake(listener: WakewordListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    takePreRollBuffer(): Float32Array | null {
      if (!capturedPreRoll) return null;
      const buf = capturedPreRoll;
      capturedPreRoll = null;
      return buf;
    },
  };
}
