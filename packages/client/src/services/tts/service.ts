/**
 * Client TTS service — live playback pump with FIFO ordering.
 *
 * Behaviour:
 *   - Audio plays **live** as `tts:audio` chunks arrive. The pump no
 *     longer waits for `tts:utterance_end` to assemble + play a single
 *     big AudioBuffer.
 *   - Each chunk is decoded (Int16 → Float32) immediately and scheduled
 *     on the AudioContext timeline using a running offset, so playback
 *     is gapless and starts within a few ms of the first chunk.
 *   - FIFO: a new `tts:utterance` does NOT interrupt the current
 *     utterance. Its audio is scheduled to start at the end of the
 *     currently-scheduled tail on the AudioContext timeline. Skipping
 *     the current utterance is an explicit user action (the Skip
 *     button).
 *   - The shared output `AudioContext` is the single source of truth
 *     for ordering — see `services/audio/context.ts`.
 *
 * Audio format (matches the BFF TTS provider contract, see
 * `packages/shared/src/services/audioFormat.ts`):
 *   - 24 kHz, mono, 16-bit signed little-endian
 *   - delivered in ~16 KB chunks (`tts:audio` ServerMessages)
 *   - `decodeAudioData` cannot handle raw PCM (no header), so we
 *     assemble the Int16 samples and construct each AudioBuffer by
 *     hand. This is the same approach the old service used, but
 *     applied per-chunk rather than per-utterance.
 *
 * The service is exposed as a process-wide singleton
 * (`./index.ts`). All consumers share the queue — there is only
 * ever one JARVIS session per page, and a second instance would
 * double-decode.
 */

import { TTS_AUDIO_FORMAT, type TtsAudioFormat, diffTtsFormat } from "@jarvis/shared";
import { ensureAudioContextRunning } from "../../lib/audio";
import { getMasterAnalyser } from "../audio/context";
import { useAgentStore } from "../../state/agentStore";
import { useVoiceStore, getWsSend } from "../../state/voiceStore";
import { makeServiceLog } from "../log";
import type {
  TtsLevelCallback,
  TtsService,
  TtsUtteranceKind,
  Unsubscribe,
} from "./types.js";

const ttsLog = makeServiceLog("tts");

interface Utterance {
  id: string;
  kind: TtsUtteranceKind;
  text: string;
  /** Resolved format (from the opening frame or fallback to the shared constant). */
  format: TtsAudioFormat;
  /** Per-utterance running offset on the AudioContext timeline. */
  nextStartTime: number;
  /** True once `endUtterance` has fired for this id. */
  received: boolean;
  /** True once `stopCurrent` (skip) has stopped this utterance. */
  cancelled: boolean;
  /** Active AudioBufferSourceNodes for this utterance. Tracked so
   *  `stopCurrent` can call `source.stop()` to actually halt playback. */
  sources: AudioBufferSourceNode[];
}

class ClientTtsService implements TtsService {
  private readonly utterances: Utterance[] = [];
  /** Every utterance id we have ever seen via `startUtterance`. Used to
   *  silently absorb a late `tts:utterance_end` after `stopAll()` —
   *  the BFF may still send the end for the in-flight id we already
   *  cancelled, and we don't want that to fire a "unknown id" warn. */
  private readonly seenIds = new Set<string>();
  private pumpCtx: AudioContext | null = null;
  /** The current "head" — the un-cancelled, un-finished utterance
   *  whose audio is currently being played on the timeline. Used for
   *  `isPlaying()` and `stopCurrent()`. */
  private currentUtteranceId: string | null = null;

  private spoken = false;
  private readonly levelSubscribers = new Set<TtsLevelCallback>();
  private levelRafId: number | null = null;

  private readonly deps: ClientTtsServiceDeps;

  constructor(deps: ClientTtsServiceDeps = {}) {
    this.deps = deps;
  }

  startUtterance(
    id: string,
    kind: TtsUtteranceKind,
    text: string,
    format?: TtsAudioFormat,
  ): void {
    const resolved = format ?? TTS_AUDIO_FORMAT;
    const diff = diffTtsFormat(resolved);
    if (diff) {
      ttsLog.warn(
        `tts:utterance ${id} has unexpected format (${diff}) — playback may be wrong`,
      );
    }

    // Idempotent within a single id: replace the previous entry.
    const existingIdx = this.utterances.findIndex((u) => u.id === id);
    // FIFO: this utterance's audio should start AFTER the latest
    // scheduled chunk on the timeline, not interrupt the current
    // head. A 10ms inter-utterance buffer prevents click/pop from
    // PCM discontinuity at the sentence boundary.
    const UTTERANCE_BUFFER_S = 0.01;
    const startTime = Math.max(
      this.computeStartTime(),
      this.latestScheduledEnd() + UTTERANCE_BUFFER_S,
    );
    const entry: Utterance = {
      id,
      kind,
      text,
      format: resolved,
      nextStartTime: startTime,
      received: false,
      cancelled: false,
      sources: [],
    };
    if (existingIdx !== -1) {
      this.utterances[existingIdx] = entry;
    } else {
      this.utterances.push(entry);
    }
    this.seenIds.add(id);
    ttsLog.system(
      `utterance ${id} (${kind}, ${text.length} chars) opened @ t=${startTime.toFixed(3)}`,
    );
  }

  pushChunk(chunk: ArrayBuffer): void {
    // The BFF sends chunks for the latest open utterance. Find it
    // and append to its timeline. Cancelled utterances are skipped
    // (so a skip-then-more-chunks still drops the late frames).
    const target = this.utterances.findLast((u) => !u.received && !u.cancelled);
    if (!target) {
      ttsLog.warn(`pushChunk with no open utterance — dropping ${chunk.byteLength}B`);
      return;
    }
    if (chunk.byteLength === 0) return;

    const ctx = this.ensureContext();
    if (!ctx) return;

    if (target.kind === "commentary") {
      useAgentStore.getState().setCurrentCommentary(target.text);
    }
    this.markSpeaking(true);

    // Decode Int16 PCM -> Float32 in [-1, 1].
    const int16 = new Int16Array(chunk);
    const float = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float[i] = (int16[i] ?? 0) / 32768;
    }

    const sampleRate = target.format.sampleRate;
    const audioBuffer = ctx.createBuffer(1, float.length, sampleRate);
    audioBuffer.copyToChannel(float, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    const master = getMasterAnalyser();
    if (master) source.connect(master);
    else source.connect(ctx.destination);

    // Schedule gapless: the next chunk in the same utterance starts
    // exactly when the previous chunk ends. `target.nextStartTime` is
    // bumped by this chunk's duration so the next call continues the
    // timeline seamlessly.
    const startAt = Math.max(ctx.currentTime, target.nextStartTime);
    source.start(startAt);
    target.nextStartTime = startAt + audioBuffer.duration;
    target.sources.push(source);

    // Advance the head if it was null. The head is the first
    // un-cancelled un-finished utterance — it is the one
    // `stopCurrent` would skip.
    if (this.currentUtteranceId === null) {
      const head = this.utterances.find((u) => !u.received && !u.cancelled);
      this.currentUtteranceId = head?.id ?? null;
    }
  }

  endUtterance(id: string): void {
    // `seenIds` tracks every id we've ever opened. If the id is in
    // `seenIds` but not in `utterances`, we already cleared the slot
    // (e.g. via `stopAll()` on a new command) — the BFF's
    // `tts:utterance_end` is just confirming the in-flight synthesis
    // is done. Log at debug, not warn.
    if (!this.utterances.some((u) => u.id === id)) {
      if (this.seenIds.has(id)) {
        ttsLog.debug(`late endUtterance for already-cleared id ${id}`);
      } else {
        ttsLog.warn(`endUtterance for unknown id ${id}`);
      }
      return;
    }
    const u = this.utterances.find((u) => u.id === id)!;
    u.received = true;
    ttsLog.system(`utterance ${id} closed (${u.kind})`);

    // Once the timeline has caught up to the end of the last
    // scheduled chunk, free the slot. We don't have a callback here
    // because each chunk already played through `start(time)` — the
    // AudioContext schedules them in order automatically.
    const ctx = this.pumpCtx;
    if (!ctx) {
      this.removeUtterance(id);
      this.advanceHead();
      return;
    }
    const remainingSec = Math.max(0, u.nextStartTime - ctx.currentTime);
    const waitMs = Math.ceil(remainingSec * 1000) + 50;
    setTimeout(() => {
      this.removeUtterance(id);
      this.advanceHead();
      this.maybeFinishSpeaking();
      if (u.kind === "commentary") {
        useAgentStore.getState().setCurrentCommentary(null);
      }
    }, waitMs);
  }

  stopCurrent(): void {
    // Find the current head and stop its scheduled audio. Late
    // chunks for a cancelled utterance are dropped (see pushChunk).
    const head = this.utterances.find((u) => !u.received && !u.cancelled);
    if (!head) {
      this.currentUtteranceId = null;
      ttsLog.system("stopCurrent: no head to stop");
      return;
    }
    head.cancelled = true;
    for (const source of head.sources) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    head.sources.length = 0;
    ttsLog.system(`stopCurrent: skipped utterance ${head.id}`);
    // Advance immediately — we don't wait for the timeline to catch
    // up since the source nodes are stopped.
    this.advanceHead();
  }

  stopAll(): void {
    const send = getWsSend();
    if (send) {
      send({ type: "cancel" });
    }
    // Stop every in-flight source.
    for (const u of this.utterances) {
      if (u.cancelled) continue;
      u.cancelled = true;
      for (const source of u.sources) {
        try { source.stop(); } catch { /* ignore */ }
      }
      u.sources.length = 0;
    }
    this.utterances.length = 0;
    this.currentUtteranceId = null;
    useAgentStore.getState().setCurrentCommentary(null);
    const voice = useVoiceStore.getState();
    if (voice.currentState === "speaking") {
      voice.setSpeaking(false);
    }
    this.markSpeaking(false);
    ttsLog.system("stopAll — utterances cleared");
  }

  getQueueDepth(): number {
    return this.utterances.length;
  }

  isPlaying(): boolean {
    return this.currentUtteranceId !== null;
  }

  subscribeLevel(cb: TtsLevelCallback): Unsubscribe {
    this.levelSubscribers.add(cb);
    if (this.levelSubscribers.size === 1) this.startLevelLoop();
    return () => {
      this.levelSubscribers.delete(cb);
      if (this.levelSubscribers.size === 0) this.stopLevelLoop();
    };
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private ensureContext(): AudioContext | null {
    if (this.pumpCtx && this.pumpCtx.state !== "closed") return this.pumpCtx;
    const factory = this.deps.audioContextFactory ?? ensureAudioContextRunning;
    // The factory is async but returns once the context is created.
    // We don't await it here because pushChunk is synchronous; the
    // first pushChunk after context creation might be a hair late —
    // that's fine, chunks line up on the timeline.
    void factory().then((ctx) => {
      this.pumpCtx = ctx;
    });
    return this.pumpCtx;
  }

  private computeStartTime(): number {
    // The first chunk should play almost immediately (just enough
    // lookahead to give the AudioContext time to schedule). Subsequent
    // chunks append to the previous chunk's end time.
    const ctx = this.pumpCtx;
    if (!ctx) return 0;
    return ctx.currentTime + 0.05;
  }

  /**
   * The latest end time across all utterances currently scheduled
   * on the AudioContext timeline. New utterances start at this
   * time so they don't overlap the existing tail.
   */
  private latestScheduledEnd(): number {
    let max = 0;
    for (const u of this.utterances) {
      if (u.cancelled) continue;
      if (u.nextStartTime > max) max = u.nextStartTime;
    }
    return max;
  }

  /**
   * Remove an utterance by id. Cleans up the `sources` array so the
   * AudioBufferSourceNode references can be GC'd.
   */
  private removeUtterance(id: string): void {
    const idx = this.utterances.findIndex((u) => u.id === id);
    if (idx === -1) return;
    const u = this.utterances[idx]!;
    u.sources.length = 0;
    this.utterances.splice(idx, 1);
    if (this.currentUtteranceId === id) this.currentUtteranceId = null;
  }

  /**
   * Advance the head pointer to the next un-cancelled un-finished
   * utterance (or null if none). Called after a cancellation,
   * removal, or natural completion.
   */
  private advanceHead(): void {
    const head = this.utterances.find((u) => !u.received && !u.cancelled);
    this.currentUtteranceId = head?.id ?? null;
  }

  private maybeFinishSpeaking(): void {
    if (this.utterances.length === 0) {
      this.markSpeaking(false);
    }
  }

  private markSpeaking(on: boolean): void {
    if (on && !this.spoken) {
      this.spoken = true;
      useVoiceStore.getState().setSpeaking(true);
    } else if (!on && this.spoken) {
      this.spoken = false;
      useVoiceStore.getState().setSpeaking(false);
    }
  }

  private startLevelLoop(): void {
    if (this.levelRafId !== null) return;
    let lastTime = 0;
    const loop = (time: number) => {
      const elapsed = time - lastTime;
      if (elapsed < 30) {
        this.levelRafId = requestAnimationFrame(loop);
        return;
      }
      lastTime = time;
      const masterAnalyser = getMasterAnalyser();
      if (masterAnalyser) {
        const data = new Uint8Array(masterAnalyser.frequencyBinCount);
        masterAnalyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const n = ((data[i] ?? 128) - 128) / 128;
          sum += n * n;
        }
        const rms = Math.sqrt(sum / data.length);
        const level = Math.min(1, rms * 5);
        for (const cb of this.levelSubscribers) cb(level);
      }
      this.levelRafId = requestAnimationFrame(loop);
    };
    this.levelRafId = requestAnimationFrame(loop);
  }

  private stopLevelLoop(): void {
    if (this.levelRafId !== null) {
      cancelAnimationFrame(this.levelRafId);
      this.levelRafId = null;
    }
  }
}

export interface ClientTtsServiceDeps {
  /**
   * Factory for the AudioContext. Defaults to
   * `ensureAudioContextRunning` from `lib/audio`. Tests inject a
   * fake here so playback can be observed without a real audio
   * device.
   */
  audioContextFactory?: () => Promise<AudioContext>;
}

export function createClientTtsService(
  deps: ClientTtsServiceDeps = {},
): TtsService {
  return new ClientTtsService(deps);
}
