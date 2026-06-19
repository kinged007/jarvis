---
id: SPEC-wakeword-listening
companions: []
sources:
  - SERVICE_MAP.md
  - packages/client/src/services/wakeword/types.ts
  - packages/client/src/services/wakeword/stub.ts
  - packages/client/src/services/stt/service.ts
  - packages/shared/src/config.ts
  - .env.example
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability only — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Wakeword Listening Service — Always-On Voice Activation with openWakeWord

## Why

The web UI requires a manual button press to activate the microphone. A constant wakeword listening service (ambient, always-on detection of a spoken trigger like "jarvis") enables hands-free voice activation. This is an **opportunity to capture** — the browser `getUserMedia` API already works, the STT pipeline is proven, and openWakeWord is already a project dependency. Browser security requires the service to gate on HTTPS or localhost — without these, `getUserMedia` is unavailable and the service must remain inert.

## Capabilities

- id: CAP-1
  intent: Service determines at construction and on demand whether the browser environment supports constant audio capture (secure context: HTTPS or localhost; `getUserMedia` available) and exposes this via a synchronous `supported` flag.
  success: On an insecure origin (not localhost, not HTTPS), `wakewordService.getState().supported` is `false` and the service never attempts to open a `MediaStream`. On localhost or HTTPS, `getState().supported` is `true`.

- id: CAP-2
  intent: Service maintains a constant `AudioContext` + `MediaStream` capture loop when `start()` is called, recording 16kHz mono Float32 audio into a rotating pre-roll ring buffer. Each raw chunk is fed to the openWakeWord `Model.predict()` for wakeword detection.
  success: When started and `supported` is `true`, the service runs a continuous mic capture loop that populates the pre-roll buffer and feeds chunks to the wakeword detector. `getState().listening` is `true`. When `stop()` is called, the mic stream and `AudioContext` tear down cleanly and `listening` flips to `false`.

- id: CAP-3
  intent: When openWakeWord detects the configured wakeword (default keyword: `hey_jarvis`, threshold: `VITE_WAKEWORD_THRESHOLD`, default `0.5`), the service fires `onWake` listeners, pops the pre-roll buffer (N seconds before detection), arms the VAD-based silence detector, and continues recording post-wakeword audio.
  success: Subscribers receive the `onWake` callback. `takePreRollBuffer()` returns a `Float32Array` of the pre-roll audio. Post-wakeword audio accumulates until VAD triggers. While capturing a command, wakeword detection is gated by the engine's own 2-second cooldown (so a single utterance can only fire one detection). The threshold of 0.5 is layered on top of the engine's VAD confirmation and cooldown gating.

- id: CAP-4
  intent: VAD halts command recording after a configurable silence duration (`VITE_WAKEWORD_SILENCE_MS`, default 3000ms) is reached post-wakeword. The service assembles the captured audio (pre-roll + post-wakeword) into a single `Int16Array` encoded to `STT_AUDIO_FORMAT` chunks, ships them to the BFF via the WebSocket `voice:chunk` / `voice:end` wire protocol, then resumes wakeword listening.
  success: After the user says the wakeword followed by a command and falls silent for `VITE_WAKEWORD_SILENCE_MS`, the complete audio is sent to the BFF as binary `voice:chunk` frames followed by `voice:end`. The existing WS dispatcher routes `stt:transcript` through `sttService.emitTranscript()` into the standard voice pipeline.

- id: CAP-5
  intent: If the wakeword is spoken while the agent is processing or speaking, the service fires `onWake` and the consumer (App.tsx) cancels the active agent run via `cancelCommand`, clears the TTS queue, and starts a fresh STT session for the new command.
  success: While the agent is mid-response, saying the wakeword sends a `cancel` WS frame, the agent run is stopped, TTS playback stops, and the new command is captured and processed as a fresh run.

- id: CAP-6
  intent: The service auto-starts when the BFF and agent are both online (if `VITE_WAKEWORD_AUTO_START=true`, default `true`). If auto-start fails (e.g. mic permission denied, model init failure), the service stays disabled until the user manually activates it via the UI indicator. If `VITE_WAKEWORD_AUTO_START=false`, the service starts disabled and the user must click the indicator to activate.
  success: When `VITE_WAKEWORD_AUTO_START=true` and the BFF reports `agentReady: true`, the wakeword service starts automatically and the UI indicator shows the listening state. If startup fails, `error` is set and the indicator shows the disabled state. When `VITE_WAKEWORD_AUTO_START=false`, the indicator shows disabled until clicked.

- id: CAP-7
  intent: A small Web UI indicator shows whether the wakeword service is listening, disabled, or in an error state. Clicking the indicator toggles the service on/off. The indicator is part of the status bar header.
  success: The status bar shows a wakeword indicator icon (ear/radio-wave) plus a visible text label (`WAKEWORD: LISTENING` / `IDLE` / `OFF` / `ERROR — {msg}`). Green pulsing = listening. Grey = disabled/supported but off. Red = error. Clicking toggles between listening and disabled states. A tooltip on hover shows the current state text.

- id: CAP-8
  intent: The silence timeout for VAD (`VITE_WAKEWORD_SILENCE_MS`, default 3000ms) is a single env variable used by both the wakeword service's post-wakeword VAD and the STT service's push-to-talk VAD, keeping the silence behaviour consistent between the two input modes.
  success: Changing `VITE_WAKEWORD_SILENCE_MS` to `2000` in the .env file and restarting dev results in both the wakeword command capture and the push-to-talk mic capture ending after 2 seconds of silence.

- id: CAP-9
  intent: The service is an independent, separately-importable module in `packages/client/src/services/wakeword/` replacing the current stub with a real openWakeWord-based implementation. It depends on `ws/sinks.ts` for `sendBinary`/`sendMessage`, on `shared` for audio format constants, and on the `WakeWordEngine` from `openwakeword-wasm-browser` (which provides AudioWorklet-based mic capture, the 3-stage ONNX inference pipeline, and VAD-gated detection events). It does not import from or couple to the STT service, voice store, TTS service, or React.
  success: `import { wakewordService } from "../services/wakeword"` provides the same `WakewordService` interface. The existing `useWakeWord` hook requires only minor additions for the new capabilities (auto-start, toggle). The service can be unit-tested in isolation by injecting mock sinks and a mock detector. The main thread runs ORT inference via the engine — no separate Web Worker, no module-worker gotchas.

## Constraints

- Must gate activation on `window.isSecureContext === true` (covers HTTPS and localhost) OR an explicit fallback check for `window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"`. Also requires `AudioContext` and `navigator.mediaDevices.getUserMedia` to be available.
- Must follow the existing service directory convention: `types.ts` (contract), `service.ts` (implementation replacing `stub.ts`), and `index.ts` (singleton export).
- Must use `STT_AUDIO_FORMAT` (16kHz mono Int16, 100ms chunks) when re-encoding captured audio for the wire.
- Must ship captured audio via `sendBinary(ArrayBuffer)` and `sendMessage({type:"voice:end"})` from `services/ws/sinks.ts`. No BFF changes required.
- Config values (`wakewordPreRollSec`, `wakewordSilenceMs`, `wakewordAutoStart`) must be added to `ClientRuntimeConfig` in `packages/shared/src/config.ts`. The silence value is also exposed as `VITE_WAKEWORD_SILENCE_MS` for Vite env access.
- Must use `openwakeword-wasm-browser` for wakeword detection. The `WakeWordEngine` class owns the wakeword-detection AudioContext + MediaStream. The JARVIS service opens a SECOND MediaStream on the same device for command capture (browsers share mic hardware across consumers).
- All three browser audio processing flags (`echoCancellation`, `noiseSuppression`, `autoGainControl`) MUST be `false` in BOTH `getUserMedia` calls (engine's wakeword mic and our command mic). They distort the frequency content openWakeWord relies on and add latency.
- The detection threshold defaults to `0.5` (configurable via `VITE_WAKEWORD_THRESHOLD`). The engine layers VAD confirmation + a 2s cooldown on top, so the 0.5 is calibrated for that gating — going lower invites false positives.
- Engine error events must set `state.error` so the UI indicator shows `WAKEWORD: ERROR — {msg}`.
- The existing `WakewordService` interface (`types.ts`) is the contract surface — extensions must be backward-compatible with `useWakeWord`.
- The wakeword service manages its own audio streams independent of the STT service's mic capture. All three (wakeword mic, command mic, STT push-to-talk mic) can coexist.

## Non-goals

- Training a custom "jarvis" ONNX wakeword model. The default uses the pre-trained `hey_jarvis_v0.1.onnx` shipped with `openwakeword-wasm-browser`, which fires on "hey jarvis" (and incidentally "hey mycroft"). The service infrastructure supports any keyword from the library's MODEL_FILE_MAP — swapping is a `VITE_WAKEWORD_MODEL` env change.
- Replacing the push-to-talk microphone flow. The mic button in `App.tsx` and `useAudioCapture` → `sttService` path remain unchanged and work independently.
- Modifying the BFF STT endpoint or the `voice:chunk`/`voice:end` wire protocol.
- Wakeword re-arm debounce beyond the engine's built-in 2s cooldown + a 600ms client-side cooldown.
- Offline STT processing. The STT pipeline still requires the BFF/Deepgram connection.

## Success signal

Run `pnpm dev`, open the web UI on `http://localhost:5174`. After login, the wakeword indicator in the status bar pulses green (listening). Say "hello deepa" (placeholder model) — the audio is captured, shipped to the BFF, transcribed, and the agent responds — without touching the mic button or keyboard. While the agent is speaking, say the wakeword again — the agent cancels, TTS stops, and the new command is processed. Click the indicator to disable listening; it turns grey. Click again to re-enable.

## Assumptions

- Assumed `openwakeword-js` v0.1.27 works in modern Chrome/Firefox with the bundled ONNX WASM runtime. ONNX WASM issues noted in the stub were assumed resolved.
- Assumed the wakeword model files (`melspectrogram.onnx`, `embedding_model.onnx`) are already in `public/models/` and served by Vite at runtime.
- Assumed `window.isSecureContext` covers the common localhost case; the fallback hostname check is present for edge cases.
- Assumed the VAD in the wakeword service re-uses the same RMS-based approach as `stt/service.ts` (RMS threshold + silence timer), with the silence duration configured by `VITE_WAKEWORD_SILENCE_MS`.
- Assumed a single `sendBinary`/`sendMessage` call per chunk during command audio shipping (the WS is already open from the ongoing connection).

## Open Questions

- Should the wakeword service require an explicit user gesture (e.g., a first mic button click) before starting, to satisfy browser autoplay policies, or does auto-start via `VITE_WAKEWORD_AUTO_START` work without one?
- ~~What wakeword model should be the default for a "jarvis" detection?~~ **Resolved**: pre-trained `hello_jarvis` model from openWakeWord v0.5.1 release. May also fire on "hey mycroft" — acceptable since neither word is in the user's natural vocabulary.
