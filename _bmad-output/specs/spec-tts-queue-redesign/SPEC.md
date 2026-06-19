---
id: SPEC-tts-queue-redesign
companions: []
sources:
  - SERVICE_MAP.md
  - packages/bff/src/services/tts/types.ts
  - packages/bff/src/services/tts/queue.ts
  - packages/bff/src/services/agent/bridge.ts
  - packages/client/src/services/tts/service.ts
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability only — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# TTS Queue Redesign — Async Queue with Complete Audio Files

## Why

The current TTS pipeline works but has several problems: commentary events from the agent are intentionally not voiced (skipped), response text is sentence-chunked which degrades prosody, and the pipeline is overly complex with streaming WS transport that hangs. The redesign simplifies the pipeline to: catch specific Hermes events → send full text to TTS → receive complete audio file → queue for playback in order. This is a **pain to solve** (chunked speech sounds bad) and an **opportunity to capture** (simpler pipeline = fewer failure modes).

## Capabilities

- id: CAP-1
  intent: Any Hermes SSE event that carries complete text (`reasoning.available` for commentary, `run.completed` for response) is asynchronously sent to the TTS service as a single utterance with no text splitting.
  success: Sending a command to the agent produces commentary audio for `reasoning.available` events and response audio for `run.completed` output, each as exactly one TTS utterance.

- id: CAP-2
  intent: The TTS service queues utterances in arrival order, synthesizes each with Deepgram REST (complete audio file, no streaming WS), and broadcasts the audio to connected clients via WebSocket.
  success: The demo CLI logs `tts:utterance` (one per event), `tts:audio` byte counts, and `tts:utterance_end` in FIFO order with no overlap between utterances.

- id: CAP-3
  intent: The client receives a live updating queue view — it knows which audio utterances are queued, their order, kind (commentary/response), and text content.
  success: The web UI and demo CLI both show incoming `tts:utterance` messages with id, kind, and text as soon as the BFF enqueues them.

- id: CAP-4
  intent: The user can skip the currently playing utterance (advance to next) or skip all utterances for the current run (clear the entire queue).
  success: Clicking "Skip" stops the current AudioBufferSourceNode and the next queued utterance begins immediately. Clicking "Skip All" clears the queue and stops all audio.

- id: CAP-5
  intent: All gateway events, TTS enqueue events, and audio delivery events are logged at appropriate levels so the user can review the pipeline flow.
  success: The BFF log files and demo CLI output show a complete trace: event received → TTS enqueued → audio delivered → utterance ended for each utterance.

- id: CAP-6
  intent: The BFF broadcasts a live queue snapshot (`tts:queue`) on every state change (enqueue, synthesis start, completion, clear) so the client always has an authoritative view of what will play, in what order, with a `currentId` pointer for the in-flight utterance.
  success: The demo CLI shows `tts queue [N]` with ▶ on the currently-synthesizing utterance, and the list auto-updates as utterances start and complete.

## Constraints

- Deepgram REST is the only TTS transport. No WebSocket TTS provider is constructed or used.
- Text is never split or chunked by sentence boundary, newline, or any other delimiter. Each event produces exactly one TTS utterance.
- Commentary (`reasoning.available`) events are voiced via TTS by default. Configurable via `TTS_COMMENTARY_ENABLED=false` env var.
- Audio format remains 24 kHz / mono / linear16 as defined in `TTS_AUDIO_FORMAT`.
- The Hermes API gateway remains the single source of agent events. No new event sources.

## Non-goals

- Chunked/streaming TTS via WebSocket (Deepgram WS provider). This is deferred for future evaluation once REST flow is proven.
- Sentence-level text splitting for first-audio latency. The tradeoff of degraded prosody is not acceptable.
- Server-side audio file storage or caching. Audio is fetched per utterance and streamed to clients in real time.
- Changing the STT pipeline. This spec touches only TTS.

## Success signal

Run `node scripts/demo.mjs`, send a command, and verify: (1) `agent:commentary` events appear in the log AND produce `tts:utterance` messages of kind `commentary`, (2) `agent:response` produces exactly one `tts:utterance` of kind `response` with the full text, (3) `tts queue [N]` messages appear with the ▶ indicator tracking the in-flight utterance, (4) audio byte counts increment between utterances, (5) no sentence-chunked utterances appear (one utterance per event type, not N utterances from sentence splitting).

## Assumptions

- Assumed Hermes `reasoning.available` text and `run.completed` output do not overlap in a way that produces audible echo. If they do, commentary TTS can be re-disabled via `TTS_COMMENTARY_ENABLED=false` without changing the queue architecture.
- Assumed the Deepgram REST provider's ~1s response time is acceptable; the user explicitly prefers complete-file quality over chunked low-latency.

## Open Questions

- Is the 15s per-utterance timeout still appropriate for potentially longer response texts? The current 15s covers multi-paragraph text with Deepgram REST comfortably, but a 10-paragraph response might need 30s.
