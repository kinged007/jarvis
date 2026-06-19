/**
 * TTS service contract.
 *
 * The BFF's TTS surface is split into two layers:
 *
 *   1. `TtsService` — the high-level queue. The agent event bridge
 *      calls `enqueueText(kind, text)` (or `enqueue(kind, text)` for
 *      explicit single-utterance control) whenever Hermes emits a
 *      `response` or `commentary` event. The queue serialises
 *      utterances, cancels them on `clear()`, and is the only thing
 *      the rest of the BFF touches.
 *
 *   2. `TtsProvider` — the transport. The queue hands an utterance
 *      off to whichever provider is configured (default: WS, with REST
 *      fallback). The provider is a thin adapter over the existing
 *      `voice/tts-ws.ts` factory and the inline REST fetch.
 *
 * The split is deliberate: the queue's only job is serialisation and
 * cancellation, and the provider's only job is "get bytes from the
 * network". Swapping providers (e.g. for a different TTS vendor) is
 * a one-line change at queue construction.
 *
 * Audio is always broadcast as `ServerMessage` `tts:audio` frames via
 * the queue's `broadcast` callback. The provider itself never
 * broadcasts — it just calls `onAudio(chunk)`, which the queue
 * wraps in a cancellation gate before forwarding.
 */

export type TtsUtteranceKind = "commentary" | "response";

export interface TtsService {
  /**
   * Enqueue a single utterance for synthesis. Returns the utterance id
   * so the caller can correlate log lines or future `tts:utterance_end`
   * frames. Always non-null; the queue accepts the utterance and
   * either plays it or drops it on `clear()`.
   */
  enqueue(kind: TtsUtteranceKind, text: string): string;

  /**
   * Enqueue `text` as a series of sentence-level utterances. The
   * chunker (see `chunker.ts`) splits on `.!?` + whitespace and
   * newlines; each chunk becomes its own TTS utterance, synthesised
   * sequentially. This is the streaming entry point — the first
   * chunk starts synthesising as soon as the queue picks it up,
   * without waiting for the rest of the text.
   *
   * Returns the list of utterance ids in synthesis order. Returns an
   * empty list if `text` is empty/whitespace.
   */
  enqueueText(kind: TtsUtteranceKind, text: string): string[];

  /**
   * Drop every pending utterance, cancel the in-flight one (sending
   * `Close` to the upstream socket if applicable), and emit a
   * `tts:utterance_end` for the in-flight id. Idempotent.
   */
  clear(): void;

  /**
   * Swap the underlying broadcast function. The BFF constructs this
   * service before the WS layer exists; once the WS layer is up, the
   * real `clientRegistry.broadcast` is installed here so subsequent
   * `tts:*` frames reach connected sockets. Until then, the
   * placeholder from construction time is used. Reads happen on every
   * broadcast frame, so the swap is picked up immediately.
   */
  setBroadcast(fn: (msg: import("@jarvis/shared").ServerMessage) => void): void;

  /** Number of utterances pending + 1 if a synthesis is in flight. */
  get depth(): number;

  /** True while a synthesis is in flight (sending audio or REST). */
  get isBusy(): boolean;
}

/** A single utterance's worth of audio, streamed into callbacks. */
export interface TtsProvider {
  /** Discriminator — used in logs and the `tts:provider` meta field. */
  readonly name: "deepgram-ws" | "deepgram-rest";

  /**
   * Begin synthesis. Returns immediately with a session handle; the
   * provider calls `onAudio` zero or more times, then either
   * `onDone` or `onError`. Exactly one of `onDone`/`onError` fires.
   *
   * The provider MUST tolerate `onError` being followed by a
   * `cancel()` call on the returned session — the queue treats that
   * as best-effort cleanup.
   */
  start(opts: {
    text: string;
    onAudio: (chunk: ArrayBuffer) => void;
    onDone: () => void;
    onError: (err: Error) => void;
  }): TtsSession;
}

export interface TtsSession {
  /**
   * Best-effort cancellation. May fire-and-forget a `Close` frame to
   * the upstream socket, or simply stop calling callbacks. The queue
   * also gates callbacks on a token, so even if a provider ignores
   * `cancel()` the audio is dropped at the broadcast site.
   */
  cancel(): void;
}
