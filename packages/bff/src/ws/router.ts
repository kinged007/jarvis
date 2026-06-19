import type { WebSocket } from "ws";
import type { FastifyBaseLogger } from "fastify";
import type {
  ClientCancel,
  ClientClientLog,
  ClientCommand,
  ClientMessage,
  ClientVoiceChunk,
  ClientVoiceEnd,
  ServerMessage,
} from "@jarvis/shared";
import { safeSend } from "./client-registry.js";
import type { AgentService } from "../services/agent/index.js";
import type { SttService, SttSession } from "../services/stt/index.js";

/**
 * WebSocket message router — Step 3.
 *
 * One handler per `ClientMessage["type"]`. Handlers are pure: they take
 * the socket, the parsed message, the per-socket state, and a shared
 * router context. The router itself is stateless — the handler in
 * `handler.ts` owns the `SocketState` map and wires everything up.
 *
 * Handler map is exhaustively typed: adding a new `ClientMessage` type
 * will fail typecheck here until a handler is added.
 *
 * Message flow:
 *   - "auth"     : no-op (auth happens on the WS upgrade)
 *   - "command"  : forward text to Hermes via agent/manager.sendCommand
 *   - "voice:chunk" : forward audio bytes to the per-socket STT session
 *   - "voice:end"   : gracefully close the STT session
 *   - "cancel"      : signal Hermes to abort the current command + close
 *                     any active STT session
 *
 * Errors during a handler are surfaced to the originating client only
 * (via a `server:error` message) — the WS connection stays open.
 *
 * Note: the router used to import `createDeepgramSttSession` directly.
 * That coupling is gone — the router now receives an `SttService` from
 * the WS handler and calls `sttService.openSession(...)`. Replacing the
 * STT provider (e.g. for tests, or a non-Deepgram backend) is a one-
 * line change at the call site that constructs the service.
 */

export interface SocketState {
  userId: string;
  /** Live STT session, or null when no utterance is in flight. */
  sttSession: SttSession | null;
  /** Hermes `run_id` of the in-flight run (for cancel), or null. */
  currentRunId: string | null;
  /** Text of the last command sent (for deduplication). */
  lastCommandText: string | null;
}

export interface RouterContext {
  /** Fan-out primitive for stt:transcript (and future router-initiated messages). */
  broadcast: (msg: ServerMessage) => void;
  logger: FastifyBaseLogger;
  /** Agent service — sends commands and cancels them. */
  agentService: AgentService;
  /** STT service — opens per-socket sessions on demand. */
  sttService: SttService;
  /** Map shared with the WS handler — the router reads/writes per-socket state. */
  states: WeakMap<WebSocket, SocketState>;
  /** Cancels any in-flight TTS utterances. Wired in Step 8 to delegate to a TtsService. */
  clearTtsQueue: () => void;
}

export async function dispatch(
  socket: WebSocket,
  message: ClientMessage,
  state: SocketState,
  ctx: RouterContext,
): Promise<void> {
  switch (message.type) {
    case "command":
      await handleCommand(socket, message, state, ctx);
      return;
    case "voice:chunk":
      await handleVoiceChunk(socket, message, state, ctx);
      return;
    case "voice:end":
      await handleVoiceEnd(socket, message, state, ctx);
      return;
    case "cancel":
      await handleCancel(socket, message, state, ctx);
      return;
    case "client:log":
      handleClientLog(message, state, ctx);
      return;
    case "agent:approval_response":
      handleApprovalResponse(socket, message, state, ctx);
      return;
    case "auth":
      // Auth happens on the WS upgrade. A client that sends an "auth"
      // message post-upgrade is misbehaving — we silently ignore it.
      return;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleCommand(
  socket: WebSocket,
  message: ClientCommand,
  state: SocketState,
  ctx: RouterContext,
): Promise<void> {
  const text = message.text.trim();
  if (!text) {
    ctx.logger.debug({ user: state.userId }, "router: empty command ignored");
    sendError(socket, ctx, "empty command");
    return;
  }
  if (state.currentRunId) {
    if (state.lastCommandText === text) {
      ctx.logger.debug({ user: state.userId, runId: state.currentRunId }, "router: ignoring duplicate command");
      return;
    }
    ctx.agentService.cancelCommand({ runId: state.currentRunId, socket });
    state.currentRunId = null;
  }
  const runId = await ctx.agentService.sendCommand(text, { socket });
  if (!runId) {
    ctx.logger.warn({ user: state.userId, textLen: text.length }, "router: agent unavailable — command dropped");
    sendError(socket, ctx, "agent unavailable");
    return;
  }
  state.currentRunId = runId;
  state.lastCommandText = text;
  ctx.logger.info({ runId, len: text.length, user: state.userId }, "router: command forwarded to agent");
}

async function handleVoiceChunk(
  _socket: WebSocket,
  message: ClientVoiceChunk,
  state: SocketState,
  ctx: RouterContext,
): Promise<void> {
  if (!state.sttSession) {
    state.sttSession = openSttSession(state.userId, state, ctx);
    ctx.logger.info({ user: state.userId }, "router: opened new stt session");
  }
  if (state.sttSession) {
    state.sttSession.sendChunk(Buffer.from(message.data));
  }
}

async function handleVoiceEnd(
  socket: WebSocket,
  _message: ClientVoiceEnd,
  state: SocketState,
  ctx: RouterContext,
): Promise<void> {
  if (!state.sttSession) {
    ctx.logger.debug({ user: state.userId }, "voice:end with no active stt session");
    return;
  }
  const session = state.sttSession;
  state.sttSession = null;
  ctx.logger.info({ user: state.userId }, "router: closing stt session (voice:end)");
  try {
    await session.finish();
    ctx.logger.info({ user: state.userId }, "router: stt session finished cleanly");
  } catch (err) {
    ctx.logger.warn(
      { err: (err as Error).message, user: state.userId },
      "stt finish() failed",
    );
    sendError(socket, ctx, "stt close failed");
  }
}

async function handleCancel(
  socket: WebSocket,
  _message: ClientCancel,
  state: SocketState,
  ctx: RouterContext,
): Promise<void> {
  if (state.currentRunId) {
    const runId = state.currentRunId;
    state.currentRunId = null;
    const ok = ctx.agentService.cancelCommand({ runId, socket });
    ctx.logger.debug({ runId, ok, user: state.userId }, "cancel forwarded to agent");
  }
  ctx.clearTtsQueue();
  if (state.sttSession) {
    state.sttSession.close();
    state.sttSession = null;
    ctx.logger.debug({ user: state.userId }, "cancel closed stt session");
  }
  // Acknowledge so the client can stop its UI spinner immediately
  // without waiting for the agent to round-trip. We use a typed
  // `server:cancelled_ack` (not `error`) so the client transitions to
  // idle rather than `error` — a user-initiated cancel is not a
  // pipeline failure.
  safeSend(socket, { type: "server:cancelled_ack" });
}

function handleApprovalResponse(
  socket: WebSocket,
  message: { type: "agent:approval_response"; runId: string; requestId: string; choice: "once" | "session" | "always" | "deny" },
  _state: SocketState,
  ctx: RouterContext,
): void {
  const ok = ctx.agentService.sendApprovalResponse(
    message.runId,
    message.requestId,
    message.choice,
  );
  ctx.logger.debug(
    { runId: message.runId, requestId: message.requestId, choice: message.choice, ok, user: _state.userId },
    "router: approval response forwarded",
  );
  void socket;
}

// ---------------------------------------------------------------------------
// STT session factory
// ---------------------------------------------------------------------------

function openSttSession(
  userId: string,
  state: SocketState,
  ctx: RouterContext,
): SttSession | null {
  return ctx.sttService.openSession({
    userId,
    onTranscript: (t) => {
      // Each transcript is broadcast to *all* clients in single-user mode.
      // The originating client correlates via its own state; the message
      // shape is the same.
      ctx.broadcast({
        type: "stt:transcript",
        text: t.text,
        interim: !t.isFinal,
      });
    },
    onError: (err) => {
      ctx.logger.warn({ err: err.message, user: userId }, "stt session error");
      // Clear the field so the next voice:chunk opens a fresh session.
      if (state.sttSession) state.sttSession = null;
    },
    onClose: () => {
      if (state.sttSession) state.sttSession = null;
    },
  });
}

// ---------------------------------------------------------------------------
// Client log shipping
// ---------------------------------------------------------------------------

/**
 * Receive a `client:log` frame and write it through the BFF's pino
 * logger so it lands in the matching `bff.<level>.log` file under
 * `~/.jarvis/logs/`. The level mapping is the inverse of the client's
 * own `LogLevel` taxonomy:
 *   - `error`           → pino error
 *   - `warn`            → pino warn
 *   - `info` | `system` → pino info
 *   - everything else (debug, tool, tool-result, commentary) → pino debug
 *
 * We also stamp `service: "client"` and a `clientService` field with
 * the original service name the client log came from (e.g. `ws`, `stt`,
 * `tts`, `agent`), so file-level `grep`/`jq` filtering stays sane.
 */
function handleClientLog(
  message: ClientClientLog,
  state: SocketState,
  ctx: RouterContext,
): void {
  const incomingMeta = message.meta ?? {};
  const clientService =
    typeof incomingMeta["service"] === "string" ? String(incomingMeta["service"]) : "client";
  const meta: Record<string, unknown> = {
    ...incomingMeta,
    service: "client",
    clientService,
    fromUser: state.userId,
  };
  switch (message.level) {
    case "error":
      ctx.logger.error(meta, message.message);
      return;
    case "warn":
      ctx.logger.warn(meta, message.message);
      return;
    case "info":
    case "system":
      ctx.logger.info(meta, message.message);
      return;
    case "debug":
    case "tool":
    case "tool-result":
    case "commentary":
      ctx.logger.debug(meta, message.message);
      return;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendError(
  socket: WebSocket,
  ctx: RouterContext,
  message: string,
): void {
  safeSend(socket, { type: "error", message });
  ctx.logger.debug({ message }, "router error -> client");
}
