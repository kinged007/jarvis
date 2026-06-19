/usr/bin/bash: warning: setlocale: LC_ALL: cannot change locale (en_GB.UTF-8): No such file or directory
---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
inputDocuments:
  - _bmad-output/specs/spec-jarvis/SPEC.md
  - _bmad-output/specs/spec-jarvis/stack.md
  - _bmad-output/specs/spec-jarvis/ux-vision.md
  - _bmad-output/specs/spec-jarvis/voice-interaction-model.md
  - _bmad-output/specs/spec-jarvis/widget-system.md
workflowType: 'architecture'
project_name: 'jarvis'
user_name: 'Josh'
date: '2026-06-02'
lastStep: 8
status: 'complete'
completedAt: '2026-06-02'
---

# Architecture Decision Document

## Input Summary

**Canonical contract:** SPEC-jarvis — 18 capabilities. Colocated deployment (BFF + client + Hermes CLI on same machine). Deepgram STT/TTS. Porcupine wake word. Alexa-style continuous utterance capture. Widgets Phase 2.

**Stack:** React 18+ / Vite / TypeScript. Fastify BFF with WebSocket. Hermes agent as subprocess. Deepgram proxied through BFF. Porcupine browser-side.

**UX:** Dark neon Tron/Ironman theme. AI brain centerpiece (Web Worker + OffscreenCanvas). Widget panel, log panel, voice status bar. Voice-first with text fallback.

## Project Context Analysis

**Functional domains:** Voice pipeline (CAP-1–5, 18), Dashboard UI (CAP-8–9, 13–14, 16), Agent integration (CAP-3–4, 10, 17), Session/interaction (CAP-6–7, 11–12).

**Critical NFRs:** STT <1s, TTS first-audio <1s, wake word <500ms, agent first response <2s, voice ≤30s, disconnect detection <5s.

**Complexity:** Medium-High. Full-stack TypeScript monorepo. Six key subsystems.

**Cross-Cutting Concerns:** Real-time WebSocket protocol, voice pipeline resilience, animation performance (Web Worker), subprocess lifecycle, API key security.

## Starter Template Evaluation

Monorepo with pnpm workspaces. `npm create vite@latest packages/client -- --template react-ts` for frontend. Custom Fastify for BFF. Shared `packages/shared` for protocol types.

**Project structure:** `packages/client` (React), `packages/bff` (Fastify), `packages/shared` (types), `docs/SOUL.md`, `config/Caddyfile`, `config/jarvis.service`.

## Core Architectural Decisions

### Data Architecture
No database. Env vars for config. localStorage for transient state.

### Authentication & Security
JWT in httpOnly cookie. bcrypt-hashed password via `JARVIS_PASSWORD` env var. Deepgram + weather API keys server-side only. HTTPS via Caddy + Let's Encrypt. No Docker (Hermes needs host CLI).

### API & Communication

**WebSocket protocol:** Single channel, typed discriminated union (`shared/messages.ts`):

```typescript
type ServerMessage =
  | { type: "agent:commentary"; text: string }
  | { type: "agent:response"; text: string }
  | { type: "agent:tool_call"; tool: string; args: Record<string, unknown> }
  | { type: "agent:tool_result"; tool: string; output: string }
  | { type: "agent:browser_open"; url: string }
  | { type: "system:heartbeat"; timestamp: number }
  | { type: "system:status"; connected: boolean; uptime: number }
  | { type: "stt:transcript"; text: string; interim: boolean }
  | { type: "tts:audio"; data: ArrayBuffer }
  | { type: "error"; message: string };

type ClientMessage =
  | { type: "command"; text: string }
  | { type: "voice:chunk"; data: ArrayBuffer }
  | { type: "voice:end" }
  | { type: "cancel" }
  | { type: "auth"; token: string };
```

**REST:** POST `/api/auth/login`, GET `/api/health`, GET `/api/weather?lat=X&lon=Y`.

**Voice flow:** Browser mic → Porcupine wake word → audio capture → WS to BFF → BFF WS to Deepgram STT → transcripts back. Agent calls TTS tool → BFF → Deepgram REST → audio chunks via WS → Web Audio API playback.

**Agent:** Subprocess of BFF. Stdin commands (JSON). Stdout structured JSON events → BFF routes to WS clients.

### Frontend Architecture

**State:** Zustand — `voiceStore`, `agentStore`, `widgetStore`, `authStore`. Independent, no cross-store imports.

**Component tree:** AuthGate → Dashboard → (WidgetPanel | BrainVisualization | LogPanel | VoiceStatusBar | TextInput).

**Brain rendering:** Web Worker + OffscreenCanvas. State transitions via postMessage. Main thread free for React + voice.

**Wake word:** Porcupine Web SDK. Callback on "JARVIS" → audio capture → WS stream.

### Infrastructure

```
[Caddy :443] → [BFF :3000] → [Hermes CLI subprocess]
                    ↕ WebSocket
           [Browser Client]
```

Systemd user service. BFF spawns Hermes on startup with auto-restart. Static build served by `@fastify/static`.

### Implementation Sequence
1. Monorepo scaffolding + shared types
2. BFF skeleton (Fastify, auth, agent manager)
3. WebSocket handler + Deepgram proxy
4. Client skeleton (Vite, Zustand, WS hook)
5. Auth flow (login → JWT → WS)
6. Wake word + audio capture
7. Voice pipeline E2E
8. Dashboard UI (brain, widgets, log)

## Implementation Patterns

**Naming:** Components `PascalCase.tsx`, hooks `useCamelCase.ts`, stores `camelCaseStore.ts`, workers `kebab-case.worker.ts`, WS messages `domain:action`, JSON fields `camelCase`.

**Structure:** Client: feature-based (`brain/`, `voice/`, `widgets/`, `log/`, `auth/`, `layout/`). BFF: layer-based (`routes/`, `ws/`, `agent/`, `voice/`, `middleware/`).

**Format:** Messages: flat `{ type, ...payload }`. REST errors: `{ error: { code, message } }`. Dates: ISO 8601.

**Communication:** WS is the single real-time channel. No polling/SSE. REST only for auth/health.

**Process:** Three error tiers (WS disconnect → reconnect; voice failure → fallback; agent crash → auto-restart). All async ops track `status: 'idle'|'loading'|'success'|'error'`.

**Enforcement:** `shared/messages.ts` catches protocol drift. Fastify schema validation for REST. ESLint: no cross-store imports.

## Project Structure & Boundaries

### Complete Tree

```
jarvis/
├── packages/
│   ├── shared/src/          # messages.ts, config.ts
│   ├── client/              # React + Vite
│   │   └── src/
│   │       ├── components/  # brain/, voice/, widgets/, log/, auth/, layout/
│   │       ├── hooks/       # useWebSocket, useWakeWord, useVoicePipeline, etc.
│   │       ├── state/       # voiceStore, agentStore, widgetStore, authStore
│   │       ├── workers/     # brain-renderer.worker.ts
│   │       └── lib/         # audio.ts, browser.ts, constants.ts
│   └── bff/                 # Fastify
│       └── src/
│           ├── routes/      # auth.ts, health.ts, weather.ts
│           ├── ws/          # handler.ts, router.ts, client-registry.ts
│           ├── agent/       # manager.ts, protocol.ts, events.ts
│           ├── voice/       # deepgram-stt.ts, deepgram-tts.ts
│           └── middleware/  # jwt-verify.ts, error-handler.ts
├── config/                  # Caddyfile, jarvis.service
├── docs/                    # SOUL.md
└── scripts/                 # dev.sh
```

### Capability Mapping

| CAP | Lives In |
|-----|----------|
| CAP-1 | `useWakeWord.ts`, `voiceStore.ts` |
| CAP-2 | `useAudioCapture.ts` → `deepgram-stt.ts` |
| CAP-3 | `useWebSocket.ts` → `agent/manager.ts` |
| CAP-4 | `agent/events.ts` → `agentStore.ts` → TTS |
| CAP-5 | `deepgram-tts.ts` → `useAudioPlayback.ts` |
| CAP-6 | `useFollowUp.ts`, `voiceStore.ts` |
| CAP-7 | `voiceStore.ts`, `useVoicePipeline.ts` |
| CAP-8 | `BrainVisualization.tsx`, `Dashboard.tsx` |
| CAP-9 | `brain-renderer.worker.ts`, `VoiceStatusBar.tsx` |
| CAP-10 | `LogPanel.tsx`, `LogEntry.tsx`, `agentStore.ts` |
| CAP-11 | `TextInput.tsx` |
| CAP-12 | `AuthGate.tsx`, `routes/auth.ts`, `jwt-verify.ts` |
| CAP-13 | `SystemStatusWidget.tsx`, `ws/handler.ts` |
| CAP-14 | `WeatherWidget.tsx` (frontend-only) |
| CAP-15 | `widgetStore.ts`, `WidgetFrame.tsx` (Phase 2) |
| CAP-16 | `WidgetFrame.tsx`, `widgetStore.ts` |
| CAP-17 | `agentStore.ts` (listens for `agent:browser_open`) |
| CAP-18 | `SOUL.md`, `deepgram-tts.ts` |

### Boundaries

- **Client ↔ BFF:** WebSocket (primary) + REST (auth/health). `shared/messages.ts` enforced.
- **BFF ↔ Hermes:** Subprocess stdin/stdout. JSON-line protocol.
- **BFF ↔ Deepgram:** WS (STT streaming), REST (TTS). Keys in BFF env only.
- **Brain Worker ↔ Main Thread:** `postMessage({ state: BrainState })`.

## Architecture Validation Results

### Coherence ✅
All technology choices compatible. Patterns consistent across client and BFF. Structure aligned with decisions. No contradictions.

### Requirements Coverage ✅
All 18 capabilities mapped. NFRs addressed. All constraints and non-goals respected.

### Implementation Readiness ✅
Decisions documented with rationale. Complete project tree defined. Patterns specified with examples and enforcement rules.

### Gap Analysis
No critical gaps. Two minor: Porcupine access key (provide via BFF config endpoint), Weather API key (proxy through BFF). Chime skipped — visual indicators sufficient.

### Completeness Checklist
All 16 items passed: requirements analysis (4), architectural decisions (4), implementation patterns (4), project structure (4).

### Readiness Assessment
**Status:** READY FOR IMPLEMENTATION. **Confidence:** High.

**Key strengths:** Shared protocol contract, clear voice pipeline separation, Web Worker brain isolation, dependency-ordered implementation sequence.

**Future:** Phase 2 widget DSL, WebRTC, PWA support.
