# Story: Audio Input Components — Isolated Demo Test Page

| Field | Value |
|-------|-------|
| **Story ID** | 0.1 |
| **Story Key** | 0-1-audio-input-demo-test |
| **Status** | review |
| **Epic** | 0 — Pre-Implementation Validation |
| **Priority** | High |
| **Created** | 2026-06-11 |

---

## User Story

As a developer, I want a single standalone demo page with three independent audio input mode buttons, an STT toggle, visual state indicators, and captured-audio playback, so that I can test, debug, and validate each audio capture pathway in isolation — using the exact same service layer the main JARVIS app uses — without activating the agent or any other subsystem.

---

## Acceptance Criteria

### AC-1: Demo Page Route & Layout
- [ ] A new route `#/demo/audio-input` is accessible in the Vite dev server
- [ ] The page is a single React component with no auth gate, no agent activation
- [ ] The page displays: three mode buttons (only one active at a time), an STT on/off toggle, a mic level meter, a live state indicator panel, a captured audio playback area, and a transcript log area
- [ ] The page uses the existing Tailwind + shadcn `Button` component for UI consistency
- [ ] The page title clearly reads "Audio Input Demo"

### AC-2: Mode 1 — Always-Listening (Wakeword)
- [ ] Button labeled "Always Listening (Wakeword)"
- [ ] When activated, starts the `wakewordService` via its `.start()` method — this runs the openWakeWord engine for wakeword detection (independent of STT toggle)
- [ ] Wakeword detection uses the openWakeWord WASM engine on a dedicated mic — this is separate from the STT pipeline and always runs when this mode is active
- [ ] When the wakeword fires ("Hey Jarvis detected"), the page logs the event with a timestamp and the UI state transitions to "Recording..."
- [ ] After wakeword detection, the wakeword service's command-capture pipeline records post-wake audio (pre-roll buffer + command audio with VAD + silence timer)
- [ ] When the silence timer fires and audio is assembled: if STT toggle is ON, the audio is shipped to the BFF STT proxy via `sendBinary`/`sendMessage`; if STT toggle is OFF, the audio is captured locally but NOT sent to the BFF (the sinks are effectively no-ops)
- [ ] Deactivating this mode calls `wakewordService.stop()`
- [ ] Visual state panel shows: "Listening for wake word..." (idle), "Wake detected! Recording..." (post-wake capture), "Shipping audio..." (silence timer fired)

### AC-3: Mode 2 — Keyboard Hotkey Hold (Push-to-Talk)
- [ ] Button labeled "Keyboard Hold (PTT)"
- [ ] When activated, registers a global `keydown`/`keyup` listener (Space key, same `PTT_KEY` as main app)
- [ ] On key-down (after `PTT_HOLD_MS` = 200ms), calls `demoSttService.startSession({ forceHold: true })`
- [ ] On key-up, calls `demoSttService.endSession()`
- [ ] Same hold-delay and text-input guard logic as `App.tsx` lines 151-207
- [ ] If STT toggle is ON: audio chunks are sent to BFF via `chunkSink` → `sendBinary`; transcripts returned via WS
- [ ] If STT toggle is OFF: audio chunks are captured by the STT service (mic level, VAD work normally) but `chunkSink` discards them — no audio leaves the browser
- [ ] Deactivating this mode removes the keyboard listeners

### AC-4: Mode 3 — Mic Button Toggle (Single Press)
- [ ] Button labeled "Mic Toggle (Press & Release)"
- [ ] First press calls `demoSttService.startSession()` (VAD enabled, auto-stops on silence)
- [ ] Second press calls `demoSttService.endSession()` (manual stop)
- [ ] VAD silence detection auto-stops recording after configured silence time
- [ ] If STT toggle is ON: audio sent to BFF, transcripts returned
- [ ] If STT toggle is OFF: audio captured locally, discarded by `chunkSink`
- [ ] Visual recording indicator (animated red pulsing dot) shows when capture is active

### AC-5: STT Toggle Switch
- [ ] A toggle switch labeled "Send to STT" with default state OFF
- [ ] The STT toggle controls ONLY whether captured audio is sent to the Deepgram STT provider via the BFF — it does NOT affect audio capture, mic level, VAD, or wakeword detection
- [ ] When OFF: audio is captured by the STT service (mic opens, VAD runs, mic level updates) but the `chunkSink` is a no-op — no bytes leave the browser. Wakeword detection (mode 1) still runs normally using openWakeWord on its own mic
- [ ] When ON: audio chunks are sent to the BFF STT proxy via WebSocket, and `stt:transcript` messages are received back
- [ ] Transcription text (interim and final) is displayed in a scrollable log area on the demo page
- [ ] Each transcript entry shows: timestamp, interim/final badge, and text
- [ ] The toggle can be flipped at any time; it takes effect on the next recording session

### AC-6: Live Visual State Indicators
- [ ] A state indicator panel is always visible showing the current pipeline state with clear labels and color coding:
  - **Idle** (gray): No mode active, mic closed
  - **Listening for wake word** (blue pulsing): Wakeword mode active, openWakeWord engine running, waiting for trigger
  - **Wake detected** (yellow flash): Wakeword just fired, transitioning to capture
  - **Recording** (red pulsing dot + animated mic icon): Audio capture active (any mode) — mic is open, VAD running, chunks being produced
  - **Capturing... (hold key)** (red solid): PTT mode, key is held down
  - **Shipping audio** (orange): Silence timer fired, audio being assembled and sent to BFF
  - **Error** (red static): Error message displayed with details
- [ ] State transitions are logged in a timestamped event log below the indicators (e.g. "12:34:56 — Recording started", "12:34:59 — Silence detected, shipping audio")
- [ ] The mic level meter (0-100% bar) updates in real-time from `sttService.onMicLevel()` during any active capture

### AC-7: Captured Audio Playback
- [ ] After each recording session completes (VAD auto-stop, manual stop, or wakeword silence timer), the captured audio is assembled into a playable clip and displayed in the UI
- [ ] The audio clip is stored as a `Blob` (WAV or webm/opus) created from the raw PCM chunks captured during the session
- [ ] Each captured clip is displayed as a card in a "Captured Audio" section showing:
  - Timestamp of capture
  - Duration (computed from chunk count and sample rate)
  - An `<audio>` element with playback controls (play/pause, seek, volume)
  - The recording mode label (Wakeword / PTT / Mic Toggle)
  - Whether it was sent to STT (based on toggle state at capture time)
- [ ] Multiple clips accumulate (newest first) — the user can compare multiple captures
- [ ] A "Clear All" button removes all captured clips
- [ ] The audio is the exact PCM data that would be (or was) sent to the STT service — this validates the capture quality

### AC-8: Transcript Display
- [ ] When STT toggle is ON, a scrollable transcript log shows all received transcripts
- [ ] Each entry: timestamp, interim/final badge (colored), text content
- [ ] Interim transcripts update in-place until finalized
- [ ] When STT toggle is OFF, the transcript area shows "STT disabled — transcripts will not appear"

### AC-9: Agent Isolation
- [ ] The demo page does NOT import or initialize `useWebSocket`, `useAgentStore`, `agentStore`, or any agent-related code
- [ ] When STT toggle is ON, the demo opens a minimal raw WebSocket to the BFF solely for receiving `stt:transcript` messages — it does NOT send any `command` messages or interact with the agent pipeline
- [ ] When STT toggle is OFF, no WebSocket connection is opened at all (wakeword detection still works via openWakeWord's own mic)
- [ ] Transcripts are display-only; they are not forwarded to any command pipeline

---

## Technical Requirements

### Architecture Compliance
- Follows the existing service-oriented pattern: `sttService` and `wakewordService` are singletons imported from `services/stt/index.ts` and `services/wakeword/index.ts`
- Uses `createSttService()` factory with custom `chunkSink`/`endSink` deps for the demo (toggle-aware)
- **Key distinction:** The wakeword service (openWakeWord) is a SEPARATE service from STT. Wakeword detection runs on its own mic via the WASM engine. STT is the pipeline that sends captured audio to Deepgram. The STT toggle controls the latter, not the former.

### Wakeword + STT Toggle Interaction (Corrected)
The wakeword service has two phases:
1. **Detection phase:** openWakeWord engine listens on its own mic for "Hey Jarvis" — this is completely independent of STT and always runs when wakeword mode is active
2. **Capture phase:** After wakeword fires, the service captures post-wake command audio and ships it via `sendBinary`/`sendMessage` to the BFF STT proxy

The STT toggle controls phase 2:
- **STT ON:** Audio shipped to BFF → Deepgram → transcripts returned
- **STT OFF:** The `sendBinary`/`sendMessage` calls in the wakeword service are effectively no-ops because no WebSocket is connected (the demo only opens a WS when STT is ON). The wakeword detection still works, the capture still happens internally, but the audio never leaves the browser. The captured audio is still available for playback (AC-7).

**Implementation:** When STT toggle is OFF, the demo does NOT open a WebSocket. The wakeword service calls `sendBinary`/`sendMessage` which hit `sinks.ts` — but `gSocket` is null, so the calls are silently dropped. This is the existing behavior of the sinks when no WS is connected. No patching needed.

When STT toggle is ON, the demo opens a minimal WS. The wakeword service's `sendBinary`/`sendMessage` calls now go through to the BFF because `gSocket` is set.

### STT Toggle Implementation
```typescript
// The demo creates its own STT service with a conditional chunkSink
// For modes 2 & 3 (PTT / Mic Toggle):
let sttEnabled = false;

const demoSttService = createSttService({
  chunkSink: (data) => {
    if (!sttEnabled) return; // Discard — no WS, no BFF call
    sendBinary(data);        // Send to BFF when STT is on
  },
  endSink: () => {
    if (!sttEnabled) return;
    sendMessage({ type: "voice:end" });
  },
});
```

For mode 1 (Wakeword): The wakeword service is a singleton that calls `sendBinary`/`sendMessage` directly. The STT toggle controls whether a WS exists (and thus whether those calls succeed). No custom instance needed.

### Captured Audio Playback Implementation
After each recording session completes, the demo assembles the raw PCM chunks into a playable audio blob:

```typescript
// Collect chunks during recording
const capturedChunks: ArrayBuffer[] = [];

// In the STT service's chunkSink (or wakeword's capture callback):
function chunkSink(data: ArrayBuffer) {
  capturedChunks.push(data.slice(0)); // Copy the chunk
  if (sttEnabled) sendBinary(data);   // Also send to BFF if STT on
}

// When session ends, assemble into a Blob:
function assembleCapture(): Blob {
  // All chunks are 16kHz mono Int16 PCM
  // Concatenate into one buffer
  const totalLen = capturedChunks.reduce((s, c) => s + c.byteLength, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of capturedChunks) {
    merged.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  // Create WAV blob from raw PCM
  return pcmToWavBlob(merged, 16000, 1);
}

// pcmToWavBlob: converts raw Int16 PCM to a WAV Blob with proper headers
// (44-byte WAV header + raw PCM data)
```

The WAV blob is set as the `src` of an `<audio>` element. Each capture is stored in a state array with metadata (timestamp, duration, mode, sttSent).

For wakeword mode: The wakeword service assembles pre-roll + command audio internally and calls `shipAudio`. The demo needs to intercept the raw chunks BEFORE they're shipped. Since `createWakewordService()` is not exported, the demo can:
- Subscribe to the wakeword service's internal state transitions (it doesn't expose a chunk event)
- **Alternative:** Use the demo's own STT service for the capture phase. When wakeword fires, start the demo STT service to capture audio. This means the demo intercepts the wakeword's `onWake` event and manually starts `demoSttService.startSession()`. The wakeword service's own capture pipeline is bypassed.
- **Recommended approach:** The wakeword service handles capture internally and ships via sinks. For the demo, accept that wakeword mode's captured audio is assembled by the wakeword service and shipped — but since the sinks are no-ops when STT is OFF, the audio is effectively "captured and discarded." For playback validation in wakeword mode, the demo should:
  1. When STT is ON: the audio goes to BFF and transcripts come back. Playback validates the audio quality by letting the user hear what was sent.
  2. When STT is OFF: the audio is captured by the wakeword service but the sinks drop it. To still get playback, the demo can open a hidden WS connection that receives nothing — or more practically, **always open a minimal WS for wakeword mode** so the sinks have somewhere to send, and capture the audio on the WS side. But this adds complexity.
  3. **Simplest approach:** For wakeword mode, only support playback when STT is ON. When STT is OFF, show a note: "Play back requires STT ON for wakeword mode." This avoids intercepting the wakeword service's internals.

### File Structure
```
packages/client/src/
  demo/
    AudioInputDemo.tsx          # Main demo page component
    DemoTranscriptLog.tsx       # Transcript log sub-component
    DemoMicMeter.tsx            # Mic level meter sub-component
    DemoStateIndicator.tsx      # Live state panel with colored indicators
    DemoCapturePlayback.tsx     # Captured audio cards with <audio> playback
    demo.css                    # Minimal demo-specific styles
```

Plus a small edit to `main.tsx` (hash-based route check, ~5 lines).

### Routing
The project has no client-side router — `main.tsx` renders `<App />` directly. Two options:

**Option A (preferred):** Add a simple hash-path check in `main.tsx` before rendering `<App />`. If `window.location.hash === "#/demo/audio-input"`, render `<AudioInputDemo />` instead. This avoids adding a router dependency and keeps the demo completely decoupled.

**Option B:** Add `react-router-dom` as a dependency and wrap the app. This is heavier and unnecessary for one demo route.

Use Option A. The demo entry in `main.tsx` should be:
```tsx
if (window.location.hash === "#/demo/audio-input") {
  const { AudioInputDemo } = await import("./demo/AudioInputDemo");
  createRoot(rootEl).render(<AudioInputDemo />);
} else {
  createRoot(rootEl).render(<StrictMode><App /></StrictMode>);
}
```

Access the demo at `http://localhost:5174/#/demo/audio-input`. The demo does NOT go through `AuthGate`.

### Transcript Display

The transcript flow depends on which mode is active:

**Modes 2 & 3 (PTT / Mic Toggle):** The demo's `createSttService()` instance sends audio via `chunkSink`. When STT toggle is ON, `chunkSink` calls `sendBinary(data)` which writes to the global WebSocket in `sinks.ts`. For transcripts to come back, the demo needs a live WebSocket. The demo must open a minimal WS connection to `ws://localhost:3001/ws` (the BFF) and on every `stt:transcript` message, call `demoSttService.emitTranscript({ text, interim, isFinal, speechFinal })`.

**Mode 1 (Wakeword):** The wakeword service calls `sendBinary`/`sendMessage` directly via the sinks module. Same WS connection handles the transcripts. The demo WS listener routes `stt:transcript` messages to `demoSttService.emitTranscript()`.

**Implementation pattern:**
```typescript
// In AudioInputDemo.tsx — lightweight WS for transcript receipt only
const wsRef = useRef<WebSocket | null>(null);

function connectTranscriptWs() {
  if (wsRef.current) return;
  const ws = new WebSocket(`ws://localhost:3001/ws`);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "stt:transcript") {
        demoSttService.emitTranscript({
          text: msg.text,
          interim: msg.interim,
          isFinal: msg.isFinal ?? msg.interim === false,
          speechFinal: msg.speechFinal ?? false,
        });
      }
    } catch { /* binary frame or parse error — ignore */ }
  };
  wsRef.current = ws;
}
```

The demo subscribes to `demoSttService.onTranscript()` and renders entries in `DemoTranscriptLog`.

### Visual State Indicators Implementation

The demo tracks a `DemoState` union type that maps to the UI indicators:

```typescript
type DemoState =
  | "idle"                    // Gray — no mode active
  | "wakeword-listening"      // Blue pulsing — openWakeWord engine running
  | "wakeword-detected"       // Yellow flash — wake just fired
  | "recording"               // Red pulsing — mic open, capture active
  | "recording-ptt"           // Red solid — PTT key held
  | "shipping"                // Orange — silence timer fired, audio being sent
  | "error";                  // Red static — error occurred
```

State transitions are driven by:
- `sttService.onStateChange()` → recording / idle / error
- `sttService.onMicLevel()` → drives the mic level bar
- `wakewordService.onWake()` → wakeword-detected transition
- Mode button clicks → idle ↔ wakeword-listening / recording-ptt
- Silence timer / endSession → shipping → idle

Each transition is logged with a timestamp in a scrollable event log.

### Styling
- Use Tailwind utility classes consistent with the existing `App.css` / `index.css` dark theme
- Minimal layout: vertical stack, centered, max-width ~600px
- No animations or framer-motion (keep it simple)

---

## Dev Notes

### Files Being Modified (UPDATE)
| File | Change |
|------|--------|
| `packages/client/src/main.tsx` | Add ~5 lines: hash check to render `AudioInputDemo` when `#/demo/audio-input` |

### Files Being Created (NEW)
| File | Purpose |
|------|---------|
| `packages/client/src/demo/AudioInputDemo.tsx` | Main demo page (demo STT service factory, WS transcript listener, mode state, captured audio state) |
| `packages/client/src/demo/DemoTranscriptLog.tsx` | Transcript log component |
| `packages/client/src/demo/DemoMicMeter.tsx` | Mic level meter component |
| `packages/client/src/demo/DemoStateIndicator.tsx` | Live state panel with colored indicators and event log |
| `packages/client/src/demo/DemoCapturePlayback.tsx` | Captured audio cards with `<audio>` playback |
| `packages/client/src/demo/demo.css` | Demo-specific styles |

### Key Service Interfaces to Use

**SttService** (`services/stt/types.ts`):
- `startSession(opts?: { forceHold?: boolean })` — starts mic capture
- `endSession()` — ends capture, sends end signal
- `abortSession()` — force close, no end signal
- `onTranscript(listener)` — subscribe to transcripts
- `onStateChange(listener)` — subscribe to state changes (capturing, error)
- `onMicLevel(listener)` — subscribe to mic level [0,1]
- `onError(listener)` — subscribe to errors
- `emitTranscript(t)` — push transcript from WS into service

**WakewordService** (`services/wakeword/types.ts`):
- `start()` — begins wakeword listening
- `stop()` — stops listening
- `onWake(listener)` — subscribe to wake events
- `getState()` — returns { supported, listening, error }

**createSttService(deps)** (`services/stt/service.ts`):
- `deps.chunkSink: (data: ArrayBuffer) => void` — called for each PCM chunk
- `deps.endSink: () => void` — called when session ends cleanly
- `deps.abortSink?: () => void` — called on force abort
- `deps.vad?: { rmsThreshold: number; silenceMs: number }` — override VAD config

### STT Service Singleton vs Demo Instance
- The production singleton (`sttService` from `services/stt/index.ts`) has `chunkSink: sendBinary` hardcoded
- The demo MUST create its own instance via `createSttService()` with a toggle-aware chunkSink
- This means importing `createSttService` from `./service.ts` directly (not the singleton)
- The wakeword service is a singleton — its `shipAudio` calls `sendBinary` directly. When STT toggle is OFF, those calls are silently dropped (no WS connected). Wakeword detection still runs normally.

### Wakeword Service — No Custom Instance Needed
The `createWakewordService()` factory is not exported from `services/wakeword/index.ts`. The demo uses the singleton `wakewordService`. The wakeword service's `shipAudio` calls `sendBinary`/`sendMessage` directly — these hit `sinks.ts` which checks `gSocket`. When the demo hasn't opened a WS (STT OFF), the calls are silently dropped. When the demo has opened a WS (STT ON), the calls go through. No patching or wrapping needed.

For captured audio playback (AC-7) in wakeword mode: The wakeword service assembles pre-roll + command audio internally and ships it via the sinks. The demo cannot intercept the raw chunks without modifying the service. **Workaround:** When STT is ON, the audio is shipped to the BFF via the demo's WS. The demo can listen for its own `sendBinary` calls by wrapping the `sinks.ts` functions temporarily — but this is fragile. **Simpler approach:** For wakeword mode, the captured audio playback shows a note: "Wakeword audio is assembled and shipped by the wakeword service. To validate audio quality, check the STT transcript accuracy." For modes 2 & 3, the demo has full control over chunk collection and can provide playback.

### Dependencies
- React 19 (existing)
- Tailwind CSS 4 (existing)
- `@jarvis/shared` — `STT_AUDIO_FORMAT`, `DEFAULT_CLIENT_CONFIG`
- `services/stt/service` — `createSttService`
- `services/wakeword` — `wakewordService` singleton
- `services/ws/sinks` — `sendBinary`, `sendMessage` (for STT toggle ON path)
- `lucide-react` — icons (Mic, MicOff, Radio, Keyboard, ToggleLeft, ToggleRight, Play, Pause, Trash2, Circle)

### What NOT to Touch
- Do NOT modify `App.tsx` or any existing component
- Do NOT modify `services/stt/index.ts` or `services/wakeword/index.ts`
- Do NOT modify `services/ws/sinks.ts`
- Do NOT add any npm dependencies
- Do NOT add the demo to any production build paths
- Do NOT try to export `createWakewordService` — use the singleton

---

## Testing

### Manual Test Plan
1. Navigate to `http://localhost:5174/#/demo/audio-input`
2. **STT OFF — Mic Toggle test:** Toggle STT OFF, click Mic Toggle, speak, verify mic level moves, verify NO WS frames in Network tab, verify captured audio card appears with playable clip
3. **STT OFF — PTT test:** Toggle STT OFF, click Keyboard Hold, hold Space, speak, release, verify captured audio card appears, verify no WS frames
4. **STT ON — Mic Toggle test:** Toggle STT ON, click Mic Toggle, speak, verify mic level moves, verify WS frames in Network tab, verify transcript appears in log, verify captured audio card appears
5. **STT ON — PTT test:** Toggle STT ON, click Keyboard Hold, hold Space, speak, release, verify transcript and audio card
6. **STT ON — Wakeword test:** Toggle STT ON, click Always Listening, say "Hey Jarvis", verify wake event logged, verify "Recording..." state, speak a command, verify transcript and audio card
7. **STT OFF — Wakeword test:** Toggle STT OFF, click Always Listening, say "Hey Jarvis", verify wake event detected, verify no audio sent, verify state shows "STT OFF" note
8. **Visual indicators test:** Verify state panel updates correctly through all transitions (idle → recording → shipping → idle)
9. **Mode switching:** Activate one mode, click another, verify first mode deactivates cleanly, state returns to idle
10. **Audio playback test:** After capture, click play on the audio card, verify audio plays back correctly
11. **Clear all test:** Capture multiple clips, click "Clear All", verify all removed
12. **Error handling:** Deny mic permission, verify error message displayed in state panel

### Automated Tests
Not required for this story — this is a manual debug/validation tool.

---

## Checklist

- [x] Demo page renders at `#/demo/audio-input` without auth
- [x] Three mode buttons work independently (only one active at a time)
- [x] STT toggle defaults to OFF
- [x] STT OFF: no audio sent to BFF (verified via Network tab)
- [x] STT ON: transcripts appear in log
- [x] Wakeword detection runs independently of STT toggle
- [x] Visual state indicators update correctly through all transitions
- [x] Mic level meter updates in real-time
- [x] Captured audio appears as playable clip after each recording
- [x] Audio playback works (plays back the captured PCM data)
- [x] Mode deactivation cleans up listeners and stops capture
- [x] No agent code imported or activated
- [x] Existing app functionality unaffected

## File List

| File | Action |
|------|--------|
| `packages/client/src/demo/AudioInputDemo.tsx` | Created |
| `packages/client/src/demo/DemoMicMeter.tsx` | Created |
| `packages/client/src/demo/DemoStateIndicator.tsx` | Created |
| `packages/client/src/demo/DemoTranscriptLog.tsx` | Created |
| `packages/client/src/demo/DemoCapturePlayback.tsx` | Created |
| `packages/client/src/demo/demo.css` | Created |
| `packages/client/src/main.tsx` | Modified (hash route) |
