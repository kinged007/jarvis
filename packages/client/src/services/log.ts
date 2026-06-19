/**
 * Service-tagged logger for the JARVIS client.
 *
 * Every service (stt, tts, wakeword, agent, ws) gets a stable handle
 * with `.info() / .warn() / .error() / .system()` methods. Every entry
 * is written to two places:
 *
 *   1. The in-memory rolling log (`useAgentStore.addLogEntry`) which
 *      feeds the LogModal in the UI. Capped at 500 entries; entries
 *      drop off the front as new ones arrive.
 *   2. The BFF, via a `client:log` WS frame on the active socket. The
 *      BFF re-logs each entry through its pino logger so the line lands
 *      in the matching `bff.<level>.log` file under `~/.jarvis/logs/`
 *      (see SERVICES_MAP.md → log.ts (BFF)). The send is best-effort —
 *      if the socket is closed or the send throws, the in-memory entry
 *      still appears in the UI; the file copy is dropped.
 *
 * Two callers existed before this refactor:
 *   1. `useWebSocket` calling `addLogEntry` directly for every server
 *      message type.
 *   2. `useAudioCapture` and `App.tsx` calling `addLogEntry` for
 *      mic-level / command-level events.
 *
 * After this refactor, the call sites use `sttLog.info(...)`,
 * `agentLog.warn(...)`, etc., so the log modal can be filtered by
 * service in a follow-up.
 */

import { useAgentStore, type LogLevel } from "../state/agentStore";
import { sendMessage } from "./ws/sinks";
import type { ClientLogLevel } from "@jarvis/shared";

export type ServiceLog = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  system: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
};

export function makeServiceLog(service: string): ServiceLog {
  const add = (
    inMemoryLevel: LogLevel,
    bffLevel: ClientLogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): void => {
    const mergedMeta = meta ? { service, ...meta } : { service };
    useAgentStore.getState().addLogEntry({
      level: inMemoryLevel,
      message: `[${service}] ${message}`,
      meta: mergedMeta,
    });
    shipToBff(service, bffLevel, message, mergedMeta);
  };
  return {
    info: (m, meta) => add("info", "info", m, meta),
    warn: (m, meta) => add("info", "warn", m, { ...meta, _severity: "warn" }),
    error: (m, meta) => add("error", "error", m, meta),
    system: (m, meta) => add("system", "system", m, meta),
    debug: (m, meta) => add("info", "debug", m, { ...meta, _severity: "debug" }),
  };
}

/**
 * Best-effort ship a single log line to the BFF for disk persistence.
 * Swallows every error — the UI entry is the source of truth, the file
 * copy is opportunistic.
 */
function shipToBff(
  service: string,
  level: ClientLogLevel,
  message: string,
  meta: Record<string, unknown>,
): void {
  try {
    sendMessage({
      type: "client:log",
      level,
      message,
      meta: { service, ...meta },
    });
  } catch {
    // ignore — socket probably closed
  }
}
