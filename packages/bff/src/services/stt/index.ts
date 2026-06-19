/**
 * BFF STT service — public surface.
 *
 * The default implementation wraps the Deepgram provider. To swap
 * providers, replace the `provider` field at construction.
 *
 * The service holds no per-socket state — the router owns the
 * `SttSession` it gets back from `openSession`. The service's only
 * job is to plumb the API key + a tagged logger into the provider
 * and return whatever session the provider hands back.
 */

import type { FastifyBaseLogger } from "fastify";
import { makeServiceLog } from "../log.js";
import { DeepgramSttProvider } from "./providers/deepgram.js";
import type {
  SttService,
  SttSession,
  SttProvider,
  SttTranscriptCallback,
  SttErrorCallback,
  SttCloseCallback,
} from "./types.js";

export interface BffSttServiceOptions {
  apiKey: string;
  logger: FastifyBaseLogger;
  /** Override for tests. Defaults to `DeepgramSttProvider`. */
  provider?: SttProvider;
}

export function createBffSttService(opts: BffSttServiceOptions): SttService {
  const log = makeServiceLog("stt", opts.logger);
  const provider = opts.provider ?? new DeepgramSttProvider();

  return {
    openSession({
      userId,
      onTranscript,
      onError,
      onClose,
    }: {
      userId: string;
      onTranscript: SttTranscriptCallback;
      onError: SttErrorCallback;
      onClose: SttCloseCallback;
    }): SttSession | null {
      if (!opts.apiKey) {
        log.warn({ userId }, "DEEPGRAM_API_KEY not set — cannot start stt session");
        return null;
      }
      log.info({ userId, provider: provider.name }, "opening stt session");
      return provider.openSession({
        apiKey: opts.apiKey,
        logger: opts.logger.child({ service: "stt" }),
        onTranscript,
        onError,
        onClose,
      });
    },
    log() {
      return log;
    },
  };
}

export type {
  SttService,
  SttSession,
  SttProvider,
  SttTranscript,
} from "./types.js";
