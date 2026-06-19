import type { FastifyInstance } from "fastify";

/** Placeholder. Real impl lands in Step 8 (widgets/weather). */
export async function weatherRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/weather", async () => ({
    error: { code: "not_implemented", message: "Weather proxy lands in Step 8" },
  }));
}
