---
id: SPEC-bff-demo-script
companions: [message-dispatch.md]
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate.

# BFF Reference CLI Client

## Why

The web UI connects to the BFF via WebSocket, but the communication path is embedded in React components (188 lines of `dispatchServerMessage` in `useWebSocket.ts`), Zustand stores, and browser-only APIs (`AudioContext`, `credentials: "include"`). When the BFF protocol evolves or needs debugging, the only way to verify wire-format correctness is through the full browser UI. A standalone Node.js CLI script that mirrors the web UI's communication patterns — same WebSocket connection, same message types, same log rendering — gives developers a fast, terminal-based way to iterate on the BFF protocol, inspect every frame, and debug backend-frontend communication without a browser.

## Capabilities

- id: CAP-1
  intent: Authenticate against the BFF via `POST /api/auth/login`, capture the `jarvis_session` cookie, and maintain it for the WebSocket upgrade.
  success: Running `node scripts/demo.mjs` prompts for password, authenticates, and reports `authenticated: true` before opening the WebSocket.

- id: CAP-2
  intent: Open a WebSocket connection to `GET /ws` at the BFF origin with binary type `arraybuffer`, using the session cookie from CAP-1.
  success: Script logs `connected` when the socket opens and receives a `system:status` frame.

- id: CAP-3
  intent: Accept typed text input from the terminal and send it as a `{type: "command", text}` frame over the WebSocket, following the same send path as `sendMessage` in `sinks.ts`.
  success: Typing `what is the weather in Tokyo` and pressing Enter sends a `command` frame. The agent responds with `agent:response` containing weather data.

- id: CAP-4
  intent: Dispatch every `ServerMessage` type from the WebSocket to terminal output, color-coded by level, matching the log-entry taxonomy used by `LogModal.tsx` (commentary=primary, error=destructive, tool=info, tool-result=muted, run=accent, system=muted).
  success: During an agent run, the terminal shows inline log lines for `system:status`, `agent:commentary`, `agent:tool_call`, `agent:tool_result`, `agent:response_delta`, `agent:run_complete`, `agent:response`, each with timestamp and level color. See `message-dispatch.md` for the exact mapping.

- id: CAP-5
  intent: Support cancel — typing `/cancel` sends `{type: "cancel"}` and waits for `server:cancelled_ack`.
  success: Sending `/cancel` mid-run stops agent output and prints `run cancelled`.

- id: CAP-6
  intent: Architecture is ready for audio output later. Binary `tts:audio` frames are detected and their metadata logged. A `--play` flag can be swapped in without restructuring the dispatch loop. `voice:chunk` sending is architected as a stub.
  success: A `--tts` flag that pipes `tts:audio` chunks to a local audio player can be added in a follow-up without touching the core WebSocket loop.

- id: CAP-7
  intent: Handle graceful shutdown via `Ctrl+C` or `/quit`, sending a clean WebSocket close code and exiting.
  success: Script exits with code 0; no lingering WebSocket connections on the BFF.

## Constraints

- **Node.js only** — no browser APIs, no `AudioContext`, no React. Uses `node:readline` for input and `ws` for WebSocket.
- **Single-file** — lives at `scripts/demo.mjs` as an ES module. No separate workspace package. Install nothing extra: `ws` is already in the project dependency tree.
- **Same message taxonomy** — log levels match `packages/client/src/components/LogModal.tsx:70-86` exactly.
- **No TypeScript runtime dependency on `@jarvis/shared`** — message type strings are inlined as discriminators. Type safety is provided by the contract, not by import.
- **Auto-connect** after authentication. No explicit `/connect` command.
- **Approval requests** are logged only (no blocking prompt), matching the current web UI behavior.

## Non-goals

- No audio capture (mic). STT/voice input is out of scope for v1.
- No audio playback in v1. TTS binary frames are detected and metadata logged, not played.
- No browser automation. This is a CLI tool.
- No persistent config file or password storage. Password from `JARVIS_PASSWORD` env var or interactive prompt.
- No REPL history or command editing beyond `node:readline`.
- Not a replacement for the web UI — the web UI is the primary client.

## Success signal

A developer can run `node scripts/demo.mjs` against a local JARVIS BFF, type a command, and see every WebSocket frame the web UI's LogModal would show — streamed live to the terminal with color-coded log levels — without opening a browser.

## Assumptions

- The script runs against `localhost:3001` by default. Override via `JARVIS_BFF_ORIGIN` env var.
- The BFF's `jarvis_session` cookie on `localhost` with `sameSite: "lax"` will be included on the WebSocket upgrade — same as `useWebSocket.ts:268`.
- `ws` package is available (already in the BFF workspace dependency tree).
- Terminal supports ANSI color codes.
