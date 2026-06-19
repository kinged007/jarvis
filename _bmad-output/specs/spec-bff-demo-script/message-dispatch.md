# Message Dispatch Map

How each `ServerMessage` type renders in the terminal. Level colors mirror `LogModal.tsx:70-86`.

## Color Scheme

| Level       | ANSI Code        | Hex       |
|-------------|------------------|-----------|
| commentary  | `\x1b[38;5;51m` | #00ffff (primary) |
| error       | `\x1b[38;5;196m`| #ff3333 (destructive) |
| tool        | `\x1b[38;5;51m` | #00ffff (primary/40 → primary) |
| tool-result | `\x1b[38;5;245m`| #8a8a8a (muted) |
| run         | `\x1b[38;5;213m`| #ff85ff (accent) |
| system      | `\x1b[38;5;245m`| #8a8a8a (muted) |
| info        | `\x1b[38;5;245m`| #8a8a8a (muted) |
| delta       | terminal default | (streamed inline, no prefix) |

## Per-Type Dispatch

| Message Type              | Terminal Output | Level Color |
|---------------------------|-----------------|-------------|
| `system:heartbeat`        | *silent*        | —           |
| `system:status`           | `STATUS  connected:{v} agentReady:{v} uptime:{v}s` | system |
| `agent:commentary`        | `COMMENTARY  {text}` | commentary |
| `agent:response`          | `RESPONSE  {text}` | info |
| `agent:response_delta`    | `{delta}` (inline, no prefix, no newline until `run_complete`) | delta |
| `agent:run_complete`      | `RUN  completed/failed/cancelled  usage:{...}` | run |
| `agent:tool_call`         | `TOOL  {tool}  {preview}  args:{...}` | tool |
| `agent:tool_result`       | `TOOL-RESULT  {tool}  {output}` (truncated to 200 chars) | tool-result |
| `agent:approval_request`  | `APPROVAL-REQUEST  {tool}  choices:{...}` | tool |
| `agent:approval_resolved` | `APPROVAL-RESOLVED  {choice}  resolved:{v}` | system |
| `agent:browser_open`      | `BROWSER-OPEN  {url}` | tool |
| `stt:transcript`          | `STT  {text}` (only final transcripts) | system |
| `tts:utterance`           | `TTS-UTTERANCE  {id}  {kind}  {text}` (truncated to 80 chars) | system |
| `tts:audio`               | *silent* (byte count logged once per second) | — |
| `tts:utterance_end`       | *silent* | — |
| `tts:error`               | `TTS-ERROR  {id}  {message}` | error |
| `error`                   | `ERROR  {message}` | error |
| `server:cancelled_ack`    | `CANCELLED` | system |

## Notes

- All lines are prefixed with `HH:MM:SS` timestamp.
- `agent:response_delta` frames stream inline without prefix. A newline is emitted on `agent:run_complete` to flush the streamed text.
- `tts:audio` binary frames are detected by type (`data instanceof Buffer`) and a byte counter is logged at most once per second.
- `agent:tool_result.output` is truncated to 200 characters in the terminal. The full value is available in the BFF log files.
