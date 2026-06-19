/**
 * Deepgram TTS provider — REST transport.
 *
 * Fetches a complete `linear16`/24kHz audio body in one shot, then
 * slices it into `chunkSize` ArrayBuffers and emits them via
 * `onAudio` in order. Fires `onDone` (or `onError`) on completion.
 *
 * This was previously inlined in `voice/tts-queue.ts` as the WS
 * fallback; it's been lifted out unchanged so the queue can pick
 * REST as a provider via the same `TtsProvider` interface.
 *
 * The provider returns a session whose `cancel()` flips a flag — the
 * fetch itself is not abortable (Web `fetch` AbortController would
 * be the next step; out of scope for this refactor). The queue
 * additionally gates the `onAudio`/`onDone` callbacks on a token,
 * so cancellation effectively drops the in-flight audio even if the
 * fetch resolves.
 */

import type { FastifyBaseLogger } from "fastify";
import type { TtsProvider, TtsSession } from "../types.js";

export type TtsEncoding = "linear16" | "wav" | "mulaw" | "alaw";

export interface DeepgramRestProviderOptions {
  apiKey: string;
  model?: string;
  encoding?: TtsEncoding;
  sampleRate?: number;
  chunkSize?: number;
  logger: FastifyBaseLogger;
}

const DEEPGRAM_TTS_URL = "https://api.deepgram.com/v1/speak";
const DEFAULT_CHUNK_SIZE = 16 * 1024;

export class DeepgramRestTtsProvider implements TtsProvider {
  readonly name = "deepgram-rest" as const;

  private readonly model: string;
  private readonly encoding: TtsEncoding;
  private readonly sampleRate: number;
  private readonly chunkSize: number;

  constructor(private readonly opts: DeepgramRestProviderOptions) {
    this.model = opts.model ?? "aura-zeus-en";
    this.encoding = opts.encoding ?? "linear16";
    this.sampleRate = opts.sampleRate ?? 24_000;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  start(p: {
    text: string;
    onAudio: (chunk: ArrayBuffer) => void;
    onDone: () => void;
    onError: (err: Error) => void;
  }): TtsSession {
    const session = new RestSession({
      text: p.text,
      apiKey: this.opts.apiKey,
      model: this.model,
      encoding: this.encoding,
      sampleRate: this.sampleRate,
      chunkSize: this.chunkSize,
      logger: this.opts.logger,
      onAudio: p.onAudio,
      onDone: p.onDone,
      onError: p.onError,
    });
    session.start();
    return session;
  }
}

class RestSession implements TtsSession {
  private cancelled = false;
  private hasFinished = false;

  constructor(
    private readonly args: {
      text: string;
      apiKey: string;
      model: string;
      encoding: TtsEncoding;
      sampleRate: number;
      chunkSize: number;
      logger: FastifyBaseLogger;
      onAudio: (chunk: ArrayBuffer) => void;
      onDone: () => void;
      onError: (err: Error) => void;
    },
  ) {}

  start(): void {
    void this.run();
  }

  cancel(): void {
    this.cancelled = true;
  }

  private async run(): Promise<void> {
    if (this.cancelled) {
      this.finishDone();
      return;
    }
    const params = new URLSearchParams({
      model: this.args.model,
      encoding: this.args.encoding,
    });
    params.set("sample_rate", String(this.args.sampleRate));
    const url = `${DEEPGRAM_TTS_URL}?${params.toString()}`;
    this.args.logger.debug({ url, len: this.args.text.length }, "tts-rest: deepgram request");

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${this.args.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: this.args.text }),
      });
    } catch (err) {
      if (this.cancelled) {
        this.finishDone();
        return;
      }
      this.finishError(err as Error);
      return;
    }

    if (this.cancelled) {
      this.finishDone();
      return;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const err = new Error(
        `deepgram tts failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
      );
      this.args.logger.warn({ status: response.status, body: body.slice(0, 200) }, "tts-rest: deepgram error");
      this.finishError(err);
      return;
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      this.args.logger.warn({}, "tts-rest: deepgram empty body");
      this.finishDone();
      return;
    }

    if (this.cancelled) {
      this.finishDone();
      return;
    }

    const total = arrayBuffer.byteLength;
    const view = new Uint8Array(arrayBuffer);
    for (let offset = 0; offset < total; offset += this.args.chunkSize) {
      if (this.cancelled) {
        this.finishDone();
        return;
      }
      const end = Math.min(offset + this.args.chunkSize, total);
      const slice = view.subarray(offset, end);
      const owned = new ArrayBuffer(slice.byteLength);
      new Uint8Array(owned).set(slice);
      this.args.onAudio(owned);
    }

    this.args.logger.debug(
      { totalBytes: total, chunks: Math.ceil(total / this.args.chunkSize) },
      "tts-rest: broadcast complete",
    );
    this.finishDone();
  }

  private finishDone(): void {
    if (this.hasFinished) return;
    this.hasFinished = true;
    if (this.cancelled) return;
    this.args.onDone();
  }

  private finishError(err: Error): void {
    if (this.hasFinished) return;
    this.hasFinished = true;
    if (this.cancelled) return;
    this.args.onError(err);
  }
}
