import type { FastifyInstance } from "fastify";
import { jwtPreHandler } from "../middleware/jwt-verify.js";

/**
 * /api/agent/* — protected agent introspection routes.
 *
 * Step 2: status only. Future steps will add control surfaces (cancel,
 * session list) behind the same JWT preHandler.
 */
export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/agent/status",
    { preHandler: jwtPreHandler },
    async (request) => {
      const agent = app.agentService;
      if (!agent) {
        return { user: request.user?.sub ?? null, agent: null, error: "agent not initialised" };
      }
      const status = agent.getStatus();
      return {
        user: request.user?.sub ?? null,
        agent: status,
      };
    },
  );
}
