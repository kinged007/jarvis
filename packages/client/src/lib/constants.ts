/**
 * Client-side constants. Keep these in one place so the spec-mandated
 * timings (follow-up window, refresh intervals) are not duplicated and
 * can be tuned in a single edit.
 *
 * Values reflect the JARVIS spec:
 *   - follow-up window: 5s after TTS ends (CAP-6)
 *   - weather refresh: every 30 min (CAP-14)
 *   - WS reconnect: exponential backoff, capped (NFR: reconnect within 5s)
 */

export const MAX_WIDGETS = 6;
export const FOLLOW_UP_WINDOW_MS = 5_000;

export const WS_RECONNECT_BASE_MS = 1_000;
export const WS_RECONNECT_MAX_MS = 30_000;

export const WEATHER_REFRESH_MS = 1_800_000; // 30 minutes
