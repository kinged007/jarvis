/**
 * Tests for the BFF TTS queue. Run with:
 *   pnpm -F @jarvis/bff exec tsx src/services/tts/queue.test.ts
 *
 * Uses Node's built-in test runner. No external deps.
 *
 * Strategy: a fake provider whose `start()` captures the queue's
 * callbacks so the test can fire `onAudio` / `onDone` / `onError` at
 * chosen times. We intercept the queue's `broadcast` to assert on the
 * wire messages.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerMessage } from "@jarvis/shared";
import type { FastifyBaseLogger } from "fastify";
import { createBffTtsService } from "./queue.js";
import type { TtsProvider } from "./types.js";

const silentLogger: FastifyBaseLogger = {
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLogger,
  level: "silent",
} as unknown as FastifyBaseLogger;

interface FakeProvider {
  provider: TtsProvider;
  /** Per-call hooks. Each entry corresponds to one `start()` call. */
  calls: Array<{
    text: string;
    audio: (chunk: ArrayBuffer) => void;
    done: () => void;
    fail: (err: Error) => void;
    cancelled: boolean;
  }>;
}

function makeFakeProvider(name: TtsProvider["name"] = "deepgram-ws"): FakeProvider {
  const calls: FakeProvider["calls"] = [];
  const provider: TtsProvider = {
    name,
    start(p) {
      const entry: FakeProvider["calls"][number] = {
        text: p.text,
        audio: p.onAudio,
        done: p.onDone,
        fail: p.onError,
        cancelled: false,
      };
      calls.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
  };
  return { provider, calls };
}

function makeFakeAudioBytes(n: number): ArrayBuffer {
  const buf = new ArrayBuffer(n);
  const view = new Uint8Array(buf);
  for (let i = 0; i < n; i++) view[i] = i & 0xff;
  return buf;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await sleep(5);
  }
}

test("enqueueText chunks into multiple utterances broadcast in order", async () => {
  const messages: ServerMessage[] = [];
  const primary = makeFakeProvider("deepgram-ws");
  const tts = createBffTtsService({
    apiKey: "test",
    broadcast: (m) => messages.push(m),
    logger: silentLogger,
    primaryProvider: primary.provider,
    fallbackProvider: null,
  });

  const ids = tts.enqueueText("response", "First. Second. Third.");
  assert.equal(ids.length, 3);

  // Drive each call to completion as it arrives, otherwise the
  // serial queue blocks on utterance N and never opens N+1.
  for (let i = 0; i < ids.length; i++) {
    await waitFor(() => primary.calls.length === i + 1);
    primary.calls[i]!.audio(makeFakeAudioBytes(64));
    primary.calls[i]!.done();
  }

  await waitFor(
    () => messages.filter((m) => m.type === "tts:utterance_end").length === 3,
  );

  const openings = messages.filter(
    (m): m is Extract<ServerMessage, { type: "tts:utterance" }> =>
      m.type === "tts:utterance",
  );
  assert.equal(openings.length, 3);
  assert.equal(openings[0]!.text, "First.");
  assert.equal(openings[1]!.text, "Second.");
  assert.equal(openings[2]!.text, "Third.");
  for (const o of openings) {
    assert.equal(o.format.encoding, "linear16");
    assert.equal(o.format.sampleRate, 24_000);
  }
  const ends = messages.filter((m) => m.type === "tts:utterance_end");
  assert.equal(ends.length, 3);
  assert.equal((ends[0] as { id: string }).id, ids[0]);
  assert.equal((ends[1] as { id: string }).id, ids[1]);
  assert.equal((ends[2] as { id: string }).id, ids[2]);
});

test("clear() cancels the in-flight utterance and drops pending ones", async () => {
  const messages: ServerMessage[] = [];
  const primary = makeFakeProvider("deepgram-ws");
  const tts = createBffTtsService({
    apiKey: "test",
    broadcast: (m) => messages.push(m),
    logger: silentLogger,
    primaryProvider: primary.provider,
    fallbackProvider: null,
  });

  tts.enqueueText("response", "First. Second. Third.");
  await waitFor(() => primary.calls.length === 1);
  tts.clear();

  // No further openings after clear.
  await sleep(20);
  assert.equal(primary.calls.length, 1);

  // The in-flight utterance should have received a tts:utterance_end.
  const ends = messages.filter((m) => m.type === "tts:utterance_end");
  assert.ok(ends.length >= 1, "expected at least one utterance_end after clear");
});

test("primary failure falls back to rest and succeeds", async () => {
  const messages: ServerMessage[] = [];
  const primary = makeFakeProvider("deepgram-ws");
  const fallback = makeFakeProvider("deepgram-rest");
  const tts = createBffTtsService({
    apiKey: "test",
    broadcast: (m) => messages.push(m),
    logger: silentLogger,
    primaryProvider: primary.provider,
    fallbackProvider: fallback.provider,
  });

  tts.enqueue("response", "Hello world.");
  await waitFor(() => primary.calls.length === 1);
  primary.calls[0]!.fail(new Error("ws boom"));

  await waitFor(() => fallback.calls.length === 1);
  fallback.calls[0]!.audio(makeFakeAudioBytes(32));
  fallback.calls[0]!.done();

  await waitFor(() => messages.some((m) => m.type === "tts:utterance_end"));
  const errors = messages.filter((m) => m.type === "tts:error");
  assert.equal(errors.length, 0, "no tts:error expected on successful fallback");
});

test("both providers failing broadcasts tts:error", async () => {
  const messages: ServerMessage[] = [];
  const primary = makeFakeProvider("deepgram-ws");
  const fallback = makeFakeProvider("deepgram-rest");
  const tts = createBffTtsService({
    apiKey: "test",
    broadcast: (m) => messages.push(m),
    logger: silentLogger,
    primaryProvider: primary.provider,
    fallbackProvider: fallback.provider,
  });
  tts.enqueue("response", "hi");
  await waitFor(() => primary.calls.length === 1);
  primary.calls[0]!.fail(new Error("ws down"));
  await waitFor(() => fallback.calls.length === 1);
  fallback.calls[0]!.fail(new Error("rest down"));

  await waitFor(() => messages.some((m) => m.type === "tts:error"));
  const err = messages.find((m) => m.type === "tts:error");
  assert.ok(err && err.type === "tts:error");
  assert.match(err.message, /ws down/);
  assert.match(err.message, /rest down/);
});

test("primary fails with no fallback -> tts:error with provider name", async () => {
  const messages: ServerMessage[] = [];
  const primary = makeFakeProvider("deepgram-ws");
  const tts = createBffTtsService({
    apiKey: "test",
    broadcast: (m) => messages.push(m),
    logger: silentLogger,
    primaryProvider: primary.provider,
    fallbackProvider: null,
  });
  tts.enqueue("response", "hi");
  await waitFor(() => primary.calls.length === 1);
  primary.calls[0]!.fail(new Error("ws down"));

  await waitFor(() => messages.some((m) => m.type === "tts:error"));
  const err = messages.find((m) => m.type === "tts:error");
  assert.ok(err && err.type === "tts:error");
  assert.equal(err.provider, "deepgram-ws");
  assert.match(err.message, /ws down/);
});

test("chunks broadcast in arrival order, then utterance_end", async () => {
  const messages: ServerMessage[] = [];
  const primary = makeFakeProvider("deepgram-ws");
  const tts = createBffTtsService({
    apiKey: "test",
    broadcast: (m) => messages.push(m),
    logger: silentLogger,
    primaryProvider: primary.provider,
    fallbackProvider: null,
  });

  tts.enqueue("response", "Hello world.");
  await waitFor(() => primary.calls.length === 1);
  primary.calls[0]!.audio(makeFakeAudioBytes(64));
  primary.calls[0]!.audio(makeFakeAudioBytes(64));
  primary.calls[0]!.audio(makeFakeAudioBytes(32));
  primary.calls[0]!.done();

  await waitFor(() => messages.some((m) => m.type === "tts:utterance_end"));

  // utterance -> audio x3 -> utterance_end (tts:queue messages may interleave)
  const nonQueue = messages.filter((m) => m.type !== "tts:queue");
  assert.deepEqual(nonQueue.slice(0, 5).map((m) => m.type), [
    "tts:utterance",
    "tts:audio",
    "tts:audio",
    "tts:audio",
    "tts:utterance_end",
  ]);
});

test("enqueueText returns [] for empty / whitespace text", () => {
  const messages: ServerMessage[] = [];
  const primary = makeFakeProvider("deepgram-ws");
  const tts = createBffTtsService({
    apiKey: "test",
    broadcast: (m) => messages.push(m),
    logger: silentLogger,
    primaryProvider: primary.provider,
    fallbackProvider: null,
  });
  assert.deepEqual(tts.enqueueText("response", ""), []);
  assert.deepEqual(tts.enqueueText("response", "   \n\t  "), []);
  assert.equal(primary.calls.length, 0);
  assert.equal(messages.length, 0);
});

test("hanging primary is killed by speakTimeoutMs, no fallback -> tts:error", async () => {
  const messages: ServerMessage[] = [];
  // Provider that never calls onAudio / onDone / onError.
  const hanging: TtsProvider = {
    name: "deepgram-ws",
    start() {
      return { cancel: () => {} };
    },
  };
  const tts = createBffTtsService({
    apiKey: "test",
    broadcast: (m) => messages.push(m),
    logger: silentLogger,
    primaryProvider: hanging,
    fallbackProvider: null,
    speakTimeoutMs: 50,
  });

  tts.enqueue("response", "hi");
  await waitFor(() => messages.some((m) => m.type === "tts:error"), 500);

  const err = messages.find((m) => m.type === "tts:error");
  assert.ok(err && err.type === "tts:error");
  assert.match(err.message, /timeout/);
  assert.equal(err.provider, "deepgram-ws");
  assert.equal(tts.isBusy, false, "queue must release the running flag on timeout");
  assert.equal(tts.depth, 0);
});

test("hanging primary -> timeout -> fallback succeeds", async () => {
  const messages: ServerMessage[] = [];
  const hanging: TtsProvider = {
    name: "deepgram-ws",
    start() {
      return { cancel: () => {} };
    },
  };
  const fallback = makeFakeProvider("deepgram-rest");
  const tts = createBffTtsService({
    apiKey: "test",
    broadcast: (m) => messages.push(m),
    logger: silentLogger,
    primaryProvider: hanging,
    fallbackProvider: fallback.provider,
    speakTimeoutMs: 50,
  });

  tts.enqueue("response", "hi");
  await waitFor(() => fallback.calls.length === 1, 500);
  fallback.calls[0]!.audio(makeFakeAudioBytes(32));
  fallback.calls[0]!.done();

  await waitFor(() => messages.some((m) => m.type === "tts:utterance_end"), 500);
  const errors = messages.filter((m) => m.type === "tts:error");
  assert.equal(errors.length, 0, "fallback success must not surface a tts:error");
  assert.equal(tts.isBusy, false);
});

test("queue recovers and processes the next utterance after a primary timeout", async () => {
  // Primary hangs on the first call, succeeds on the second. The
  // point of this test: a single hung provider must not wedge the
  // queue — the next utterance has to play.
  const messages: ServerMessage[] = [];
  let calls = 0;
  const primary: TtsProvider = {
    name: "deepgram-ws",
    start(p) {
      calls++;
      if (calls === 1) {
        return { cancel: () => {} };
      }
      p.onAudio(makeFakeAudioBytes(32));
      p.onDone();
      return { cancel: () => {} };
    },
  };
  const tts = createBffTtsService({
    apiKey: "test",
    broadcast: (m) => messages.push(m),
    logger: silentLogger,
    primaryProvider: primary,
    fallbackProvider: null,
    speakTimeoutMs: 50,
  });

  const ids = tts.enqueueText("response", "First. Second.");
  assert.equal(ids.length, 2);

  // Second utterance's tts:utterance_end is the recovery signal.
  await waitFor(
    () => {
      const ends = messages.filter((m) => m.type === "tts:utterance_end");
      return ends.some(
        (e) => e.type === "tts:utterance_end" && e.id === ids[1],
      );
    },
    1000,
  );

  assert.equal(tts.isBusy, false, "queue must drain after recovering from a hang");
  assert.equal(tts.depth, 0);
  const errors = messages.filter((m) => m.type === "tts:error");
  assert.equal(errors.length, 1, "exactly one tts:error for the timed-out utterance");
  assert.equal(
    (errors[0] as { id: string }).id,
    ids[0],
    "tts:error id should match the first utterance id",
  );
});
