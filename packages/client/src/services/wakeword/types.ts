/**
 * Wakeword service — typed contract.
 *
 * The wakeword service is responsible for one thing: detect a spoken
 * trigger word (e.g. "jarvis") in the live mic stream and fire a `wake`
 * event, optionally handing the STT service the audio buffer captured
 * immediately before the trigger (the "pre-roll" — typically 1-2s of
 * audio that the user spoke before the model accepted the trigger).
 *
 * The service deliberately knows nothing about:
 *   - The agent (S3). The hook consumer (App.tsx) translates a wake
 *     event into a `voiceState.transition({ type: "wake" })` call.
 *   - STT (S2). The pre-roll buffer is exposed as a Float32Array; the
 *     STT service is responsible for re-encoding it into the wire
 *     format. Today (no real wakeword) the STT service starts capture
 *     from the moment `wake` fires, so the pre-roll is unused.
 *   - TTS (S4).
 *   - UI state.
 *
 * The implementation lives in `stub.ts` for now (no-op that reports
 * "not implemented"). A real `openWakeWord.ts` lands in a follow-up;
 * swapping it is one import change in `index.ts`.
 */

export type WakewordState = {
  /** True if the browser exposes the audio APIs the service needs. */
  supported: boolean;
  /** True while the wakeword loop is running. */
  listening: boolean;
  /** Non-null when the service cannot run (missing API, init failure). */
  error: string | null;
};

export type WakewordListener = () => void;

export interface WakewordService {
  /** Read the current state synchronously. */
  getState(): WakewordState;
  /** Begin listening. Idempotent. Resolves once the loop is running. */
  start(): Promise<void>;
  /** Stop listening. Safe to call when not listening. */
  stop(): void;
  /**
   * Subscribe to wake events. Returns an unsubscribe function. The
   * callback fires on the audio thread — keep it cheap; if you need
   * to do work, schedule it on the React tick.
   */
  onWake(listener: WakewordListener): () => void;
  /**
   * Pop the pre-roll buffer captured before the most recent wake
   * event. Returns null if no buffer is available or if it was
   * already consumed.
   */
  takePreRollBuffer(): Float32Array | null;
}
