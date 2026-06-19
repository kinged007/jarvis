/**
 * Agent service contract.
 *
 * The BFF's only direct dependency on the Hermes API server is through
 * this interface. The default implementation (`createBffAgentService`)
 * composes `spawner` (subprocess lifecycle) + `apiClient` (HTTP+SSE) +
 * `runTracker` (per-run state) + `bridge` (event translation) into a
 * single `AgentService`. Tests can pass a fake.
 *
 * Methods are organised in four groups:
 *   - Command channel : `sendCommand`, `cancelCommand`, `sendApprovalResponse`
 *   - Introspection   : `getStatus`
 *   - Subscription    : `onEvent`, `onStatus`, `onCommandTimeout`
 *
 * Subscription methods return an `unsubscribe` function. Consumers MUST
 * call it when they no longer need the stream — leaking listeners will
 * leak the BFF.
 */

import type { ServerMessage } from "@jarvis/shared";

// ---------------------------------------------------------------------------
// Hermes SSE event union (the BFF ↔ Hermes boundary)
// ---------------------------------------------------------------------------

/** Mirror of `gateway/platforms/api_server.py`'s Runs API event vocabulary.
 *  See `_bmad-output/specs/spec-hermes-api-gateway-integration/hermes-api-events.md`
 *  for the canonical mapping and per-event semantics. */

export interface HermesRunStarted {
  event: "run.started";
  run_id: string;
  timestamp: number;
}

export interface HermesMessageDelta {
  event: "message.delta";
  run_id: string;
  timestamp: number;
  delta: string;
}

export interface HermesToolStarted {
  event: "tool.started";
  run_id: string;
  timestamp: number;
  tool: string;
  preview?: string;
  args?: Record<string, unknown>;
}

export interface HermesToolCompleted {
  event: "tool.completed";
  run_id: string;
  timestamp: number;
  tool: string;
  duration: number;
  error: boolean;
}

export interface HermesReasoningAvailable {
  event: "reasoning.available";
  run_id: string;
  timestamp: number;
  text: string;
}

export interface HermesApprovalRequest {
  event: "approval.request";
  run_id: string;
  timestamp: number;
  /** The dangerous shell command that triggered the guard. */
  command: string;
  /** Human-readable description of why it was flagged (e.g. "recursive delete"). */
  description?: string;
  /** Primary guard pattern key that matched (e.g. "recursive_delete"). */
  pattern_key?: string;
  /** All guard pattern keys that matched. */
  pattern_keys?: ReadonlyArray<string>;
  /** Legacy fields — may be absent from actual SSE events. */
  request_id?: string;
  tool?: string;
  args?: Record<string, unknown>;
  message?: string;
  choices: ReadonlyArray<"once" | "session" | "always" | "deny">;
}

export interface HermesApprovalResponded {
  event: "approval.responded";
  run_id: string;
  timestamp: number;
  choice: "once" | "session" | "always" | "deny";
  resolved: number;
}

export interface HermesRunCompleted {
  event: "run.completed";
  run_id: string;
  timestamp: number;
  output: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
}

export interface HermesRunFailed {
  event: "run.failed";
  run_id: string;
  timestamp: number;
  error: string;
}

export interface HermesRunCancelled {
  event: "run.cancelled";
  run_id: string;
  timestamp: number;
}

export interface HermesRunStopping {
  event: "run.stopping";
  run_id: string;
  timestamp: number;
}

export type HermesSseEvent =
  | HermesRunStarted
  | HermesMessageDelta
  | HermesToolStarted
  | HermesToolCompleted
  | HermesReasoningAvailable
  | HermesApprovalRequest
  | HermesApprovalResponded
  | HermesRunCompleted
  | HermesRunFailed
  | HermesRunCancelled
  | HermesRunStopping;

/** Narrow helper — true if `value` looks like a known Hermes SSE event. */
export function isHermesSseEvent(value: unknown): value is HermesSseEvent {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { event?: unknown }).event;
  if (typeof t !== "string") return false;
  return (
    t === "run.started" ||
    t === "message.delta" ||
    t === "tool.started" ||
    t === "tool.completed" ||
    t === "reasoning.available" ||
    t === "approval.request" ||
    t === "approval.responded" ||
    t === "run.completed" ||
    t === "run.failed" ||
    t === "run.cancelled" ||
    t === "run.stopping"
  );
}

// ---------------------------------------------------------------------------
// Status / subscriptions
// ---------------------------------------------------------------------------

export interface AgentStatus {
  /** Hermes gateway subprocess is alive. */
  running: boolean;
  /** `/health` returned 200 at least once since the last start. */
  ready: boolean;
  pid: number | null;
  uptimeSec: number;
  restarts: number;
  lastError: string | null;
  /** Hermes API server snapshot. */
  api: {
    url: string;
    /** Cached result of the most recent `/health` poll. */
    healthy: boolean;
    /** Model name from `/v1/capabilities` (null until first read). */
    model: string | null;
  };
}

export type AgentEventListener = (event: ServerMessage) => void;
export type AgentStatusListener = (status: AgentStatus) => void;
export type AgentCommandTimeoutListener = (runId: string) => void;

export type Unsubscribe = () => void;

/** Per-call context for `sendCommand`. The BFF passes the originating WS
 *  so the runTracker can manage a per-WS `previous_response_id` chain. */
export interface SendCommandContext {
  /** The WS that originated the command. The runTracker uses a WeakMap
   *  on this socket to track the last `response_id` for conversation
   *  continuity. */
  socket: import("ws").WebSocket;
  /** Optional explicit session id; defaults to a stable per-socket id. */
  sessionId?: string;
}

export interface AgentService {
  /**
   * Submit a text command to Hermes as a new run. Returns the Hermes
   * `run_id` (string) on success, or `null` if the agent isn't ready
   * or the submission failed within the deadline.
   */
  sendCommand(text: string, ctx: SendCommandContext): Promise<string | null>;

  /**
   * Stop the active run for the given `run_id` (or, if `runId` is
   * omitted, the most recent active run on the supplied socket).
   * Returns true if a stop was issued.
   */
  cancelCommand(input: { runId?: string; socket?: import("ws").WebSocket }): boolean;

  /**
   * Relay the user's approval response to Hermes. The BFF looks up the
   * active run by `runId` and POSTs `{choice}` to
   * `/v1/runs/{runId}/approval`. Returns true if a response was sent.
   */
  sendApprovalResponse(
    runId: string,
    requestId: string,
    choice: "once" | "session" | "always" | "deny",
  ): boolean;

  /** Snapshot of current state. Cheap; safe to call on every WS connect. */
  getStatus(): AgentStatus;

  /** Subscribe to `ServerMessage`s translated from Hermes SSE events. */
  onEvent(listener: AgentEventListener): Unsubscribe;

  /** Subscribe to lifecycle status changes (spawning, ready, restart, exit). */
  onStatus(listener: AgentStatusListener): Unsubscribe;

  /**
   * Subscribe to run-timeout events (Hermes didn't produce a terminal
   * event within the per-run timeout). The bridge uses this to broadcast
   * a `server:error` so the UI can stop its spinner.
   */
  onCommandTimeout(listener: AgentCommandTimeoutListener): Unsubscribe;

  /** Start the Hermes gateway subprocess. Idempotent. */
  start(): Promise<void>;

  /** Stop the Hermes gateway subprocess. Idempotent. */
  stop(): Promise<void>;

  /**
   * Swap the underlying broadcast function. The BFF constructs this
   * service before the WS layer exists; once the WS layer is up, the
   * real `clientRegistry.broadcast` is installed here so subsequent
   * `agent:*` events reach connected sockets. Until then, the
   * placeholder from construction time is used. Reads happen on every
   * broadcast frame, so the swap is picked up immediately.
   */
  setBroadcast(fn: (msg: ServerMessage, opts?: { targetSocket?: import("ws").WebSocket }) => void): void;

  /**
   * Swap the underlying TTS service. The BFF constructs the agent
   * service before the TTS service exists in the WS layer; once the
   * WS layer is up, the real `BffTtsService` is installed here. The
   * agent bridge reads the current TTS on every event, so the swap
   * is picked up immediately for the next utterance.
   */
  setTts(tts: import("../tts/types.js").TtsService): void;
}
