/**
 * Hermes Runs API SSE consumer.
 *
 * Opens `GET /v1/runs/{runId}/events` with the Bearer token and yields
 * typed `HermesSseEvent`s via an async iterable. Cancellation aborts the
 * underlying `fetch` and releases the connection back to the pool.
 *
 * Built on `eventsource-parser` v2 (callback-based `createParser`).
 * Hermes uses `data:`-only framing with the `event` field embedded in
 * the JSON payload — the parser's `event` field is therefore undefined
 * for every Hermes event and we extract the event name from `data`.
 */

import type { FastifyBaseLogger } from "fastify";
import { createParser, type ParseEvent, type ParsedEvent } from "eventsource-parser";
import { HermesApiError, type HermesApiClient } from "./apiClient.js";
import { isHermesSseEvent, type HermesSseEvent } from "./types.js";

export interface SubscribeOptions {
  runId: string;
  signal?: AbortSignal;
  /** Max buffer size for the parser (default 1 MB). */
  maxBufferSize?: number;
}

export interface SseClientOptions {
  client: HermesApiClient;
  logger: FastifyBaseLogger;
}

/**
 * Open the SSE stream and yield typed events. Throws on the first non-2xx
 * response or on a transport-level error after the stream is open.
 */
export async function* subscribeRunEvents(
  opts: SubscribeOptions & SseClientOptions,
): AsyncGenerator<HermesSseEvent> {
  const { client, logger, runId } = opts;
  // Internal accessors — `HermesApiClient` is closed-over so we can
  // avoid leaking the implementation details into a public getter.
  const baseUrl = (client as unknown as { baseUrl: string }).baseUrl;
  const apiKey = (client as unknown as { apiKey: string }).apiKey;

  const url = `${baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`;

  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const controller = new AbortController();
  opts.signal?.addEventListener(
    "abort",
    () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    },
    { once: true },
  );

  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers, signal: controller.signal });
  } catch (err) {
    const durationMs = Date.now() - start;
    logger.warn(
      { service: "agent", runId, durationMs, err: (err as Error).message },
      "sse: connect failed",
    );
    throw err;
  }

  if (!res.ok) {
    let body: { error?: { message: string; code?: string } } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // body wasn't JSON
    }
    const durationMs = Date.now() - start;
    logger.warn(
      { service: "agent", runId, status: res.status, durationMs },
      "sse: non-2xx",
    );
    throw new HermesApiError(res.status, body as never);
  }

  if (!res.body) {
    throw new Error("sse: response has no body");
  }

  const durationMs = Date.now() - start;
  logger.info({ service: "agent", runId, durationMs }, "sse: open");

  // Queue of parsed events; the read loop drains it and yields to the
  // caller. The parser calls `onParse` synchronously from inside
  // `parser.feed()`, so we just push into the queue and wake the
  // consumer via `pendingResolve`.
  const queue: HermesSseEvent[] = [];
  let pendingResolve: ((v: IteratorResult<HermesSseEvent>) => void) | null = null;
  let done = false;
  let error: Error | null = null;

  const wakeConsumer = (): void => {
    if (pendingResolve) {
      const r: ((v: IteratorResult<HermesSseEvent>) => void) | null = pendingResolve;
      pendingResolve = null;
      const next = queue.shift();
      if (next && r) r({ value: next, done: false });
    }
  };
  const finishConsumer = (err: Error | null): void => {
    const r: ((v: IteratorResult<HermesSseEvent>) => void) | null = pendingResolve;
    pendingResolve = null;
    if (r) r({ value: undefined, done: true });
    void err;
  };

  const onParse = (ev: ParseEvent): void => {
    if (ev.type === "reconnect-interval") {
      // Hermes doesn't set a `retry:` field; ignore.
      return;
    }
    const message = ev as ParsedEvent;
    const raw = message.data;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn(
        { service: "agent", runId, err: (err as Error).message, raw: raw.slice(0, 200) },
        "sse: non-JSON data frame",
      );
      return;
    }
    if (!isHermesSseEvent(parsed)) {
      return; // comment frame, meta frame, etc.
    }
    queue.push(parsed);
    wakeConsumer();
  };
  const parser = createParser(onParse);

  // Pump the response body chunk by chunk into the parser.
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const pump = (async (): Promise<void> => {
    try {
      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        if (value) {
          const text = decoder.decode(value, { stream: true });
          try {
            parser.feed(text);
          } catch (err) {
            logger.warn(
              { service: "agent", runId, err: (err as Error).message },
              "sse: feed threw",
            );
          }
        }
      }
      const tail = decoder.decode();
      if (tail) parser.feed(tail);
      done = true;
    } catch (err) {
      error = err as Error;
      done = true;
    } finally {
      finishConsumer(null);
    }
  })();

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift() as HermesSseEvent;
        continue;
      }
      if (done) {
        if (error) throw error;
        return;
      }
      const result = await new Promise<IteratorResult<HermesSseEvent>>((resolve) => {
        pendingResolve = resolve;
      });
      if (result.done) {
        if (error) throw error;
        return;
      }
      yield result.value;
    }
  } finally {
    try {
      reader.cancel().catch(() => { /* cancel rejected — stream already torn down */ });
    } catch {
      /* reader.cancel threw synchronously — stream already torn down */
    }
    void pump;
    logger.info({ service: "agent", runId }, "sse: closed");
  }
}
