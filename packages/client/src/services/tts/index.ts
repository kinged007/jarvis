/**
 * Client TTS service — public surface + process-wide singleton.
 *
 * The singleton (`ttsService`) is shared across every consumer
 * (WS dispatch, audio playback hook, level visualizer, App).
 * There is only ever one JARVIS session per page; multiple
 * instances would double-decode the same audio.
 */

import { createClientTtsService } from "./service.js";
import type { TtsService } from "./types.js";

export const ttsService: TtsService = createClientTtsService();

export type {
  TtsService,
  TtsUtteranceKind,
  TtsLevelCallback,
  Unsubscribe,
} from "./types.js";
