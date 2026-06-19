# Voice Interaction Model

## State Machine

```
                  ┌──────────┐
                  │   IDLE   │ ◄────────────────────────────┐
                  │ (passive │                              │
                  │  listen) │                              │
                  └────┬─────┘                              │
                       │ wake word detected                 │
                       │ (full utterance capture begins)    │
                       ▼                                    │
                  ┌──────────┐                              │
                  │ACTIVATED │ (visual + audio chime)       │
                  │ streaming│ Deepgram STT starts          │
                  │ to STT   │                              │
                  └────┬─────┘                              │
                       │ STT complete → command text        │
                       ▼                                    │
                  ┌──────────┐                              │
                  │PROCESSING│ command → Hermes agent       │
                  │ (working)│◄── periodic commentary ──┐   │
                  └────┬─────┘                          │   │
                       │                                │   │
          ┌────────────┼────────────┐                   │   │
          ▼            ▼            ▼                   │   │
    ┌──────────┐ ┌──────────┐ ┌──────────┐              │   │
    │SPEAKING  │ │EXECUTING │ │COMMENTARY│──────────────┘   │
    │(final)   │ │(tool)    │ │(mid-task)│                  │
    └────┬─────┘ └────┬─────┘ └──────────┘                  │
         │            │                                      │
         └────────────┼────── response complete              │
                      ▼                                      │
               ┌──────────┐                                  │
               │FOLLOW-UP │ (N-second window)                │
               │ WINDOW   │── new command → PROCESSING       │
               └────┬─────┘                                  │
                    │ window expires OR "dismiss"             │
                    └────────────────────────────────────────┘
```

## Wake Word & Audio Pipeline

- **IDLE:** A lightweight on-device wake word detector (Porcupine/Picovoice) runs continuously in the browser. No audio data is sent over the network in this state — eliminates Deepgram cost during silence.
- **On Detection:** The detector fires the moment "JARVIS" (configurable) is recognized. The microphone audio stream is immediately captured from this point — including the wake word phrase and everything after.
- **Alexa-style flow:** The user says "JARVIS show me the weather" as one continuous sentence. The wake word detector triggers on "JARVIS" and the full audio buffer from that moment is streamed to Deepgram STT. No pause between wake word and command.
- **Audio Buffer:** A small rolling buffer (~2 seconds) is maintained so the STT stream includes audio from the instant of detection — no words are lost.

## States

### IDLE
- Porcupine wake word detector runs locally in the browser
- Audio is processed entirely on-device; no network transmission
- Wake word "JARVIS" (configurable) triggers transition to ACTIVATED
- Visual: brain core slow pulse, dim cyan, "Say JARVIS..." hint

### ACTIVATED
- Triggered by wake word detection
- Audio chime confirms activation (short, distinctive sound)
- Full audio stream (from wake word moment) is sent to Deepgram STT via BFF proxy
- STT result text appears as visual confirmation
- Visual: brain core brightens, ring expands, listening waveform pulses
- Timeout: if no speech detected within 8 seconds of activation, returns to IDLE
- User speaks naturally — no waiting for a "ready" prompt

### PROCESSING
- Command text (wake word stripped) dispatched to BFF → Hermes agent
- Agent begins work
- Visual: brain core rotates, data streams animate, "Thinking..." label
- Agent may emit COMMENTARY or EXECUTING events during this state

### COMMENTARY (mid-task voice)
- Agent calls a dedicated TTS tool with commentary text (e.g., "Checking the weather now...")
- BFF sends text to Deepgram TTS; audio streamed back and played in browser
- Visual: brain pulses in sync with speech, waveform rings
- Agent continues processing — commentary is non-blocking
- Multiple commentary events may occur per task

### EXECUTING (tool call)
- Agent signals it's running a tool
- Tool name and brief description appear in log panel
- Visual: neural nodes flash, data pulse effect
- May overlap with COMMENTARY state

### SPEAKING (final response)
- Agent sends final response text
- BFF sends to Deepgram TTS; audio played in browser
- Visual: brain pulses with speech waveform, full glow
- Response text also appears in log panel

### FOLLOW-UP WINDOW
- After final response, JARVIS stays active for N seconds (default 5, configurable)
- User can speak follow-up without re-waking
- STT remains active during this window
- Window timer resets on each follow-up
- Visual: brain core stays bright but dims slightly, countdown indicator
- "Dismiss", "thank you", "that's all" → immediate return to IDLE
- Window expiry → return to IDLE

## Cancellation

- Voice commands: "dismiss", "thank you JARVIS", "that's all", "stop", "cancel"
- UI: dedicated dismiss button (always visible when not IDLE)
- Effect: immediately stops TTS playback, signals agent to abort, returns to IDLE

## Error Handling

- Wake word detector unavailable: show permanent warning, text-input-only mode available
- Deepgram STT failure: display "Sorry, I didn't catch that" (text + brief TTS fallback), return to IDLE
- Deepgram TTS failure: display response as text only, show subtle error indicator
- Agent timeout (no response after 30s): display "I'm having trouble with that" (text + voice), return to IDLE
- Connection loss: visual indicator in status bar, auto-reconnect, queue missed commands
- Microphone permission denied: show persistent warning, text-input-only mode
