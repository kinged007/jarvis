/**
 * Speech-to-text (STT) service — typed contract.
 *
 * The STT service is the bridge between the user's microphone and the
 * BFF's STT proxy. Its responsibilities are narrow:
 *
 *   1. Acquire a mic stream and produce raw 16 kHz Int16 PCM chunks.
 *   2. Run a local silence-detector to decide when an utterance is over.
 *   3. Ship the chunks to the BFF as binary WS frames, signalling
 *      start/end of utterance.
 *   4. Surface transcripts (interim + final) to subscribers.
 *   5. Surface the live mic level for the UI meter.
 *
 * It does NOT know about:
 *   - The wakeword (S1). The pre-roll buffer is exposed by the wakeword
 *     service as a Float32Array; the STT service accepts it as input
 *     and re-encodes to the wire format. Today (no real wakeword) the
 *     service starts capture from the moment `startSession` is called.
 *   - The agent (S3). Transcripts are emitted to subscribers; the
 *     bridge to the agent is a separate concern (handled in
 *     `useWebSocket.ts`).
 *   - TTS (S4).
 *   - UI state. The hook layer (`useAudioCapture`) maps service events
 *     to voiceStore / agentStore writes.
 *
 * The default implementation lives in `./service.ts`. A future swap
 * (e.g. for a different VAD, a different wire format, or a server-
 * side STT alternative) replaces that one file.
 */

import type { STT_AUDIO_FORMAT } from "@jarvis/shared";

export type SttTranscript = {
  text: string;
  /** False while Deepgram is still refining the segment. */
  interim: boolean;
  /** True once Deepgram has committed the segment. */
  isFinal: boolean;
  /** True once the segment will not be updated (endpointing). */
  speechFinal: boolean;
};

export type SttSessionState = {
  /** True between startSession and endSession. */
  capturing: boolean;
  /** Live mic level in [0, 1] for the UI meter. */
  micLevel: number;
  /** Non-null when the session ended due to an error. */
  error: string | null;
};

export type SttListener<T> = (value: T) => void;

export interface SttService {
  /** Current session state synchronously. */
  getState(): SttSessionState;

  /**
   * Open a capture session. Acquires the mic, begins streaming chunks
   * upstream (via the `chunkSink` provided at construction), and arms
   * the VAD. Resolves once the mic is open.
   *
   * When `forceHold` is true the VAD silence detector will not
   * auto-close the session — the caller must call `endSession()`
   * explicitly. Used by push-to-talk hotkey.
   */
  startSession(opts?: { forceHold?: boolean }): Promise<void>;
  /** Close the session cleanly. Sends an end-of-utterance upstream. */
  endSession(): Promise<void>;
  /** Force-close. No end-of-utterance sent (used on cancel). */
  abortSession(): void;

  /**
   * Subscribe to transcripts from the BFF. The `SttService` itself
   * doesn't receive them — the WebSocket dispatcher calls
   * `emitTranscript` on incoming messages. The hook layer wires this
   * up.
   */
  onTranscript(listener: SttListener<SttTranscript>): () => void;
  /** Subscribe to session state changes. */
  onStateChange(listener: SttListener<SttSessionState>): () => void;
  /** Subscribe to mic level updates. */
  onMicLevel(listener: SttListener<number>): () => void;
  /** Subscribe to errors. */
  onError(listener: SttListener<string>): () => void;

  /**
   * Push a transcript received from the BFF into the service. This
   * is the inbound side of the STT contract — the WebSocket
   * dispatcher calls it for every `stt:transcript` message.
   */
  emitTranscript(t: SttTranscript): void;
}

export type SttChunkSink = (data: ArrayBuffer) => void;
export type SttEndSignal = () => void;

/**
 * Factory options. Separating the wire layer (`chunkSink`, `endSink`)
 * from the audio layer lets us test the audio side without a WS.
 */
export interface SttServiceDeps {
  /** Called for each captured PCM chunk (16 kHz Int16 mono). */
  chunkSink: SttChunkSink;
  /** Called when the session ends cleanly (after the VAD silence). */
  endSink: SttEndSignal;
  /** Optional: called when the session is force-aborted (cancel). */
  abortSink?: SttEndSignal;
  /** STT audio format (defaults to `STT_AUDIO_FORMAT` from shared). */
  format?: typeof STT_AUDIO_FORMAT;
  /** Override VAD thresholds (mostly for tests). */
  vad?: {
    rmsThreshold: number;
    silenceMs: number;
  };
}
