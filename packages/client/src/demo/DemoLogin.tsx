import { useState, type FormEvent } from "react";
import { useAuthStore } from "../state/authStore";

const BFF_ORIGIN = `${window.location.protocol}//${window.location.hostname}:3001`;

export function DemoLogin() {
  const authError = useAuthStore((s) => s.error);
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || loggingIn) return;
    setLoggingIn(true);
    setLoginError(null);
    try {
      const res = await fetch(`${BFF_ORIGIN}/api/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        setLoginError(detail?.error?.message ?? `Login failed (${res.status})`);
        return;
      }
      useAuthStore.setState({ isAuthenticated: true, status: "success", error: null });
    } catch (err) {
      setLoginError((err as Error).message || "Network error");
    } finally {
      setLoggingIn(false);
    }
  };

  return (
    <div className="demo-shell">
      <h1 className="demo-title">Audio Input Demo</h1>
      <div className="demo-section">
        <div className="demo-section-title">Login Required</div>
        <form onSubmit={(e) => void handleLogin(e)} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            disabled={loggingIn}
            style={{
              flex: 1, padding: "0.5rem", border: "1px solid #2a2a3e", borderRadius: "0.375rem",
              background: "#12121c", color: "#e0e0e0", fontSize: "0.8rem", fontFamily: "inherit",
            }}
          />
          <button type="submit" className="demo-mode-btn" disabled={loggingIn || !password}>
            {loggingIn ? "..." : "Login"}
          </button>
        </form>
        {(loginError || authError) && (
          <div style={{ color: "#ef4444", fontSize: "0.7rem", marginTop: "0.5rem" }}>
            {loginError || authError}
          </div>
        )}
      </div>
    </div>
  );
}
