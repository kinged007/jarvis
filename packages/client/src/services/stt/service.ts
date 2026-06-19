/**
 * STT service — default implementation.
 *
 * Extracts the audio-capture + VAD logic from the old `useAudioCapture`
 * hook into a plain imperative service. The hook is a thin React
 * adapter; everything else (the mic stream, the silence detector, the
 * chunk emission) lives here.
 *
 * Wire format: 16 kHz mono Int16 PCM in 100 ms chunks (matches
 * `STT_AUDIO_FORMAT` in @jarvis/shared). The chunks are forwarded to
 * the `chunkSink` provided at construction — the production sink is
 * the WebSocket binary send function.
 */

import { STT_AUDIO_FORMAT, DEFAULT_CLIENT_CONFIG } from "@jarvis/shared";
import type {
  SttService,
  SttServiceDeps,
  SttTranscript,
  SttSessionState,
  SttListener,
} from "./types";

const SILENCE_MS = Number(import.meta.env.VITE_WAKEWORD_SILENCE_MS) || DEFAULT_CLIENT_CONFIG.wakewordSilenceMs;

const DEFAULT_VAD = {
  rmsThreshold: 0.01,
  silenceMs: SILENCE_MS,
} as const;

export function createSttService(deps: SttServiceDeps): SttService {
  const format = deps.format ?? STT_AUDIO_FORMAT;
  const vad = deps.vad ?? DEFAULT_VAD;

  const state: SttSessionState = {
    capturing: false,
    micLevel: 0,
    error: null,
  };

  const transcriptListeners = new Set<SttListener<SttTranscript>>();
  const stateListeners = new Set<SttListener<SttSessionState>>();
  const levelListeners = new Set<SttListener<number>>();
  const errorListeners = new Set<SttListener<string>>();

  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let scriptNode: ScriptProcessorNode | null = null;
  let analyser: AnalyserNode | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let capturing = false;
  let forceHold = false;
  let totalSamples = 0;
  let chunkBuffer = new Int16Array(0);
  let startupPromise: Promise<void> | null = null;

  function emitState(): void {
    for (const l of stateListeners) l({ ...state });
  }
  function emitLevel(level: number): void {
    state.micLevel = level;
    for (const l of levelListeners) l(level);
  }
  function emitError(message: string): void {
    state.error = message;
    for (const l of errorListeners) l(message);
  }

  function clearSilenceTimer(): void {
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function tearDown(): void {
    capturing = false;
    forceHold = false;
    startupPromise = null;
    clearSilenceTimer();
    if (scriptNode) {
      try { scriptNode.disconnect(); } catch { /* ignore */ }
      scriptNode = null;
    }
    if (stream) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      stream = null;
    }
    if (audioCtx) {
      try { void audioCtx.close(); } catch { /* ignore */ }
      audioCtx = null;
    }
    analyser = null;
    emitLevel(0);
  }

  async function startSession(opts?: { forceHold?: boolean }): Promise<void> {
    if (state.capturing) return;
    capturing = true;
    forceHold = opts?.forceHold ?? false;
    state.capturing = true;
    state.error = null;
    totalSamples = 0;
    chunkBuffer = new Int16Array(0);
    emitState();

    const p = (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: format.sampleRate,
            channelCount: format.channels,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });

        // Session was ended while we were acquiring the mic.
        // Tear down the freshly-opened stream and bail.
        if (!capturing) {
          try { s.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
          return;
        }

        stream = s;

        const ctx = new AudioContext({ sampleRate: format.sampleRate });
        audioCtx = ctx;
        const source = ctx.createMediaStreamSource(s);

        const a = ctx.createAnalyser();
        a.fftSize = 256;
        analyser = a;
        source.connect(a);

        const sn = ctx.createScriptProcessor(4096, 1, 1);
        scriptNode = sn;
        source.connect(sn);
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;
        silentGain.connect(ctx.destination);
        sn.connect(silentGain);

        const samplesPerChunk = (format.sampleRate * format.chunkMs) / 1000;

        sn.onaudioprocess = (ev: AudioProcessingEvent) => {
          if (!capturing) return;
          const input = ev.inputBuffer.getChannelData(0);
          const int16 = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            const v = input[i] ?? 0;
            const clamped = Math.max(-1, Math.min(1, v));
            int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
          }
          const merged = new Int16Array(chunkBuffer.length + int16.length);
          merged.set(chunkBuffer, 0);
          merged.set(int16, chunkBuffer.length);
          chunkBuffer = merged;
          totalSamples += int16.length;

          while (chunkBuffer.length >= samplesPerChunk) {
            const chunk = chunkBuffer.slice(0, samplesPerChunk);
            chunkBuffer = chunkBuffer.slice(samplesPerChunk);
            deps.chunkSink(chunk.buffer.slice(0));
          }
        };

        const checkVad = (): void => {
          if (!capturing || !analyser) return;
          const data = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const n = ((data[i] ?? 128) - 128) / 128;
            sum += n * n;
          }
          const rms = Math.sqrt(sum / data.length);
          emitLevel(Math.min(1, rms * 10));

          if (rms > vad.rmsThreshold) {
            clearSilenceTimer();
          } else if (silenceTimer === null && !forceHold) {
            silenceTimer = setTimeout(() => {
              // VAD-triggered end of utterance. Send the end signal and
              // tear down the mic (but keep the service in `capturing`
              // state long enough for the dispatcher to process the
              // end-sink before we mark it closed).
              if (!capturing) return;
              tearDown();
              state.capturing = false;
              emitState();
              void endSession();
            }, vad.silenceMs);
          }
          if (capturing) requestAnimationFrame(checkVad);
        };
        requestAnimationFrame(checkVad);
    } catch (err) {
      const msg = `mic: ${(err as Error).message}`;
      emitError(msg);
      tearDown();
      state.capturing = false;
      emitState();
    }
    })();

    startupPromise = p;
    void p.finally(() => { if (startupPromise === p) startupPromise = null; });
  }

  async function endSession(): Promise<void> {
    if (!state.capturing && !capturing) return;
    capturing = false;
    clearSilenceTimer();
    // If startSession is still acquiring the mic, wait for it so it
    // can check `capturing` and bail out (or clean up the fresh stream).
    if (startupPromise) await startupPromise;
    tearDown();
    state.capturing = false;
    state.error = null;
    emitState();
    deps.endSink();
  }

  function abortSession(): void {
    capturing = false;
    clearSilenceTimer();
    // Don't await startupPromise here — abort is synchronous by design.
    // The startup IIFE will check `capturing` and bail out.
    tearDown();
    state.capturing = false;
    state.error = null;
    emitState();
    deps.abortSink?.();
  }

  return {
    getState: () => ({ ...state }),
    startSession,
    endSession,
    abortSession,
    onTranscript: (l) => {
      transcriptListeners.add(l);
      return () => transcriptListeners.delete(l);
    },
    onStateChange: (l) => {
      stateListeners.add(l);
      return () => stateListeners.delete(l);
    },
    onMicLevel: (l) => {
      levelListeners.add(l);
      return () => levelListeners.delete(l);
    },
    onError: (l) => {
      errorListeners.add(l);
      return () => errorListeners.delete(l);
    },
    emitTranscript: (t) => {
      for (const l of transcriptListeners) l(t);
    },
  };
}
