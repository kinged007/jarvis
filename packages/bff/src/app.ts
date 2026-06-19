import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pino, multistream, transport, destination, type DestinationStream, type Logger } from "pino";
import pinoRoll from "pino-roll";
import { env } from "./env.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { weatherRoutes } from "./routes/weather.js";
import { agentRoutes } from "./routes/agent.js";
import { sttRoutes } from "./routes/stt.js";
import { wsRoutes } from "./ws/handler.js";
import type { AgentService } from "./services/agent/index.js";

/**
 * BFF entry point — Step 3.
 *
 * What's wired here:
 *   - CORS allowing the Vite dev origin (5174)
 *   - Cookie support (for the JWT cookie, CAP-12)
 *   - JWT auth preHandler (jwt-verify.ts) used by /api/auth/whoami
 *     and /api/agent/status
 *   - /api/health, /api/auth/whoami, /api/weather, /api/agent/status
 *   - @fastify/websocket + GET /ws for the single real-time channel
 *     (CAP-3, CAP-4, CAP-12, CAP-13). The handler is in ws/handler.ts;
 *     JWT verification runs inside the upgrade via jwt-verify.ts.
 *
 * Lifecycle:
 *   - buildServer() returns a Fastify instance with all routes registered
 *     and nothing spawned.
 *   - server.ts calls spawnAgent() after listen() succeeds and stopAgent()
 *     before app.close() so the subprocess lifecycle mirrors the BFF.
 *
 * Logging (split-by-level file rotation):
 *   All log lines are written to `~/.jarvis/logs/bff.<level>.1.log` where
 *   `<level>` is `debug`, `info`, `warn`, or `error`. The trailing `.1`
 *   is `pino-roll`'s count suffix — the current (active) file is always
 *   `<base>.1.<ext>`, and when it hits 10 MB the stream reopens at
 *   `<base>.2.<ext>` and the `.1` file becomes the most recent backup.
 *   With `limit.count: 1` we keep exactly one backup on disk, so
 *   worst-case footprint is ~20 MB per level. The numbers tick up over
 *   time as older backups age out (`.1` is deleted once `.3` exists).
 *
 *   A single `Writable` (levelRouter) parses each JSON line and routes
 *   it to exactly one of the four streams, giving strict per-level
 *   separation (the default pino multistream semantics deliver "level
 *   and above" to each stream, which would dump everything into the
 *   debug file). Client logs shipped over the WS `client:log` channel
 *   land in these same files with `service: "client"` and the original
 *   client service name in `clientService`. See SERVICE_MAP.md → log.ts
 *   (BFF) for the full contract.
 *
 * What is NOT wired yet (intentionally, future steps):
 *   - Deepgram TTS as an agent tool call    -> Step 7
 *   - Static file serving                    -> Step 4+
 *   - Login route (cookie set)               -> Step 5
 *   - Widgets (Phase 2)
 */
export interface BuildServerOptions {
  /**
   * The agent service to wire into the routes. If `undefined`, the WS
   * route plugin will defer; call `app.decorate("agentService", svc)`
   * after construction and then `app.ready()` will fire. The agent
   * status route reads from the same decorator.
   */
  agentService?: AgentService;
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const LOG_DIR = join(process.env["HOME"] ?? "/tmp", ".jarvis", "logs");
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* */ }

  const logger = await buildLogger(LOG_DIR);

  const app = await import("fastify").then(({ default: fastify }) =>
    fastify({
      loggerInstance: logger as unknown as FastifyBaseLogger,
    }),
  );

  // --- Plugins -----------------------------------------------------------
  await app.register(import("@fastify/cors"), {
    origin: env.CLIENT_ORIGIN,
    credentials: true,
  });
  await app.register(import("@fastify/cookie"));
  await app.register(import("@fastify/websocket"), {
    // No `options` block — we don't want a global path; the route opts
    // pin `websocket: true` on /ws only.
    options: { maxPayload: 1024 * 1024 },
  });

  // Register the agent service as a Fastify decorator so the route
  // modules can read it without a module-level singleton. The WS route
  // is the only consumer that needs the live instance; the agent status
  // route uses the same accessor.
  if (opts.agentService) {
    app.decorate("agentService", opts.agentService);
  }

  // --- Routes ------------------------------------------------------------
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(weatherRoutes);
  await app.register(agentRoutes);
  await app.register(sttRoutes);
  await app.register(wsRoutes);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    agentService?: AgentService;
  }
}

/**
 * Build the pre-constructed pino instance. The instance fans out to:
 *   - a `pino-pretty` worker in dev / `pino.destination(1)` (stdout JSON)
 *     in prod
 *   - a `levelRouter` Writable that splits each line by `level` into one
 *     of four rotated file streams.
 */
export async function buildBffLogger(): Promise<Logger> {
  const logDir = join(process.env["HOME"] ?? "/tmp", ".jarvis", "logs");
  try { mkdirSync(logDir, { recursive: true }); } catch { /* */ }
  return buildLogger(logDir);
}

async function buildLogger(logDir: string): Promise<Logger> {
  const fileStreams = {
    debug: await pinoRoll({
      file: join(logDir, "bff.debug.log"),
      size: "10m",
      limit: { count: 1 },
      mkdir: true,
      // Compress rotated (.1) files with gzip to keep disk footprint
      // small. The active file stays plain so tail -f still works.
      compress: true,
    }),
    info: await pinoRoll({
      file: join(logDir, "bff.info.log"),
      size: "10m",
      limit: { count: 1 },
      mkdir: true,
      compress: true,
    }),
    warn: await pinoRoll({
      file: join(logDir, "bff.warn.log"),
      size: "10m",
      limit: { count: 1 },
      mkdir: true,
      compress: true,
    }),
    error: await pinoRoll({
      file: join(logDir, "bff.error.log"),
      size: "10m",
      limit: { count: 1 },
      mkdir: true,
      compress: true,
    }),
  };

  // Strict per-level router. pino emits one JSON object per line, so we
  // can decide the destination by reading the `level` numeric field and
  // forwarding the whole line to exactly one stream. Unparseable lines
  // land in error.log so they're never lost.
  const levelRouter: DestinationStream = new Writable({
    write(chunk: Buffer, _enc, callback): void {
      const line = chunk.toString("utf8");
      let lvl: number;
      try {
        lvl = (JSON.parse(line) as { level?: number }).level ?? 50;
      } catch {
        lvl = 50;
      }
      const target =
        lvl >= 50 ? fileStreams.error
        : lvl >= 40 ? fileStreams.warn
        : lvl >= 30 ? fileStreams.info
        : fileStreams.debug;
      target.write(line + "\n");
      callback();
    },
  });

  const streams: Array<{ stream: DestinationStream; level: string }> = [
    { level: "debug", stream: levelRouter },
  ];

  if (env.NODE_ENV === "production") {
    streams.push({ level: "debug", stream: destination(1) });
    return pino({ level: "debug" }, multistream(streams));
  }

  const prettyStream = (await transport({
    target: "pino-pretty",
    options: { colorize: true, destination: 1 },
  })) as unknown as DestinationStream;
  streams.push({ level: "debug", stream: prettyStream });
  return pino({ level: "debug" }, multistream(streams));
}
