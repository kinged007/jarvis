/**
 * Hermes SSE → BFF WS event translator.
 *
 * Subscribes to Hermes SSE events (via `sseClient.subscribeRunEvents`)
 * and translates them into the BFF's WS `ServerMessage` shape. Also
 * handles the terminal `run.completed` fan-out: fetches `/v1/runs/{id}`
 * after the event to read the authoritative `response_id` for
 * `previous_response_id` continuity.
 *
 * TTS strategy: complete events are enqueued as single utterances with
 * no text splitting:
 *   - `reasoning.available` → `tts.enqueue("commentary", text)` immediately
 *   - `run.completed` → `tts.enqueue("response", fullDeltaBuffer)` once
 * The terminal `agent:response` is emitted as a clean `ServerMessage`
 * for the log container, but is NOT re-enqueued to TTS — the deltas
 * accumulate and are flushed as one utterance on run completion.
 * If a user interrupts mid-run, the WS layer calls `tts.clear()`
 * directly to drop any in-flight synthesis.
 */

import { EventEmitter } from "node:events";
import type { FastifyBaseLogger } from "fastify";
import type WebSocket from "ws";
import type {
  ServerAgentCommentary,
  ServerAgentResponse,
  ServerAgentResponseDelta,
  ServerAgentRunComplete,
  ServerAgentState,
  ServerAgentToolCall,
  ServerAgentToolResult,
  ServerAgentApprovalRequest,
  ServerAgentApprovalResolved,
  ServerAgentLongResponse,
  ServerMessage,
  AgentState,
} from "@jarvis/shared";
import type { HermesApiClient, RunStatusSnapshot } from "./apiClient.js";
import { subscribeRunEvents } from "./sseClient.js";
import type { HermesSseEvent } from "./types.js";
import { RunTracker } from "./runTracker.js";
import type { TtsService } from "../tts/types.js";

export interface BridgeOptions {
  apiClient: HermesApiClient;
  tracker: RunTracker;
  logger: FastifyBaseLogger;
  /** Used to know which sockets to broadcast to. The composition root
   *  wires this — the bridge doesn't track WS connections itself. */
  broadcast: (msg: ServerMessage, opts?: { targetSocket?: WebSocket }) => void;
  /** Lazy accessor for the TTS service. The composition root constructs
   *  the agent service before the TTS service exists; the WS layer swaps
   *  in the real TTS service on first connect via `agentService.setTts`.
   *  The bridge reads the current TTS on every call so the swap is
   *  picked up immediately for the next utterance. */
  getTts: () => TtsService;
  /** Per-run timeout in ms (default 5 minutes). */
  runTimeoutMs?: number;
  /** Override for tests. */
  subscribe?: typeof subscribeRunEvents;
  /** Whether to voice `reasoning.available` commentary via TTS. Default true. */
  ttsCommentaryEnabled?: boolean;
  /** Word-count threshold above which a response triggers the long-response
   *  modal + TTS trimming. Default 100. */
  longResponseThreshold?: number;
}

interface ActiveRun {
  runId: string;
  socket: WebSocket;
  streamDone: Promise<void>;
  cancel: () => void;
  /** Per-run tool call ids so we can correlate `tool.completed`. */
  toolStartIds: Map<string, string>;
  closed: boolean;
  timeoutTimer: NodeJS.Timeout | null;
  /** Accumulated `message.delta` text for the current run. Flushed to
   *  TTS as a single utterance on terminal events (run.completed /
   *  run.failed). No sentence splitting. */
  deltaBuffer: string;
  /** Ids of TTS utterances that have been enqueued but not yet spoken
   *  for this run. Used so cancel/cleanup can drop them in flight. */
  pendingUtteranceIds: string[];
  /** Count of in-flight tool calls. Decremented on tool.completed. */
  activeToolCount: number;
}

const DEFAULT_RUN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_LONG_RESPONSE_THRESHOLD = 100;

export class AgentEventBridge extends EventEmitter {
  private readonly opts: BridgeOptions;
  private readonly runs = new Map<string, ActiveRun>();
  private readonly longResponseThreshold: number;
  private _state: AgentState = "offline";

  constructor(opts: BridgeOptions) {
    super();
    this.opts = opts;
    this.longResponseThreshold = opts.longResponseThreshold ?? DEFAULT_LONG_RESPONSE_THRESHOLD;
  }

  get state(): AgentState {
    return this._state;
  }

  /** Broadcast an agent state change to all connected clients. Idempotent
   *  — no-op if `state` matches the current value. */
  setState(state: AgentState, runId?: string): void {
    if (this._state === state) return;
    this._state = state;
    this.opts.broadcast({
      type: "agent:state",
      state,
      runId,
    } satisfies ServerAgentState);
  }

  /** Begin streaming events for a freshly-submitted run. */
  attach(runId: string, socket: WebSocket): void {
    if (this.runs.has(runId)) return;
    const controller = new AbortController();
    const sub = this.opts.subscribe ?? subscribeRunEvents;

    const streamDone = (async () => {
      try {
        for await (const event of sub({
          client: this.opts.apiClient,
          logger: this.opts.logger,
          runId,
          signal: controller.signal,
        })) {
          this.handleEvent(event, socket);
          if (
            event.event === "run.completed" ||
            event.event === "run.failed" ||
            event.event === "run.cancelled"
          ) {
            break;
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        this.opts.logger.error(
          { service: "agent", runId, err: (err as Error).message },
          "bridge: stream error",
        );
        this.opts.tracker.markTerminal(runId, "failed", { error: (err as Error).message });
        this.opts.broadcast({
          type: "agent:run_complete",
          runId,
          status: "failed",
          error: (err as Error).message,
        } satisfies ServerAgentRunComplete);
        this.setState("error", runId);
      } finally {
        this.cleanupRun(runId);
      }
    })().catch((err) => {
      this.opts.logger.error(
        { service: "agent", runId, err: (err as Error).message },
        "bridge: streamDone rejected",
      );
    });

    const active: ActiveRun = {
      runId,
      socket,
      streamDone,
      cancel: () => controller.abort(),
      toolStartIds: new Map(),
      closed: false,
      timeoutTimer: null,
      deltaBuffer: "",
      pendingUtteranceIds: [],
      activeToolCount: 0,
    };
    active.timeoutTimer = setTimeout(() => {
      if (active.closed) return;
      this.opts.logger.warn({ service: "agent", runId }, "bridge: run timeout");
      this.opts.tracker.markTerminal(runId, "failed", { error: "run timed out" });
      this.emit("timeout", runId);
      this.opts.broadcast({
        type: "agent:run_complete",
        runId,
        status: "failed",
        error: "run timed out",
      } satisfies ServerAgentRunComplete);
      this.setState("error", runId);
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }, this.opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);

    this.runs.set(runId, active);
  }

  /** Cancel an in-flight SSE stream (used by `cancelCommand`). */
  detach(runId: string): void {
    const active = this.runs.get(runId);
    if (!active) return;
    active.cancel();
  }

  /** Cancel everything — called from `stop()`. */
  detachAll(): void {
    for (const active of this.runs.values()) active.cancel();
  }

  /** Map Hermes events to BFF `ServerMessage`s and broadcast. */
  private handleEvent(event: HermesSseEvent, socket: WebSocket): void {
    this.opts.tracker.applyEvent(event);
    this.opts.logger.debug(
      { service: "agent", runId: event.run_id, event: event.event },
      "bridge: event",
    );

    switch (event.event) {
      case "run.started":
        // No client-facing message — first delta will arrive shortly.
        this.setState("thinking", event.run_id);
        return;

      case "message.delta": {
        // Ensure thinking state (may already be set from run.started).
        if (this._state === "idle") this.setState("thinking", event.run_id);
        const msg: ServerAgentResponseDelta = {
          type: "agent:response_delta",
          runId: event.run_id,
          delta: event.delta,
        };
        this.opts.broadcast(msg, { targetSocket: socket });
        // Append to the per-run response buffer. The buffer is flushed
        // to TTS as a single utterance on the terminal event.
        // See `appendResponseDelta` below.
        this.appendResponseDelta(event.run_id, event.delta);
        return;
      }

      case "reasoning.available": {
        const msg: ServerAgentCommentary = {
          type: "agent:commentary",
          runId: event.run_id,
          text: event.text,
        };
        this.opts.broadcast(msg, { targetSocket: socket });
        // Enqueue commentary text for TTS as a single utterance when
        // enabled. No chunking — the full text goes to the TTS queue
        // as-is. Disable via `ttsCommentaryEnabled: false` if Hermes
        // emits duplicative response text on this channel.
        //
        // Reset the delta buffer so the commentary text that was also
        // streamed via message.delta is not flushed again as part of
        // the response utterance on run.completed.
        if (this.opts.ttsCommentaryEnabled !== false) {
          const commentaryId = this.opts.getTts().enqueue("commentary", event.text);
          this.opts.logger.debug(
            {
              service: "agent",
              runId: event.run_id,
              ttsId: commentaryId,
              kind: "commentary",
              len: event.text.length,
            },
            "bridge: commentary enqueued to TTS",
          );
        }
        this.resetDeltaBuffer(event.run_id);
        return;
      }

      case "tool.started": {
        const key = `${event.tool}:${event.timestamp}`;
        const id = `tool:${event.run_id}:${key}`;
        const active = this.runs.get(event.run_id);
        if (active) active.toolStartIds.set(key, id);
        const msg: ServerAgentToolCall = {
          type: "agent:tool_call",
          runId: event.run_id,
          tool: event.tool,
          args: event.args ?? {},
          ...(event.preview !== undefined ? { preview: event.preview } : {}),
        };
        this.opts.broadcast(msg, { targetSocket: socket });
        if (active) {
          active.activeToolCount++;
          if (active.activeToolCount === 1) this.setState("executing", event.run_id);
        }
        return;
      }

      case "tool.completed": {
        const key = `${event.tool}:${event.timestamp}`;
        const active = this.runs.get(event.run_id);
        const id =
          active?.toolStartIds.get(key) ??
          `tool:${event.run_id}:${key}`;
        const msg: ServerAgentToolResult = {
          type: "agent:tool_result",
          runId: event.run_id,
          tool: event.tool,
          output: "",
          duration: event.duration,
          ...(event.error ? { error: true } : {}),
        };
        this.opts.broadcast(msg, { targetSocket: socket });
        if (active && active.activeToolCount > 0) {
          active.activeToolCount--;
          if (active.activeToolCount === 0) this.setState("thinking", event.run_id);
        }
        return;
      }

      case "approval.request": {
        const msg: ServerAgentApprovalRequest = {
          type: "agent:approval_request",
          runId: event.run_id,
          requestId: event.request_id ?? "",
          tool: event.tool ?? "terminal",
          args: event.args ?? (event.command ? { command: event.command } : {}),
          message: event.message ?? event.description ?? event.command,
          choices: [...event.choices],
        };
        this.opts.broadcast(msg, { targetSocket: socket });
        this.setState("waiting", event.run_id);
        return;
      }

      case "approval.responded": {
        const rec = this.opts.tracker.get(event.run_id);
        if (rec?.pendingApproval) rec.pendingApproval = undefined;
        const msg: ServerAgentApprovalResolved = {
          type: "agent:approval_resolved",
          runId: event.run_id,
          choice: event.choice,
          resolved: event.resolved,
        };
        this.opts.logger.debug(
          {
            service: "agent",
            runId: event.run_id,
            choice: event.choice,
            resolved: event.resolved,
          },
          "bridge: approval resolved",
        );
        this.opts.broadcast(msg, { targetSocket: socket });
        // Return to the state before waiting.
        const active = this.runs.get(event.run_id);
        if (active && active.activeToolCount > 0) {
          this.setState("executing", event.run_id);
        } else {
          this.setState("thinking", event.run_id);
        }
        return;
      }

      case "run.completed": {
        const isLong = this.isLongResponse(event.output);

        if (isLong) {
          // Trimmed TTS — only speak text before the first line break so
          // the audio feedback is brief. The full response is shown in the
          // client-side modal.
          const trimmed = event.output.split("\n")[0]?.trim() ?? "";
          if (trimmed) {
            const id = this.opts.getTts().enqueue("response", trimmed);
            const active = this.runs.get(event.run_id);
            if (active) active.pendingUtteranceIds.push(id);
          }
          // Discard the accumulated delta buffer (it contains the full
          // long text we don't want spoken).
          this.resetDeltaBuffer(event.run_id);

          // Signal the client to open the long-response modal with the
          // full markdown text.
          const longMsg: ServerAgentLongResponse = {
            type: "agent:long_response",
            runId: event.run_id,
            text: event.output,
          };
          this.opts.broadcast(longMsg, { targetSocket: socket });
        } else {
          // Normal path: flush accumulated deltas as one TTS utterance.
          this.flushResponseDelta(event.run_id, "tail");
        }

        // Surface the full text as a clean `agent:response` for the
        // log container. TTS is NOT re-enqueued — the single utterance
        // above already covers the full response.
        const full: ServerAgentResponse = {
          type: "agent:response",
          runId: event.run_id,
          text: event.output,
        };
        this.opts.broadcast(full, { targetSocket: socket });
        this.opts.broadcast({
          type: "agent:run_complete",
          runId: event.run_id,
          status: "completed",
        } satisfies ServerAgentRunComplete);
        this.setState("idle");

        // After fanning out the terminal event, fetch the authoritative
        // run state to capture the actual `response_id` for the next
        // `previous_response_id` chain step.
        void this.fetchAndCacheResponseId(event.run_id);
        return;
      }

      case "run.failed": {
        // Flush any tail so the user still hears the partial response.
        this.flushResponseDelta(event.run_id, "tail");
        this.opts.broadcast({
          type: "error",
          message: event.error,
        } satisfies ServerMessage);
        this.opts.broadcast({
          type: "agent:run_complete",
          runId: event.run_id,
          status: "failed",
          error: event.error,
        } satisfies ServerAgentRunComplete);
        this.setState("error", event.run_id);
        return;
      }

      case "run.cancelled": {
        // Drop any unflushed tail — the user cancelled, we don't want
        // to keep speaking.
        this.flushResponseDelta(event.run_id, "cancel");
        this.opts.broadcast({
          type: "agent:run_complete",
          runId: event.run_id,
          status: "cancelled",
        } satisfies ServerAgentRunComplete);
        this.setState("idle");
        return;
      }

      case "run.stopping": {
        // No client-facing message — the terminal event will follow.
        return;
      }
    }
  }

  private isLongResponse(text: string): boolean {
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return wordCount > this.longResponseThreshold;
  }

  private async fetchAndCacheResponseId(runId: string): Promise<void> {
    try {
      const snap: RunStatusSnapshot = await this.opts.apiClient.getRun(runId);
      if (snap.response_id) {
        this.opts.tracker.markTerminal(runId, "completed", { responseId: snap.response_id });
      }
    } catch (err) {
      this.opts.logger.warn(
        { service: "agent", runId, err: (err as Error).message },
        "bridge: response_id fetch failed",
      );
    }
  }

  /**
   * Append a response delta to the per-run buffer. No sentence
   * splitting — the entire accumulated text is flushed as a single
   * utterance on `run.completed` (or dropped on `run.cancelled`).
   */
  private appendResponseDelta(runId: string, delta: string): void {
    const active = this.runs.get(runId);
    if (!active) return;
    active.deltaBuffer += delta;
  }

  /**
   * Reset the per-run delta buffer. Called when a `reasoning.available`
   * event fires so the commentary text that was also streamed via
   * `message.delta` is not re-spoken as part of the response utterance.
   */
  private resetDeltaBuffer(runId: string): void {
    const active = this.runs.get(runId);
    if (active) active.deltaBuffer = "";
  }

  /**
   * Flush any remaining buffered text. `mode`:
   *   - `"tail"`  — speak whatever's buffered (run completed/failed)
   *   - `"cancel"` — drop the buffer (user cancelled)
   */
  private flushResponseDelta(runId: string, mode: "tail" | "cancel"): void {
    const active = this.runs.get(runId);
    if (!active) return;
    if (mode === "tail" && active.deltaBuffer.trim()) {
      const id = this.opts.getTts().enqueue("response", active.deltaBuffer);
      active.pendingUtteranceIds.push(id);
    }
    active.deltaBuffer = "";
  }

  private cleanupRun(runId: string): void {
    const active = this.runs.get(runId);
    if (!active) return;
    active.closed = true;
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    this.runs.delete(runId);
    // If no runs remain, go idle.
    if (this.runs.size === 0) this.setState("idle");
  }
}
