/**
 * BFF agent service — public surface.
 *
 * The default implementation (`createBffAgentService`) composes:
 *   - `HermesSpawner`   : subprocess lifecycle (SIGTERM/SIGKILL, backoff)
 *   - `HermesApiClient` : HTTP client for the Runs API
 *   - `sseClient`       : SSE consumer via `eventsource-parser`
 *   - `RunTracker`      : per-run state + per-WS `previous_response_id`
 *   - `AgentEventBridge`: Hermes event → BFF ServerMessage translator
 *
 * The composition is the only place that knows the wiring. Tests can
 * pass an `impl` override to skip the subprocess entirely.
 */

import type WebSocket from "ws";
import { HermesApiClient } from "./apiClient.js";
import { HermesSpawner } from "./spawner.js";
import { RunTracker } from "./runTracker.js";
import { AgentEventBridge } from "./bridge.js";
import type {
  AgentService,
  AgentStatus,
  AgentEventListener,
  AgentStatusListener,
  AgentCommandTimeoutListener,
  Unsubscribe,
} from "./types.js";
import type { TtsService } from "../tts/types.js";
import type { ServerMessage } from "@jarvis/shared";

export interface BffAgentServiceDeps {
  hermesCmd: string;
  hermesArgs: string[];
  hermesApiUrl: string;
  hermesApiKey: string;
  tts: TtsService;
  broadcast: (msg: ServerMessage, opts?: { targetSocket?: WebSocket }) => void;
  logger: import("fastify").FastifyBaseLogger;
  /** Whether to voice `reasoning.available` commentary via TTS. Default true. */
  ttsCommentaryEnabled?: boolean;
  /** Word-count threshold for long-response modal + TTS trimming. Default 100. */
  longResponseThreshold?: number;
}

export interface BffAgentServiceOptions {
  /** Test hook — fully-formed implementation. */
  impl?: AgentService;
  /** Test hook — override the deps partially. */
  deps?: Partial<BffAgentServiceDeps>;
}

/** The BFF's `AgentService` shape. */
export function createBffAgentService(opts: BffAgentServiceOptions = {}): AgentService {
  if (opts.impl) return opts.impl;
  if (!opts.deps) {
    throw new Error("createBffAgentService requires either impl or deps");
  }
  return new ComposedAgentService(opts.deps as BffAgentServiceDeps);
}

class ComposedAgentService implements AgentService {
  private readonly apiClient: HermesApiClient;
  private readonly spawner: HermesSpawner;
  private readonly tracker = new RunTracker();
  private readonly bridge: AgentEventBridge;
  // Mutable broadcast — the BFF swaps in the real `clientRegistry.broadcast`
  // once the WS layer is up. Until then, the placeholder (typically
  // `log.debug`) is used. Reads happen on every broadcast frame, so the
  // swap is picked up immediately for the next event.
  private broadcast: BffAgentServiceDeps["broadcast"];
  // Mutable TTS service. The agent service is constructed in server.ts
  // before the TTS service exists in `wsRoutes`. The WS layer calls
  // `setTts(realTts)` on first connect; the bridge reads the current
  // value on every event so the swap is picked up immediately.
  private tts: TtsService;
  private readonly logger: import("fastify").FastifyBaseLogger;
  private readonly eventListeners = new Set<AgentEventListener>();
  private readonly statusListeners = new Set<AgentStatusListener>();
  private readonly timeoutListeners = new Set<AgentCommandTimeoutListener>();
  private started = false;

  constructor(deps: BffAgentServiceDeps) {
    this.broadcast = deps.broadcast;
    this.tts = deps.tts;
    this.logger = deps.logger;
    this.apiClient = new HermesApiClient({
      baseUrl: deps.hermesApiUrl,
      apiKey: deps.hermesApiKey,
      logger: deps.logger,
    });
    this.spawner = new HermesSpawner({
      cmd: deps.hermesCmd,
      args: deps.hermesArgs,
      apiUrl: deps.hermesApiUrl,
      apiKey: deps.hermesApiKey,
      logger: deps.logger,
    });
    this.bridge = new AgentEventBridge({
      apiClient: this.apiClient,
      tracker: this.tracker,
      logger: deps.logger,
      broadcast: (msg, broadcastOpts) => {
        // The bridge may pass `targetSocket` for a per-WS broadcast.
        this.broadcast(msg, broadcastOpts);
        for (const listener of this.eventListeners) listener(msg);
      },
      getTts: () => this.tts,
      ttsCommentaryEnabled: deps.ttsCommentaryEnabled,
      longResponseThreshold: deps.longResponseThreshold,
    });
    this.bridge.on("timeout", (runId) => {
      for (const l of this.timeoutListeners) l(runId);
    });
    this.spawner.on("status", (snapshot) => {
      const status = this.buildStatus(snapshot);
      for (const l of this.statusListeners) l(status);
      // Keep bridge state in sync with spawner health.
      // "offline" always wins; when agent comes back up go to
      // "idle" unless a run is active (bridge handles that).
      if (!status.ready) {
        this.bridge.setState("offline");
      } else if (this.bridge.state === "offline") {
        this.bridge.setState("idle");
      }
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.spawner.start();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.bridge.detachAll();
    await this.spawner.stop();
  }

  setBroadcast(fn: BffAgentServiceDeps["broadcast"]): void {
    this.broadcast = fn;
    this.logger.debug({}, "agent: broadcast swapped");
  }

  setTts(tts: TtsService): void {
    this.tts = tts;
    this.logger.debug({}, "agent: tts swapped");
  }

  async sendCommand(text: string, ctx: { socket: WebSocket; sessionId?: string }): Promise<string | null> {
    if (!this.spawner.snapshot().health?.healthy) {
      this.logger.warn({ service: "agent" }, "sendCommand: agent not ready");
      return null;
    }
    let runId: string;
    try {
      const sessionId = ctx.sessionId ?? this.tracker.getOrCreateSessionId(ctx.socket);
      const previousResponseId = this.tracker.getPreviousResponseId(ctx.socket);
      const submitted = await this.apiClient.submitRun({
        input: text,
        sessionId,
        ...(previousResponseId ? { previousResponseId } : {}),
      });
      runId = submitted.runId;
    } catch (err) {
      this.logger.error(
        { service: "agent", err: (err as Error).message },
        "sendCommand: submit failed",
      );
      this.broadcast({ type: "error", message: (err as Error).message });
      return null;
    }
    if (!this.tracker.register(runId, ctx.socket)) {
      this.logger.warn({ service: "agent", runId }, "sendCommand: concurrency cap hit");
      this.broadcast({ type: "error", message: "agent concurrency cap reached" });
      return null;
    }
    this.bridge.attach(runId, ctx.socket);
    return runId;
  }

  cancelCommand(input: { runId?: string; socket?: WebSocket }): boolean {
    const runId = input.runId ?? (input.socket ? this.tracker.mostRecentForSocket(input.socket)?.runId : undefined);
    if (!runId) return false;
    void this.apiClient.stopRun(runId).catch((err) => {
      this.logger.warn(
        { service: "agent", runId, err: (err as Error).message },
        "cancelCommand: stopRun failed",
      );
    });
    this.bridge.detach(runId);
    return true;
  }

  sendApprovalResponse(
    runId: string,
    _requestId: string,
    choice: "once" | "session" | "always" | "deny",
  ): boolean {
    void this.apiClient.respondApproval(runId, choice).catch((err) => {
      this.logger.warn(
        { service: "agent", runId, choice, err: (err as Error).message },
        "sendApprovalResponse: failed",
      );
    });
    return true;
  }

  getStatus(): AgentStatus {
    return this.buildStatus(this.spawner.snapshot());
  }

  onEvent(listener: AgentEventListener): Unsubscribe {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onStatus(listener: AgentStatusListener): Unsubscribe {
    this.statusListeners.add(listener);
    // Fire once on subscribe so the caller has the current snapshot.
    try {
      listener(this.getStatus());
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, "status listener threw on snapshot");
    }
    return () => this.statusListeners.delete(listener);
  }
  onCommandTimeout(listener: AgentCommandTimeoutListener): Unsubscribe {
    this.timeoutListeners.add(listener);
    return () => this.timeoutListeners.delete(listener);
  }

  private buildStatus(snapshot: ReturnType<HermesSpawner["snapshot"]>): AgentStatus {
    const running =
      snapshot.phase === "ready" ||
      snapshot.phase === "running" ||
      snapshot.phase === "starting" ||
      snapshot.phase === "spawning";
    return {
      running,
      ready: snapshot.phase === "ready" || snapshot.phase === "running",
      pid: snapshot.pid,
      uptimeSec: snapshot.uptimeSec,
      restarts: snapshot.restarts,
      lastError: snapshot.lastError,
      api: {
        url: (this.apiClient as unknown as { baseUrl: string }).baseUrl,
        healthy: !!snapshot.health?.healthy,
        model: snapshot.health?.model ?? null,
      },
    };
  }
}

export type {
  AgentService,
  AgentStatus,
  AgentEventListener,
  AgentStatusListener,
  AgentCommandTimeoutListener,
  Unsubscribe,
} from "./types.js";
