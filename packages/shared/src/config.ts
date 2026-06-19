/**
 * Shared runtime config constants. Env values that are used by both the
 * client and the BFF (after a `/api/config` fetch from the BFF) live here so
 * the wire format stays typed.
 */

export interface ClientRuntimeConfig {
  /** BFF origin (no trailing slash). */
  bffOrigin: string;
  /** Seconds the assistant stays active for follow-up commands (CAP-6). */
  followUpWindowSec: number;
  /** Default weather coordinates for the permanent weather widget (CAP-14). */
  weather: { lat: number; lon: number; label: string };
  /** Seconds of audio to capture before the wakeword moment (pre-roll buffer). */
  wakewordPreRollSec: number;
  /** Milliseconds of silence after wakeword before command recording stops.
   *  Shared between wakeword VAD and push-to-talk STT VAD. */
  wakewordSilenceMs: number;
  /** Auto-start the wakeword service when the BFF and agent are online. */
  wakewordAutoStart: boolean;
}

export const DEFAULT_CLIENT_CONFIG: ClientRuntimeConfig = {
  bffOrigin: "",
  followUpWindowSec: 5,
  weather: { lat: 51.5074, lon: -0.1278, label: "London" },
  wakewordPreRollSec: 2,
  wakewordSilenceMs: 3000,
  wakewordAutoStart: true,
};
