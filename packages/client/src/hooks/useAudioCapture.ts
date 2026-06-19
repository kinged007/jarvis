/**
 * useAudioCapture — thin React adapter over the STT service.
 *
 * The capture + VAD logic lives in `services/stt/`. This hook:
 *   - Watches `voiceStore.currentState` and starts/stops the session.
 *   - Mirrors the service's `micLevel` and `isCapturing` to the
 *     voiceStore for the UI.
 *   - Logs session lifecycle events via `sttLog`.
 *
 * The actual audio capture, VAD, and chunk emission are not in this
 * file — they're in the service. That keeps the audio concerns
 * contained and testable in isolation from React.
 *
 * Push-to-talk (keyboard) bypasses this hook entirely — App.tsx calls
 * sttService.startSession()/endSession() directly from key handlers.
 */

import { useEffect } from "react";
import { useVoiceStore, type VoiceState } from "../state/voiceStore";
import { makeServiceLog } from "../services/log";
import type { SttService } from "../services/stt";

const sttLog = makeServiceLog("stt");

export interface UseAudioCaptureResult {
  isCapturing: boolean;
  startCapture: () => void;
  stopCapture: () => void;
}

export function useAudioCapture(service: SttService): UseAudioCaptureResult {
  const voiceState = useVoiceStore((s) => s.currentState) as VoiceState;
  const isCapturing = useVoiceStore((s) => s.isCapturing);
  const setCapturing = useVoiceStore((s) => s.setCapturing);
  const setMicLevel = useVoiceStore((s) => s.setMicLevel);
  const onIdle = useVoiceStore((s) => s.onIdle);

  useEffect(() => {
    const offState = service.onStateChange((s) => {
      setCapturing(s.capturing);
      if (s.error) {
        sttLog.error(s.error);
        useVoiceStore.getState().onError(s.error);
      }
    });
    const offLevel = service.onMicLevel((l) => setMicLevel(l));
    const offError = service.onError((msg) => sttLog.error(msg));
    return () => {
      offState();
      offLevel();
      offError();
    };
  }, [service, setCapturing, setMicLevel]);

  // Mic-button / wake-word: start session when voice state enters "listening",
  // stop when it leaves.  Keyboard PTT does NOT go through this effect —
  // it calls the service directly from keydown/keyup handlers in App.tsx.
  useEffect(() => {
    if ((voiceState as string) === "listening") {
      void service.startSession();
    } else if (voiceState === "speaking" || voiceState === "idle" || voiceState === "error") {
      if (service.getState().capturing) {
        void service.endSession();
      }
    }
  }, [voiceState, service]);

  useEffect(() => {
    return () => {
      if (service.getState().capturing) {
        service.abortSession();
      }
    };
  }, [service]);

  // The "VAD-triggered end" path also drops the voice machine to idle
  // so the UI does not stay stuck in "listening" when the user
  // paused and the silence detector closed the session.
  useEffect(() => {
    const off = service.onStateChange((s) => {
      if (!s.capturing && useVoiceStore.getState().currentState === "listening") {
        onIdle();
      }
    });
    return off;
  }, [service, onIdle]);

  return {
    isCapturing,
    startCapture: () => void service.startSession(),
    stopCapture: () => void service.endSession(),
  };
}
