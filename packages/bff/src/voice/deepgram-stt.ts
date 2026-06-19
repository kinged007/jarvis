import { WebSocket } from "ws";
import type { FastifyBaseLogger } from "fastify";

/**
 * Deepgram STT proxy — Step 3.
 *
 * One `DeepgramSttSession` per browser WS connection. Audio chunks captured
 * after the wake word (CAP-2) flow: browser MediaRecorder → BFF WS → here
 * → Deepgram `wss://api.deepgram.com/v1/listen`. Incremental transcripts
 * are surfaced via the `onTranscript` callback; the caller (ws/router.ts)
 * is responsible for turning them into `stt:transcript` ServerMessages.
 *
 * The session is a stateful object with three terminal transitions:
 *   - `finish()` — clean EOS. Sends a JSON Close frame so Deepgram flushes
 *                  any buffered audio and emits the final `is_final=true`
 *                  transcript. Resolves when the upstream socket closes.
 *   - `close()`  — force close. Skips the graceful JSON Close and just
 *                  drops the underlying WS. Used on cancel / ws close.
 *
 * Internally we use the `ws` package (already a transitive dep of
 * @fastify/websocket). The Deepgram auth header is set on the upgrade.
 *
 * Model defaults: nova-2, opus, 48kHz. Those are the typical settings for
 * `MediaRecorder({ mimeType: "audio/webm;codecs=opus" })` at the default
 * browser sample rate. Override via the constructor if a different
 * encoding is needed.
 */

const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen";

export interface DeepgramSttTranscript {
  text: string;
  /** True once Deepgram has committed the segment (no more changes). */
  isFinal: boolean;
  /** True once the segment won't be updated (e.g. endpointing triggered). */
  speechFinal: boolean;
}

export interface DeepgramSttOptions {
  apiKey: string;
  /** Called for every interim/final transcript from Deepgram. */
  onTranscript: (t: DeepgramSttTranscript) => void;
  /** Called when the upstream WS errors or closes unexpectedly. */
  onError: (err: Error) => void;
  /** Called once the upstream WS has fully closed (any path). */
  onClose: (code: number, reason: string) => void;
  logger?: FastifyBaseLogger;
  /** Audio encoding — must match what the browser MediaRecorder produces. */
  encoding?: "opus" | "linear16" | "wav" | "flac" | "mulaw" | "amr-wb" | "amr-nb";
  /** Sample rate of the incoming audio in Hz. */
  sampleRate?: number;
  /** STT model — nova-2 is the current default for streaming. */
  model?: string;
  /** Language code (e.g. "en-US"). Defaults to "en-US". */
  language?: string;
  /** Enable interim results (default true — needed for CAP-7 follow-up). */
  interimResults?: boolean;
  /** Endpointing silence in ms. 300 is a good balance. */
  endpointingMs?: number;
  /** Enable VAD events. */
  vadEvents?: boolean;
  /** Smart-format (punctuation, etc). Default true. */
  smartFormat?: boolean;
  /** Profanity filter. Default false — JARVIS doesn't need to be sanitised. */
  profanityFilter?: boolean;
}

export interface DeepgramSttSession {
  /** Send a chunk of browser audio. Safe to call after `close()` (no-op). */
  sendChunk(data: Buffer): void;
  /** Signal end of utterance. Sends a JSON Close frame and resolves on EOS. */
  finish(): Promise<void>;
  /** Force-close the upstream WS. Idempotent. */
  close(): void;
  /** True once `close()` or `finish()` has been called. */
  isClosed(): boolean;
}

export function createDeepgramSttSession(opts: DeepgramSttOptions): DeepgramSttSession {
  const params = new URLSearchParams({
    model: opts.model ?? "nova-2",
    encoding: opts.encoding ?? "linear16",
    sample_rate: String(opts.sampleRate ?? 16_000),
    language: opts.language ?? "en-US",
    interim_results: String(opts.interimResults ?? true),
    endpointing: String(opts.endpointingMs ?? 300),
    vad_events: String(opts.vadEvents ?? true),
    smart_format: String(opts.smartFormat ?? true),
    profanity_filter: String(opts.profanityFilter ?? false),
  });
  const url = `${DEEPGRAM_URL}?${params.toString()}`;

  const ws = new WebSocket(url, {
    headers: { Authorization: `Token ${opts.apiKey}` },
  });

  let closed = false;
  let opened = false;
  let finishResolve: (() => void) | null = null;
  const log = opts.logger;

  const chunkBuffer: Buffer[] = [];
  let bufferedByteCount = 0;

  function drainBuffer(): void {
    while (chunkBuffer.length > 0) {
      const chunk = chunkBuffer.shift()!;
      bufferedByteCount -= chunk.byteLength;
      try {
        ws.send(chunk, { binary: true });
      } catch (err) {
        opts.onError(err as Error);
        return;
      }
    }
  }

  ws.on("open", () => {
    opened = true;
    log?.debug({ url, bufferedChunks: chunkBuffer.length }, "deepgram stt session open");
    drainBuffer();
  });

  ws.on("message", (raw: Buffer) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch (err) {
      opts.onError(new Error(`deepgram: invalid JSON: ${(err as Error).message}`));
      return;
    }
    const msgType = (parsed as { type?: string }).type;
    log?.debug({ dgType: msgType, dgRaw: raw.toString("utf8").slice(0, 200) }, "deepgram stt message");
    handleDeepgramMessage(parsed, opts);
  });

  ws.on("error", (err) => {
    if (closed) return;
    log?.warn({ err: err.message }, "deepgram stt error");
    opts.onError(err);
  });

  ws.on("close", (code, reasonBuf) => {
    closed = true;
    const reason = reasonBuf.toString("utf8");
    log?.debug({ code, reason, droppedBufferedChunks: chunkBuffer.length }, "deepgram stt closed");
    chunkBuffer.length = 0;
    bufferedByteCount = 0;
    opts.onClose(code, reason);
    if (finishResolve) {
      const r = finishResolve;
      finishResolve = null;
      r();
    }
  });

  return {
    sendChunk(data: Buffer): void {
      if (closed) return;
      if (!opened || ws.readyState !== ws.OPEN) {
        chunkBuffer.push(data);
        bufferedByteCount += data.byteLength;
        if (chunkBuffer.length % 10 === 1) {
          log?.debug({ bufferedCount: chunkBuffer.length, bufferedBytes: bufferedByteCount }, "deepgram stt: buffering chunks until open");
        }
        return;
      }
      try {
        ws.send(data, { binary: true });
      } catch (err) {
        opts.onError(err as Error);
      }
    },
    finish(): Promise<void> {
      if (closed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        finishResolve = resolve;
        try {
          // Deepgram Close control frame: tells the server to flush.
          ws.send(JSON.stringify({ type: "CloseStream" }));
        } catch {
          // If the write fails the close handler will still fire and resolve.
        }
        // Hard-stop fallback in case Deepgram never sends its EOS — the
        // user-perceived cap is ~3s of silence anyway.
        setTimeout(() => {
          if (!closed) {
            try {
              ws.terminate();
            } catch {
              // ignore
            }
          }
        }, 3_000).unref();
      });
    },
    close(): void {
      if (closed) return;
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    },
    isClosed(): boolean {
      return closed;
    },
  };
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function handleDeepgramMessage(
  raw: unknown,
  opts: DeepgramSttOptions,
): void {
  if (typeof raw !== "object" || raw === null) return;
  const m = raw as { type?: unknown };
  const type = typeof m.type === "string" ? m.type : "Results";

  if (type !== "Results") return;

  const channel = (raw as { channel?: { alternatives?: { transcript?: string }[] } }).channel;
  const alt0 = channel?.alternatives?.[0];
  const text = alt0?.transcript ?? "";
  const isFinal = (raw as { is_final?: boolean }).is_final === true;
  const speechFinal = (raw as { speech_final?: boolean }).speech_final === true;

  if (!text) {
    opts.logger?.debug({ isFinal, speechFinal, rawText: JSON.stringify(raw).slice(0, 200) }, "deepgram stt: empty transcript");
    return;
  }

  opts.onTranscript({ text, isFinal, speechFinal });
}
