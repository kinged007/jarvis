/**
 * Auth store — Step 5: auth flow.
 *
 * Owns the JWT bootstrap flow (CAP-12). The BFF sets an httpOnly
 * session cookie on a successful login and verifies it on every
 * subsequent request — JS never sees the raw token, so XSS exposure
 * is bounded by what the cookie can do (which is: nothing to other
 * origins).
 *
 *   - login(password) — POST /api/auth/login. On 200 the BFF has set
 *     the httpOnly cookie via Set-Cookie; we just flip
 *     `isAuthenticated` and stash whatever user payload comes back.
 *   - checkSession() — GET /api/auth/whoami to rehydrate from cookie
 *     on reload. Called once from App.tsx on mount.
 *   - logout() — POST /api/auth/logout. The endpoint may not be wired
 *     yet in the BFF; in that case the network call 404s and we
 *     swallow it, because the local-state clear is the source of
 *     truth for "logged out" on the client.
 *
 * The optional `token` field on the login response is captured for
 * future use (e.g. sub-protocol WS auth when the cookie is blocked by
 * an intermediate proxy). The colocated deployment doesn't need it —
 * the cookie rides on the WS upgrade automatically.
 */

import { create } from "zustand";
import { DEFAULT_CLIENT_CONFIG } from "@jarvis/shared";

export type AuthStatus = "idle" | "loading" | "success" | "error";

export interface AuthUser {
  id: string;
  name?: string;
}

export interface AuthState {
  isAuthenticated: boolean;
  token: string | null;
  user: AuthUser | null;
  status: AuthStatus;
  error: string | null;
}

export interface AuthActions {
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  reset: () => void;
}

export type AuthStore = AuthState & AuthActions;

const BFF_ORIGIN = DEFAULT_CLIENT_CONFIG.bffOrigin;

const initialState: AuthState = {
  isAuthenticated: false,
  token: null,
  user: null,
  status: "idle",
  error: null,
};

interface LoginResponse {
  token?: string;
  user?: AuthUser;
}

interface WhoamiResponse {
  authenticated: boolean;
  /**
   * BFF `/api/auth/whoami` returns the JWT subject as a plain string
   * (see `routes/auth.ts`). We also tolerate the richer object shapes
   * that an upstream identity provider might surface, so a future
   * swap to OIDC/Auth0 etc. is a wire-format change, not a client
   * rewrite.
   */
  user?: string | AuthUser | { sub?: string } | null;
}

export const useAuthStore = create<AuthStore>((set) => ({
  ...initialState,

  async login(password) {
    set({ status: "loading", error: null });
    try {
      const res = await fetch(`${BFF_ORIGIN}/api/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        const message =
          (detail as { error?: { message?: string } }).error?.message ??
          `Login failed (${res.status})`;
        set({ status: "error", error: message, isAuthenticated: false });
        return;
      }
      const body = (await res.json()) as LoginResponse;
      set({
        status: "success",
        isAuthenticated: true,
        token: body.token ?? null,
        user: body.user ?? null,
        error: null,
      });
    } catch (err) {
      set({
        status: "error",
        error: (err as Error).message || "Network error",
        isAuthenticated: false,
      });
    }
  },

  async logout() {
    set({ status: "loading", error: null });
    try {
      await fetch(`${BFF_ORIGIN}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // Swallow network errors on logout — local clear is the priority.
    }
    set({ ...initialState });
  },

  async checkSession() {
    set({ status: "loading" });
    try {
      const res = await fetch(`${BFF_ORIGIN}/api/auth/whoami`, {
        credentials: "include",
      });
      if (!res.ok) {
        set({ ...initialState, status: "idle" });
        return;
      }
      const body = (await res.json()) as WhoamiResponse;
      if (!body.authenticated) {
        set({ ...initialState, status: "idle" });
        return;
      }
      const rawUser = body.user;
      let user: AuthUser | null = null;
      if (typeof rawUser === "string" && rawUser.length > 0) {
        // BFF shapes whoami as { authenticated, user: <sub> } (a string).
        user = { id: rawUser };
      } else if (rawUser && typeof rawUser === "object" && "sub" in rawUser) {
        const sub = (rawUser as { sub?: unknown }).sub;
        if (typeof sub === "string" && sub.length > 0) {
          user = { id: sub };
        }
      } else if (rawUser && typeof rawUser === "object" && "id" in rawUser) {
        user = rawUser as AuthUser;
      }
      set({
        status: "success",
        isAuthenticated: true,
        user,
        token: null,
        error: null,
      });
    } catch (err) {
      set({
        status: "error",
        error: (err as Error).message || "Network error",
        isAuthenticated: false,
      });
    }
  },

  reset() {
    set({ ...initialState });
  },
}));
