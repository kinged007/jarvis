# WebSocket Message Changes

The client-facing WS protocol on `packages/shared/src/messages.ts` is extended, not replaced. The rest of the union is unchanged; 4 new types are added and 1 type gains an optional field.

Source of truth for existing types: `packages/shared/src/messages.ts` lines 30-138.

## New: `ServerAgentResponseDelta` (server → client)

Streamed response text from the LLM. The bridge emits one of these per `message.delta` SSE event.

```ts
export interface ServerAgentResponseDelta {
  type: "agent:response_delta";
  /** The incremental text fragment. Concatenated in arrival order, it equals
   *  the eventual `agent:response` text emitted on run.completed. */
  delta: string;
  /** The run this delta belongs to. The client can use it to correlate
   *  with tool_call/approval messages. */
  runId: string;
}
```

**Consumer behavior (client):**
- TTS pipeline consumes deltas in real time. The `services/tts/queue.ts` already chunks text by sentence; the bridge enqueues each delta into the same queue, and the existing chunker produces utterance boundaries.
- UI: the live transcript area appends `delta` to the in-progress bubble. The accumulated text matches the eventual terminal `agent:response`.
- Log container: deltas are NOT shipped to the BFF's `client:log` channel (they would flood the file). The log gets `agent:response` (terminal) and the higher-signal events.

## New: `ServerAgentRunComplete` (server → client)

Terminal marker emitted on `run.completed` alongside the synthesized `agent:response`. Informational; lets the client update UI state (e.g. turn the spinner off) without waiting for the full `agent:response` round-trip.

```ts
export interface ServerAgentRunComplete {
  type: "agent:run_complete";
  runId: string;
  status: "completed" | "failed" | "cancelled";
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  error?: string;
}
```

**Consumer behavior (client):**
- UI turns off the spinner / processing state.
- Log modal records the completion.
- For `failed` and `cancelled`, the client may also receive a `server:error` (existing behavior); this message is the structured equivalent.

## New: `ServerAgentApprovalRequest` (server → client)

Emitted on SSE `approval.request`.

```ts
export interface ServerAgentApprovalRequest {
  type: "agent:approval_request";
  runId: string;
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
  message?: string;
  choices: ReadonlyArray<"once" | "session" | "always" | "deny">;
}
```

**Consumer behavior (client):**
- A future UI modal/toast prompts the user with the four choices. The user picks, the client sends `agent:approval_response`.
- For v1 of the integration, the client log modal records the event; the modal UI is a follow-up workstream (NG-9).

## New: `ClientAgentApprovalResponse` (client → server)

The user's response to an `agent:approval_request`.

```ts
export interface ClientAgentApprovalResponse {
  type: "agent:approval_response";
  runId: string;
  requestId: string;
  choice: "once" | "session" | "always" | "deny";
}
```

**BFF behavior:**
- Validates `runId` matches an active run; `choice` is one of the four; `requestId` is opaque (forwarded as-is to Hermes via the `runId` lookup, not the body).
- Calls `POST /v1/runs/{runId}/approval` with body `{choice: choice}`.
- The Hermes API server's `requestId` is its own internal token; we don't pass it through (Hermes resolves approvals by `run_id` + the latest pending approval for that run, not by `request_id`). The `requestId` is included in the WS message for client-side correlation only.

## New: `ServerAgentApprovalResolved` (server → client)

Emitted on SSE `approval.responded` (echo from the API server after the BFF's POST). Informational; the client can dismiss any UI it showed.

```ts
export interface ServerAgentApprovalResolved {
  type: "agent:approval_resolved";
  runId: string;
  choice: "once" | "session" | "always" | "deny";
  resolved: number;  // 1 if a pending approval was actually resolved, 0 if there was none
}
```

## Extended: `ServerAgentToolCall` (server → client)

Add optional `preview?: string`. The existing `args` field is kept for compatibility.

```ts
export interface ServerAgentToolCall {
  type: "agent:tool_call";
  tool: string;
  args: Record<string, unknown>;
  /** One-line summary from Hermes, e.g. "searching for weather in Tokyo".
   *  Optional; older agents or certain tools may not provide it. */
  preview?: string;
  /** Run this tool call belongs to. New field. */
  runId: string;
}
```

## Extended: `ServerAgentToolResult` (server → client)

Add optional `duration?: number` and `error?: boolean`. Also add `runId` for correlation.

```ts
export interface ServerAgentToolResult {
  type: "agent:tool_result";
  tool: string;
  output: string;
  duration?: number;  // seconds
  error?: boolean;
  runId: string;
}
```

## Extended: `ServerAgentCommentary` (server → client)

Add `runId` for correlation.

```ts
export interface ServerAgentCommentary {
  type: "agent:commentary";
  text: string;
  runId: string;
}
```

## Extended: `ServerAgentResponse` (server → client)

Add `runId` for correlation. The terminal message still carries the full text; it is the canonical log entry.

```ts
export interface ServerAgentResponse {
  type: "agent:response";
  text: string;
  runId: string;
}
```

## Updated union membership

```ts
export type ServerMessage =
  | ServerAgentCommentary
  | ServerAgentResponse
  | ServerAgentResponseDelta   // NEW
  | ServerAgentRunComplete     // NEW
  | ServerAgentApprovalRequest // NEW
  | ServerAgentApprovalResolved // NEW
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
  | ServerError;

export type ClientMessage =
  | ClientCommand
  | ClientVoiceChunk
  | ClientVoiceEnd
  | ClientCancel
  | ClientAuth
  | ClientClientLog
  | ClientAgentApprovalResponse; // NEW
```

## Backwards compatibility

All changes are additive:
- 4 new `ServerMessage` types: clients that don't handle them just log the unknown type and move on (the existing `useWebSocket` dispatch already has a default branch that ignores unknown types).
- 1 new `ClientMessage` type: servers that don't handle it respond with a `server:error {message: "unknown message type"}` (the existing `parseClientMessage` rejects unknown types).
- 3 existing `ServerMessage` types get an added `runId` field (which the client can ignore if it doesn't care).
- `ServerAgentToolCall` gets an optional `preview` field (older senders omit it; older receivers ignore it).
- `ServerAgentToolResult` gets optional `duration` and `error` fields (same pattern).

The exhaustive `switch (event.type)` in `useWebSocket.ts` will need a new case for `agent:response_delta` (and the others). For v1, the simplest correct behavior is to call the same hooks the existing `agent:response` and `agent:commentary` paths call — but `response_delta` should NOT trigger a log entry (would flood) and SHOULD feed the TTS queue. The detailed dispatch lives in the client workstream (NG-9).
