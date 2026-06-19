import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import type { ClientMessage, ClientLogLevel } from "@jarvis/shared";
import { verifyWsUpgrade } from "../middleware/jwt-verify.js";
import { env } from "../env.js";
import {
  addClient,
  broadcast,
  getClientCount,
  removeClient,
  safeSend,
} from "./client-registry.js";
import {
  dispatch,
  type RouterContext,
  type SocketState,
} from "./router.js";
import { createBffSttService, type SttService } from "../services/stt/index.js";
import {
  createBffAgentService,
  type AgentService,
} from "../services/agent/index.js";
import { createBffTtsService, type TtsService } from "../services/tts/index.js";

/**
 * WebSocket route — GET /ws
 *
 * Single real-time channel. JWT verified on upgrade via httpOnly cookie.
 * Cookie refresh happens via REST whoami on page load — WS just verifies.
 */

const socketStates = new WeakMap<WebSocket, SocketState>();
let sttService: SttService | null = null;
let ttsService: TtsService | null = null;
let clearTtsQueueFn: () => void = () => {};

export function liveClientCount(): number {
  return getClientCount();
}

export async function wsRoutes(app: FastifyInstance): Promise<void> {
  if (!sttService) {
    sttService = createBffSttService({
      apiKey: env.DEEPGRAM_API_KEY,
      logger: app.log,
    });
  }
  if (!ttsService) {
    ttsService = env.DEEPGRAM_API_KEY
      ? createBffTtsService({
          apiKey: env.DEEPGRAM_API_KEY,
          model: env.DEEPGRAM_SPEAK_MODEL,
          broadcast,
          logger: app.log,
        })
      : null;
    if (ttsService) {
      app.log.info("tts service initialised (deepgram)");
    } else {
      app.log.warn("DEEPGRAM_API_KEY not set — TTS disabled");
    }
  }
  const agentService = app.agentService;
  if (agentService) {
    _cachedAgentService = agentService;
    // Swap the real WS broadcast into the agent service. The service
    // was constructed in server.ts with a placeholder; the WS layer
    // is the natural point of access for clientRegistry.broadcast, so
    // we install it here. The agent service is shared across
    // connections, so this swap runs once per app instance.
    agentService.setBroadcast((msg, opts) => broadcast(msg, opts));
    // Swap the real TTS service too. The agent bridge reads the
    // current TTS on every event, so this is picked up immediately.
    if (ttsService) {
      agentService.setTts(ttsService);
    }
  }
  // Note: the agent service is `start()`-ed by `server.ts` after the
  // HTTP listener binds. wsRoutes() does not start it — Fastify's
  // plugin lifecycle would otherwise start it twice if the app is
  // built once and re-registered (tests, hot reload).
  // TTS cancel hook — used by the router when a user interrupts.
  clearTtsQueueFn = () => ttsService?.clear();

  app.get("/ws", { websocket: true }, (socket, request) => {
    const payload = verifyWsUpgrade(request);
    if (!payload) {
      app.log.warn({ ip: request.ip }, "ws upgrade rejected: invalid jwt");
      try { socket.close(1008, "unauthorized"); } catch { /* ignore */ }
      return;
    }

    const userId = payload.sub;
    const state: SocketState = { userId, sttSession: null, currentRunId: null, lastCommandText: null };
    socketStates.set(socket, state);
    addClient(socket, userId);

    app.log.info({ user: userId, clients: getClientCount() }, "ws client connected");

    sendStatus(socket, agentService!.getStatus());

    const heartbeat = setInterval(() => {
      safeSend(socket, { type: "system:heartbeat", timestamp: Date.now() });
    }, 10_000);
    heartbeat.unref();

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      void handleMessage(socket, raw, state, app.log);
    });

    socket.on("close", (code: number, reasonBuf: Buffer) => {
      clearInterval(heartbeat);
      cleanupSocket(socket, state, code, reasonBuf.toString("utf8"), app.log);
    });

    socket.on("error", (err: Error) => {
      app.log.warn({ err: err.message, user: userId }, "ws error");
      try { safeSend(socket, { type: "error", message: "ws error" }); } catch { /* ignore */ }
    });
  });
}

// --- message handling ---

async function handleMessage(
  socket: WebSocket, raw: Buffer | ArrayBuffer | Buffer[],
  state: SocketState, log: FastifyBaseLogger,
): Promise<void> {
  const buf = toBuffer(raw);
  if (buf.length === 0) return;

  if (buf[0] === 0x7b) {
    let parsed: unknown;
    try { parsed = JSON.parse(buf.toString("utf8")); } catch (err) {
      log.debug({ err: (err as Error).message }, "ws: invalid JSON");
      safeSend(socket, { type: "error", message: "invalid JSON" });
      return;
    }
    const message = parseClientMessage(parsed);
    if (!message) {
      safeSend(socket, { type: "error", message: "unknown message type" });
      return;
    }
    try { await dispatch(socket, message, state, buildRouterContext(log)); } catch (err) {
      log.warn({ err: (err as Error).message, type: message.type }, "router dispatch threw");
      safeSend(socket, { type: "error", message: `router error: ${(err as Error).message}` });
    }
    return;
  }

  try {
    await dispatch(socket, { type: "voice:chunk", data: toArrayBuffer(buf) }, state, buildRouterContext(log));
  } catch (err) {
    log.warn({ err: (err as Error).message }, "voice:chunk dispatch threw");
  }
}

function toBuffer(raw: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  return raw;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

function parseClientMessage(value: unknown): ClientMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as { type?: unknown };
  if (typeof v.type !== "string") return null;
  switch (v.type) {
    case "command": { const t = (v as { text?: unknown }).text; return typeof t === "string" ? { type: "command", text: t } : null; }
    case "voice:chunk": return { type: "voice:chunk", data: new ArrayBuffer(0) };
    case "voice:end": return { type: "voice:end" };
    case "cancel": return { type: "cancel" };
    case "auth": { const t = (v as { token?: unknown }).token; return typeof t === "string" ? { type: "auth", token: t } : null; }
    case "agent:approval_response": {
      const r = (v as { runId?: unknown }).runId;
      const c = (v as { choice?: unknown }).choice;
      if (typeof r !== "string" || typeof c !== "string") return null;
      if (c !== "once" && c !== "session" && c !== "always" && c !== "deny") return null;
      const q = typeof (v as { requestId?: unknown }).requestId === "string" ? (v as { requestId: string }).requestId : "";
      return { type: "agent:approval_response", runId: r, requestId: q, choice: c };
    }
    case "client:log": {
      const lv = (v as { level?: unknown }).level;
      const msg = (v as { message?: unknown }).message;
      const meta = (v as { meta?: unknown }).meta;
      if (typeof lv !== "string" || typeof msg !== "string") return null;
      if (meta !== undefined && (typeof meta !== "object" || meta === null)) return null;
      return {
        type: "client:log",
        level: lv as ClientLogLevel,
        message: msg,
        ...(meta !== undefined ? { meta: meta as Record<string, unknown> } : {}),
      };
    }
    default: return null;
  }
}

function sendStatus(
  socket: WebSocket,
  status: { ready: boolean },
): void {
  safeSend(socket, {
    type: "system:status",
    connected: true,
    uptime: process.uptime(),
    agentReady: status.ready,
  });
}

function buildRouterContext(log: FastifyBaseLogger): RouterContext {
  if (!sttService) {
    throw new Error("services not initialised — wsRoutes() must run before dispatch");
  }
  // The agent service lives on the Fastify instance. The router context
  // shape doesn't carry a reference to `app`, so we capture the
  // singleton via the module-level cache below.
  const agentService = getCachedAgentService();
  if (!agentService) {
    throw new Error("agent service not initialised");
  }
  return {
    broadcast,
    logger: log,
    agentService,
    sttService,
    states: socketStates,
    clearTtsQueue: clearTtsQueueFn,
  };
}

function cleanupSocket(socket: WebSocket, state: SocketState, code: number, reason: string, log: FastifyBaseLogger): void {
  if (state.sttSession) { try { state.sttSession.close(); } catch { /* ignore */ } state.sttSession = null; }
  // Run is intentionally NOT cancelled here — the bridge's 5-minute
  // timeout will fire and clean up if the client never reconnects.
  // This gives the client a grace period within the existing timeout
  // window to reconnect without losing their conversation context.
  removeClient(socket);
  socketStates.delete(socket);
  log.info({ code, reason, user: state.userId, clients: getClientCount() }, "ws client disconnected");
}

/** Module-level cache for the agent service. Populated in `wsRoutes`
 *  from `app.agentService`, read by the per-message dispatch helpers.
 *  Cleaner than threading `app` through every router context. */
let _cachedAgentService: AgentService | null = null;
function getCachedAgentService(): AgentService | null {
  return _cachedAgentService;
}
