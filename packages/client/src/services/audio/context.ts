/**
 * Single shared output `AudioContext` for the JARVIS client.
 *
 * Three services need to produce or consume audio on the client:
 *   - the wakeword service (input)  — input context, owned by audioSession
 *   - the STT service (input)       — input context, owned by audioSession
 *   - the TTS service (output)      — output context, owned by THIS module
 *
 * This module owns the OUTPUT side. Multiple `AudioContext`s in one
 * browser is a known footgun (they tick independently and can drift out
 * of sync with the system clock; only the first one created runs in
 * "interactive" mode, the rest are "normal" priority). The TTS playback
 * path needs gapless audio and a `masterAnalyser` for the level meter,
 * so we centralise the output context here and let the TTS service
 * consume it.
 *
 * The context is created lazily because the browser refuses to start
 * an `AudioContext` until a user gesture has occurred in the tab. The
 * first call to `ensureOutputAudioRunning()` should be wired to a click
 * handler.
 */

let outputCtx: AudioContext | null = null;
let masterAnalyser: AnalyserNode | null = null;

export function getOutputAudioContext(): AudioContext | null {
  return outputCtx;
}

export function getMasterAnalyser(): AnalyserNode | null {
  return masterAnalyser;
}

/**
 * Idempotent. Returns the shared context, creating it on first call.
 * Safe to call from a React effect — the resume is a no-op when the
 * context is already running.
 */
export async function ensureOutputAudioRunning(): Promise<AudioContext> {
  if (!outputCtx) {
    const Ctor =
      typeof window !== "undefined"
        ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!Ctor) throw new Error("Web Audio API not supported in this environment");
    outputCtx = new Ctor();
    masterAnalyser = outputCtx.createAnalyser();
    masterAnalyser.fftSize = 256;
    masterAnalyser.connect(outputCtx.destination);
  }
  if (outputCtx.state === "suspended") {
    await outputCtx.resume();
  }
  return outputCtx;
}

/**
 * Test / lifecycle hook. Closes the output context so a new one can be
 * created on next `ensureOutputAudioRunning`. Not used in app code.
 */
export async function closeOutputAudio(): Promise<void> {
  if (outputCtx && outputCtx.state !== "closed") {
    try {
      await outputCtx.close();
    } catch {
      // ignore
    }
  }
  outputCtx = null;
  masterAnalyser = null;
}
