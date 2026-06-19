/**
 * Hermes gateway subprocess spawner.
 *
 * Owns the lifecycle of the `hermes -p jarvis gateway run --accept-hooks`
 * process. Emits lifecycle events on an internal EventEmitter that the
 * `AgentService` composition root (`index.ts`) translates into `AgentStatus`
 * updates for the BFF.
 *
 * Lifecycle states (see `_bmad-output/specs/spec-hermes-api-gateway-integration/subprocess-lifecycle.md`):
 *
 *   stopped → spawning → starting → ready → running* → exited* → spawning
 *                                                    ↑
 *                                          (or adopt existing)
 *                                                    ↓
 *                                                  stopping
 *
 * Before spawning, the spawner probes the configured `HERMES_API_URL`. If a
 * gateway is already healthy there AND its `/v1/capabilities` accepts our
 * `HERMES_API_KEY`, the BFF **adopts** it instead of spawning — no subprocess
 * is created, `pid` stays `null`, and `stop()` simply un-tracks it. This
 * handles:
 *   - Dev workflows where the user runs Hermes in a separate terminal
 *   - Prod where an external supervisor (systemd, s6) manages the gateway
 *   - The "Gateway already running (PID N)" stdout message that would
 *     otherwise cause an immediate exit + restart loop
 *
 * Backoff between restart attempts follows the schedule
 *   1s → 2s → 4s → 8s → 16s → 30s (capped)
 * and resets to 1s after ≥30s of stable `ready` uptime. A 401 from the API
 * server triggers a single retry at the long-backoff cap and then stops
 * polling (the API key is invalid; restart can't fix it).
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { FastifyBaseLogger } from "fastify";
import { HermesApiClient, type RunCapabilities } from "./apiClient.js";

export type SpawnerPhase =
  | "stopped"
  | "spawning"
  | "starting"
  | "ready"
  | "running"
  | "exited"
  | "stopping";

export interface SpawnerEvent {
  phase: SpawnerPhase;
  pid: number | null;
  uptimeSec: number;
  restarts: number;
  lastError: string | null;
  /** Health snapshot (only on `ready` and steady-state updates). */
  health?: { healthy: boolean; latencyMs?: number; model: string | null };
}

const HEALTH_POLL_INTERVAL_MS = 5_000;
const HEALTH_POLL_DEADLINE_MS = 15_000;
const HEALTH_POLL_INITIAL_MS = 250;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const LONG_BACKOFF_MS = 30_000;
const STABILITY_RESET_MS = 30_000;
const SIGKILL_GRACE_MS = 5_000;
const MAX_AUTH_RETRIES = 1;

export interface HermesSpawnerOptions {
  cmd: string;
  args: string[];
  apiUrl: string;
  apiKey: string;
  logger: FastifyBaseLogger;
  /** Override for tests. */
  spawnImpl?: typeof spawn;
}

export class HermesSpawner extends EventEmitter {
  private readonly cmd: string;
  private readonly args: string[];
  private readonly apiClient: HermesApiClient;
  private readonly log: FastifyBaseLogger;
  private readonly spawnImpl: typeof spawn;

  private proc: ReturnType<typeof spawn> | null = null;
  private pid: number | null = null;
  private phase: SpawnerPhase = "stopped";
  private restarts = 0;
  private lastError: string | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private backoffTimer: NodeJS.Timeout | null = null;
  private startupDeadline: NodeJS.Timeout | null = null;
  private stableSince: number | null = null;
  private authRetries = 0;
  private stopping = false;
  /** When true, the BFF is talking to a gateway it did NOT spawn. `proc`/`pid` are null. */
  private adopted = false;
  private healthSnapshot: SpawnerEvent["health"] = { healthy: false, model: null };

  constructor(opts: HermesSpawnerOptions) {
    super();
    this.cmd = opts.cmd;
    this.args = opts.args;
    this.log = opts.logger;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.apiClient = new HermesApiClient({
      baseUrl: opts.apiUrl,
      apiKey: opts.apiKey,
      logger: opts.logger,
    });
  }

  start(): void {
    if (this.phase !== "stopped" && this.phase !== "exited") return;
    this.stopping = false;
    void this.adoptOrSpawn();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearHealthTimer();
    this.clearBackoffTimer();
    this.clearStartupDeadline();
    // If we adopted a foreign gateway, we don't own it — just un-track.
    if (this.adopted || !this.proc) {
      this.adopted = false;
      this.transition("stopped");
      return;
    }
    this.transition("stopping");
    return new Promise<void>((resolve) => {
      const proc = this.proc!;
      const exited = new Promise<void>((res) => proc.once("exit", () => res()));
      try {
        proc.kill("SIGTERM");
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, "spawner: SIGTERM failed");
      }
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch (err) {
          this.log.warn({ err: (err as Error).message }, "spawner: SIGKILL failed");
        }
      }, SIGKILL_GRACE_MS);
      exited.then(() => {
        clearTimeout(timer);
        this.proc = null;
        this.pid = null;
        this.transition("stopped");
        resolve();
      });
    });
  }

  /** Snapshot for the public `AgentService.getStatus()`. */
  snapshot(): SpawnerEvent {
    return {
      phase: this.phase,
      pid: this.pid,
      uptimeSec: this.stableSince ? Math.floor((Date.now() - this.stableSince) / 1000) : 0,
      restarts: this.restarts,
      lastError: this.lastError,
      health: this.healthSnapshot,
    };
  }

  /** Test hook — replace the API client. */
  setApiClient(client: HermesApiClient): void {
    Object.assign(this, { apiClient: client });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Probe the configured `HERMES_API_URL` for an already-running gateway and
   * adopt it. If health + auth both pass, we transition to `ready` without
   * spawning a subprocess. Returns true if adopted, false if the probe failed
   * and the caller should fall back to `spawnProcess()`.
   */
  private async tryAdopt(): Promise<boolean> {
    this.log.info({ service: "agent", apiUrl: this.apiClient.baseUrl }, "spawner: probing for existing gateway");
    const h = await this.apiClient.healthCheck();
    if (!h.ok) {
      this.log.debug({ service: "agent", status: h.status, error: h.error }, "spawner: no existing gateway");
      return false;
    }
    let caps: RunCapabilities;
    try {
      caps = await this.apiClient.getCapabilities();
    } catch (err) {
      this.log.warn(
        { service: "agent", err: (err as Error).message },
        "spawner: capabilities check failed (key mismatch?) — will spawn our own",
      );
      return false;
    }
    this.adopted = true;
    this.proc = null;
    this.pid = null;
    this.stableSince = Date.now();
    this.healthSnapshot = { healthy: true, latencyMs: h.latencyMs, model: caps.model };
    this.lastError = null;
    this.consecutiveHealthFails = 0;
    this.log.info(
      { service: "agent", model: caps.model, latencyMs: h.latencyMs },
      "spawner: adopted existing gateway (no subprocess spawned)",
    );
    this.transition("ready");
    this.beginSteadyStateHealth();
    return true;
  }

  private async adoptOrSpawn(): Promise<void> {
    if (await this.tryAdopt()) return;
    this.spawnProcess();
  }

  private spawnProcess(): void {
    this.transition("spawning");
    this.log.info({ service: "agent", cmd: this.cmd, args: this.args }, "spawner: spawning");
    let proc: ReturnType<typeof spawn>;
    try {
      proc = this.spawnImpl(this.cmd, this.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        detached: false,
      });
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log.error({ service: "agent", err: this.lastError }, "spawner: spawn failed");
      this.scheduleRestart();
      return;
    }
    this.proc = proc;
    this.pid = proc.pid ?? null;
    this.transition("starting");

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.log.debug({ service: "agent", stream: "stdout", text }, "hermes: stdout");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.log.warn({ service: "agent", stream: "stderr", text }, "hermes: stderr");
    });

    proc.once("exit", (code, signal) => {
      this.proc = null;
      this.pid = null;
      this.clearHealthTimer();
      this.clearStartupDeadline();
      if (this.stopping) return; // stop() handles the transition
      this.lastError = code !== 0 ? `exit code ${code}${signal ? ` (${signal})` : ""}` : null;
      this.log.warn(
        { service: "agent", code, signal, restarts: this.restarts },
        "spawner: exited unexpectedly",
      );
      this.transition("exited");
      this.scheduleRestart();
    });

    proc.once("error", (err) => {
      this.lastError = err.message;
      this.log.error({ service: "agent", err: err.message }, "spawner: error event");
    });

    // Begin polling for readiness.
    this.pollHealthUntilReady();
  }

  private async pollHealthUntilReady(): Promise<void> {
    const start = Date.now();
    this.startupDeadline = setTimeout(() => {
      if (this.phase === "starting" || this.phase === "spawning") {
        this.lastError = `Hermes gateway did not become ready within ${HEALTH_POLL_DEADLINE_MS}ms`;
        this.log.error({ service: "agent" }, this.lastError);
        if (this.proc) {
          try {
            this.proc.kill("SIGTERM");
          } catch {
            /* noop */
          }
        }
      }
    }, HEALTH_POLL_DEADLINE_MS);

    const tick = async (): Promise<void> => {
      if (this.phase !== "starting" && this.phase !== "spawning") return;
      const h = await this.apiClient.healthCheck();
      if (h.ok) {
        this.clearStartupDeadline();
        this.stableSince = Date.now();
        let caps: { model?: string } = {};
        try {
          caps = await this.apiClient.getCapabilities();
        } catch (err) {
          this.log.warn({ service: "agent", err: (err as Error).message }, "spawner: capabilities failed");
        }
        this.healthSnapshot = {
          healthy: true,
          latencyMs: h.latencyMs,
          model: caps.model ?? null,
        };
        this.lastError = null;
        this.transition("ready");
        this.beginSteadyStateHealth();
        return;
      }
      if (h.status === 401) {
        if (this.authRetries < MAX_AUTH_RETRIES) {
          this.authRetries++;
          this.lastError = "Hermes API rejected the key (401) — retrying once with backoff";
          this.log.error({ service: "agent" }, this.lastError);
          await new Promise((r) => setTimeout(r, LONG_BACKOFF_MS));
          if (this.phase === "starting" || this.phase === "spawning") {
            this.healthTimer = setTimeout(tick, HEALTH_POLL_INITIAL_MS);
          }
          return;
        }
        // Out of auth retries — kill the subprocess and stop polling.
        this.lastError = "Hermes API rejected the key (401) — check HERMES_API_KEY";
        this.log.error({ service: "agent" }, this.lastError);
        if (this.proc) {
          try {
            this.proc.kill("SIGTERM");
          } catch {
            /* noop */
          }
        }
        return;
      }
      if (Date.now() - start > HEALTH_POLL_DEADLINE_MS) {
        this.lastError = "Health poll deadline exceeded";
        this.log.error({ service: "agent" }, this.lastError);
        if (this.proc) {
          try {
            this.proc.kill("SIGTERM");
          } catch {
            /* noop */
          }
        }
        return;
      }
      this.healthTimer = setTimeout(tick, HEALTH_POLL_INITIAL_MS);
    };
    // Fire first tick on next tick so caller doesn't observe synchronous recursion.
    this.healthTimer = setTimeout(tick, HEALTH_POLL_INITIAL_MS);
  }

  private beginSteadyStateHealth(): void {
    this.clearHealthTimer();
    this.healthTimer = setInterval(async () => {
      if (this.phase === "stopped" || this.phase === "stopping") return;
      const h = await this.apiClient.healthCheck();
      this.healthSnapshot = {
        healthy: h.ok,
        latencyMs: h.latencyMs,
        model: this.healthSnapshot?.model ?? null,
      };
      if (h.ok) {
        if (!this.stableSince) this.stableSince = Date.now();
        if (this.phase === "ready") this.transition("running");
        if (this.phase === "exited") this.transition("ready");
        if (this.stableSince && Date.now() - this.stableSince > STABILITY_RESET_MS) {
          this.restarts = 0;
        }
        this.emitStatus();
      } else {
        // Three consecutive failures → exited
        this.consecutiveHealthFails = (this.consecutiveHealthFails ?? 0) + 1;
        if (this.consecutiveHealthFails >= 3) {
          this.lastError = `Hermes API /health failed ${this.consecutiveHealthFails} times`;
          this.clearHealthTimer();
          this.transition("exited");
          this.scheduleRestart();
        } else {
          this.emitStatus();
        }
      }
    }, HEALTH_POLL_INTERVAL_MS);
  }

  private consecutiveHealthFails = 0;

  private scheduleRestart(): void {
    if (this.stopping) return;
    this.clearBackoffTimer();
    if (this.restarts > 0 && this.stableSince) {
      // We were up — reset the backoff counter.
      if (Date.now() - this.stableSince > STABILITY_RESET_MS) {
        this.restarts = 0;
      }
    }
    this.restarts++;
    const delayMs = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, this.restarts - 1));
    this.log.info({ service: "agent", restarts: this.restarts, delayMs }, "spawner: scheduling restart");
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      void this.adoptOrSpawn();
    }, delayMs);
  }

  private clearHealthTimer(): void {
    if (this.healthTimer) {
      clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
  }
  private clearBackoffTimer(): void {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }
  private clearStartupDeadline(): void {
    if (this.startupDeadline) {
      clearTimeout(this.startupDeadline);
      this.startupDeadline = null;
    }
  }

  private transition(phase: SpawnerPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    if (phase === "ready") {
      this.stableSince = Date.now();
      this.consecutiveHealthFails = 0;
    }
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit("status", this.snapshot());
  }
}
