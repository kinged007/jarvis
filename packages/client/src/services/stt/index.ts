/**
 * STT service — public surface.
 *
 * The default export is the singleton service. It is constructed once
 * with the WebSocket binary send + end-signal as the wire sinks; the
 * hook layer (`useAudioCapture`) drives the state machine; the
 * dispatcher (`useWebSocket`) calls `emitTranscript` for every
 * incoming `stt:transcript` server message.
 *
 * The sinks are imported from `services/ws/sinks.ts` so the service is
 * always wired — no init function is required. If the WS is not open
 * the sinks drop frames silently (the existing behaviour).
 */

import { createSttService } from "./service";
import { sendBinary, sendMessage } from "../ws/sinks";
import type { SttService } from "./types";

export const sttService: SttService = createSttService({
  chunkSink: sendBinary,
  endSink: () => sendMessage({ type: "voice:end" }),
});

export type { SttService, SttTranscript, SttSessionState } from "./types";
