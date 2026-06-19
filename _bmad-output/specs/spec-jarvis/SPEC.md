/usr/bin/bash: warning: setlocale: LC_ALL: cannot change locale (en_GB.UTF-8): No such file or directory
/usr/bin/bash: warning: setlocale: LC_ALL: cannot change locale (en_GB.UTF-8): No such file or directory
/usr/bin/bash: warning: setlocale: LC_ALL: cannot change locale (en_GB.UTF-8): No such file or directory
/usr/bin/bash: warning: setlocale: LC_ALL: cannot change locale (en_GB.UTF-8): No such file or directory
/usr/bin/bash: warning: setlocale: LC_ALL: cannot change locale (en_GB.UTF-8): No such file or directory
/usr/bin/bash: warning: setlocale: LC_ALL: cannot change locale (en_GB.UTF-8): No such file or directory
---
id: SPEC-jarvis
companions:
  - stack.md
  - ux-vision.md
  - voice-interaction-model.md
  - widget-system.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate.

# JARVIS — Voice-First AI Assistant Dashboard

## Why

A vision to realize: a futuristic, voice-first AI assistant interface that feels alive — like Ironman's JARVIS. Current AI interfaces are text-heavy, silent-until-done, and feel like tools rather than companions. JARVIS bridges this gap by wrapping a Hermes agent in a web client that listens constantly, speaks back naturally during its work, visualizes its "brain" activity, and controls the browser from the user's context (not the headless CLI). The experience should feel like talking to a capable AI presence, not operating a chatbot.

## Capabilities

- id: CAP-1
  intent: System constantly listens via microphone and activates when the user says "JARVIS" (or a configurable wake word).
  success: Saying "JARVIS" within microphone range triggers a visible and audible activation state within 500ms. Saying other words does not trigger activation.

- id: CAP-2
  intent: When wake word is detected, the full utterance (including the wake word phrase) is captured and streamed to Deepgram STT for speech-to-text conversion. No pause between wake word and command — like Alexa, the user says "JARVIS show me the weather" as one continuous sentence.
  success: Full utterance text appears on screen within 1 second of speech completion. Wake word is stripped from the command text before dispatch.

- id: CAP-3
  intent: Recognized command text is dispatched to the Hermes agent for processing via the BFF.
  success: Command text reaches Hermes agent and a response (or stream of responses) begins within 2 seconds of dispatch.

- id: CAP-4
  intent: During agent execution, the agent sends periodic voice commentary (e.g., on tool calls, milestones) and a final voice response — making JARVIS feel alive and interactive while working.
  success: At least one mid-execution voice update is heard before the final response for any task taking >5 seconds. The final voice response is always delivered.

- id: CAP-5
  intent: Agent text responses (final and mid-execution commentary) are converted to natural-sounding speech via Deepgram TTS and played through the browser audio output. Mid-execution commentary is triggered by a dedicated agent tool that calls TTS.
  success: Voice output is intelligible, matches the response content, and plays without user interaction. Latency from text to first audio is under 1 second.

- id: CAP-6
  intent: After delivering a response, JARVIS remains active for a configurable window (default ~5 seconds) to accept follow-up commands without re-waking.
  success: Speaking a follow-up command within the window is processed without saying "JARVIS" again. Window expiry returns to listening-but-inactive state.

- id: CAP-7
  intent: User can dismiss or cancel JARVIS at any time via voice command (e.g., "thank you JARVIS", "dismiss") or UI button.
  success: Cancellation stops any in-progress agent work, ends voice output, and returns to inactive listening state within 1 second.

- id: CAP-8
  intent: Dashboard renders a futuristic, dark-themed UI with neon accents (Tron/Ironman aesthetic) centered on an animated AI brain visualization that reflects JARVIS's state.
  success: UI is visually distinct from conventional web apps. Brain animation changes visibly across states: idle, listening, thinking, speaking, executing.

- id: CAP-9
  intent: Visual state indicators (animations, color shifts, particle effects) communicate what JARVIS is doing at all times — listening, thinking, talking, executing tools.
  success: A user can identify JARVIS's current state from across the room by the visual indicators alone.

- id: CAP-10
  intent: A collapsible side panel shows real-time text logs: CLI outputs, tool calls, agent reasoning — so the user can inspect what JARVIS is doing if desired.
  success: Each tool call and its output appears in the log within 1 second of execution. Log is scrollable and searchable.

- id: CAP-11
  intent: A text input field is available as a fallback for typed commands when voice is not desired or not possible.
  success: Typing a command and pressing Enter dispatches it identically to a voice command (CAP-3).

- id: CAP-12
  intent: Dashboard is protected by simple password authentication on page load. No multi-user, no OAuth — single password gate.
  success: Unauthenticated requests see only a password prompt. Correct password grants access to the full dashboard. Session persists via token/cookie.

- id: CAP-13
  intent: Dashboard displays a system status widget showing agent health, connection state, and a heartbeat indicator graph.
  success: Widget updates in real-time. Heartbeat graph shows the last N minutes of agent responsiveness. Disconnection is visibly indicated within 5 seconds.

- id: CAP-14
  intent: Dashboard displays a weather widget showing current conditions and temperature for a configurable location.
  success: Widget shows accurate current weather. Location is changeable via config. Updates at least every 30 minutes.

- id: CAP-15
  intent: Dashboard supports a widget system where widgets are driven by scripts that produce structured output following a defined DSL. Widgets render with a predefined theme. (Full agent-created dynamic widgets deferred to Phase 2.)
  success: A script output conforming to the widget DSL renders correctly on the dashboard with the JARVIS theme applied.

- id: CAP-16
  intent: Widgets have two sizes (default compact, expanded on click). Weather widget is a permanent frontend widget that fetches data directly from a weather API — no agent involvement.
  success: Clicking the compact weather widget expands it. Weather data is current and updates independently of agent activity.

- id: CAP-17
  intent: When the agent needs to open a URL (browser, new tab), the command is routed through the webapp's browser context — not the headless CLI — so the user sees the opened page on their machine.
  success: Agent-triggered URL opens in a new browser tab on the user's machine. The CLI makes no attempt to open a browser locally.

- id: CAP-18
  intent: JARVIS responds with short, conversational voice output — not long blocks of text/audio. Responses are broken into natural spoken segments.
  success: No single voice output exceeds 30 seconds. Multi-part responses are delivered as sequential short segments with natural pacing.

## Constraints

- Single-page web application (SPA) — one HTML page, dynamic content.
- React-based frontend (Vite tooling).
- BFF (Backend for Frontend) layer wraps CLI commands to Hermes agent; no traditional database-backed backend.
- BFF, web client, and Hermes agent CLI are packaged and run on the same machine; user accesses the dashboard remotely from another computer or mobile device.
- All browser interaction (tab opening, audio playback) originates from the user's browser context, not the CLI.
- Voice-first interaction model — UI must be usable without keyboard/mouse during normal operation.
- Password-only authentication (no OAuth, no multi-user, no RBAC).
- Dark visual theme with neon accents (Tron/Ironman palette).
- Dashboard widgets are limited in quantity (max ~6 visible at once) and default to compact size.
- All voice processing (STT, TTS) happens browser-side or via BFF-proxied services — no local native dependencies on the client machine beyond a browser.

## Non-goals

- Multi-user support or user accounts.
- Mobile native app (mobile browser is acceptable but not a design target).
- Offline operation — requires network connectivity to BFF and Hermes agent.
- File upload, document management, or media hosting.
- Video or camera input.
- Traditional persistent chat history with search (transient session log only).
- Integration with smart home devices or external IoT.
- Custom wake word training (uses a fixed or pre-trained model).

## Success signal

A user opens the JARVIS dashboard, authenticates with a password, and says "JARVIS, what's the weather and how is my server doing?" Within seconds they hear "Let me check both of those for you." The AI brain pulses with activity. A weather widget appears showing current conditions. Moments later: "Your server is healthy — CPU at 23%, memory at 60%. Here's the heartbeat graph." A system status widget updates live. The user says "thanks JARVIS" and the assistant returns to quiet listening. The entire interaction feels like talking to a capable, attentive AI companion — not operating a tool.

## Assumptions

- STT and TTS use Deepgram API (via BFF proxy for API key protection).
- A lightweight, always-on wake word detector runs browser-side (e.g., Porcupine or similar) to avoid burning Deepgram credits on silence.
- Deepgram STT is invoked only after wake word detection — capturing the full utterance from the moment of detection (Alexa-style, no pause needed).
- Hermes agent is instructed (via SOUL.md/AGENTS.md) to provide mid-execution voice commentary by calling a dedicated TTS tool.

## Resolved Decisions

- **TTS/STT:** Deepgram for both. STT invoked only after wake word (not constantly listening via Deepgram — cost concern).
- **Wake word:** Lightweight browser-side detector (Porcupine or similar). On detection, captures the full continuous utterance and streams to Deepgram STT. No pause between wake word and command.
- **Mid-execution commentary:** Dedicated agent tool that calls TTS. Agent behavior specified in SOUL.md/AGENTS.md.
- **BFF location:** BFF, web client static files, and Hermes CLI all run on the same machine. User accesses remotely from another computer/mobile.
- **Weather:** Frontend widget fetches directly from weather API — no agent involvement.
- **Widgets:** Phase 2 (deferred). Script-driven with a defined DSL and predefined theme. Phase 1 includes weather widget only.
