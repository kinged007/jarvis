/**
 * WebSocket protocol contract between the JARVIS client and the BFF.
 *
 * Single channel, typed discriminated union on `type`. Both sides MUST
 * import from this file — protocol drift is the #1 risk to avoid.
 *
 * Naming: `domain:action` (e.g. `agent:response`, `stt:transcript`).
 * Field names: camelCase. Dates: ISO 8601 strings.
 */
/** Periodic liveness ping from the BFF. */
export interface ServerHeartbeat {
    type: "system:heartbeat";
    timestamp: number;
}
/** BFF connection / agent health snapshot. */
export interface ServerStatus {
    type: "system:status";
    connected: boolean;
    uptime: number;
    /** Whether the Hermes agent subprocess is running and ready. */
    agentReady: boolean;
}
/** Mid-execution commentary from the agent (CAP-4). The agent calls a TTS
 *  tool; the BFF forwards the text here so the client can log it before audio
 *  arrives. */
export interface ServerAgentCommentary {
    type: "agent:commentary";
    text: string;
}
/** Final agent response text for the current turn. */
export interface ServerAgentResponse {
    type: "agent:response";
    text: string;
}
/** Agent invoked a tool — log + UI affordance. */
export interface ServerAgentToolCall {
    type: "agent:tool_call";
    tool: string;
    args: Record<string, unknown>;
}
/** Tool finished and produced output. */
export interface ServerAgentToolResult {
    type: "agent:tool_result";
    tool: string;
    output: string;
}
/** Agent wants the user's browser to open a URL (CAP-17). */
export interface ServerAgentBrowserOpen {
    type: "agent:browser_open";
    url: string;
}
/** Streaming STT transcript from Deepgram (via BFF). */
export interface ServerSttTranscript {
    type: "stt:transcript";
    text: string;
    /** True while the utterance is still being recognised. */
    interim: boolean;
}
/** Opens a new TTS utterance with metadata. Sent before the first chunk. */
export interface ServerTtsUtterance {
    type: "tts:utterance";
    id: string;
    kind: "commentary" | "response";
    text: string;
    /**
     * Wire format of the upcoming `tts:audio` frames. The client uses this
     * to (a) pick the right decoder and (b) warn if the BFF ever sends
     * something other than what the contract promises.
     */
    format: {
        encoding: "linear16";
        sampleRate: 24_000;
        channels: 1;
        bitDepth: 16;
        chunkBytes: number;
    };
}
/** TTS audio chunk (raw mp3/pcm bytes). Belongs to the most recently opened
 *  utterance that has not yet received a `tts:utterance_end`. The client
 *  funnels these into the Web Audio queue per-utterance. */
export interface ServerTtsAudio {
    type: "tts:audio";
    data: ArrayBuffer;
}
/** Closes the current TTS utterance. After this, the next `tts:audio`
 *  chunk (if any) belongs to a future `tts:utterance`. */
export interface ServerTtsUtteranceEnd {
    type: "tts:utterance_end";
    id: string;
}
/**
 * Surfaces a TTS pipeline failure for a specific utterance. Sent when
 * both the primary and fallback providers fail. The client uses this
 * to log the failure to the UI instead of silently dropping audio.
 */
export interface ServerTtsError {
    type: "tts:error";
    id: string;
    message: string;
    provider?: string;
}
/** Error envelope — surfaces BFF / agent / pipeline failures to the UI. */
export interface ServerError {
    type: "error";
    message: string;
}
export type ServerMessage = ServerAgentCommentary | ServerAgentResponse | ServerAgentToolCall | ServerAgentToolResult | ServerAgentBrowserOpen | ServerHeartbeat | ServerStatus | ServerSttTranscript | ServerTtsUtterance | ServerTtsAudio | ServerTtsUtteranceEnd | ServerTtsError | ServerError;
/** Text command — typed in the input box (CAP-11) or sent after STT (CAP-3). */
export interface ClientCommand {
    type: "command";
    text: string;
}
/** Mic audio chunk captured between wake-word and `voice:end` (CAP-2). */
export interface ClientVoiceChunk {
    type: "voice:chunk";
    data: ArrayBuffer;
}
/** End of captured utterance. The BFF closes the Deepgram STT stream. */
export interface ClientVoiceEnd {
    type: "voice:end";
}
/** User-initiated cancel (CAP-7). Stops agent work, ends TTS playback. */
export interface ClientCancel {
    type: "cancel";
}
/** Auth token presented on WS connect (after REST login, CAP-12). */
export interface ClientAuth {
    type: "auth";
    token: string;
}
/** Severity ladder used by the client to map into BFF pino levels. */
export type ClientLogLevel = "info" | "warn" | "error" | "debug" | "system" | "tool" | "tool-result" | "commentary";
/**
 * A single log line from the client, shipped to the BFF for file
 * persistence. The BFF logs each one through its normal pino logger
 * (which then routes by `level` into the matching `bff.<level>.log`
 * file under `~/.jarvis/logs/`), stamping `service: "client"` and the
 * original `clientService` name into the entry.
 *
 * `level` is the client's own LogLevel taxonomy — the BFF's
 * `handleClientLog` does the final mapping into pino severity
 * (`tool` / `commentary` / `tool-result` / `debug` → debug, etc).
 */
export interface ClientClientLog {
    type: "client:log";
    level: ClientLogLevel;
    message: string;
    meta?: Record<string, unknown>;
}
export type ClientMessage = ClientCommand | ClientVoiceChunk | ClientVoiceEnd | ClientCancel | ClientAuth | ClientClientLog;
/** Narrow a `ServerMessage` to a specific `type` literal. */
export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, {
    type: T;
}>;
/** Narrow a `ClientMessage` to a specific `type` literal. */
export type ClientMessageOf<T extends ClientMessage["type"]> = Extract<ClientMessage, {
    type: T;
}>;
//# sourceMappingURL=messages.d.ts.map