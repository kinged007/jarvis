/**
 * Deepgram TTS provider — WebSocket transport.
 *
 * Thin adapter over `voice/tts-ws.ts`. The adapter exists so the
 * queue depends on the `TtsProvider` interface, not on the concrete
 * `createTtsWsSession` factory.
 *
 * The WS session itself is unchanged: it opens a connection, sends
 * a `Speak` frame, receives binary audio frames + a `Flushed` JSON
 * terminator, and exposes a `cancel()` that sends `Close` and tears
 * the socket down.
 */

import type { FastifyBaseLogger } from "fastify";
import {
  createTtsWsSession,
  type TtsWsSession,
} from "../../../voice/tts-ws.js";
import type { TtsProvider, TtsSession } from "../types.js";

export interface DeepgramWsProviderOptions {
  apiKey: string;
  model?: string;
  logger: FastifyBaseLogger;
}

export class DeepgramWsTtsProvider implements TtsProvider {
  readonly name = "deepgram-ws" as const;

  constructor(private readonly opts: DeepgramWsProviderOptions) {}

  start(p: {
    text: string;
    onAudio: (chunk: ArrayBuffer) => void;
    onDone: () => void;
    onError: (err: Error) => void;
  }): TtsSession {
    const session: TtsWsSession = createTtsWsSession({
      apiKey: this.opts.apiKey,
      model: this.opts.model,
      onAudio: p.onAudio,
      onDone: p.onDone,
      onError: p.onError,
      logger: this.opts.logger,
    });
    session.start(p.text);
    return wrapWsSession(session);
  }
}

function wrapWsSession(s: TtsWsSession): TtsSession {
  return {
    cancel: () => s.cancel(),
  };
}
