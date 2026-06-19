/**
 * Shared runtime config constants. Env values that are used by both the
 * client and the BFF (after a `/api/config` fetch from the BFF) live here so
 * the wire format stays typed.
 */
export interface ClientRuntimeConfig {
    /** BFF origin (no trailing slash). */
    bffOrigin: string;
    /** Wake word (default: "jarvis"). Configurable per deployment. */
    wakeWord: string;
    /** Seconds the assistant stays active for follow-up commands (CAP-6). */
    followUpWindowSec: number;
    /** Default weather coordinates for the permanent weather widget (CAP-14). */
    weather: {
        lat: number;
        lon: number;
        label: string;
    };
}
export declare const DEFAULT_CLIENT_CONFIG: ClientRuntimeConfig;
//# sourceMappingURL=config.d.ts.map