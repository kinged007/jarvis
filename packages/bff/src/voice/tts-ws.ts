import type { FastifyBaseLogger } from "fastify";
import WebSocket from "ws";

export interface TtsWsSession {
  start(text: string): void;
  cancel(): void;
}

export function createTtsWsSession(opts: {
  apiKey: string;
  model?: string;
  onAudio: (chunk: ArrayBuffer) => void;
  onDone: () => void;
  onError: (err: Error) => void;
  logger?: FastifyBaseLogger;
}): TtsWsSession {
  const model = opts.model ?? "aura-zeus-en";
  let socket: WebSocket | null = null;
  let done = false;

  const start = (text: string): void => {
    const params = new URLSearchParams({
      encoding: "linear16",
      sample_rate: "24000",
      model,
    });
    const url = `wss://api.deepgram.com/v1/speak?${params.toString()}`;

    socket = new WebSocket(url, {
      headers: {
        Authorization: `Token ${opts.apiKey}`,
      },
    });

    socket.on("open", () => {
      opts.logger?.debug({ len: text.length }, "tts-ws: connected, sending Speak");
      socket!.send(JSON.stringify({ type: "Speak", text }));
    });

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as string);
      if (!isBinary) {
        try {
          const msg = JSON.parse(buf.toString());
          if (msg.type === "Flushed") {
            opts.logger?.debug("tts-ws: received Flushed");
            done = true;
            opts.onDone();
            socket?.send(JSON.stringify({ type: "Close" }));
          }
        } catch {
          opts.logger?.warn({ data: buf.toString().slice(0, 200) }, "tts-ws: unparseable text message");
        }
        return;
      }
      const ab = new ArrayBuffer(buf.byteLength);
      new Uint8Array(ab).set(buf);
      opts.onAudio(ab);
    });

    socket.on("error", (err: Error) => {
      opts.logger?.warn({ err: err.message }, "tts-ws: socket error");
      if (!done) {
        done = true;
        opts.onError(err);
      }
    });

    socket.on("close", (code: number, reasonBuf: Buffer) => {
      opts.logger?.debug({ code, reason: reasonBuf.toString().slice(0, 100) }, "tts-ws: socket closed");
      if (!done) {
        done = true;
        opts.onDone();
      }
    });
  };

  const cancel = (): void => {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      try {
        socket.send(JSON.stringify({ type: "Close" }));
        socket.close();
      } catch {
        // ignore
      }
    }
    socket = null;
  };

  return { start, cancel };
}
