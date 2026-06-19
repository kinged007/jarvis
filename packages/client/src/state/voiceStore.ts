/**
 * Voice store — owns voice pipeline state + WS send handles.
 *
 * State machine: idle → listening → processing → speaking → idle
 * Push-to-talk: press mic → onWakeWord() → listening → release → onIdle()
 * Text input: send command via sendWsMessage (stored WS handle)
 */

import { create } from "zustand";
import type { ClientMessage } from "@jarvis/shared";

export type VoiceState = "idle" | "listening" | "processing" | "speaking" | "error";
export type VoiceStatus = "idle" | "loading" | "success" | "error";
export type MicPermission = "unknown" | "granted" | "denied" | "unsupported";

export interface VoiceStateData {
  currentState: VoiceState;
  transcript: string | null;
  micLevel: number;
  isCapturing: boolean;
  status: VoiceStatus;
  error: string | null;
  micPermission: MicPermission;
}

export type WsSendFn = (msg: ClientMessage | { type: "voice:chunk"; data: ArrayBuffer }) => void;
export type WsSendBinaryFn = (data: ArrayBuffer) => void;

const PROCESSING_TIMEOUT_MS = 30_000;

export interface VoiceActions {
  onWakeWord: () => void;
  onTranscript: (text: string) => void;
  onProcessing: () => void;
  onSpeaking: () => void;
  onError: (msg: string) => void;
  onIdle: () => void;
  setSpeaking: (speaking: boolean) => void;
  setMicLevel: (level: number) => void;
  setCapturing: (capturing: boolean) => void;
  setMicPermission: (permission: MicPermission) => void;
  setStatus: (status: VoiceStatus) => void;
  /** Store the WS send function so text input can send commands. */
  setWsSend: (send: WsSendFn | null) => void;
  setWsSendBinary: (send: WsSendBinaryFn | null) => void;
  startProcessingTimeout: () => void;
  clearProcessingTimeout: () => void;
  reset: () => void;
}

export type VoiceStore = VoiceStateData & VoiceActions;

const initialState: VoiceStateData = {
  currentState: "idle",
  transcript: null,
  micLevel: 0,
  isCapturing: false,
  status: "idle",
  error: null,
  micPermission: "unknown",
};

export const useVoiceStore = create<VoiceStore>((set, get) => ({
  ...initialState,

  // Module-level refs for WS send functions (not serialized in state)
  _wsSend: null as WsSendFn | null,
  _wsSendBinary: null as WsSendBinaryFn | null,
  _speakingTimer: null as ReturnType<typeof setTimeout> | null,
  _processingTimer: null as ReturnType<typeof setTimeout> | null,
  _lastTranscriptText: "" as string,

  _clearSpeakingTimer() {
    const t = (get() as unknown as { _speakingTimer: ReturnType<typeof setTimeout> | null })._speakingTimer;
    if (t) { clearTimeout(t); (get() as unknown as { _speakingTimer: null })._speakingTimer = null; }
  },

  onWakeWord() {
    (get() as unknown as { _clearSpeakingTimer: () => void; _lastTranscriptText: string })._clearSpeakingTimer();
    (get() as unknown as { _lastTranscriptText: string })._lastTranscriptText = "";
    set({
      currentState: "listening",
      transcript: null,
      isCapturing: false,
      error: null,
      status: "idle",
    });
  },

  onTranscript(text) {
    const self = get() as unknown as {
      _clearSpeakingTimer: () => void;
      _wsSend: WsSendFn | null;
      _lastTranscriptText: string;
      startProcessingTimeout: () => void;
    };
    self._clearSpeakingTimer();
    if (self._lastTranscriptText === text) return;
    self._lastTranscriptText = text;
    set({ transcript: text, currentState: "processing", status: "loading" });
    const send = self._wsSend;
    if (send) send({ type: "command", text });
    self.startProcessingTimeout();
  },

  onProcessing() {
    (get() as unknown as { _clearSpeakingTimer: () => void })._clearSpeakingTimer();
    set({ currentState: "processing", status: "loading" });
  },

  onSpeaking() {
    const self = get() as unknown as { _clearSpeakingTimer: () => void; _speakingTimer: ReturnType<typeof setTimeout> | null; _processingTimer: ReturnType<typeof setTimeout> | null };
    self._clearSpeakingTimer();
    if (self._processingTimer) { clearTimeout(self._processingTimer); self._processingTimer = null; }
    set({ currentState: "speaking", status: "success" });
  },

  setSpeaking(speaking: boolean) {
    if (speaking) {
      set({ currentState: "speaking", status: "success" });
    } else {
      if ((get() as VoiceStore).currentState === "speaking") {
        set({ currentState: "idle", status: "idle" });
      }
    }
  },

  onError(msg) {
    const self = get() as unknown as { _clearSpeakingTimer: () => void; _processingTimer: ReturnType<typeof setTimeout> | null };
    self._clearSpeakingTimer();
    if (self._processingTimer) { clearTimeout(self._processingTimer); self._processingTimer = null; }
    set({ currentState: "error", error: msg, status: "error" });
  },

  onIdle() {
    const self = get() as unknown as { _clearSpeakingTimer: () => void; _processingTimer: ReturnType<typeof setTimeout> | null };
    self._clearSpeakingTimer();
    if (self._processingTimer) { clearTimeout(self._processingTimer); self._processingTimer = null; }
    set({
      currentState: "idle",
      micLevel: 0,
      isCapturing: false,
      status: "idle",
      error: null,
    });
  },

  setMicLevel(level) {
    const clamped = Math.max(0, Math.min(1, level));
    set({ micLevel: clamped });
  },

  setCapturing(capturing) {
    set({ isCapturing: capturing });
  },

  setMicPermission(permission) {
    set({ micPermission: permission });
  },

  setStatus(status) {
    set({ status });
  },

  setWsSend(send) {
    (get() as unknown as { _wsSend: WsSendFn | null })._wsSend = send;
  },

  setWsSendBinary(send) {
    (get() as unknown as { _wsSendBinary: WsSendBinaryFn | null })._wsSendBinary = send;
  },

  startProcessingTimeout() {
    const self = get() as unknown as { _processingTimer: ReturnType<typeof setTimeout> | null };
    if (self._processingTimer) clearTimeout(self._processingTimer);
    self._processingTimer = setTimeout(() => {
      self._processingTimer = null;
      set({ currentState: "error", error: "agent not responding — command timed out", status: "error" });
    }, PROCESSING_TIMEOUT_MS);
  },

  clearProcessingTimeout() {
    const self = get() as unknown as { _processingTimer: ReturnType<typeof setTimeout> | null };
    if (self._processingTimer) {
      clearTimeout(self._processingTimer);
      self._processingTimer = null;
    }
  },

  reset() {
    const self = get() as unknown as { _processingTimer: ReturnType<typeof setTimeout> | null };
    if (self._processingTimer) { clearTimeout(self._processingTimer); self._processingTimer = null; }
    set({ ...initialState });
  },
}));

/** Get the stored WS send function (for use outside React). */
export function getWsSend(): WsSendFn | null {
  return (useVoiceStore.getState() as unknown as { _wsSend: WsSendFn | null })._wsSend;
}

/** Get the stored WS binary send function. */
export function getWsSendBinary(): WsSendBinaryFn | null {
  return (useVoiceStore.getState() as unknown as { _wsSendBinary: WsSendBinaryFn | null })._wsSendBinary;
}
