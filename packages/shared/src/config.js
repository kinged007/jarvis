/**
 * Shared runtime config constants. Env values that are used by both the
 * client and the BFF (after a `/api/config` fetch from the BFF) live here so
 * the wire format stays typed.
 */
export const DEFAULT_CLIENT_CONFIG = {
    bffOrigin: "",
    wakeWord: "sugar",
    followUpWindowSec: 5,
    weather: { lat: 51.5074, lon: -0.1278, label: "London" },
};
//# sourceMappingURL=config.js.map