import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../env.js";
import {
  jwtPreHandler,
  refreshSessionCookie,
} from "../middleware/jwt-verify.js";

/**
 * /api/auth/* — login, logout, whoami.
 *
 * Password verification: if the stored JARVIS_PASSWORD looks like a bcrypt
 * hash (starts with "$2"), we use bcrypt.compare. Otherwise (plain text,
 * useful for dev), we do a direct string comparison. In production always
 * set a bcrypt hash.
 */
async function verifyPassword(plain: string): Promise<boolean> {
  const stored = env.JARVIS_PASSWORD;
  if (stored.startsWith("$2")) {
    return bcrypt.compare(plain, stored);
  }
  // Plain-text fallback for dev convenience
  return plain === stored;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/auth/login — password → JWT cookie
  app.post("/api/auth/login", async (request, reply) => {
    const { password } = request.body as { password?: string } ?? {};

    if (!password || typeof password !== "string") {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "Password is required" },
      });
    }

    const valid = await verifyPassword(password);
    if (!valid) {
      return reply.status(401).send({
        error: { code: "UNAUTHORIZED", message: "Invalid password" },
      });
    }

    const token = jwt.sign({ sub: "owner" }, env.JWT_SECRET, {
      algorithm: "HS256",
      expiresIn: env.JWT_TTL_SEC,
    });

    reply.setCookie("jarvis_session", token, {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      maxAge: env.JWT_TTL_SEC,
    });

    return { authenticated: true, user: "owner" };
  });

  // POST /api/auth/logout — clear cookie
  app.post("/api/auth/logout", async (_request, reply) => {
    reply.clearCookie("jarvis_session", { path: "/" });
    return { authenticated: false };
  });

  // GET /api/auth/whoami — verify existing session. On success the JWT
  // cookie is re-issued with a fresh 6h expiry, so any authenticated
  // request to this endpoint (the client polls it on mount/visibility
  // change) keeps the session alive as long as the user is active.
  app.get(
    "/api/auth/whoami",
    { preHandler: jwtPreHandler },
    async (request, reply) => {
      if (request.user) {
        refreshSessionCookie(reply, request.user);
      }
      return {
        authenticated: true,
        user: request.user?.sub ?? null,
      };
    },
  );
}
