/**
 * BFF TTS queue — orchestrates the (default REST) TTS provider with
 * an optional fallback.
 *
 * Responsibilities:
 *   - Serialise utterances: while one is in flight, others wait.
 *   - On `clear()`, drop every pending utterance, cancel the
 *     in-flight one (both at the provider level and at the broadcast
 *     gate), and emit a `tts:utterance_end` for the in-flight id.
 *   - For each utterance, try the primary provider; on provider
 *     error, fall back to the configured fallback (if any) for the
 *     same text. The default primary is Deepgram REST; the WS
 *     provider was hanging on 15s timeouts in this environment, so
 *     it's no longer the default. Tests / opt-in callers can pass
 *     `opts.primaryProvider` to bring the WS path back.
 *   - If both providers fail for an utterance (or only the primary
 *     is configured and it fails), broadcast a `tts:error` frame so
 *     the client surfaces the failure to the UI rather than going
 *     silently silent.
 *   - For streaming, expose `enqueueText` which chunks input on
 *     sentence boundaries and enqueues each chunk as its own
 *     utterance. Sentence 1 starts synthesising before sentence 5 has
 *     even been tokenised by the agent.
 *
 * The queue is intentionally provider-agnostic — it depends only on
 * the `TtsProvider` interface. Swapping in a non-Deepgram provider
 * is a one-line change at construction.
 *
 * Cancellation: each utterance allocates a fresh `cancelToken` (a
 * unique object). The `wrappedBroadcast` checks the token before
 * forwarding to the real broadcast. `clear()` swaps the token to
 * `null`, so any in-flight `onAudio`/`onDone` callback becomes a
 * no-op. The session is also `cancel()`-ed at the provider level.
 */

import { randomUUID } from "node:crypto";
import { TTS_AUDIO_FORMAT, type ServerMessage } from "@jarvis/shared";
import type { FastifyBaseLogger } from "fastify";
import { DeepgramRestTtsProvider } from "./providers/rest.js";
import { chunkSentences } from "./chunker.js";
import type {
  TtsProvider,
  TtsService,
  TtsSession,
  TtsUtteranceKind,
} from "./types.js";

export interface TtsQueueItem {
  id: string;
  kind: TtsUtteranceKind;
  text: string;
}

export interface CreateBffTtsServiceOptions {
  apiKey: string;
  broadcast: (msg: ServerMessage) => void;
  logger: FastifyBaseLogger;
  model?: string;
  /** Override for tests. Defaults to WS provider. */
  primaryProvider?: TtsProvider;
  /**
   * Override for tests / disabling the REST fallback.
   *   - `undefined` (not passed) → use the default REST provider if an
   *     API key is configured, else no fallback.
   *   - `TtsProvider` instance  → use it as the fallback.
   *   - `null`                   → no fallback. The error path is
   *     tested with this.
   */
  fallbackProvider?: TtsProvider | null;
  /**
   * Per-utterance wall-clock cap. If a provider (primary or fallback)
   * does not call `onDone` or `onError` within this many ms, the queue
   * cancels the session, rejects the provider promise with
   * `provider timeout`, and moves on to either the fallback provider
   * or the next utterance. Defaults to 15s. Bypasses a hang in any
   * single provider so the queue never gets wedged.
   */
  speakTimeoutMs?: number;
}

export function createBffTtsService(opts: CreateBffTtsServiceOptions): TtsService {
  // Default primary: Deepgram REST. Historically the WS primary hung in
  // this environment (15s timeout per utterance) while REST returns in
  // ~1s. The queue still supports an explicit `opts.primaryProvider`
  // override (e.g. for tests or a future non-Deepgram backend).
  const primary: TtsProvider =
    opts.primaryProvider ??
    new DeepgramRestTtsProvider({
      apiKey: opts.apiKey,
      model: opts.model,
      logger: opts.logger,
    });
  // Default fallback: none. REST is reliable enough that the WS path
  // is not needed as a backup, and constructing both providers for
  // every queue instance is wasteful. Tests / opt-in callers can still
  // pass `opts.fallbackProvider` to enable a fallback.
  // `fallbackProvider` distinguishes three states:
  //   - `null` (default)           → no fallback. Failed primary
  //     surfaces a `tts:error` frame.
  //   - a `TtsProvider` instance  → use it as the fallback.
  //   - `undefined` (not passed)   → same as `null` (no fallback).
  const fallback: TtsProvider | null =
    opts.fallbackProvider === null || opts.fallbackProvider === undefined
      ? null
      : opts.fallbackProvider;

  const pending: TtsQueueItem[] = [];
  let running = false;
  let currentId: string | null = null;
  let currentKind: TtsUtteranceKind = "response";
  let currentText = "";
  let cancelToken: object | null = null;
  let currentSession: TtsSession | null = null;

  const wrappedBroadcast = (msg: ServerMessage): void => {
    if (cancelToken === null) return;
    broadcastFn(msg);
  };

  // Mutable broadcast handle. The BFF constructs this service before
  // the WS layer exists; the WS layer swaps in the real broadcast on
  // the first connect. Until then, the placeholder (typically a
  // log.debug) is used. Reads happen on every broadcast frame, so the
  // swap is picked up immediately for the next utterance.
  let broadcastFn: (msg: ServerMessage) => void = opts.broadcast;

  const broadcastQueue = (): void => {
    const items: Array<{ id: string; kind: TtsUtteranceKind; text: string }> = [];
    if (currentId) {
      // The current item was already shifted from `pending` in
      // processNext, so it won't appear in the iteration below.
      // Include it at the head so the client sees the full queue.
      items.push({ id: currentId, kind: currentKind, text: currentText });
    }
    for (const p of pending) {
      items.push({ id: p.id, kind: p.kind, text: p.text });
    }
    broadcastFn({ type: "tts:queue", items, currentId });
  };

  const speakWith = (
    item: TtsQueueItem,
    provider: TtsProvider,
    isCurrent: () => boolean,
    utteranceStartMs: number,
  ): Promise<void> => {
    const timeoutMs = opts.speakTimeoutMs ?? 15_000;
    let firstAudioMs: number | null = null;
    return new Promise<void>((resolve, reject) => {
      if (!isCurrent()) {
        resolve();
        return;
      }
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (
        action: () => void,
      ): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        action();
      };
      const session = provider.start({
        text: item.text,
        onAudio: (chunk) => {
          if (settled) return;
          if (firstAudioMs === null) {
            firstAudioMs = Date.now() - utteranceStartMs;
            opts.logger.info(
              { id: item.id, kind: item.kind, provider: provider.name, ttfaMs: firstAudioMs },
              "tts-queue: first audio chunk",
            );
          }
          wrappedBroadcast({ type: "tts:audio", data: chunk });
        },
        onDone: () => {
          finish(() => resolve());
        },
        onError: (err) => {
          finish(() => reject(err));
        },
      });
      currentSession = session;
      timer = setTimeout(() => {
        const errMsg = `provider timeout after ${timeoutMs}ms`;
        opts.logger.warn(
          { id: item.id, provider: provider.name, timeoutMs, ttfaMs: firstAudioMs },
          "tts-queue: provider timeout",
        );
        finish(() => {
          try {
            session.cancel();
          } catch {
            // ignore — best-effort cleanup
          }
          reject(new Error(errMsg));
        });
      }, timeoutMs);
    });
  };

  const speakOne = async (item: TtsQueueItem): Promise<{ ok: boolean }> => {
    // Fresh per-utterance token: clear() flips the module-level
    // token to null, so any in-flight onAudio/onDone from this
    // utterance becomes a no-op. `isCurrent()` is checked at every
    // async boundary to honour mid-utterance cancellation.
    const token: object = {};
    cancelToken = token;
    const isCurrent = (): boolean => cancelToken === token;

    // Timing metrics — wall-clock from "utterance open" to "first
    // audio chunk" is the user-facing TTS latency. Captured here so
    // it's available to the provider call in `speakWith`.
    const utteranceStartMs = Date.now();

    opts.logger.debug(
      { id: item.id, kind: item.kind, len: item.text.length, provider: primary.name },
      "tts-queue: start utterance",
    );
    wrappedBroadcast({
      type: "tts:utterance",
      id: item.id,
      kind: item.kind,
      text: item.text,
      format: {
        encoding: TTS_AUDIO_FORMAT.encoding,
        sampleRate: TTS_AUDIO_FORMAT.sampleRate,
        channels: TTS_AUDIO_FORMAT.channels,
        bitDepth: TTS_AUDIO_FORMAT.bitDepth,
        chunkBytes: TTS_AUDIO_FORMAT.chunkBytes,
      },
    });

    let primaryFailed: Error | null = null;
    let fallbackFailed: Error | null = null;

    try {
      await speakWith(item, primary, isCurrent, utteranceStartMs);
    } catch (err) {
      if (!isCurrent()) {
        opts.logger.debug({ id: item.id }, "tts-queue: utterance discarded (cleared)");
        return { ok: true };
      }
      primaryFailed = err as Error;
      opts.logger.warn(
        { id: item.id, provider: primary.name, err: primaryFailed.message },
        "tts-queue: primary provider failed, falling back",
      );
    }

    if (primaryFailed && fallback && isCurrent()) {
      try {
        await speakWith(item, fallback, isCurrent, utteranceStartMs);
      } catch (err) {
        if (!isCurrent()) {
          opts.logger.debug({ id: item.id }, "tts-queue: utterance discarded (cleared)");
          return { ok: true };
        }
        fallbackFailed = err as Error;
        opts.logger.warn(
          { id: item.id, provider: fallback.name, err: fallbackFailed.message },
          "tts-queue: fallback provider failed",
        );
      }
    }

    if (!isCurrent()) return { ok: true };

    if (primaryFailed && !fallback) {
      wrappedBroadcast({
        type: "tts:error",
        id: item.id,
        message: primaryFailed.message,
        provider: primary.name,
      });
      opts.logger.warn(
        { id: item.id, provider: primary.name, err: primaryFailed.message },
        "tts-queue: no fallback configured, broadcasting error",
      );
    } else if (primaryFailed && fallbackFailed) {
      wrappedBroadcast({
        type: "tts:error",
        id: item.id,
        message: `${primary.name}: ${primaryFailed.message}; ${fallback!.name}: ${fallbackFailed.message}`,
      });
      opts.logger.warn(
        { id: item.id, primary: primary.name, fallback: fallback!.name },
        "tts-queue: both providers failed, broadcasting error",
      );
    } else {
      wrappedBroadcast({ type: "tts:utterance_end", id: item.id });
      opts.logger.debug({ id: item.id }, "tts-queue: end utterance");
    }
    return { ok: !primaryFailed || !fallbackFailed };
  };

  const processNext = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (pending.length > 0) {
        const item = pending.shift();
        if (!item) break;
        currentId = item.id;
        currentKind = item.kind;
        currentText = item.text;
        broadcastQueue();
        await speakOne(item);
        currentId = null;
        currentText = "";
        // Only broadcast "waiting" state if there's nothing next.
        // When a next item exists it goes straight to ▶ on the
        // next loop iteration, avoiding a flicker.
        if (pending.length === 0) broadcastQueue();
      }
    } finally {
      running = false;
      currentId = null;
      currentText = "";
      currentSession = null;
      cancelToken = null;
    }
  };

  return {
    enqueue(kind: TtsUtteranceKind, text: string): string {
      const id = randomUUID();
      pending.push({ id, kind, text });
      opts.logger.debug({ id, kind, len: text.length, depth: pending.length }, "tts-queue: enqueued");
      void processNext();
      return id;
    },
    enqueueText(kind: TtsUtteranceKind, text: string): string[] {
      const chunks = chunkSentences(text);
      if (chunks.length === 0) return [];
      const ids: string[] = [];
      for (const chunk of chunks) {
        const id = randomUUID();
        pending.push({ id, kind, text: chunk });
        ids.push(id);
      }
      opts.logger.debug(
        { kind, totalChunks: chunks.length, ids, totalLen: text.length },
        "tts-queue: enqueueText (chunked)",
      );
      void processNext();
      return ids;
    },
    clear(): void {
      if (currentSession) {
        try {
          currentSession.cancel();
        } catch {
          // ignore — best-effort
        }
        currentSession = null;
      }
      if (cancelToken !== null && currentId !== null) {
        wrappedBroadcast({ type: "tts:utterance_end", id: currentId });
      }
      pending.length = 0;
      cancelToken = null;
      currentId = null;
      currentText = "";
      broadcastQueue();
      opts.logger.debug({}, "tts-queue: cleared");
    },
    setBroadcast(fn: (msg: ServerMessage) => void): void {
      broadcastFn = fn;
      opts.logger.debug({}, "tts-queue: broadcast swapped");
    },
    get depth(): number {
      return pending.length + (running ? 1 : 0);
    },
    get isBusy(): boolean {
      return running;
    },
  };
}
