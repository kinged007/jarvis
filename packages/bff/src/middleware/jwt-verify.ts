import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { env } from "../env.js";

/**
 * JWT auth middleware — Step 2.
 *
 * Two entry points:
 *   - `jwtPreHandler`   : Fastify preHandler hook for REST routes. Reads the
 *                         httpOnly cookie set at login (Step 5), verifies it,
 *                         attaches the decoded payload to `request.user`.
 *   - `verifyWsUpgrade` : Used during the WebSocket upgrade (Step 3). Browsers
 *                         include httpOnly cookies on the upgrade request, so
 *                         we parse the raw `Cookie` header and verify the JWT
 *                         before allowing the WS connection through.
 *
 * The actual login route (bcrypt compare, cookie set) lands in Step 5; here
 * we only enforce that any request marked protected carries a valid signed
 * token. Decoding never throws — invalid/expired tokens return null and the
 * preHandler responds 401.
 *
 * Sliding expiration: `refreshSessionCookie` re-signs a fresh JWT and rewrites
 * the `jarvis_session` cookie. The whoami REST route and the WS upgrade
 * preHandler call it on every successful authentication so the 6h idle clock
 * is reset on any authenticated request.
 */

export const JWT_COOKIE_NAME = "jarvis_session";

/** Decoded JWT payload. Single-user system — `sub` is the owner. */
export interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by `jwtPreHandler` on protected routes. */
    user?: JwtPayload;
  }
}

/**
 * Minimal surface needed to set the session cookie. Lets the helper work
 * with both a real `FastifyReply` (REST routes) and any object exposing
 * `setCookie` — which is what the WS upgrade preHandler gets handed by
 * @fastify/websocket before the 101 handshake completes.
 */
type CookieSetter = Pick<FastifyReply, "setCookie">;

/**
 * Verify a JWT string against the configured secret. Never throws — returns
 * null on any failure (bad signature, expired, malformed, wrong issuer...).
 */
export function verifyJwt(token: string | undefined | null): JwtPayload | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ["HS256"],
    });
    if (typeof decoded !== "object" || decoded === null) return null;
    const payload = decoded as Record<string, unknown>;
    if (typeof payload["sub"] !== "string") return null;
    if (typeof payload["iat"] !== "number") return null;
    if (typeof payload["exp"] !== "number") return null;
    return {
      sub: payload["sub"],
      iat: payload["iat"],
      exp: payload["exp"],
    };
  } catch {
    return null;
  }
}

/**
 * Fastify preHandler: read JWT from httpOnly cookie, verify, attach payload
 * to `request.user`. Responds 401 on failure.
 */
export const jwtPreHandler: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const token = request.cookies[JWT_COOKIE_NAME];
  const payload = verifyJwt(token);
  if (!payload) {
    await reply.code(401).send({
      error: { code: "unauthorized", message: "Missing or invalid session token" },
    });
    return;
  }
  request.user = payload;
};

/**
 * Parse a raw `Cookie` header into a flat map. Minimal — only what we need
 * for the WS upgrade path. Returns empty string for missing values, which
 * `verifyJwt` will then reject.
 */
export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

/**
 * Verify a JWT presented during a WebSocket upgrade. Browsers include the
 * httpOnly session cookie on the upgrade request automatically, so this is
 * the only token source we honour on the WS path.
 *
 * Returns the decoded payload on success, null on failure. The WS handler is
 * responsible for closing the socket with 1008 (policy violation) on null.
 */
export function verifyWsUpgrade(req: {
  headers: { cookie?: string | undefined };
}): JwtPayload | null {
  const cookies = parseCookieHeader(req.headers.cookie);
  return verifyJwt(cookies[JWT_COOKIE_NAME]);
}

/**
 * Sign a fresh JWT for `payload.sub` and write it back as the
 * `jarvis_session` cookie. Used to implement sliding expiration: any
 * authenticated request resets the 6h idle clock.
 *
 * Cookie attributes mirror the ones set at login time so the browser treats
 * the refresh identically to the original issuance.
 */
export function refreshSessionCookie(
  reply: CookieSetter,
  payload: Pick<JwtPayload, "sub">,
): void {
  const token = jwt.sign({ sub: payload.sub }, env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: env.JWT_TTL_SEC,
  });
  reply.setCookie(JWT_COOKIE_NAME, token, {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    maxAge: env.JWT_TTL_SEC,
  });
}

/**
 * Pre-handler for the WebSocket upgrade. Verifies the session cookie,
 * refreshes it so the 6h clock is reset, and attaches the payload to
 * `request.user` for the route handler to consume. On failure the reply is
 * sent with 401 — @fastify/websocket short-circuits the upgrade in that
 * case, so the socket is never opened.
 */
export const wsAuthPreHandler: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const cookies = parseCookieHeader(request.headers.cookie);
  const payload = verifyJwt(cookies[JWT_COOKIE_NAME]);
  if (!payload) {
    await reply.code(401).send({
      error: { code: "unauthorized", message: "Missing or invalid session token" },
    });
    return;
  }
  request.user = payload;
  refreshSessionCookie(reply, payload);
};
