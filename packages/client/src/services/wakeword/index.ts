/**
 * Wakeword service — public surface.
 *
 * The default export is the openWakeWord-based implementation.
 * Falls back to the stub if openWakeWord is disabled via env or
 * if the model files are unavailable.
 */

import { createWakewordService } from "./service";
import type { WakewordService } from "./types";

export const wakewordService: WakewordService = createWakewordService();
export type { WakewordService, WakewordState, WakewordListener } from "./types";
