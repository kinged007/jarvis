/**
 * BFF STT service — typed contract.
 *
 * The STT service on the BFF side is a thin proxy over a third-party
 * STT provider (Deepgram today). One `SttSession` is opened per
 * browser WebSocket connection for the duration of a single utterance;
 * the session forwards audio chunks to the provider and emits
 * transcripts back to the WS router.
 *
 * The service is constructed once with the API key and the broadcast
 * primitive from `client-registry.ts`. The router owns the per-socket
 * session lifecycle (`openSession` / `closeSession`).
 *
 * Adding a new provider (e.g. AssemblyAI, Whisper) means writing a
 * new file under `services/stt/providers/` that implements
 * `SttProvider`, and pointing `services/stt/index.ts` at it. The
 * router and the WS handler don't change.
 */

import type { FastifyBaseLogger } from "fastify";
import type { ServerMessage } from "@jarvis/shared";

/** Transcript shape produced by a provider. */
export interface SttTranscript {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
}

/** Callback signatures for the session lifecycle. */
export type SttTranscriptCallback = (t: SttTranscript) => void;
export type SttErrorCallback = (err: Error) => void;
export type SttCloseCallback = (code: number, reason: string) => void;

/**
 * One live STT session. The router holds one per browser socket; the
 * session is opened on the first voice:chunk and closed on voice:end
 * or on socket disconnect.
 */
export interface SttSession {
  /** Send a chunk of browser audio. Safe to call after `close()` (no-op). */
  sendChunk(data: Buffer): void;
  /** Signal end of utterance. Sends a JSON Close frame and resolves on EOS. */
  finish(): Promise<void>;
  /** Force-close the upstream WS. Idempotent. */
  close(): void;
  /** True once `close()` or `finish()` has been called. */
  isClosed(): boolean;
}

/** A pluggable STT provider. The default is Deepgram. */
export interface SttProvider {
  readonly name: string;
  openSession(opts: {
    apiKey: string;
    logger: FastifyBaseLogger;
    onTranscript: SttTranscriptCallback;
    onError: SttErrorCallback;
    onClose: SttCloseCallback;
  }): SttSession;
}

/** BFF-wide STT service surface. */
export interface SttService {
  /**
   * Open a per-socket STT session. The router calls this lazily on the
   * first voice:chunk message. Returns null if no provider is configured
   * (missing API key, etc.) — the router treats that as a no-op session.
   */
  openSession(opts: {
    userId: string;
    onTranscript: SttTranscriptCallback;
    onError: SttErrorCallback;
    onClose: SttCloseCallback;
  }): SttSession | null;
  /** Service-level log helper for the WS handler. */
  log(): { info: Function; warn: Function; error: Function; debug: Function };
}

/** Internal: turn an STT transcript into a `stt:transcript` ServerMessage. */
export function sttTranscriptToServerMessage(
  t: SttTranscript,
): Extract<ServerMessage, { type: "stt:transcript" }> {
  return {
    type: "stt:transcript",
    text: t.text,
    interim: !t.isFinal,
  };
}
