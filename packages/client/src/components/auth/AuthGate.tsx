/**
 * AuthGate — Step 5: full-viewport auth overlay (CAP-12).
 *
 * Owns the seam between "anonymous browser" and "authenticated
 * dashboard". Children (the dashboard) are ALWAYS mounted so:
 *   - the brain visualization is visible behind the gate as a teaser
 *     (DESIGN.md: "Brain visualization visible behind the gate in
 *     idle state as a teaser"),
 *   - WS hooks and audio contexts warm up while the user is typing
 *     the password,
 *   - the fade-out transition is a true cross-fade rather than a
 *     mount-then-render flash.
 *
 * The gate itself has three states driven by `useAuthStore`:
 *
 *   1. `checking`  — `status === "loading"` and !isAuthenticated.
 *                    Renders a pulsing brain skeleton (no form yet).
 *                    Resolves when /api/auth/whoami comes back.
 *   2. `locked`    — !isAuthenticated. Renders <LoginForm />.
 *   3. `unlocked`  — isAuthenticated. Overlay fades out (500ms,
 *                    AnimatePresence exit) and unmounts.
 *
 * The actual session bootstrap (`checkSession()`) is fired by the
 * parent (App.tsx) on mount; this component is purely presentational
 * and re-renders on store changes.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useAuthStore } from "../../state/authStore";
import { LoginForm } from "./LoginForm";
import "./AuthGate.css";

const FADE_OUT_MS = 500;

export interface AuthGateProps {
  children: React.ReactNode;
}

export function AuthGate({ children }: AuthGateProps): React.JSX.Element {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const status = useAuthStore((s) => s.status);

  const isChecking = status === "loading" && !isAuthenticated;
  const showGate = !isAuthenticated;

  return (
    <div className="jarvis-authgate">
      {/* Dashboard always mounted so brain teaser + warmup happen behind gate. */}
      <div className="jarvis-authgate__content" aria-hidden={showGate}>
        {children}
      </div>

      <AnimatePresence>
        {showGate && (
          <motion.div
            key="auth-overlay"
            className="jarvis-authgate__overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: FADE_OUT_MS / 1000, ease: "easeOut" }}
            role="dialog"
            aria-modal="true"
            aria-label="JARVIS authentication"
          >
            {/* Decorative brain teaser behind the card — pure CSS, mirrors
                the dashboard's brain so it reads as the "real" one. */}
            <div
              className="jarvis-authgate__brain jarvis-brain jarvis-brain--idle"
              aria-hidden="true"
            >
              <div className="jarvis-brain__pulse" />
            </div>

            <AnimatePresence mode="wait" initial={false}>
              {isChecking ? (
                <motion.div
                  key="checking"
                  className="jarvis-authgate__checking"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <p className="jarvis-authgate__checking-label">
                    checking session…
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  key="login"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.25, ease: "easeOut" }}
                >
                  <LoginForm />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
