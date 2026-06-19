/**
 * WebSocket protocol contract between the JARVIS client and the BFF.
 *
 * Single channel, typed discriminated union on `type`. Both sides MUST
 * import from this file — protocol drift is the #1 risk to avoid.
 *
 * Naming: `domain:action` (e.g. `agent:response`, `stt:transcript`).
 * Field names: camelCase. Dates: ISO 8601 strings.
 */

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

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

/** Agent state derived from Hermes events. Broadcast on every transition. */
export type AgentState = "offline" | "idle" | "thinking" | "executing" | "waiting" | "error";

/** Broadcast when the agent's derived state changes. The UI uses this to
 *  render status indicators (spinner, tool badge, approval prompt, etc.)
 *  independently from the "speaking" state which the UI tracks locally. */
export interface ServerAgentState {
  type: "agent:state";
  state: AgentState;
  /** The run this state belongs to, if any. */
  runId?: string;
}

/** Mid-execution commentary from the agent (CAP-4). The agent calls a TTS
 *  tool; the BFF forwards the text here so the client can log it before audio
 *  arrives. */
export interface ServerAgentCommentary {
  type: "agent:commentary";
  text: string;
  /** Hermes run id this commentary belongs to (added in Hermes API server
   *  integration; older clients ignore it). */
  runId?: string;
}

/** Final agent response text for the current turn. Synthesized by the BFF
 *  from `run.completed.output`; text is the same as the concatenation of
 *  the `agent:response_delta` frames. */
export interface ServerAgentResponse {
  type: "agent:response";
  text: string;
  runId?: string;
}

/**
 * Streamed response delta from the agent — one of these per Hermes
 * `message.delta` SSE event. The TTS pipeline consumes deltas in real
 * time so the user hears the first sentence while the agent is still
 * generating the rest. Concatenated in arrival order, `delta` equals
 * the eventual `agent:response` text.
 */
export interface ServerAgentResponseDelta {
  type: "agent:response_delta";
  /** Incremental text fragment. */
  delta: string;
  /** Run this delta belongs to. */
  runId: string;
}

/**
 * Terminal marker for a run. Emitted on Hermes `run.completed`,
 * `run.failed`, or `run.cancelled`. The synthesized `agent:response`
 * (full text) follows on the success path. Informational; lets the UI
 * turn off the spinner without waiting for the full `agent:response`.
 */
export interface ServerAgentRunComplete {
  type: "agent:run_complete";
  runId: string;
  status: "completed" | "failed" | "cancelled";
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  error?: string;
}

/** Agent invoked a tool — log + UI affordance. */
export interface ServerAgentToolCall {
  type: "agent:tool_call";
  tool: string;
  args: Record<string, unknown>;
  /** One-line summary from Hermes (e.g. "searching for weather in Tokyo").
   *  Optional; older agents or certain tools may not provide it. */
  preview?: string;
  runId?: string;
}

/** Tool finished and produced output. */
export interface ServerAgentToolResult {
  type: "agent:tool_result";
  tool: string;
  output: string;
  /** Wall-clock duration of the tool call in seconds. */
  duration?: number;
  /** True when the tool failed. */
  error?: boolean;
  runId?: string;
}

/** Agent wants the user's browser to open a URL (CAP-17). */
export interface ServerAgentBrowserOpen {
  type: "agent:browser_open";
  url: string;
}

/**
 * Agent is asking for human approval before executing a tool. Emitted
 * on Hermes `approval.request`. The user (or a future UI) responds with
 * `ClientAgentApprovalResponse` carrying one of the `choices`. YOLO mode
 * (the jarvis profile's default) suppresses most of these; this is the
 * fallback path.
 */
export interface ServerAgentApprovalRequest {
  type: "agent:approval_request";
  runId: string;
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
  message?: string;
  choices: ReadonlyArray<"once" | "session" | "always" | "deny">;
}

/**
 * Approval was resolved (by the BFF on behalf of the user, or by another
 * path). Emitted on Hermes `approval.responded`. Informational; any UI
 * that prompted the user can dismiss itself.
 */
export interface ServerAgentApprovalResolved {
  type: "agent:approval_resolved";
  runId: string;
  choice: "once" | "session" | "always" | "deny";
  /** 1 if a pending approval was actually resolved, 0 if there was none. */
  resolved: number;
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

/**
 * Full queue snapshot broadcast on every state change. Sent after
 * enqueue, start-of-synthesis, utterance completion, and clear so the
 * client always knows the exact queue contents, order, and progress
 * without maintaining its own model. The client uses `items` to render
 * the upcoming-audio list and `currentId` to highlight or skip the
 * in-flight utterance.
 */
export interface ServerTtsQueue {
  type: "tts:queue";
  items: Array<{
    id: string;
    kind: "commentary" | "response";
    text: string;
  }>;
  currentId: string | null;
}

/**
 * Long agent response — sent alongside `agent:response` when the final
 * response exceeds the configured word-count threshold. The client opens a
 * dedicated modal to render the full markdown content. The accompanying
 * `agent:response` (and TTS utterance) carries only the trimmed text.
 */
export interface ServerAgentLongResponse {
  type: "agent:long_response";
  runId: string;
  text: string;
}

/** Error envelope — surfaces BFF / agent / pipeline failures to the UI. */
export interface ServerError {
  type: "error";
  message: string;
}

/**
 * Acknowledgement of a client-initiated `cancel`. Lets the client move
 * its UI out of the processing state immediately, without waiting for
 * the new command's first event. Distinct from `ServerError` so the
 * client can transition to idle instead of `error`.
 */
export interface ServerCancelledAck {
  type: "server:cancelled_ack";
}

export type ServerMessage =
  | ServerAgentCommentary
  | ServerAgentResponse
  | ServerAgentResponseDelta
  | ServerAgentRunComplete
  | ServerAgentState
  | ServerAgentApprovalRequest
  | ServerAgentApprovalResolved
  | ServerAgentLongResponse
  | ServerAgentToolCall
  | ServerAgentToolResult
  | ServerAgentBrowserOpen
  | ServerHeartbeat
  | ServerStatus
  | ServerSttTranscript
  | ServerTtsUtterance
  | ServerTtsAudio
  | ServerTtsUtteranceEnd
  | ServerTtsError
  | ServerTtsQueue
  | ServerError
  | ServerCancelledAck;

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

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

/**
 * User's response to an `agent:approval_request`. The BFF relays it to
 * Hermes via `POST /v1/runs/{runId}/approval`. `requestId` is opaque
 * (carried for client-side correlation only; Hermes resolves approvals
 * by `runId` + the latest pending approval for that run).
 */
export interface ClientAgentApprovalResponse {
  type: "agent:approval_response";
  runId: string;
  requestId: string;
  choice: "once" | "session" | "always" | "deny";
}

/** Severity ladder used by the client to map into BFF pino levels. */
export type ClientLogLevel =
  | "info"
  | "warn"
  | "error"
  | "debug"
  | "system"
  | "tool"
  | "tool-result"
  | "commentary";

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

export type ClientMessage =
  | ClientCommand
  | ClientVoiceChunk
  | ClientVoiceEnd
  | ClientCancel
  | ClientAuth
  | ClientAgentApprovalResponse
  | ClientClientLog;

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/** Narrow a `ServerMessage` to a specific `type` literal. */
export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<
  ServerMessage,
  { type: T }
>;

/** Narrow a `ClientMessage` to a specific `type` literal. */
export type ClientMessageOf<T extends ClientMessage["type"]> = Extract<
  ClientMessage,
  { type: T }
>;
