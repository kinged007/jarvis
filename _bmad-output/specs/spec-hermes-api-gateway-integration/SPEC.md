---
id: SPEC-hermes-api-gateway-integration
companions:
  - hermes-api-events.md
  - ws-message-changes.md
  - protocol-migration.md
  - subprocess-lifecycle.md
sources:
  - /home/josh/workspaces/jarvis/SERVICE_MAP.md
  - /home/josh/workspaces/jarvis/packages/bff/src/agent/manager.ts
  - /home/josh/workspaces/jarvis/packages/bff/src/agent/hermes-sidecar.py
  - /home/josh/workspaces/jarvis/packages/bff/src/agent/protocol.ts
  - /home/josh/.hermes/hermes-agent/gateway/platforms/api_server.py
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability only — consult them only if you need narrative rationale this contract intentionally omits.

# Hermes API Gateway Integration

## Why

The JARVIS BFF talks to the Hermes agent through a bespoke Python sidecar (`packages/bff/src/agent/hermes-sidecar.py`) that re-implements a JSON-over-stdio line protocol on top of `run_conversation()`. We hand-parse CLI-shaped output, hand-serialize a `command`/`cancel`/`ping` envelope, and own a separate `AIAgent` instance whose lifecycle is glued to the BFF process. Every new Hermes feature (real text deltas, rich tool events, approval prompts, mid-run stop, `previous_response_id` chain, the OpenAI-compatible HTTP API) has to be re-mapped through this shim, and we re-discover its bugs on every Hermes upgrade.

Hermes ships a ready-made, OpenAI-compatible HTTP server built directly into the gateway (`gateway/platforms/api_server.py`, 4,228 LOC) with a Runs API the team built for exactly this use case: `POST /v1/runs` returns 202 with a `run_id` immediately, `GET /v1/runs/{id}/events` streams structured SSE lifecycle events (`message.delta` for streamed response text, `reasoning.available` for thinking, `tool.started`/`tool.completed` for tool lifecycle, `approval.request` for human-in-the-loop prompts, `run.completed`/`run.failed`/`run.cancelled` for terminal events), `POST /v1/runs/{id}/stop` interrupts, `POST /v1/runs/{id}/approval` resolves approvals, and `previous_response_id` chains turns into a continuous conversation.

By replacing the sidecar with a thin HTTP+SSE client that talks to `http://127.0.0.1:8642` we (a) delete ~340 LOC of shim code and the Python child process it owns, (b) inherit every Hermes feature (streaming response deltas in real time, tool progress, approval hand-shake, response chain) for free, (c) move JARVIS onto the same integration path the Hermes team supports, and (d) make the BFF portable to any environment where a Hermes gateway is already running (we can swap the BFF-spawned process for a remote URL later with a one-line env change).

The streamed-response delta path (OQ-1) is the user-visible win: today the user waits for the sidecar to write a final `response` event before any text moves. With the Runs API, every `message.delta` becomes an `agent:response_delta` frame and the TTS pipeline can begin speaking the first sentence while the agent is still generating the rest. The UI's log container also gets every distinct event (`tool_call`/`tool_result`/`commentary`/`response`) so the user can drill in if they want.

## Capabilities

- id: CAP-1
  intent: BFF spawns and supervises the Hermes gateway subprocess (`hermes -p jarvis gateway run`) for the lifetime of the BFF process.
  success: After BFF start, `GET http://127.0.0.1:8642/health` returns 200 within 15s of spawn; the subprocess is killed (SIGTERM then SIGKILL after 5s) on BFF shutdown; an unexpected exit triggers auto-restart with exponential backoff (1s → 2s → 4s → 8s → 16s → 30s cap). See `subprocess-lifecycle.md` for state machine.

- id: CAP-2
  intent: BFF submits a user turn to Hermes as a structured run (`POST /v1/runs`) and gets back a `run_id` fast.
  success: A `command` or final STT transcript produces a `run_id` (202 Accepted with `{"run_id":"run_...","status":"started"}`); failure to get a `run_id` within 5s surfaces a `server:error` to the originating client; `previous_response_id` from the most recent successful run on the same WS connection is automatically attached to the next submission in the same body (Hermes does the chain stitching server-side via the `ResponseStore`).

- id: CAP-3
  intent: BFF subscribes to the SSE event stream of a live run (`GET /v1/runs/{id}/events`) and translates every structured event into the existing `ServerMessage` shape the client already speaks — with one new streaming type for real-time text deltas.
  success: `message.delta` → `agent:response_delta` (new, real-time text frames); `tool.started` → `agent:tool_call` (with optional `preview`); `tool.completed` → `agent:tool_result` (with `duration`, `error`); `reasoning.available` → `agent:commentary` (thinking text, distinct from the streamed response); `approval.request` → `agent:approval_request` (new); `approval.responded` → `agent:approval_resolved` (new, informational); `run.completed` → synthesized terminal `agent:response` with the full output (so the log container always has one final line) + `system:status` `agentReady=true`; `run.failed` → `server:error` with the error message; `run.cancelled` → `server:error {message: "cancelled"}`; `run.stopping` → silent (debug log only).

- id: CAP-4
  intent: BFF streams the full lifecycle of an in-flight run (text deltas, tool starts/completes, reasoning, approvals, terminal event) to the WS client in real time so the user hears the response while the agent is still generating, and the log container records every distinct event.
  success: For a run that calls 2 tools then produces a streamed answer, the WS client receives, in order and in real time: `agent:commentary` (if any reasoning), `agent:tool_call` ×2 (with `preview`), `agent:tool_result` ×2, a stream of `agent:response_delta` frames as text arrives (fed into the TTS queue immediately, sentence-chunked, so the user hears the first sentence before the agent finishes), and a final synthesized `agent:response` (full text, for the log entry) on `run.completed`; no `agent:response_delta` is duplicated as `agent:commentary`.

- id: CAP-5
  intent: BFF relays a user-initiated `cancel` from the WS to the Hermes stop endpoint for the active run.
  success: WS `cancel` while a run is in flight triggers `POST /v1/runs/{run_id}/stop` within 500ms; the run produces a `run.cancelled` event that the BFF forwards as `server:error {message: "cancelled"}`; the BFF clears any in-flight TTS utterances (`bridge.clearTtsQueue()`); the BFF closes the matching STT session; the originating client gets the cancel ack before the stop round-trip completes.

- id: CAP-6
  intent: BFF relays user approval decisions from the WS to the Hermes approval endpoint.
  success: WS `agent:approval_response` (carrying `runId`, `requestId`, `choice: "once" | "session" | "always" | "deny"`) triggers `POST /v1/runs/{run_id}/approval` with body `{"choice": "<choice>"}`; the resolved run emits a `run.completed` or `run.failed` that the BFF forwards normally; if the run has no active approval session the BFF logs a warn and returns a no-op ack to the client.

- id: CAP-7
  intent: BFF uses the existing STT and TTS services unchanged — the new agent service is a peer of them, not their replacement — and the STT final transcript → Hermes run → TTS enqueue flow continues to work end-to-end for voice input.
  success: Voice pipeline: speak → STT final transcript → POST /v1/runs → SSE `message.delta` frames stream in → bridge enqueues TTS utterances in real time (sentence-chunked) → audio plays while the agent is still generating. Cancel mid-response stops both TTS playback and the run within 300ms. On Hermes restart the BFF reconnects transparently on the next user input.

- id: CAP-8
  intent: BFF exposes a `GET /api/agent/status` route that surfaces Hermes API server health and connectivity, replacing the current "sidecar alive" snapshot.
  success: The route returns `{running, ready, pid, uptimeSec, restarts, lastError, api: {url, healthy, model}}` where `api.healthy` is the cached result of the most recent `GET /health` poll (re-polled every 5s while the gateway is up) and `api.model` comes from the cached `GET /v1/capabilities` response.

- id: CAP-9
  intent: Setup-time configuration of the Hermes profile is idempotent and emits the `api_server` platform block with a generated key on first run, without breaking the existing CLI usage of the same profile.
  success: `bash scripts/setup.sh` on a fresh checkout writes `platforms.api_server: {enabled: true, host: 127.0.0.1, port: 8642, key: <generated>, cors_origins: [http://localhost:5174]}` into `~/.hermes/profiles/jarvis/config.yaml` (creating the block if missing, leaving the block untouched if already `enabled: true` with the same key); the generated `HERMES_API_KEY` is also written to the BFF's `.env`; re-running setup is a no-op for unchanged config. Implementation uses a small inline Node script that depends on `js-yaml` (added as a BFF dep).

- id: CAP-10
  intent: The new agent service is fully interface-driven: the WS router, TTS bridge, and `/api/agent/status` route depend only on the `AgentService` interface and never on the API client or subprocess manager.
  success: The existing `services/agent/types.ts` interface is the only thing `ws/router.ts` and `routes/agent.ts` import from this module; swapping the implementation (test fake, future remote URL with no local spawn) requires zero changes to those consumers. `sendCommand`, `cancelCommand`, `getStatus`, `onEvent`, `onStatus`, `onCommandTimeout` keep their signatures; the interface is extended (not broken) with `sendApprovalResponse(runId, requestId, choice)`.

## Constraints

- **C-1**: The BFF's only new runtime dependency on the Hermes side is the API server at `http://127.0.0.1:8642`. No JSONL pipes, no Python child process, no shared memory. The BFF talks to Hermes over HTTP+SSE using `fetch` and a small SSE parser with the Bearer token from `HERMES_API_KEY`.
- **C-2**: The BFF-spawned subprocess is `hermes -p jarvis gateway run` (foreground, BFF-managed SIGTERM/SIGKILL on shutdown, exponential-backoff auto-restart on crash). No systemd/launchd, no `hermes gateway install`.
- **C-3**: The Hermes API server `api_server` platform is enabled in the existing `~/.hermes/profiles/jarvis/config.yaml` via a non-destructive yaml patch in `setup.sh` (using `js-yaml` from the BFF's `node_modules`). The patch is idempotent and never removes unrelated config.
- **C-4**: The Hermes API server's `API_SERVER_KEY` is mandatory (the server refuses to start without it, even on loopback). The BFF generates a 32-byte hex key on setup and persists it in two places: the profile yaml `platforms.api_server.key` and the BFF's `.env` as `HERMES_API_KEY`. The BFF reads it from the env at runtime and passes it to the subprocess as `API_SERVER_KEY`.
- **C-5**: Per-WS-connection `previous_response_id` chain. The BFF remembers the last successful `response_id` from `run.completed` per active WS socket and attaches it to the next `POST /v1/runs` on the same socket. No disk persistence in v1 — a WS reconnect starts a fresh chain.
- **C-6**: The BFF does not modify `run_agent` or any code under `~/.hermes/hermes-agent/`. The boundary is the API server's HTTP surface.
- **C-7**: The new `services/agent/` module exposes the same `AgentService` interface the WS router, TTS bridge, and `/api/agent/status` route already consume. The interface shape is extended (new method `sendApprovalResponse`) but `sendCommand`, `cancelCommand`, `getStatus`, `onEvent`, `onStatus`, `onCommandTimeout` keep their signatures. The `bridge` still owns the only call to `tts.enqueueText` for `response`/`commentary` events.
- **C-8**: The `STT_AUDIO_FORMAT` and `TTS_AUDIO_FORMAT` constants in `packages/shared/src/services/audioFormat.ts` are not touched. The voice pipeline uses the same wire formats the client already speaks.
- **C-9**: The `agent/manager.ts` and `agent/hermes-sidecar.py` files are deleted. `agent/protocol.ts` is deleted. The new `services/agent/` module is the only place that talks to Hermes; `ws/handler.ts`, `ws/router.ts`, `routes/agent.ts`, and `services/agent/bridge.ts` are the only consumers.
- **C-10**: The BFF logs every Hermes API request (method, path, status, duration_ms, run_id when applicable) and every SSE event (event name, run_id) through the existing pino `levelRouter` at `info` level so they land in `~/.jarvis/logs/bff.info.1.log` with `{service: "agent"}` for grep. SSE `message.delta` frames are logged at `debug` level (not info) to avoid log floods; the text itself is never logged.
- **C-11**: SSE consumer uses `eventsource-parser` (a small, well-tested Node SSE parser) instead of hand-rolled framing. The lib is added as a BFF dep.
- **C-12**: Concurrency: the Hermes API server caps concurrent runs at 10 (`_MAX_CONCURRENT_RUNS`). The BFF surfaces 429s as `server:error` and does not retry — the caller decides.

## Non-goals

- **NG-1**: A native React/Vue component library for Hermes. The client keeps talking to the BFF over the existing WS protocol (with the small additions in `ws-message-changes.md`).
- **NG-2**: Browser-direct connections to the Hermes API server (`http://localhost:8642/v1/...` from a fetch in the client). The BFF is the only client of the API server.
- **NG-3**: Persistent conversation history across BFF restarts. `previous_response_id` lives in the per-WS in-memory chain only.
- **NG-4**: A new WS protocol. The client-facing WS messages on `packages/shared/src/messages.ts` are extended (not replaced): 4 new types added — `agent:response_delta`, `agent:run_complete`, `agent:approval_request`, `agent:approval_response` — plus an optional `preview` field on `agent:tool_call`. The rest of the union is unchanged.
- **NG-5**: Re-implementing any feature of the Hermes API server in the BFF. The BFF does not run tools, does not cache responses, does not implement the Responses API's `previous_response_id` server-side store — it only consumes the Runs API.
- **NG-6**: Audio I/O via the Hermes API server's audio capabilities. The Hermes API server does not currently expose audio I/O (`audio_api: false` in `/v1/capabilities`); STT/TTS remain the BFF's Deepgram-based services.
- **NG-7**: Multi-tenant Hermes. The jarvis BFF is single-user; the API server is loopback-only and the BFF is its only client.
- **NG-8**: Changing the BFF's existing pino log layout, file rotation, or `client:log` shipping path. The new agent events flow through the same `levelRouter` infrastructure already wired in `app.ts`.
- **NG-9**: Working on the client UI beyond what is strictly required to receive the new WS message types. The log container in `useAgentStore` already records every event the bridge emits (no UI changes needed for that). Adding the actual approval modal is a separate workstream.

## Success signal

End-to-end: opening the JARVIS client, speaking "what's the weather in Tokyo", and seeing real-time text stream into the TTS queue while a tool-call indicator flashes on the page — with the entire pipeline running through the Hermes API server's Runs API (SSE events visible in `bff.info.1.log` as `{"service":"agent","event":"message.delta","run_id":"run_..."}` at `debug` level, plus `{"service":"agent","event":"tool.started","run_id":"run_..."}` at `info`), and `GET /api/agent/status` returning `api.healthy: true` with `api.model: "jarvis"`. The `agent/manager.ts` and `agent/hermes-sidecar.py` files no longer exist. Setup on a fresh machine takes the same single command (`bash scripts/setup.sh && pnpm dev`).

## Assumptions

- **A-1**: The Hermes team continues to expose the Runs API endpoints (`/v1/runs`, `/v1/runs/{id}`, `/v1/runs/{id}/events`, `/v1/runs/{id}/stop`, `/v1/runs/{id}/approval`) in the same shape we observed in `gateway/platforms/api_server.py`. The event vocabulary in `hermes-api-events.md` is the canonical surface.
- **A-2**: The Hermes API server's `tools.approval` subsystem is enabled and reachable from the BFF. The jarvis profile sets `HERMES_YOLO_MODE=1` in `.hermes/profile/.env`, so most tool calls are auto-approved; `approval.request` is a fallback path for tools the YOLO gate cannot bypass (e.g. network actions, browser popups). The BFF always wires the approval endpoint regardless of YOLO state, so it Just Works when the mode is off.
- **A-3**: `aiohttp` is available in the hermes-agent venv (required by `check_api_server_requirements()`); verified on the current hermes install.
- **A-4**: The `jarvis` profile has no other enabled platforms that would conflict with running `hermes -p jarvis gateway run` (Telegram, Discord, etc. are not configured for this single-user voice assistant). If a future platform is added, the gateway starts it alongside the API server — the BFF is unaffected.
- **A-5**: The Hermes API server is loopback-only (`127.0.0.1:8642`). No CORS, no auth concerns beyond the Bearer token. Network-accessible deployment is explicitly out of scope.
- **A-6**: `js-yaml` and `eventsource-parser` are added as BFF dependencies in `packages/bff/package.json` and installed via `pnpm install`. Total added weight: `js-yaml` ~80KB, `eventsource-parser` ~15KB, no native bindings.
- **A-7**: The Hermes API server's `previous_response_id` chain is a single linear chain. Branching/forks (which `POST /api/sessions/{id}/fork` supports) are out of scope; the BFF uses the linear chain via `previous_response_id`.
- **A-8**: The streamed response text (sequence of `message.delta` frames) and the final `run.completed.output` text differ only in framing — they concatenate to the same string. The TTS queue is fed by the deltas (low latency); the synthesized terminal `agent:response` carries the same text as the concatenation of deltas (so the log entry is consistent). No duplicate TTS enqueue on terminal.

## Open Questions

None at draft time. The three OQs from the planning round were resolved:
- **OQ-1** resolved as "richer delta-driven UX": new `agent:response_delta` for `message.delta`; reasoning stays `agent:commentary`.
- **OQ-2** resolved as "option B (js-yaml)": inline Node script in `setup.sh` using `js-yaml` from BFF's `node_modules`.
- **OQ-3** resolved as "add optional `preview?: string` to `ServerAgentToolCall`".
