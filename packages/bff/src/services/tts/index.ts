/**
 * BFF TTS service — public surface.
 *
 * The default implementation (`createBffTtsService`) is a serialising
 * queue with a primary WS provider and a REST fallback, both
 * Deepgram-backed. To run a single-provider setup, or a different
 * vendor, pass `primaryProvider` and/or `fallbackProvider` overrides
 * to the factory.
 *
 * Consumers depend on the `TtsService` interface, never on the
 * concrete queue. Today the only consumer is the agent event
 * bridge in `services/agent/bridge.ts`.
 */

export { createBffTtsService } from "./queue.js";
export type {
  CreateBffTtsServiceOptions,
  TtsQueueItem,
} from "./queue.js";
export type {
  TtsService,
  TtsProvider,
  TtsSession,
  TtsUtteranceKind,
} from "./types.js";
export { DeepgramWsTtsProvider } from "./providers/ws.js";
export { DeepgramRestTtsProvider } from "./providers/rest.js";
