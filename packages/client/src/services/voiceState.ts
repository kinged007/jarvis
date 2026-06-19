/**
 * Single-source voice state machine.
 *
 * Before this refactor the 5-state machine (idle / listening /
 * processing / speaking / error) was driven from 5 different call sites
 * (App.tsx, useAudioCapture, useWebSocket, voiceStore, ttsService).
 * Every site had its own transition logic and timeouts; the client
 * frequently landed in inconsistent states (e.g. stuck in "processing"
 * after the server already started speaking).
 *
 * This module owns:
 *   - The state values.
 *   - The valid transitions.
 *   - The single processing-timeout (30s; matches the BFF's
 *     `commandTimeoutMs` in spirit if not in number).
 *
 * It does NOT own:
 *   - The state storage (still in `useVoiceStore` — zustand is the
 *     store, this is the reducer).
 *   - The audio capture (lives in `services/stt/`).
 *   - The WS send handle (lives in `services/ws/`).
 *
 * Callers emit events through `transitionVoiceState(event)`. The
 * reducer validates the transition, updates the store, and arms/disarms
 * the processing timeout.
 */

import { useVoiceStore, type VoiceState } from "../state/voiceStore";

export const PROCESSING_TIMEOUT_MS = 30_000;

/** All events that can drive the voice state machine. */
export type VoiceEvent =
  | { type: "wake" } // push-to-talk press
  | { type: "idle" } // push-to-talk release / user idle
  | { type: "transcript"; text: string } // STT final transcript
  | { type: "processing" } // command sent, waiting for agent
  | { type: "speaking" } // agent response audio starting
  | { type: "speakingEnded" } // playback finished
  | { type: "error"; message: string }
  | { type: "cancelled" }
  | { type: "reset" };

/**
 * Valid transitions. Anything not in this table is a bug — the reducer
 * logs and ignores invalid transitions.
 */
const VALID: Record<VoiceState, ReadonlyArray<VoiceEvent["type"]>> = {
  idle: ["wake", "transcript", "error", "reset"],
  listening: ["idle", "transcript", "error", "reset"],
  processing: ["speaking", "error", "cancelled", "idle", "reset"],
  speaking: ["speakingEnded", "cancelled", "idle", "error", "reset"],
  error: ["idle", "wake", "reset"],
};

let processingTimer: ReturnType<typeof setTimeout> | null = null;

function clearProcessingTimer(): void {
  if (processingTimer !== null) {
    clearTimeout(processingTimer);
    processingTimer = null;
  }
}

function armProcessingTimer(): void {
  clearProcessingTimer();
  processingTimer = setTimeout(() => {
    processingTimer = null;
    transitionVoiceState({
      type: "error",
      message: "agent not responding — command timed out",
    });
  }, PROCESSING_TIMEOUT_MS);
}

export interface TransitionResult {
  ok: boolean;
  state: VoiceState;
  reason?: "invalid-transition";
}

/**
 * Apply an event to the state machine and return whether it was
 * accepted. Side effects: updates the `useVoiceStore` and arms/disarms
 * the processing timeout.
 *
 * `onEvent` is called after the store has been mutated, so listeners
 * can read the new state synchronously. It's typed for convenience.
 */
export function transitionVoiceState(event: VoiceEvent): TransitionResult {
  const store = useVoiceStore.getState();
  const current = store.currentState;
  const allowed = VALID[current] ?? [];
  if (!allowed.includes(event.type)) {
    if (typeof window !== "undefined" && import.meta.env.DEV) {
      console.debug(
        `[voiceState] rejected transition ${current} --/--> ${event.type}`,
      );
    }
    return { ok: false, state: current, reason: "invalid-transition" };
  }

  switch (event.type) {
    case "wake":
      store.onWakeWord();
      break;
    case "idle":
      store.onIdle();
      break;
    case "transcript":
      store.onTranscript(event.text);
      break;
    case "processing":
      store.onProcessing();
      armProcessingTimer();
      break;
    case "speaking":
      store.onSpeaking();
      clearProcessingTimer();
      break;
    case "speakingEnded":
      store.setSpeaking(false);
      break;
    case "error":
      clearProcessingTimer();
      store.onError(event.message);
      break;
    case "cancelled":
      clearProcessingTimer();
      // Use the existing onIdle path so the UI also drops any
      // processing-timeout side effects.
      store.onIdle();
      break;
    case "reset":
      clearProcessingTimer();
      store.reset();
      break;
  }

  return { ok: true, state: useVoiceStore.getState().currentState };
}

/** Test / teardown hook. */
export function _resetVoiceStateTimers(): void {
  clearProcessingTimer();
}
