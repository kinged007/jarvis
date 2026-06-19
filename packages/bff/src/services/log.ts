/**
 * Service-tagged logger for the BFF.
 *
 * Every BFF service (stt, tts, agent, ws, …) gets its own logger with
 * a stable `service` field on every entry. This lets pino ship JSON
 * logs that group cleanly per service in the aggregator.
 *
 * The interface is intentionally the same shape as the Fastify base
 * logger, so any consumer that already accepts `FastifyBaseLogger` can
 * be passed a service logger with no other changes.
 *
 * Usage:
 *   const log = makeServiceLog("stt", app.log);
 *   log.info({ userId }, "session opened");
 *   // → {"level":"info","service":"stt","userId":"…","msg":"session opened"}
 */

import type { FastifyBaseLogger } from "fastify";

export type ServiceLog = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
  debug: (obj: Record<string, unknown>, msg?: string) => void;
};

export function makeServiceLog(
  service: string,
  base: FastifyBaseLogger | undefined,
): ServiceLog {
  const tag = { service };
  if (!base) {
    return {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  }
  return {
    info: (obj, msg) => base.info({ ...tag, ...obj }, msg),
    warn: (obj, msg) => base.warn({ ...tag, ...obj }, msg),
    error: (obj, msg) => base.error({ ...tag, ...obj }, msg),
    debug: (obj, msg) => base.debug({ ...tag, ...obj }, msg),
  };
}
