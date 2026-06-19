import type { FastifyInstance } from "fastify";

/** GET /api/health — liveness probe. Request logging suppressed. */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", { logLevel: "silent" }, async () => ({
    ok: true,
    service: "jarvis-bff",
    uptime: process.uptime(),
    ts: new Date().toISOString(),
  }));
}
