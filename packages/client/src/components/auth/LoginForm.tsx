/**
 * LoginForm — password-only single-user auth card (CAP-12).
 *
 * Layout: 400×280 card on `bg.deep` with `shapes.glow-soft`. Title in
 * neon cyan, password input with dim→cyan border on focus, "Enter"
 * button with neon border. On wrong password the card shakes for 300ms
 * (CSS class toggle) and the error text in `neon.red` appears.
 *
 * Submits on Enter key OR button click. Calls `useAuthStore.login`.
 * While `status === "loading"` the input + button are disabled and a
 * subtle spinner replaces the button label.
 *
 * Styling lives in `index.css` (`.jarvis-auth-card`, `.jarvis-auth-input`,
 * `.jarvis-auth-button`, `.jarvis-auth-shake`, etc.) so the visual
 * contract is one search away.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuthStore } from "../../state/authStore";

const SHAKE_MS = 300;

export interface LoginFormProps {
  /** Optional className for the outer card (e.g. for animation hooks). */
  className?: string;
}

export function LoginForm({ className }: LoginFormProps): React.JSX.Element {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [focused, setFocused] = useState(false);
  const [shaking, setShaking] = useState(false);
  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const login = useAuthStore((s) => s.login);

  const submitting = status === "loading";

  // Trigger the shake animation whenever a *new* error appears after a
  // submit attempt. We key off `error` + a transition from non-error
  // → error so the same error re-render doesn't restart the animation.
  const prevErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (error && error !== prevErrorRef.current) {
      prevErrorRef.current = error;
      setShaking(true);
      if (shakeTimerRef.current !== null) clearTimeout(shakeTimerRef.current);
      shakeTimerRef.current = setTimeout(() => setShaking(false), SHAKE_MS);
    } else if (!error) {
      prevErrorRef.current = null;
    }
    return () => {
      if (shakeTimerRef.current !== null) {
        clearTimeout(shakeTimerRef.current);
        shakeTimerRef.current = null;
      }
    };
  }, [error]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    if (password.length === 0) return;
    await login(password);
  }

  const cardClasses = [
    "jarvis-auth-card",
    shaking ? "jarvis-auth-shake" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <form
      className={cardClasses}
      onSubmit={handleSubmit}
      noValidate
      aria-label="JARVIS login"
    >
      <h1 className="jarvis-auth-title">JARVIS</h1>

      <label className="jarvis-auth-field">
        <span className="jarvis-auth-label">PASSWORD</span>
        <div
          className={`jarvis-auth-inputwrap${
            focused ? " jarvis-auth-inputwrap--focus" : ""
          }${error ? " jarvis-auth-inputwrap--error" : ""}`}
        >
          <input
            className="jarvis-auth-input"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="••••••••"
            autoComplete="current-password"
            autoFocus
            disabled={submitting}
            aria-label="Password"
            aria-invalid={Boolean(error)}
          />
          <button
            type="button"
            className="jarvis-auth-toggle"
            onClick={() => setShowPassword((s) => !s)}
            tabIndex={-1}
            aria-label={showPassword ? "Hide password" : "Show password"}
            disabled={submitting}
          >
            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
        {error && (
          <span className="jarvis-auth-error" role="alert">
            {error}
          </span>
        )}
      </label>

      <button
        type="submit"
        className="jarvis-auth-button"
        disabled={submitting || password.length === 0}
        aria-label="Submit password"
      >
        {submitting ? <Spinner /> : "Enter"}
      </button>
    </form>
  );
}

function EyeIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-6.5 0-10-7-10-7a19.5 19.5 0 0 1 4.22-5.19" />
      <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c6.5 0 10 7 10 7a19.86 19.86 0 0 1-3.17 4.19" />
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}

function Spinner(): React.JSX.Element {
  return (
    <span className="jarvis-auth-spinner" aria-hidden="true">
      <span key="s1" />
      <span key="s2" />
      <span key="s3" />
    </span>
  );
}
