# Service map — JARVIS BFF + client

This file documents the service boundaries created during the service-isolation refactor. Use it to navigate the code, decide where new functionality belongs, and understand what can be reused.

## Shared (`packages/shared/src/`)

### `services/audioFormat.ts`
- `STT_AUDIO_FORMAT` (16kHz / mono / Int16 / 100ms chunks) — contract between client mic capture, BFF STT proxy, and Deepgram.
- `TTS_AUDIO_FORMAT` (24kHz / mono / Int16, 16KB chunks) — contract between BFF TTS providers and the client playback service.
- Single source of truth: changing a constant here ripples to both sides.
- Re-exported from the package barrel `packages/shared/src/index.ts`.

## BFF (`packages/bff/src/services/`)

### `stt/` — speech-to-text transport
- **`types.ts`** — `SttService` (`openSession`), `SttSession` (`sendChunk` / `finish` / `close` / `isClosed`), `SttProvider` interface.
- **`providers/deepgram.ts`** — `DeepgramSttProvider` wrapping the existing `voice/deepgram-stt.ts`. Swap providers here for tests or non-Deepgram backends.
- **`index.ts`** — `createBffSttService({apiKey, logger, provider?})`. Owns the API-key check, the `{service: "stt"}` tagged logger, and the `provider.openSession(...)` call.

### `agent/` — Hermes API gateway integration
- **`types.ts`** — `AgentService` interface. Command channel: `sendCommand(text, ctx: {socket, sessionId?}) → runId | null`, `cancelCommand({runId?, socket?}) → boolean`, `sendApprovalResponse(runId, requestId, choice) → boolean`. Introspection: `getStatus() → AgentStatus` (includes `api: {url, healthy, model}`). Lifecycle: `start()`, `stop()`. Subscriptions: `onEvent`, `onStatus`, `onCommandTimeout`. Also exports the `HermesSseEvent` union (11 variants) and the `isHermesSseEvent` type guard.
- **`apiClient.ts`** — `HermesApiClient` HTTP client. `GET /health`, `GET /v1/capabilities`, `POST /v1/runs`, `GET /v1/runs/{id}`, `POST /v1/runs/{id}/stop`, `POST /v1/runs/{id}/approval`. Bearer auth from `HERMES_API_KEY`. Per-request timeout (default 5 s) via `AbortController`. All requests logged at `{service:"agent"}` with method/path/status/durationMs.
- **`sseClient.ts`** — `subscribeRunEvents({client, logger, runId, signal}) → AsyncGenerator<HermesSseEvent>`. Opens `GET /v1/runs/{id}/events` and parses with `eventsource-parser` v2 (callback-based `createParser`). Cancellation aborts the underlying `fetch` and releases the connection.
- **`runTracker.ts`** — `RunTracker` per-run state. `register(runId, socket)` enforces a 10-concurrent-run cap. `previousResponseId` and `sessionId` live in `WeakMap<WebSocket, string>` (chain resets on reconnect). Tracks `pendingApproval` for `approval.request → approval.responded` correlation. `applyEvent` mutates phase (`pending → active → terminal`) from the Hermes event stream.
- **`spawner.ts`** — `HermesSpawner` extends `EventEmitter`. State machine: `stopped → spawning → starting → ready → running* → exited* → spawning` (or `stopping → stopped` on shutdown). **Adoption**: on `start()` and on every backoff-restart, probes the configured `HERMES_API_URL` with `GET /health` + `GET /v1/capabilities`; if both succeed, adopts the existing gateway (`adopted=true`, no subprocess, `pid=null`) and goes straight to `ready`. `stop()` then un-tracks it without sending a signal. This avoids the "Gateway already running" restart loop when Hermes is supervised externally (dev shell, systemd). Backoff: 1 s → 2 s → 4 s → 8 s → 16 s → 30 s cap, resets to 1 s after ≥30 s of stable `ready`. SIGTERM with 5 s SIGKILL grace. 401 → 30 s backoff + one retry then stops polling (invalid key). Steady-state 5 s health poll; 3 consecutive failures → `exited` → backoff restart.
- **`bridge.ts`** — `AgentEventBridge` translates `HermesSseEvent` → `ServerMessage`. `attach(runId, socket)` opens the SSE stream and pumps events through `tracker.applyEvent` then broadcasts. `message.delta` → `agent:response_delta` + TTS `enqueue("response", delta)`. `reasoning.available` → `agent:commentary`. `tool.started/completed` → `agent:tool_call`/`agent:tool_result` (per-run id correlation). `approval.request` → `agent:approval_request`. `run.completed` → `agent:response` (full text, no TTS re-enqueue) + `agent:run_complete` + fetches `response_id` for chain continuity. `run.failed/cancelled` → `agent:run_complete`. 5-minute per-run timeout emits `agent:run_complete` with `status:"failed"` and fires `timeout` event.
- **`index.ts`** — `createBffAgentService({impl?, deps?})` composition root. `ComposedAgentService` wires `HermesSpawner` + `HermesApiClient` + `RunTracker` + `AgentEventBridge` + injected `TtsService`. `start()` spawns the gateway subprocess; `stop()` cancels all in-flight SSE streams and SIGTERMs. `sendCommand` returns the Hermes `run_id`; `cancelCommand` POSTs to `/v1/runs/{id}/stop`. Inject `impl` for tests; `deps` for production with `{hermesCmd, hermesArgs, hermesApiUrl, hermesApiKey, tts, broadcast, logger}`.

### `tts/` — text-to-speech transport
- **`types.ts`** — `TtsService` (queue: `enqueue` / `clear` / `depth` / `isBusy`), `TtsProvider` (`start({text, onAudio, onDone, onError}) → TtsSession`), `TtsSession` (`cancel()`). Provider `name` is `"deepgram-ws" | "deepgram-rest"`.
- **`providers/ws.ts`** — `DeepgramWsTtsProvider` wrapping `voice/tts-ws.ts`.
- **`providers/rest.ts`** — `DeepgramRestTtsProvider`. Lifted from `voice/tts-queue.ts:151-204`. Best-effort cancellation (sets a flag; can't abort the in-flight fetch).
- **`queue.ts`** — `createBffTtsService({apiKey, broadcast, logger, model?, primaryProvider?, fallbackProvider?})`. Serialising queue with per-utterance cancellation token; primary (WS) → fallback (REST) on provider error.
- **Cross-service contract**: the agent bridge is the *only* caller of `tts.enqueue`. The bridge holds the `TtsService` instance and exposes `bridge.clearTtsQueue()` to the WS router.

### `log.ts` (BFF)
- `makeServiceLog(name, baseLogger)` returns `{info, warn, error, debug}` tagged with `{service: name}`. Used by the BFF services to add structured context to Fastify's pino logger.
- **Log files (split by level, auto-rotated)**: every log line the BFF emits — from `makeServiceLog`, from direct `app.log.*` calls in `ws/handler.ts` / `services/agent/bridge.ts` / `services/tts/queue.ts` / `server.ts`, and from client log shipping (see below) — lands in **one of four files** under `~/.jarvis/logs/`. The `<N>` in the filename is `pino-roll`'s count suffix (the current active file is always `<base>.1.<ext>`):
  - `bff.debug.1.log` — `level: 10/20` (trace/debug)
  - `bff.info.1.log`  — `level: 30` (info)
  - `bff.warn.1.log`  — `level: 40` (warn)
  - `bff.error.1.log` — `level: 50/60` (error/fatal)
- **Size control**: each file is capped at **10 MB** and rotated by `pino-roll` (size: `10m`, `limit.count: 1`). On overflow, the current file is renamed from `<base>.1.<ext>` to `<base>.2.<ext>` and a fresh `<base>.1.<ext>` is opened. With `count: 1` we keep exactly one backup on disk, so worst-case footprint is ~20 MB per level (~80 MB total). The numbers tick up over time as older backups age out (`.1` is deleted once `.3` exists). Rotation is automatic; the BFF does not need to be restarted.
- **Strict level separation**: a single in-process `Writable` (`levelRouter`, built in `app.ts:buildLogger`) parses each JSON line and forwards it to exactly one of the four `pino-roll` streams. The default pino `multistream` semantics ("level and above") would have dumped everything into the debug file, defeating the split; the custom router fixes that.
- **Stdout mirror**: in dev the same lines also go through `pino-pretty` (colorised, no file). In prod they go raw JSON to stdout (for `pm2` / `docker logs`).
- **Location override**: the directory is hard-coded to `~/.jarvis/logs/` today. A `JARVIS_LOG_DIR` env var is the natural extension if the user needs to redirect (not wired yet).
- **Client logs land here too**: the `client:log` WS message (see `ws/router.ts:handleClientLog`) is logged through this same pino instance with `service: "client"` and the original client service name in `clientService`. An AI agent (or a human) can `grep '"clientService":"stt"' ~/.jarvis/logs/bff.info.1.log` to pull just the client's STT entries.

## Client (`packages/client/src/services/`)

### `audio/context.ts` — single output `AudioContext`
- `getOutputAudioContext()`, `ensureOutputAudioRunning()`, `getMasterAnalyser()`, `closeOutputAudio()`.
- **One** `AudioContext` for the whole client. `lib/audio.ts` and `services/tts/service.ts` both read from it.

### `log.ts` (client)
- `makeServiceLog(name)` returns `{info, warn, error, system}` funnelling into two sinks:
  1. **`useAgentStore.addLogEntry`** — in-memory rolling buffer (capped at 500) that the `LogModal` reads from. Preserves the pre-refactor UI behaviour.
  2. **`sendMessage({type:"client:log",...})`** — ships a `client:log` frame on the active WS socket. The BFF's `ws/router.handleClientLog` re-logs it through pino so it lands in the matching `bff.<level>.1.log` file under `~/.jarvis/logs/` (see `log.ts` (BFF) for the file layout). The send is best-effort: a closed socket or send error never breaks the UI entry.
- **Why both**: the in-memory buffer is the source of truth for the live UI. The BFF shipping is what gives an AI agent (or post-mortem review) durable access to what happened in the browser, since the browser has no native fs. Without this, every `stt interim` line, every `ws:reconnect in 200ms` line, every `tts: stopAll` line evaporates on page refresh.
- **Level mapping** (client `LogLevel` → BFF `ClientLogLevel` → pino severity):
  - `error` → `error` → pino error
  - `warn` (stamped via `_severity` from `makeServiceLog.warn`) → `warn` → pino warn
  - `info` / `system` → `info` / `system` → pino info
  - `tool` / `tool-result` / `commentary` / `debug` → `tool` / `tool-result` / `commentary` / `debug` → pino debug
- **Replaces 22 ad-hoc `addLogEntry` call sites** — the direct `agent.addLogEntry({level:"tool",...})` calls in `useWebSocket.ts` were left in place (the modal needs the `tool`/`commentary`/`tool-result` channel-specific levels) and supplemented with a parallel `agentLog.*` call that ships the same data to the BFF.

### `voiceState.ts` — voice state machine
- `transitionVoiceState(event)`, `PROCESSING_TIMEOUT_MS = 30_000`, `armProcessingTimer(...)`. Single source of truth for the 5-state machine (idle / listening / processing / speaking / error) with an explicit `VALID` transition table. Replaces 5 sites that each had their own transition logic.

### `ws/sinks.ts` — shared WebSocket handles
- `setActiveSocket(s)`, `getActiveSocket()`, `sendMessage(msg)`, `sendBinary(ab)`. Module-level singletons shared by the STT service (sends audio + `voice:chunk` from imperative code) and React hooks (sends `command` / `cancel` from UI).

### `wakeword/` — wakeword detection
- **`types.ts`** — `WakewordService` (`getState` / `start` / `stop` / `onWake` / `takePreRollBuffer`).
- **`stub.ts`** — `createStubWakewordService()` returns an error for `takePreRollBuffer` and is otherwise inert. This is the only implementation today.
- **`index.ts`** — `wakewordService` singleton.
- `useWakeWord` (in `hooks/`) is a thin adapter that polls the service every 250ms when enabled.
- **Future**: drop a real `openWakeWord` provider into `wakeword/` and swap the export in `index.ts`. No consumer changes.

### `stt/` — speech-to-text client side
- **`types.ts`** — `SttService` (`start` / `stop` / `emitTranscript` — the last is called by the WS dispatch when `stt:transcript` arrives; `voiceLevel` subscription).
- **`service.ts`** — imperative implementation extracted from the old `useAudioCapture` hook. Owns mic capture, VAD, the pre-roll ring buffer. The `emitTranscript` method is the seam where the WS layer hands STT results back.
- **`index.ts`** — `sttService` singleton constructed with `sendBinary` (for `voice:chunk`) and `sendMessage` (for `voice:end`) from `ws/sinks.ts`.
- **Consumers**: `useAudioCapture` (thin React adapter taking the service), `useWebSocket` (calls `emitTranscript` on `stt:transcript` messages).

### `tts/` — text-to-speech client side
- **`types.ts`** — `TtsService` (`startUtterance` / `pushChunk` / `endUtterance` / `stopCurrent` / `stopAll` / `getQueueDepth` / `isPlaying` / `subscribeLevel`).
- **`service.ts`** — `ClientTtsService` class. Owns the utterance queue, the `pumpQueue` async loop that decodes raw linear16 PCM into AudioBuffers and plays them through the shared output `AudioContext` (via `getMasterAnalyser()` from `services/audio/context.ts`), and the rAF RMS loop for `subscribeLevel`.
- **`index.ts`** — `ttsService` singleton.
- **Consumers**: `useWebSocket` (calls `startUtterance` / `pushChunk` / `endUtterance` on `tts:*` messages), `useAudioPlayback` (polls `getQueueDepth` / `isPlaying` for UI controls), `useTtsLevel` (subscribes for the visualizer), `App.tsx` (calls `stopAll` before sending a typed command).

## Cross-service contracts (the wiring)

### BFF
- **`ws/router.ts` — `RouterContext`** is the seam: `{broadcast, logger, agentService, sttService, states, clearTtsQueue}`. Router handlers depend on the *interfaces*, not the modules. The router never imports `agent/manager.js` or `voice/*` directly.
- **`ws/handler.ts`** is the composition root: lazily instantiates the three services on first WS upgrade, installs the agent bridge once, and builds `RouterContext` for every dispatched message.

### Client
- **`useWebSocket`** is the central dispatch: it owns the active socket (via `ws/sinks.ts`), parses every `ServerMessage`, and routes to the right service.
- **Cross-service flow on `agent:response`**: `useWebSocket` → `ttsService.startUtterance` (id, kind, text) → BFF sends `tts:utterance` → `ttsService.startUtterance` again on client → `ttsService.pushChunk` for each audio chunk → `ttsService.endUtterance` on `tts:utterance_end` → pump loop decodes and plays.
- **Cross-service flow on `command` send**: `App` → `ttsService.stopAll` (clears any in-flight) → `ws/sinks.sendMessage({type:"command",...})` → `voiceState.transitionVoiceState({type:"START_PROCESSING"})` → BFF agent → eventually `agent:response` → back to TTS pipeline.
- **Cross-service flow on every `serviceLog.*` call (client → BFF file)**: `useAudioCapture` / `useWebSocket` / `App.tsx` → `sttLog.info(...)` / `agentLog.warn(...)` / etc. → `add()` in `services/log.ts` does two things in parallel: `useAgentStore.addLogEntry(...)` (UI modal) **and** `sendMessage({type:"client:log", level, message, meta})` via `ws/sinks.ts` → BFF `ws/handler.ts:parseClientMessage` → `ws/router.ts:handleClientLog` → `ctx.logger.<level>({service:"client", clientService, ...}, msg)` → pino `levelRouter` `Writable` → exactly one of the four `pino-roll` file streams under `~/.jarvis/logs/` (writing to `bff.<level>.1.log`). Send is best-effort (try/catch around `sendMessage`); the in-memory entry is the source of truth for the UI.

## Singleton inventory

| Package | Service | File | Type |
|---|---|---|---|
| shared | `STT_AUDIO_FORMAT`, `TTS_AUDIO_FORMAT` | `services/audioFormat.ts` | const |
| bff | `sttService` | `ws/handler.ts` (lazy) | per-process |
| bff | `agentService` | `ws/handler.ts` (lazy) | per-process (wraps `agent/manager` singleton) |
| bff | `ttsService` | `ws/handler.ts` (lazy, null if no API key) | per-process |
| bff | log file streams (`bff.{debug,info,warn,error}.1.log` current + `.2.log` backup) | `~/.jarvis/logs/` (built in `app.ts:buildLogger`) | per-process (rotated, 10 MB cap) |
| client | `wakewordService` | `services/wakeword/index.ts` | per-process |
| client | `sttService` | `services/stt/index.ts` | per-process |
| client | `ttsService` | `services/tts/index.ts` | per-process |
| client | output `AudioContext` | `services/audio/context.ts` | per-process |
| client | active `WebSocket` | `services/ws/sinks.ts` | per-process |

## Where to add a new service

1. Pick the package (`bff` for server-only, `client` for browser-only, `shared` for both).
2. Add a `services/<name>/` directory with `types.ts` (interface), `service.ts` or `providers/` (implementation), and `index.ts` (singleton + re-exports).
3. If it's BFF, instantiate it in `ws/handler.ts` next to the other services and pass it into `RouterContext` (extend the interface in `router.ts`).
4. If it's client, export a singleton from the service's `index.ts` and import where needed.
5. If it needs logging, use the package's `services/log.ts` factory (BFF takes the Fastify logger; the logger is pre-wired to write to the four split-by-level files under `~/.jarvis/logs/` with the 10 MB cap. Client funnels to `useAgentStore` for the UI and ships a `client:log` frame to the BFF for file persistence).
