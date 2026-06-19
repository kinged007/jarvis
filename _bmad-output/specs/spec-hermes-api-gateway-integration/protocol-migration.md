# Protocol Migration

What gets deleted, what gets rewritten, and what gets added when the BFF moves from the JSONL sidecar to the Hermes API server's Runs API.

## Deleted (the old way)

| File | LOC | Why it goes |
|---|---|---|
| `packages/bff/src/agent/manager.ts` | 540 | Spawned the Python sidecar over stdio. Replaced by `services/agent/spawner.ts` (manages `hermes gateway run` as a real subprocess) + `services/agent/apiClient.ts` (HTTP+SSE client). |
| `packages/bff/src/agent/hermes-sidecar.py` | 343 | The Python bridge that imported `run_agent.AIAgent` and spoke JSONL over stdio. Replaced by the Hermes API server's HTTP+SSE surface. |
| `packages/bff/src/agent/protocol.ts` | 215 | The JSONL protocol types, framer, and writers. Replaced by the typed `eventsource-parser` events from the API server (see `hermes-api-events.md`). |

The entire `packages/bff/src/agent/` directory is removed after the new `services/agent/` module is in place and the BFF typechecks. `git rm` (or just `rm` if you don't track the new files in a commit yet).

## Rewritten (in place, same module paths)

| File | New shape |
|---|---|
| `packages/bff/src/services/agent/types.ts` | Extended `AgentService` interface. Keep `sendCommand`, `cancelCommand`, `getStatus`, `onEvent`, `onStatus`, `onCommandTimeout` signatures. Add `sendApprovalResponse(runId, requestId, choice): boolean`. Re-export the typed Hermes API event union (`HermesSseEvent`) so the bridge can switch on it exhaustively. |
| `packages/bff/src/services/agent/bridge.ts` | `installAgentEventBridge({agent, tts, broadcast, log})` keeps the same signature. The internal `translateAgentEvent` is replaced by `translateHermesEvent` which switches on the `HermesSseEvent` union from `hermes-api-events.md`. On `run.completed`, the bridge calls `tts.enqueueText` for the full output (the TTS queue has been receiving deltas in parallel; the chunker dedupes by id, so the terminal enqueue is the consolidation that lands in the log as a single line). On `run.failed`/`run.cancelled`, the bridge broadcasts `server:error` and skips TTS. On `message.delta`, the bridge enqueues TTS for the delta (chunked) AND broadcasts `agent:response_delta` for the client log. |
| `packages/bff/src/services/agent/index.ts` | `createBffAgentService({impl?})` returns the new wrapper that composes the spawner, apiClient, runTracker, and bridge. The wrapper presents the `AgentService` interface. `impl?` is still accepted for tests and for the future "remote URL, no local spawn" mode. |
| `packages/bff/src/ws/router.ts` | Add a `case "agent:approval_response"` in the `dispatch` switch. The handler calls `agent.sendApprovalResponse(runId, requestId, choice)` and acks with `server:error {message: "approval recorded"}` on success or `server:error {message: "no pending approval"}` on miss. |
| `packages/bff/src/ws/handler.ts` | No signature changes. The new `agentService` is constructed in the same place (line ~52). `installAgentEventBridge` is still installed once. |
| `packages/bff/src/routes/agent.ts` | Extend the `/api/agent/status` response with `api: {url, healthy, model}`. The `api` snapshot comes from a small `getApiHealth()` helper in `services/agent/apiClient.ts`. |
| `packages/bff/src/env.ts` | Add `HERMES_API_URL` (default `http://127.0.0.1:8642`), `HERMES_API_KEY` (required; throws at boot if missing), `HERMES_PROFILE` (default `jarvis`). Drop the `HERMES_CMD` constant (no more sidecar). `HERMES_HOME` stays. |
| `packages/bff/src/server.ts` | Drop the `args: ["./src/agent/hermes-sidecar.py"]` from the `getAgentManager` call. The new `agentService` doesn't take args at construction — the spawner reads them from `env` and `HERMES_PROFILE`. |
| `packages/bff/package.json` | Add `js-yaml: ^4.1.0` and `eventsource-parser: ^2.0.0` to dependencies. Add `@types/js-yaml: ^4.0.9` to devDependencies. |
| `packages/shared/src/messages.ts` | Per `ws-message-changes.md`. |
| `.env.example` | Add the 3 new env vars with comments. |
| `scripts/setup.sh` | Per CAP-9: idempotently generate `HERMES_API_KEY`, write `platforms.api_server` block to the jarvis profile yaml, write `HERMES_API_KEY` to `.env`. |
| `SERVICE_MAP.md` | Rewrite the `### agent/` section to describe the new architecture (spawner, apiClient, sseClient, runTracker, bridge). |

## Added (new files under `packages/bff/src/services/agent/`)

```
services/agent/
├── types.ts         # rewritten (extended interface + HermesSseEvent union)
├── index.ts         # rewritten (composition root)
├── bridge.ts        # rewritten (event translation)
├── spawner.ts       # NEW — subprocess lifecycle (start, health poll, backoff, stop)
├── apiClient.ts     # NEW — HTTP client (Bearer auth, error handling, /health, /v1/runs, /v1/runs/{id}/{events,stop,approval})
├── sseClient.ts     # NEW — Node SSE consumer (uses eventsource-parser)
├── runTracker.ts    # NEW — per-run state machine, owns the SSE subscription, exposes submit/stop/respondApproval
└── approval.ts      # NEW — small helper for the approval hand-shake (mostly types)
```

### `spawner.ts` responsibilities
- `start()`: spawn `hermes -p <profile> gateway run` with the right env. Poll `/health` until ok or deadline.
- `stop()`: SIGTERM, wait 5s, SIGKILL.
- `restart()`: schedule with exponential backoff on unexpected exit.
- `onStatusChange(listener)`: emit `running` / `ready` / `exited` transitions.
- `isReady()`: bool.
- `getStatus()`: snapshot (pid, uptimeSec, restarts, lastError).

The spawner is the only place that knows about the subprocess. Everything else talks to Hermes via the apiClient.

### `apiClient.ts` responsibilities
- `healthCheck(): Promise<{ok, latencyMs, error?}>`.
- `getCapabilities(): Promise<{model, ...}>` (cached at startup).
- `submitRun(input, opts: {previousResponseId, sessionId}): Promise<{runId}>` → `POST /v1/runs`.
- `getRun(runId): Promise<RunStatus>` (used after `run.completed` to fetch the actual `response_id` for `previous_response_id` chaining).
- `stopRun(runId): Promise<void>` → `POST /v1/runs/{id}/stop`.
- `respondApproval(runId, choice): Promise<{resolved: number}>` → `POST /v1/runs/{id}/approval`.
- `subscribeRunEvents(runId): AsyncIterable<HermesSseEvent>` → wraps `eventsource-parser`.

Every request is logged at `info` level with `{service: "agent", method, path, status, durationMs, runId?}`. Errors at `warn`/`error`. SSE events at `info` (or `debug` for `message.delta`).

### `sseClient.ts` responsibilities
- A thin wrapper around `eventsource-parser` that yields typed `HermesSseEvent`s from a Node `http.ClientRequest` response.
- The stream is consumed by `runTracker`. On disconnect, the runTracker requests a resubscribe (Hermes does not currently resume; the BFF surfaces `server:error` to the client if a stream dies mid-run).

### `runTracker.ts` responsibilities
- Per active run, a `RunState` object: `{runId, sessionId, previousResponseId, status, startedAt, endedAt?, outputBuffer, deltaBuffer, toolCalls, approvalPending?}`.
- `submit(input, ctx)`: calls `apiClient.submitRun`, then `apiClient.subscribeRunEvents` in a fire-and-forget task. The task pushes events through the bridge.
- `stop(runId)`: calls `apiClient.stopRun`. The SSE stream then receives `run.cancelled` and the bridge handles it.
- `respondApproval(runId, choice)`: calls `apiClient.respondApproval`.
- Cleans up `RunState` on terminal events. Caps concurrent runs to whatever the API server allows (10); surfaces 429 as `server:error`.
- Holds the per-WS `previous_response_id` map. WeakMap<WebSocket, string>. Cleared on WS close.

### `bridge.ts` (rewritten) responsibilities
- Translate each `HermesSseEvent` to one or more `ServerMessage`s.
- Inject TTS enqueue for `message.delta` (per-delta, real-time) and `run.completed.output` (terminal consolidation — chunker dedupes).
- Broadcast `system:status` on lifecycle transitions.
- Broadcast `server:error` on failures.
- The bridge is the only consumer of `runTracker`'s event stream; the `AgentService.onEvent` method forwards bridge output.

## What does NOT change

- `services/stt/` (Deepgram, untouched).
- `services/tts/` (Deepgram, untouched — the bridge injects TTS the same way as before).
- `services/log.ts` (the BFF logger factory, untouched).
- `app.ts` (the pino levelRouter + file rotation, untouched).
- `ws/client-registry.ts` (the WS client fan-out, untouched).
- `middleware/jwt-verify.ts` (auth on WS upgrade, untouched).
- `routes/auth.ts`, `routes/health.ts`, `routes/weather.ts` (untouched).
- The client (`packages/client/`) is touched only in `messages.ts` (additive) and `useWebSocket.ts` (default-case handling for the new types; no new UI).
- The shared package (`packages/shared/`) is touched only in `messages.ts` and possibly `services/audioFormat.ts` (no — that's untouched per C-8).
- `SOUL.md`, `.hermes/plugins/jarvis/`, `~/.hermes/profiles/jarvis/`, and the `hermes-agent` venv — all untouched.

## Verification

The BFF typechecks (`pnpm --filter @jarvis/bff typecheck`) before and after. The smoke test: start the BFF, observe `agent: spawning hermes` in `bff.info.1.log`, then `agent: hermes ready (model: jarvis, port: 8642)` within 15s, then `agent: GET /v1/capabilities 200 12ms` from the startup cache fetch.

A second smoke test: `curl http://127.0.0.1:8642/health` (run by the user) returns `{"status":"ok"}`.
