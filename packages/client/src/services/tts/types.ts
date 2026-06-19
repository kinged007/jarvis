/**
 * Client TTS service contract.
 *
 * The TTS service is the playback half of the voice loop:
 *   - The WS layer (useWebSocket) calls `startUtterance` / `pushChunk`
 *     / `endUtterance` as `tts:*` messages arrive.
 *   - The service decodes each `tts:audio` chunk (raw linear16 PCM)
 *     into a small AudioBuffer and schedules it on the shared output
 *     `AudioContext` (see `services/audio/context.ts`) at the correct
 *     offset on the AudioContext timeline. Audio plays live — there is
 *     no "wait for end-of-utterance" gate.
 *   - The UI (useAudioPlayback) polls `getQueueDepth` / `isPlaying`
 *     to render the play controls.
 *   - The visualisation (useTtsLevel) subscribes to `subscribeLevel`
 *     for an RMS-driven amplitude value.
 *
 * All consumers depend on this interface, not on the underlying
 * `lib/tts-queue.ts` module. The implementation lives in
 * `service.ts`; a different decoder (Opus, MP3, etc.) or a different
 * transport (e.g. a Web Worker) can be swapped in without touching
 * any of the call sites.
 */

import type { TtsAudioFormat } from "@jarvis/shared";

export type TtsUtteranceKind = "commentary" | "response";

export type TtsLevelCallback = (level: number) => void;
export type Unsubscribe = () => void;

export interface TtsService {
  /**
   * Begin tracking a new utterance. Idempotent within a single id —
   * a duplicate call replaces the previous entry for the same id.
   *
   * The `format` field is the wire format the BFF is sending for
   * this utterance's `tts:audio` chunks. The service validates it
   * (logs a warning on mismatch) and uses it to size the AudioBuffer
   * correctly. Pass `undefined` for legacy messages that don't carry
   * the field — the service falls back to the documented default.
   */
  startUtterance(
    id: string,
    kind: TtsUtteranceKind,
    text: string,
    format?: TtsAudioFormat,
  ): void;

  /**
   * Append an audio chunk to the most recently started utterance
   * that hasn't been marked complete. The chunk is decoded and
   * scheduled for live playback immediately. Drops the chunk if no
   * such utterance exists (defensive — can happen on late frames
   * after a `clear`).
   */
  pushChunk(chunk: ArrayBuffer): void;

  /**
   * Mark the utterance with `id` as complete. The pump flushes any
   * remaining buffered samples and frees the utterance slot.
   */
  endUtterance(id: string): void;

  /**
   * Stop the currently-playing source node, leaving any queued
   * utterances intact. The pump then plays the next one.
   */
  stopCurrent(): void;

  /**
   * Drop every queued utterance, stop the in-flight source, and
   * send a `{type: "cancel"}` to the BFF so its TTS queue is also
   * cleared. Also clears the `currentCommentary` and resets the
   * voice `speaking` flag.
   */
  stopAll(): void;

  /** Number of utterances pending + 1 if one is currently playing. */
  getQueueDepth(): number;

  /** True while a source node is connected and playing. */
  isPlaying(): boolean;

  /**
   * Subscribe to an RMS-derived amplitude in [0, 1]. The internal
   * `requestAnimationFrame` loop starts on the first subscriber and
   * stops when the last unsubscribes. Returns the unsubscribe fn.
   */
  subscribeLevel(cb: TtsLevelCallback): Unsubscribe;
}
