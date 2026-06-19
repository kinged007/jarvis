/**
 * Deepgram STT provider — implements the `SttProvider` contract.
 *
 * This is the original `voice/deepgram-stt.ts` exposed under the new
 * `services/stt/providers/` path. The public function is unchanged:
 * `createDeepgramSttSession({ apiKey, logger, callbacks })`.
 *
 * The provider is constructed once at service-init time and shared
 * across every per-socket STT session. Each session is an independent
 * Deepgram WS connection.
 */

import type { FastifyBaseLogger } from "fastify";
import {
  createDeepgramSttSession,
  type DeepgramSttOptions,
  type DeepgramSttSession,
  type DeepgramSttTranscript,
} from "../../../voice/deepgram-stt.js";
import type {
  SttProvider,
  SttSession,
  SttTranscriptCallback,
  SttErrorCallback,
  SttCloseCallback,
  SttTranscript,
} from "../types.js";

export class DeepgramSttProvider implements SttProvider {
  readonly name = "deepgram";

  openSession(opts: {
    apiKey: string;
    logger: FastifyBaseLogger;
    onTranscript: SttTranscriptCallback;
    onError: SttErrorCallback;
    onClose: SttCloseCallback;
  }): SttSession {
    const session = createDeepgramSttSession({
      apiKey: opts.apiKey,
      logger: opts.logger,
      onTranscript: (t: DeepgramSttTranscript) => {
        const out: SttTranscript = {
          text: t.text,
          isFinal: t.isFinal,
          speechFinal: t.speechFinal,
        };
        opts.onTranscript(out);
      },
      onError: opts.onError,
      onClose: opts.onClose,
    });
    return wrapSession(session);
  }
}

function wrapSession(s: DeepgramSttSession): SttSession {
  return {
    sendChunk: (data) => s.sendChunk(data),
    finish: () => s.finish(),
    close: () => s.close(),
    isClosed: () => s.isClosed(),
  };
}
