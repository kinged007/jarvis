/**
 * Hermes API server HTTP client.
 *
 * Thin `fetch` wrapper that:
 *   - Adds the Bearer auth header from `HERMES_API_KEY`
 *   - Times every request and logs `{service, method, path, status, durationMs}`
 *   - Translates OpenAI-style error envelopes into a typed `HermesApiError`
 *   - Exposes the Runs API surface (`/v1/runs`, `/v1/runs/{id}/events`, etc.)
 *
 * The client holds no state beyond the base URL and the API key. Per-run
 * state (run_id ↔ WS, previous_response_id) lives in `runTracker`.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { FastifyBaseLogger } from "fastify";

export interface HermesApiClientOptions {
  baseUrl: string;
  apiKey: string;
  logger: FastifyBaseLogger;
  /** Request timeout in ms (default 5s for non-streaming). */
  requestTimeoutMs?: number;
}

/** OpenAI-style error envelope (subset of what the Hermes API server returns). */
export interface HermesApiErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string;
    param?: string;
  };
  message?: string;
}

export class HermesApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly param: string | undefined;

  constructor(status: number, body: HermesApiErrorBody) {
    super(body.error?.message ?? body.message ?? `Hermes API error ${status}`);
    this.name = "HermesApiError";
    this.status = status;
    this.code = body.error?.code;
    this.param = body.error?.param;
  }
}

export interface SubmitRunInput {
  /** Text or array-of-messages the LLM should respond to. */
  input: string;
  /** Optional `previous_response_id` for conversation continuity. */
  previousResponseId?: string;
  /** Optional session id (Hermes short-term transcript scope). */
  sessionId?: string;
  /** Optional ephemeral system prompt override. */
  instructions?: string;
}

export interface SubmitRunResult {
  runId: string;
  status: "started" | "queued";
  /** Session id echoed back from the server (or the one we sent). */
  sessionId?: string;
}

export interface RunCapabilities {
  object: string;
  platform: string;
  model: string;
  auth: { type: string; required: boolean };
  features: Record<string, unknown>;
  endpoints: Record<string, { method: string; path: string }>;
}

export interface RunStatusSnapshot {
  run_id: string;
  status:
    | "queued"
    | "running"
    | "waiting_for_approval"
    | "stopping"
    | "completed"
    | "failed"
    | "cancelled";
  output?: string;
  error?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  created_at: number;
  updated_at: number;
  last_event?: string;
  response_id?: string;
  session_id?: string;
}

export interface ApprovalResponseResult {
  object: string;
  run_id: string;
  choice: "once" | "session" | "always" | "deny";
  resolved: number;
}

export class HermesApiClient {
  /** Public base URL (used by the spawner to log which URL it's probing for adoption). */
  public readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly log: FastifyBaseLogger;
  private readonly requestTimeoutMs: number;

  constructor(opts: HermesApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.log = opts.logger;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
  }

  /** `GET /health` — liveness check (no auth). Returns latency in ms. */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; status?: number; error?: string }> {
    const start = Date.now();
    try {
      const res = await this.fetchRaw("/health", { method: "GET", auth: false, timeoutMs: 1_000 });
      const latencyMs = Date.now() - start;
      if (res.status === 200) return { ok: true, latencyMs, status: res.status };
      return { ok: false, latencyMs, status: res.status, error: `status ${res.status}` };
    } catch (err) {
      const latencyMs = Date.now() - start;
      return { ok: false, latencyMs, error: (err as Error).message };
    }
  }

  /** `GET /v1/capabilities` — fetch the API surface + advertised model. */
  async getCapabilities(): Promise<RunCapabilities> {
    return this.request<RunCapabilities>("/v1/capabilities", { method: "GET" });
  }

  /** `POST /v1/runs` — submit a turn. Returns the `run_id` immediately. */
  async submitRun(input: SubmitRunInput): Promise<SubmitRunResult> {
    const body: Record<string, unknown> = { input: input.input };
    if (input.previousResponseId) body["previous_response_id"] = input.previousResponseId;
    if (input.sessionId) body["session_id"] = input.sessionId;
    if (input.instructions) body["instructions"] = input.instructions;
    const res = await this.request<{
      run_id: string;
      status: SubmitRunResult["status"];
      session_id?: string;
    }>("/v1/runs", { method: "POST", body, timeoutMs: 5_000 });
    return {
      runId: res.run_id,
      status: res.status,
      sessionId: res.session_id ?? input.sessionId,
    };
  }

  /** `GET /v1/runs/{run_id}` — fetch pollable status. Used after
   *  `run.completed` to read the `response_id` for the next chain step. */
  async getRun(runId: string): Promise<RunStatusSnapshot> {
    return this.request<RunStatusSnapshot>(`/v1/runs/${encodeURIComponent(runId)}`, { method: "GET" });
  }

  /** `POST /v1/runs/{run_id}/stop` — interrupt a running agent. */
  async stopRun(runId: string): Promise<{ runId: string; status: "stopping" }> {
    return this.request<{ run_id: string; status: "stopping" }>(
      `/v1/runs/${encodeURIComponent(runId)}/stop`,
      { method: "POST", timeoutMs: 6_000 },
    ).then((r) => ({ runId: r.run_id, status: r.status }));
  }

  /** `POST /v1/runs/{run_id}/approval` — resolve a pending approval. */
  async respondApproval(
    runId: string,
    choice: "once" | "session" | "always" | "deny",
  ): Promise<ApprovalResponseResult> {
    return this.request<ApprovalResponseResult>(
      `/v1/runs/${encodeURIComponent(runId)}/approval`,
      { method: "POST", body: { choice } },
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async request<T>(path: string, init: RequestInitJson): Promise<T> {
    const res = await this.fetchRaw(path, init);
    if (!res.ok) {
      let body: HermesApiErrorBody;
      try {
        body = (await res.json()) as HermesApiErrorBody;
      } catch {
        body = { message: `Hermes API error ${res.status}` };
      }
      throw new HermesApiError(res.status, body);
    }
    return (await res.json()) as T;
  }

  private async fetchRaw(
    path: string,
    init: {
      method: "GET" | "POST" | "PATCH" | "DELETE";
      body?: unknown;
      auth?: boolean;
      timeoutMs?: number;
    },
  ): Promise<Response> {
    const auth = init.auth ?? true;
    const timeoutMs = init.timeoutMs ?? this.requestTimeoutMs;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (auth && this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    let res: Response;
    try {
      const reqInit: {
        method: string;
        headers: Record<string, string>;
        body?: string;
        signal: AbortSignal;
      } = {
        method: init.method,
        headers,
        signal: controller.signal,
      };
      if (body !== undefined) reqInit.body = body;
      res = await fetch(`${this.baseUrl}${path}`, reqInit as unknown as RequestInit);
    } catch (err) {
      const durationMs = Date.now() - start;
      this.log.warn(
        { service: "agent", method: init.method, path, durationMs, err: (err as Error).message },
        "hermes api request failed",
      );
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Date.now() - start;
    // Health polls are noise — log at debug only.
    const logLevel = path === "/health" ? "debug" : "info";
    this.log[logLevel](
      {
        service: "agent",
        method: init.method,
        path,
        status: res.status,
        durationMs,
      },
      "hermes api request",
    );
    return res;
  }
}

interface RequestInitJson {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
}

/** Small helper for exponential backoff used by the spawner's health loop. */
export async function backoffDelay(attempt: number, baseMs: number, capMs: number): Promise<void> {
  const delayMs = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  await delay(delayMs);
}
