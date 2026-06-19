/**
 * Tests for the Hermes SSE → BFF WS event translator.
 * Run with:
 *   pnpm -F @jarvis/bff exec tsx src/services/agent/bridge.test.ts
 *
 * Uses Node's built-in test runner. No external deps.
 *
 * Strategy: drive the bridge with a fake `subscribe` async iterable
 * that yields synthetic `HermesSseEvent`s. Capture the broadcasts and
 * the TTS enqueueText calls to assert on the wire output.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerMessage } from "@jarvis/shared";
import type { FastifyBaseLogger } from "fastify";
import type WebSocket from "ws";
import { AgentEventBridge } from "./bridge.js";
import type { HermesApiClient } from "./apiClient.js";
import type { HermesSseEvent } from "./types.js";
import { RunTracker } from "./runTracker.js";
import type { TtsService, TtsUtteranceKind } from "../tts/types.js";

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

const noopApiClient = {
  baseUrl: "http://test",
  healthCheck: () => Promise.resolve({ ok: true, latencyMs: 0 }),
  getCapabilities: () =>
    Promise.resolve({
      object: "capabilities",
      platform: "test",
      model: "test",
      auth: { type: "bearer", required: false },
      features: {},
      endpoints: {},
    }),
  submitRun: () => Promise.resolve({ runId: "run_test", status: "queued" as const }),
  getRun: () => Promise.resolve({} as never),
  stopRun: () => Promise.resolve({ runId: "run_test", status: "stopping" as const }),
  respondApproval: () =>
    Promise.resolve({ object: "approval", run_id: "run_test", choice: "once" as const }),
} as unknown as HermesApiClient;

/** A TTS service that records every enqueue/enqueueText call. */
interface FakeTts extends TtsService {
  enqueueCalls: Array<{ kind: TtsUtteranceKind; text: string }>;
  enqueueTextCalls: Array<{ kind: TtsUtteranceKind; text: string }>;
}

function makeFakeTts(): FakeTts {
  const enqueueCalls: FakeTts["enqueueCalls"] = [];
  const enqueueTextCalls: FakeTts["enqueueTextCalls"] = [];
  const tts: FakeTts = {
    enqueueCalls,
    enqueueTextCalls,
    enqueue(kind, text) {
      enqueueCalls.push({ kind, text });
      void tts;
      return `id-${enqueueCalls.length}`;
    },
    enqueueText(kind, text) {
      enqueueTextCalls.push({ kind, text });
      return [`id-${enqueueTextCalls.length}`];
    },
    clear() {},
    setBroadcast() {},
    get depth() {
      return 0;
    },
    get isBusy() {
      return false;
    },
  };
  return tts;
}

interface BridgeHarness {
  bridge: AgentEventBridge;
  broadcasts: ServerMessage[];
  tts: FakeTts;
  /** Send a sequence of events to the bridge. */
  emit: (events: HermesSseEvent[]) => Promise<void>;
}

function makeBridge(): BridgeHarness {
  const broadcasts: ServerMessage[] = [];
  const tts = makeFakeTts();
  const tracker = new RunTracker();
  const bridge = new AgentEventBridge({
    apiClient: noopApiClient,
    tracker,
    logger: silentLogger,
    broadcast: (msg) => {
      broadcasts.push(msg);
    },
    getTts: () => tts,
  });

  return {
    bridge,
    broadcasts,
    tts,
    emit: async (events) => {
      // Make the fake subscribe yield the events in order. Wrap in
      // an async iterable.
      const socket = {
        readyState: 1,
        send: () => {},
      } as unknown as WebSocket;
      const runId = events[0]?.run_id ?? "run_test";
      // Override subscribe to push our events through.
      const originalAttach = bridge.attach.bind(bridge);
      // Easier: just use a custom subscribe that yields the events.
      // Attach needs a runId; the subscribe option in BridgeOptions
      // gets called inside attach. We patch the bridge instance.
      (bridge as unknown as { opts: unknown }).opts = {
        ...((bridge as unknown as { opts: object }).opts),
        subscribe: (async function* () {
          for (const e of events) yield e;
        }) as unknown as typeof import("./sseClient.js").subscribeRunEvents,
      };
      originalAttach(runId, socket);
      // Wait for the run to complete (run.completed / run.cancelled /
      // run.failed cleans up via finally).
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}

test("reasoning.available broadcasts agent:commentary AND enqueues TTS", async () => {
  const h = makeBridge();
  await h.emit([
    {
      event: "run.started",
      run_id: "run_1",
      timestamp: 0,
    },
    {
      event: "reasoning.available",
      run_id: "run_1",
      timestamp: 1,
      text: "thinking about it",
    },
    {
      event: "run.completed",
      run_id: "run_1",
      timestamp: 2,
      output: "thinking about it",
    },
  ]);

  // The commentary frame should be broadcast.
  const commentary = h.broadcasts.find((m) => m.type === "agent:commentary");
  assert.ok(commentary, "expected agent:commentary in broadcasts");
  assert.equal(
    commentary && "text" in commentary ? commentary.text : null,
    "thinking about it",
  );

  // Commentary MUST be enqueued to TTS as a single utterance.
  const commentaryEnqueues = h.tts.enqueueCalls.filter(
    (c) => c.kind === "commentary",
  );
  assert.equal(commentaryEnqueues.length, 1, "commentary should be enqueued to TTS");
  assert.equal(commentaryEnqueues[0]!.text, "thinking about it");
});

test("message.delta flushes full response text as a single TTS utterance on run.completed", async () => {
  const h = makeBridge();
  await h.emit([
    {
      event: "run.started",
      run_id: "run_2",
      timestamp: 0,
    },
    {
      event: "message.delta",
      run_id: "run_2",
      timestamp: 1,
      delta: "All systems operational. ",
    },
    {
      event: "message.delta",
      run_id: "run_2",
      timestamp: 2,
      delta: "Ready for orders.",
    },
    {
      event: "run.completed",
      run_id: "run_2",
      timestamp: 3,
      output: "All systems operational. Ready for orders.",
    },
  ]);

  // One single utterance — no sentence chunking. The full
  // accumulated delta buffer is flushed as a single `response`
  // enqueue on run.completed.
  const responseEnqueues = h.tts.enqueueCalls.filter(
    (c) => c.kind === "response",
  );
  assert.equal(responseEnqueues.length, 1, "expected exactly one response TTS utterance");
  assert.equal(
    responseEnqueues[0]!.text,
    "All systems operational. Ready for orders.",
  );

  // No sentence-chunking via enqueueText should have been used.
  assert.equal(h.tts.enqueueTextCalls.length, 0, "enqueueText should not be called");

  // The terminal `agent:response` frame should be broadcast.
  const response = h.broadcasts.find(
    (m) => m.type === "agent:response",
  );
  assert.ok(response, "expected agent:response in broadcasts");
  assert.equal(
    response && "text" in response ? response.text : null,
    "All systems operational. Ready for orders.",
  );
});

test("delta buffer is reset after reasoning.available so commentary is not re-spoken as response", async () => {
  const h = makeBridge();
  await h.emit([
    {
      event: "run.started",
      run_id: "run_3",
      timestamp: 0,
    },
    // Commentary arrives via both channels — deltas first, then reasoning.
    {
      event: "message.delta",
      run_id: "run_3",
      timestamp: 1,
      delta: "Let me think. ",
    },
    {
      event: "reasoning.available",
      run_id: "run_3",
      timestamp: 2,
      text: "Let me think. ",
    },
    // Response text deltas arrive after the reasoning.
    {
      event: "message.delta",
      run_id: "run_3",
      timestamp: 3,
      delta: "The answer is 42.",
    },
    {
      event: "run.completed",
      run_id: "run_3",
      timestamp: 4,
      output: "Let me think. The answer is 42.",
    },
  ]);

  // Commentary was enqueued once.
  const commentaryEnqueues = h.tts.enqueueCalls.filter(
    (c) => c.kind === "commentary",
  );
  assert.equal(commentaryEnqueues.length, 1, "commentary enqueued once");
  assert.equal(commentaryEnqueues[0]!.text, "Let me think. ");

  // Response enqueue should NOT contain the commentary text — the
  // buffer was reset at reasoning.available, so only the post-reasoning
  // deltas ("The answer is 42.") should be flushed.
  const responseEnqueues = h.tts.enqueueCalls.filter(
    (c) => c.kind === "response",
  );
  assert.equal(responseEnqueues.length, 1, "exactly one response utterance");
  assert.equal(
    responseEnqueues[0]!.text,
    "The answer is 42.",
    "response must NOT contain the already-spoken commentary text",
  );
});
