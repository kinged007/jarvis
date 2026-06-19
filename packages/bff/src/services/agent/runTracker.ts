/**
 * Per-run state tracker.
 *
 * Owns the mapping between Hermes `run_id` and the WS connection that
 * originated the command. Holds the per-socket `previous_response_id` chain
 * in a `WeakMap<WebSocket, string>` so disconnected sockets are garbage-
 * collected and the chain starts fresh on reconnect.
 *
 * Also enforces the Hermes-side concurrency cap (10 active runs) — extra
 * `sendCommand` calls are rejected with a clear error and a 429-shaped
 * status, surfaced to the UI as `server:error` with no retry.
 *
 * Run state transitions:
 *   pending → active   (on HermesRunStarted / first SSE event)
 *   active  → terminal (on run.completed | run.failed | run.cancelled |
 *                        run.stopping; run.stopping resolves after a
 *                        brief grace period during which run.cancelled
 *                        may arrive)
 *
 * Terminal runs are kept in `terminal` for ~30s so late `tool.completed`
 * / `message.delta` events can still be mapped back to their run, then
 * evicted by `pruneTerminal`.
 */

import type WebSocket from "ws";
import type { HermesSseEvent } from "./types.js";

export const MAX_CONCURRENT_RUNS = 10;
/** How long to retain a finished run before pruning. */
const TERMINAL_TTL_MS = 30_000;

export type RunPhase = "pending" | "active" | "terminal";

export interface RunRecord {
  runId: string;
  socket: WebSocket;
  startedAt: number;
  phase: RunPhase;
  /** True after the run emitted a terminal Hermes event. */
  finished: boolean;
  /** Set on terminal. */
  finalStatus?: "completed" | "failed" | "cancelled";
  /** `response_id` returned by Hermes; used to chain the next request. */
  responseId?: string;
  /** Last full output text (only for `run.completed`). */
  output?: string;
  /** Any error message (only for `run.failed`). */
  error?: string;
  /** Cached pending approval context, if the run is awaiting one. */
  pendingApproval?: {
    requestId?: string;
    tool?: string;
    args?: Record<string, unknown>;
    choices: ReadonlyArray<"once" | "session" | "always" | "deny">;
  };
}

export class RunTracker {
  /** Active + recently-terminal runs keyed by `run_id`. */
  private readonly runs = new Map<string, RunRecord>();
  /** `response_id` chain per originating socket. */
  private readonly previousResponseId = new WeakMap<WebSocket, string>();
  /** Stable per-socket session id (for the `/v1/runs` `session_id` field). */
  private readonly sessionIds = new WeakMap<WebSocket, string>();
  private nextSessionCounter = 1;
  /** Pending runs by socket (for "cancel most recent" semantics). */
  private readonly activeBySocket = new WeakMap<WebSocket, Set<string>>();

  /**
   * Try to register a brand-new run for `socket`. Returns null if the
   * concurrency cap is hit (caller should emit `server:error`).
   */
  register(runId: string, socket: WebSocket): RunRecord | null {
    if (this.countActive(socket) >= MAX_CONCURRENT_RUNS) return null;
    const rec: RunRecord = {
      runId,
      socket,
      startedAt: Date.now(),
      phase: "pending",
      finished: false,
    };
    this.runs.set(runId, rec);
    let set = this.activeBySocket.get(socket);
    if (!set) {
      set = new Set();
      this.activeBySocket.set(socket, set);
    }
    set.add(runId);
    return rec;
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  /** Mark a run active (first non-`run.started` event for it). */
  markActive(runId: string): void {
    const r = this.runs.get(runId);
    if (r && r.phase === "pending") r.phase = "active";
  }

  /** Record a terminal event. Idempotent. */
  markTerminal(
    runId: string,
    finalStatus: "completed" | "failed" | "cancelled",
    extras?: { output?: string; error?: string; responseId?: string },
  ): void {
    const r = this.runs.get(runId);
    if (!r) return;
    r.phase = "terminal";
    r.finished = true;
    r.finalStatus = finalStatus;
    if (extras?.output !== undefined) r.output = extras.output;
    if (extras?.error !== undefined) r.error = extras.error;
    if (extras?.responseId !== undefined) {
      r.responseId = extras.responseId;
      this.previousResponseId.set(r.socket, extras.responseId);
    }
    this.activeBySocket.get(r.socket)?.delete(runId);
  }

  /** Lookup the most recent active run for a socket (used for cancel). */
  mostRecentForSocket(socket: WebSocket): RunRecord | undefined {
    const set = this.activeBySocket.get(socket);
    if (!set || set.size === 0) return undefined;
    let best: RunRecord | undefined;
    for (const id of set) {
      const r = this.runs.get(id);
      if (!r) continue;
      if (!best || r.startedAt > best.startedAt) best = r;
    }
    return best;
  }

  /** Total non-terminal runs across all sockets (for the concurrency cap). */
  countActive(_socket?: WebSocket): number {
    let n = 0;
    for (const r of this.runs.values()) {
      if (r.phase !== "terminal") n++;
    }
    return n;
  }

  getPreviousResponseId(socket: WebSocket): string | undefined {
    return this.previousResponseId.get(socket);
  }

  /** Stable per-socket id; reused across reconnects via the WeakMap. */
  getOrCreateSessionId(socket: WebSocket): string {
    let id = this.sessionIds.get(socket);
    if (!id) {
      id = `bff-${Date.now().toString(36)}-${(this.nextSessionCounter++).toString(36)}`;
      this.sessionIds.set(socket, id);
    }
    return id;
  }

  /**
   * Drop `runId` from active tracking once a terminal event has been
   * observed end-to-end. Called after the bridge has flushed the last
   * `agent:*` message to the client.
   */
  release(runId: string): void {
    const r = this.runs.get(runId);
    if (!r) return;
    if (r.phase !== "terminal") return;
    this.runs.delete(runId);
  }

  /** Evict terminal runs older than `TERMINAL_TTL_MS`. */
  pruneTerminal(now: number = Date.now()): number {
    let pruned = 0;
    for (const [id, r] of this.runs) {
      if (r.phase === "terminal" && now - r.startedAt > TERMINAL_TTL_MS) {
        this.runs.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /** Called on WS close — drop active runs for that socket and mark
   *  them as cancelled locally so the bridge can release pending tools. */
  onSocketClosed(socket: WebSocket): RunRecord[] {
    const set = this.activeBySocket.get(socket);
    if (!set) return [];
    const cancelled: RunRecord[] = [];
    for (const id of set) {
      const r = this.runs.get(id);
      if (r && r.phase !== "terminal") {
        r.phase = "terminal";
        r.finished = true;
        r.finalStatus = "cancelled";
        cancelled.push(r);
      }
    }
    set.clear();
    return cancelled;
  }

  /** Apply a generic event to the run record. Best-effort; doesn't throw. */
  applyEvent(event: HermesSseEvent): void {
    const r = this.runs.get(event.run_id);
    if (!r) return;
    if (event.event === "run.started") {
      r.phase = "active";
      return;
    }
    if (event.event === "run.completed") {
      this.markTerminal(event.run_id, "completed", { output: event.output });
      return;
    }
    if (event.event === "run.failed") {
      this.markTerminal(event.run_id, "failed", { error: event.error });
      return;
    }
    if (event.event === "run.cancelled") {
      this.markTerminal(event.run_id, "cancelled");
      return;
    }
    if (event.event === "run.stopping") {
      // Grace period: not terminal yet, but mark in-progress.
      r.phase = "active";
      return;
    }
    if (event.event === "approval.request") {
      r.pendingApproval = {
        requestId: event.request_id,
        tool: event.tool,
        args: event.args,
        choices: event.choices,
      };
    }
  }
}
