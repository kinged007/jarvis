/**
 * Browser capability checks. Run these once at boot to decide which
 * JARVIS features to enable and which to gracefully degrade.
 *
 * All checks are defensive: SSR / node runtimes must not throw, and
 * the audio/canvas APIs we rely on must be feature-detected, not
 * assumed.
 */

export function checkMicrophoneSupport(): boolean {
  if (typeof navigator === "undefined") return false;
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") return false;
  return true;
}

export function checkSpeechSynthesisSupport(): boolean {
  if (typeof window === "undefined") return false;
  return typeof window.speechSynthesis !== "undefined";
}

export function checkOffscreenCanvasSupport(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof OffscreenCanvas === "undefined") return false;
  // Worker must exist and accept OffscreenCanvas transfer.
  if (typeof Worker === "undefined") return false;
  return true;
}
