# Technology Stack

## Frontend

- **Framework:** React 18+ with Vite
- **Language:** TypeScript
- **Styling:** Tailwind CSS + custom CSS for neon/glow effects
- **Animation:** Framer Motion (React animations), Canvas API or Three.js for AI brain visualization
- **State:** React Context + useReducer for app state; WebSocket for real-time events
- **Wake Word:** Porcupine (Picovoice) or similar lightweight on-device wake word detector running in the browser
- **STT:** Deepgram Speech-to-Text API — invoked only after wake word detection; captures full continuous utterance
- **TTS:** Deepgram Text-to-Speech API — called by agent tool or BFF; audio played in browser
- **Auth:** Simple password form → JWT or session token stored in cookie/localStorage
- **Weather:** Frontend fetches directly from weather API (e.g., OpenWeatherMap) — no agent involved

## BFF (Backend for Frontend)

- **Runtime:** Node.js with TypeScript
- **Framework:** Express or Fastify
- **Real-time:** WebSocket server (ws or Socket.IO) for streaming agent updates to frontend
- **CLI integration:** Child process spawning of Hermes agent CLI; stdout/stderr capture and event parsing
- **Auth:** Password verification middleware; token issuance
- **API Proxying:** Proxies Deepgram API calls (STT/TTS) to keep API keys server-side
- **Deployment:** BFF, web client static files, and Hermes CLI all run on the same machine

## Hermes Agent Integration

- Agent runs as a subprocess invoked by the BFF
- Communication: stdin (commands) / stdout+stderr (responses, tool calls, commentary)
- Agent personality and commentary behavior specified in SOUL.md/AGENTS.md
- Custom output protocol: agent emits structured JSON events on stdout for:
  - `tool_call`: tool invocation started
  - `tool_result`: tool execution result
  - `commentary`: mid-execution voice text (triggers TTS tool)
  - `response`: final response text
  - `browser_open`: URL to open in user's browser
- Widget events (`widget:*`) deferred to Phase 2

## Deployment

- Frontend: Static build served by BFF
- BFF: Single Node.js process
- All components (BFF, static files, Hermes CLI) colocated on one machine
- User accesses dashboard remotely from another computer or mobile device via browser
- Communication: HTTPS + WSS (WebSocket Secure) between browser and BFF
