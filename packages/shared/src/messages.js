/**
 * WebSocket protocol contract between the JARVIS client and the BFF.
 *
 * Single channel, typed discriminated union on `type`. Both sides MUST
 * import from this file — protocol drift is the #1 risk to avoid.
 *
 * Naming: `domain:action` (e.g. `agent:response`, `stt:transcript`).
 * Field names: camelCase. Dates: ISO 8601 strings.
 */
export {};
//# sourceMappingURL=messages.js.map