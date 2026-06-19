# Subprocess Lifecycle

The BFF owns the Hermes gateway subprocess for its lifetime. The spawner module is the only place that knows about the subprocess. Everything else talks to Hermes via the apiClient.

## State machine

```
              start()
   ┌──────────────────────────────┐
   │                              ▼
[start] ──► [spawning] ──► [starting] ──► [ready] ──► [running]
                │              │             │           │
                │              │             │           │
                ▼              ▼             ▼           ▼
            [exited*]      [failed*]    [degraded*]   [stopping]
                                                       │
                                                       ▼
                                                    [exited]
```

- **start**: the spawner is constructed but no subprocess exists.
- **spawning**: `child_process.spawn` is in flight. Transitions to `starting` once `child.pid` is valid.
- **starting**: the subprocess has a pid but the API server isn't accepting requests yet. The spawner polls `GET /health` every 250ms. Transitions to `ready` on first 200, to `failed` on 15s deadline, to `exited` if the child dies during startup.
- **ready**: `/health` returned 200. The spawner has cached the apiClient base URL and a fresh `getCapabilities()` response. Transitions to `running` on the first successful API call (i.e. immediately — the apiClient is now usable). For practical purposes `ready` and `running` collapse to one state.
- **running**: the gateway is up, the apiClient is hot. Stays here until the gateway exits unexpectedly or `stop()` is called.
- **stopping**: `stop()` was called. SIGTERM sent, 5s grace period, then SIGKILL. No restart will be scheduled.
- **degraded**: the gateway is up but the last health poll returned non-200. Stays here until either a health poll recovers (back to `running`) or three consecutive failures transition to `exited` (and trigger a restart).
- **exited***: the subprocess is gone, the spawner is about to schedule a restart (with backoff). `stopping` was NOT set, so this is an unexpected exit. After `scheduleRestart()` returns, the spawner goes back to `spawning`.
- **failed***: startup timed out (15s with no `/health` 200). The child is killed (SIGKILL) and the spawner transitions to `exited*` (which schedules a restart).

`*` is a transient state — the spawner does not stay there.

## Restart backoff

| Attempt | Delay |
|---|---|
| 1 | 1s |
| 2 | 2s |
| 3 | 4s |
| 4 | 8s |
| 5 | 16s |
| 6+ | 30s (cap) |

The counter resets to 0 on a successful `ready` transition (i.e. the gateway stayed up for ≥ 30s). On `stop()`-initiated shutdown, the counter is not reset (so a manual restart still preserves the count if you call `start()` immediately after `stop()`).

401 from `/health` is treated specially: the spawner logs an error, kills the child, sets a `longBackoff` flag, and schedules a 30s restart (the first 401, ignoring 30s backoff). Subsequent 401s do NOT retry — the BFF broadcasts a single `server:error {message: "agent authentication failed — check HERMES_API_KEY"}` to all clients and stops polling. Recovery requires a manual `start()` after the user fixes the env.

## Health polling

Once in `starting`, the spawner polls `GET {HERMES_API_URL}/health` every 250ms with a 1s per-request timeout. The poll uses `fetch` (Node 20+ built-in). The poll loop exits on the first 200 OR on the 15s deadline.

When in `running`, the spawner polls `/health` every 5s (configurable via `HERMES_HEALTH_POLL_MS`). Three consecutive non-200 responses transition to `degraded`. Three more in `degraded` transition to `exited*` (restart).

## Capabilities cache

On the first transition into `ready`, the spawner calls `GET {HERMES_API_URL}/v1/capabilities` once and caches the result. The `model` field from the response is exposed via `getStatus().api.model`. The cache is invalidated on a restart (the new gateway may have a different config). It is not invalidated on `/v1/runs` failures — those are surfaced as `server:error` but don't re-fetch capabilities.

## Stdout/stderr

The subprocess's stdout is consumed (for log forwarding) and the spawner pipes every chunk through pino at `info` level with `{service: "agent", stream: "stdout"}`. Stderr is the same at `info` level with `{stream: "stderr"}`. Both go to the BFF's split-by-level files at `~/.jarvis/logs/`. Long lines are truncated at 2KB for log readability (the spawner keeps a count of truncated lines in `getStatus().stderrTruncated`).

The subprocess's stdin is closed immediately (Hermes gateway doesn't read stdin in `gateway run` mode — but we close it cleanly so the subprocess sees EOF on its stdin pipe).

## Previous response id handling

The BFF maintains a `WeakMap<WebSocket, string>` mapping each open WS to the last `response_id` for the conversation on that socket. On every `run.completed`, the BFF fetches `GET /v1/runs/{runId}` to read the actual `response_id` (the API server's pollable status carries it after the run is committed). That `response_id` is cached against the originating WS and sent as `previous_response_id` on the next `POST /v1/runs` from the same socket.

The mapping is cleared on WS close (the WeakMap handles this automatically; we just need to make sure the BFF doesn't hold any strong reference to the WebSocket from elsewhere — it does not).

For a voice assistant that wants to remember context across sessions, a future follow-up could persist the `response_id` to `~/.jarvis/state.db` keyed by user. That's explicitly out of scope here (NG-3).

## Failure mode matrix

| Failure | Spawner reaction | BFF reaction | WS client reaction |
|---|---|---|---|
| Spawn fails (`ENOENT`, no `hermes` on PATH) | Mark `failed`, retry with backoff | Log error, keep BFF up | `server:error` on next `command` |
| Subprocess exits unexpectedly (any signal/exit code) | Schedule restart with backoff | Log warn, keep BFF up | `server:error` on next `command` while in `exited*` |
| 401 from `/health` or any other endpoint | Mark `longBackoff` (30s), one retry, then stop polling | Log error | One-time broadcast: `server:error {message: "agent authentication failed — check HERMES_API_KEY"}` |
| 429 (rate limit, too many runs) | Pass-through to apiClient | Forward as `server:error` | `server:error {message: "agent busy — too many runs"}` |
| 5xx from `/v1/runs` (Hermes internal error) | Pass-through | Forward as `server:error` | `server:error {message: "agent internal error"}` |
| SSE stream dies mid-run | The runTracker's `subscribeRunEvents` consumer errors; runTracker marks the run `error` | Log warn, mark active run as `error`, broadcast `system:status` | `server:error {message: "agent stream disconnected"}` + `system:status` |
| BFF shutdown (`SIGTERM`) | `stop()` called: SIGTERM child, 5s grace, SIGKILL | `app.close()` after spawner returns | All WS clients disconnected (existing behavior) |

## Implementation sketch

```ts
// services/agent/spawner.ts
export interface SpawnerStatus {
  running: boolean;
  ready: boolean;
  pid: number | null;
  uptimeSec: number;
  restarts: number;
  lastError: string | null;
  api: { url: string; healthy: boolean; model: string | null };
}

export class HermesSpawner extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): SpawnerStatus;
  onStatusChange(listener: (status: SpawnerStatus) => void): () => void;
}
```

The spawner emits `status` (a `SpawnerStatus` snapshot) on every state transition. The `bridge` subscribes and broadcasts `system:status` to all WS clients.

## Test mode

For unit tests, the spawner accepts a `command` and `args` override and skips the `which hermes` check. The same pattern the deleted `manager.ts` already used (line 99-107). This lets `services/agent/bridge.test.ts` (and future tests) inject a fake hermes subprocess that prints ready/lives forever.
