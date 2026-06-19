/usr/bin/bash: warning: setlocale: LC_ALL: cannot change locale (en_GB.UTF-8): No such file or directory
---
design_ref: DESIGN.md
components_inherit: DESIGN.md.components
colors_ref: DESIGN.md.colors
typography_ref: DESIGN.md.typography
spacing_ref: DESIGN.md.spacing
status: final
updated: '2026-06-02'
---

# JARVIS — Experience & Interaction Design

## Foundation

**Form-factor:** Desktop-first responsive web application (React SPA). Primary target: 1920×1080px or 2560×1440px desktop browser. Minimum viable: 1280×720px. Mobile/tablet supported but not the design target.

**UI system:** Custom. No component library. All components built from `{DESIGN.md.components}` tokens. Visual identity: `DESIGN.md`.

**Constraints from SPEC:**
- Single viewport on desktop (no scroll) — layout must fit within available height
- Voice-first interaction — UI usable without keyboard/mouse during normal operation
- Dark theme only — no light mode
- Personal dashboard — no multi-user, no RBAC, no admin panel

**Technical context (from architecture):**
- React + Vite + TypeScript + Tailwind
- Zustand state management (voiceStore, agentStore, widgetStore, authStore)
- Brain visualization: Web Worker + OffscreenCanvas
- Real-time: single WebSocket channel
- Voice: Porcupine wake word (browser), Deepgram STT/TTS (BFF-proxied)

## Information Architecture

Single page, no routing. Two states: unauthenticated and authenticated.

```
/ (root)
├── [unauthenticated] AuthGate
│   └── LoginForm
└── [authenticated] Dashboard
    ├── StatusBar          (top, fixed)
    ├── WidgetPanel        (left, scrollable internally)
    ├── BrainVisualization (center, fills remaining space)
    ├── LogPanel           (right, collapsible)
    ├── VoiceStatusBar     (bottom, fixed)
    └── TextInput          (bottom, fixed)
```

**Surface closure:**
- Activate JARVIS → WakeWordIndicator (in VoiceStatusBar) + BrainVisualization (listening state)
- Speak command → transcript appears in VoiceStatusBar → dispatched
- See agent working → LogPanel (tool calls) + BrainVisualization (thinking state) + VoiceStatusBar (status)
- Hear response → Audio via speakers + BrainVisualization (speaking state) + LogPanel (response text)
- Check weather → WeatherWidget (auto-updating)
- Check system → SystemStatusWidget (heartbeat graph)
- Type command → TextInput (fallback)
- Log in → AuthGate → LoginForm

## Voice and Tone

**Brand voice:** JARVIS from Ironman — capable, concise, slightly formal but warm. Never chatty. Never apologizes unnecessarily. Facts first, personality second.

**Microcopy principles:**
- Status labels: present tense, single word or short phrase ("Listening...", "Working...")
- Errors: what happened + what to do ("Couldn't reach Deepgram. Check your connection.")
- Placeholders: instructional, calm ("Type a command or say JARVIS...")
- Widget labels: neutral, data-focused ("CPU Usage", "Weather — London")
- Never: exclamation marks, emoji, "oops", "please try again" (just say what to do)

**Voice output (TTS):** Short segments (≤30s per `{SPEC.md.CAP-18}`). Conversational pacing. During work: "Checking the weather now." "Your server is healthy — CPU at 23%." Final: "Here's what I found. The forecast shows rain this afternoon."

## Component Patterns

### Brain Visualization

**Behavior:** Receives state events via `postMessage` from main thread. Each state transition triggers a 400ms crossfade (ease-in-out). The worker runs its own `requestAnimationFrame` loop — never blocks on main thread React renders.

**State mapping** (from `{voice-interaction-model.md}`):
| Voice State | Brain State | Visual |
|-------------|-------------|--------|
| IDLE | idle | Slow pulse, particles drift |
| ACTIVATED | listening | Convergence pulse, ring expands |
| PROCESSING | thinking | Rotating rings, data streams |
| COMMENTARY / SPEAKING | speaking | Waveform rings, speech-synced |
| Error / disconnected | error | Flicker, ring fragments |

**Reduced motion:** When user toggles reduced motion, brain freezes at current state with a static dim cyan core. No animation loop. Transitions are instant cuts, not crossfades.

### WidgetFrame

**Behavior:** Generic container for all widgets. Provides: title bar (drag handle), content area, expand/collapse button, dismiss button (temporary widgets only).

- **Expand:** Click title bar or expand icon → widget grows to fill panel to 350px height. Other widgets shift down. Click again or click another widget → collapses (only one expanded at a time).
- **Drag:** Title bar is draggable. Reorder persisted to localStorage via `widgetStore`.
- **Dismiss:** Temporary widgets (Phase 2) show × button. Fade-out animation (200ms) on dismiss.

### WeatherWidget

**Behavior:** Frontend-only. On mount, fetches weather from configured API endpoint (proxied through BFF). Refreshes every 30 minutes. Shows loading skeleton on fetch.

**Compact:** Icon (sun/cloud/rain) + temperature + condition. 24px icon, `typography.ui.lg` temp, `typography.ui.sm` condition.

**Expanded:** 5-day forecast as horizontal mini-cards (icon + high/low temp). Humidity bar. Wind direction arrow. "Updated 5 min ago" timestamp.

**Error:** "Weather unavailable" + retry button. Never blocks dashboard.

### SystemStatusWidget

**Behavior:** Driven by WebSocket `system:status` and `system:heartbeat` events. Updates in real-time.

**Compact:** Connection dot (green = connected, red = disconnected) + uptime counter + last heartbeat timestamp.

**Expanded:** Heartbeat line chart (last 60 minutes, rolling window). Agent status text. CPU/memory if available from agent. Reconnection count.

**Disconnection:** Dot turns red immediately on missed heartbeat (5s threshold). Graph shows gap. "Reconnecting..." label. Auto-reconnects via `useWebSocket` exponential backoff.

### LogPanel

**Behavior:** Streams entries from `agentStore`. Each `agent:tool_call`, `agent:tool_result`, `agent:commentary`, `agent:response`, `error` event appends an entry.

- Auto-scroll enabled by default. Scrolls to latest entry on each append.
- Pause on hover or scroll-up. "Paused — scroll to resume" indicator at top.
- Collapse via toggle button (top-right). Animated slide (300ms ease, width → 0). Thin tab (24px) remains to re-expand.
- Max 500 entries in memory. Older entries pruned.
- Search/filter: not implemented. Low priority for personal dashboard.

### VoiceStatusBar

**Behavior:** Reflects `voiceStore.state`. Mic level from `useAudioCapture` (analyser node on mic stream).

**States:**
- Idle: "◎ Idle — Say JARVIS..." in `text.muted`
- Listening: "● Listening..." pulsing dot in `neon.cyan`, mic meter active
- Processing: "◉ Working..." solid dot in `state.thinking`
- Speaking: "◉ Speaking..." solid dot in `state.speaking`
- Error: "✕ {error message}" in `neon.red`

Transcript display: shows last recognized utterance in center while processing/speaking. Clears after follow-up window expires.

### TextInput

**Behavior:** Fallback input. Always visible at bottom center. On Enter: dispatches text as `{ type: "command", text }` via WebSocket. Clears input. Disabled during voice capture (but always available — typing doesn't interrupt voice).

### AuthGate

**Behavior:** Full-viewport overlay with `z-index: max`. Password input with show/hide toggle. Enter or click "Enter" to submit. On success: fade-out (500ms) → dashboard revealed. On failure: input shakes (300ms CSS animation), error text "Incorrect password" in `neon.red`. No rate limiting on client (BFF handles brute-force).

## State Patterns

### Voice State Machine

Implemented in `voiceStore`. States map 1:1 from `{voice-interaction-model.md}`:

```
IDLE → (wake word) → ACTIVATED → (STT complete) → PROCESSING
PROCESSING → (commentary) → SPEAKING → (done) → PROCESSING
PROCESSING → (final response) → SPEAKING → (done) → FOLLOW_UP
FOLLOW_UP → (new command) → PROCESSING
FOLLOW_UP → (timeout | "dismiss") → IDLE
Any state → (cancel) → IDLE
```

**Visual mapping:** Each state drives BrainVisualization state + VoiceStatusBar display + panel border glows.

### Loading States

- **Page load:** AuthGate checks for existing JWT cookie. Shows nothing until resolved (no flash of dashboard).
- **Weather fetch:** Skeleton card (pulsing `bg.elevated` placeholder) until data arrives.
- **Agent connection:** SystemStatusWidget shows "Connecting..." with amber dot during initial WS handshake.
- **STT processing:** VoiceStatusBar shows transcript with trailing "..." while Deepgram streams interim results.

### Empty States

- **Log panel (fresh session):** "Waiting for commands..." in `text.muted`, centered.
- **Widget panel (only if all widgets removed — Phase 2):** "No widgets" with faint plus icon.
- **Transcript (no utterance yet):** Nothing displayed in center of VoiceStatusBar.

### Error States

| Error | Visual | Recovery |
|-------|--------|----------|
| WS disconnect | SystemStatusWidget red dot, VoiceStatusBar "◎ Reconnecting..." | Auto-reconnect (exponential backoff) |
| Deepgram STT failure | VoiceStatusBar "✕ Didn't catch that" in `neon.red` | Auto-retry on next activation |
| Deepgram TTS failure | LogPanel shows response text, Brain shows error pulse briefly | Fallback: read the text |
| Agent crash | SystemStatusWidget red, LogPanel shows disconnect event | BFF auto-restarts agent, WS reconnects |
| Microphone denied | VoiceStatusBar "✕ Microphone access required" persistent | TextInput becomes primary input |
| Weather API failure | WeatherWidget "Unavailable" + retry button | Manual retry or wait for next interval |
| Wrong password | LoginForm shake + error text | User retries |

## Interaction Primitives

### Voice (primary)
- **Activation:** Say "JARVIS" (configurable). No button press. Continuous passive listening.
- **Command:** Speak naturally after activation. No wake word needed during follow-up window.
- **Cancellation:** Say "dismiss", "thank you", "that's all", "stop", or "cancel".
- **Feedback:** VoiceStatusBar shows recognized text. Brain visualization shows listening state.

### Click/Tap
- Widget expand/collapse: click title bar
- Log panel collapse: click toggle button
- Auth submit: click "Enter" button
- Dismiss widgets (Phase 2): click × button
- Weather retry: click "Retry" on error state

### Keyboard
- TextInput: type command, Enter to submit. Escape to clear.
- Auth: type password, Enter to submit.
- No global keyboard shortcuts (personal dashboard, not a power tool).

### Motion toggle
- Accessible via a small icon in top-right of status bar (gear → "Reduce motion").
- Toggles CSS `prefers-reduced-motion` simulation.
- Brain visualization: stops animation loop, shows static dim core.
- All CSS transitions: duration → 0ms.
- Persisted to localStorage.

## Accessibility Floor

**Personal dashboard — not a public product.** Accept trade-offs for the neon aesthetic:

- **Contrast:** Body text ≥3:1 (relaxed). Neon cyan on dark: `#00f0ff` on `#0a0a0f` = ~8:1 (acceptable). Dim cyan `#88ccdd` on `#0a0a0f` = ~4:1 (marginal for small text — use only for secondary elements at ≥13px).
- **Focus indicators:** Neon border glow on focused inputs — visible but not WCAG-compliant. Acceptable for personal use.
- **Screen reader:** ARIA labels on interactive elements (widget frames, buttons, status bar). Brain visualization: `aria-label` updates with state ("JARVIS is listening"). Log panel: `aria-live="polite"` region for new entries.
- **Reduced motion:** Toggle in status bar (see above). Respects `prefers-reduced-motion: reduce` OS setting.
- **Keyboard navigation:** Tab order: TextInput → WidgetPanel → LogPanel → StatusBar controls. AuthGate traps focus.
- **No voice-only dependency:** TextInput always available. Voice failure doesn't lock out the user.

**Not implemented (personal scope):**
- WCAG 2.1 AA full compliance
- Screen reader testing
- Color blindness simulation
- Mobile accessibility (target is desktop browser)

## Key Flows

### Flow 1: Wake → Command → Response

**Protagonist:** Josh, at his desk, JARVIS dashboard open on secondary monitor.

1. Josh says "JARVIS, what's the weather in London?"
2. Porcupine detects "JARVIS" → `voiceStore` transitions to ACTIVATED. BrainVisualization: listening pulse. VoiceStatusBar: "● Listening..."
3. Audio stream (including full utterance) sent to BFF → Deepgram STT.
4. Transcript appears: "what's the weather in London" in VoiceStatusBar center. `voiceStore` → PROCESSING.
5. BrainVisualization: rotating rings, data streams. VoiceStatusBar: "◉ Working..."
6. Agent receives command. Calls weather tool. LogPanel: `[14:32:01] ◈ weather London,UK`.
7. Agent commentary: "Checking the weather now..." → Deepgram TTS → audio plays. Brain: speaking pulse synced.
8. Agent final: "London is 18°C, partly cloudy. Rain expected this evening." → TTS plays.
9. WeatherWidget updates: 18°C, cloud icon. LogPanel shows response.
10. `voiceStore` → FOLLOW_UP (5s window). VoiceStatusBar: "◉ Active — follow up?"
11. Josh says nothing. Window expires → IDLE. Brain: idle slow pulse.

**Climax beat:** The weather widget updates visually *while* JARVIS is still speaking — show and tell in parallel.

### Flow 2: Text Fallback

**Protagonist:** Josh, late night, doesn't want to wake anyone.

1. Josh clicks TextInput at bottom.
2. Types: "check server status" → Enter.
3. Same dispatch as voice (CAP-3). Brain → thinking. LogPanel streams tool calls.
4. Response delivered as voice (TTS plays) AND text in LogPanel.
5. SystemStatusWidget updates with current heartbeat.
6. Follow-up window activates — Josh could type another command without waking.

### Flow 3: Authentication

**Protagonist:** Josh, first visit, or session expired.

1. Dashboard loads. AuthGate overlay visible.
2. Brain visualization visible behind gate, idle state — hints at what's inside.
3. Josh types password → Enter.
4. POST `/api/auth/login` → JWT cookie set.
5. AuthGate fades out (500ms). Dashboard revealed.
6. WebSocket connects with auth token. SystemStatusWidget → "Connected".
7. VoiceStatusBar: "◎ Idle — Say JARVIS..."

### Flow 4: Error Recovery

**Protagonist:** Josh, during a command, agent crashes.

1. Mid-command, SystemStatusWidget dot turns red. "Disconnected" timestamp.
2. VoiceStatusBar: "✕ Connection lost — reconnecting..."
3. BrainVisualization: error pulse (red flicker).
4. LogPanel shows `[14:35:22] ✕ Agent connection lost`.
5. BFF auto-restarts agent (2s backoff). WebSocket reconnects.
6. SystemStatusWidget: green dot, "Reconnected — uptime 0:00:12".
7. VoiceStatusBar: "◎ Idle — Say JARVIS..."
8. Josh re-issues command. System recovers transparently.

**Climax beat:** The error state is visible but not alarming — red pulse is brief, recovery is automatic, Josh barely pauses.
