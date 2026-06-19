import { config } from "dotenv";

const envResult = config({ path: ["../../.env", ".env"], quiet: true });
if (envResult.error) {
  // .env is optional in dev — env.ts falls back to dev defaults.
}

/**
 * Centralised env access. Throws fast at boot if anything required is missing.
 * Mirrors the keys declared in .env.example.
 */
function readEnv(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error("Missing required env var: " + key);
}

function readNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error("Env var " + key + " must be a number, got: " + raw);
  return n;
}

export const env = {
  NODE_ENV: process.env["NODE_ENV"] ?? "development",
  PORT: readNumber("PORT", 3001),
  CLIENT_ORIGIN: readEnv("CLIENT_ORIGIN", "http://localhost:5174"),

  JARVIS_PASSWORD: readEnv("JARVIS_PASSWORD", "dev-only-password"),
  JWT_SECRET: readEnv("JWT_SECRET", "dev-only-jwt-secret-change-me"),
  JWT_TTL_SEC: readNumber("JWT_TTL_SEC", 60 * 60 * 6), // 6h

  DEEPGRAM_API_KEY: process.env["DEEPGRAM_API_KEY"] ?? "",
  DEEPGRAM_SPEAK_MODEL: process.env["DEEPGRAM_SPEAK_MODEL"] ?? "aura-zeus-en",
  TTS_COMMENTARY_ENABLED: process.env["TTS_COMMENTARY_ENABLED"] !== "false",
  /** Word-count threshold above which a response triggers the long-response
   *  modal + TTS trimming. Default 100 words. */
  LONG_RESPONSE_THRESHOLD_WORDS: readNumber("LONG_RESPONSE_THRESHOLD_WORDS", 100),
  WEATHER_API_KEY: process.env["WEATHER_API_KEY"] ?? "",

  // Hermes API server (replaces the old sidecar/JSONL transport).
  // The BFF spawns `hermes -p <HERMES_PROFILE> gateway run` and talks to
  // the API server at HERMES_API_URL with HERMES_API_KEY as a Bearer token.
  HERMES_API_URL: process.env["HERMES_API_URL"] ?? "http://127.0.0.1:8642",
  HERMES_API_KEY: process.env["HERMES_API_KEY"] ?? "",
  HERMES_PROFILE: process.env["HERMES_PROFILE"] ?? "jarvis",
  HERMES_HOME: process.env["HERMES_HOME"] ?? "/home/josh/.hermes/profiles/jarvis",
  HERMES_CMD: process.env["HERMES_CMD"] ?? "hermes",
  HERMES_HEALTH_POLL_MS: readNumber("HERMES_HEALTH_POLL_MS", 5_000),
  HERMES_HEALTH_DEADLINE_MS: readNumber("HERMES_HEALTH_DEADLINE_MS", 15_000),
  HERMES_AUTH_BACKOFF_MS: readNumber("HERMES_AUTH_BACKOFF_MS", 30_000),
} as const;

export type Env = typeof env;
