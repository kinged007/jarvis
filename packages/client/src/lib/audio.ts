/**
 * Web Audio API helpers for JARVIS client.
 *
 * The audio subsystem is split into:
 *   - `createAudioContext()` — returns the shared output context if it
 *     has already been created. Throws otherwise (callers that need to
 *     create it must use the async `ensureAudioContextRunning`).
 *   - `ensureAudioContextRunning()` — async, creates + resumes.
 *     Re-exported from `services/audio/context.ts` (one owner for the
 *     output context).
 *   - `playAudioChunk(ctx, chunk)` — queue an ArrayBuffer onto the
 *     context's output. Used by useAudioPlayback for gapless TTS.
 *
 * Encoded formats: we accept whatever the BFF forwards (likely
 * Deepgram's linear16 / mp3). We branch on the first byte to detect
 * an MP3 ID3 / frame header and decode accordingly; raw PCM falls
 * through to a direct decodeAudioData path. This keeps the surface
 * narrow while still being robust to common transport shapes.
 */

import {
  ensureOutputAudioRunning as _ensureOutputAudioRunning,
  getOutputAudioContext,
} from "../services/audio/context";

const MP3_FRAME_SYNC = 0xffe;
const ID3_TAG = 0x4944; // "ID"

function looksLikeMp3(buffer: ArrayBuffer): boolean {
  const view = new DataView(buffer);
  if (view.byteLength < 4) return false;
  if (view.getUint16(0, false) === ID3_TAG) return true;
  if ((view.getUint16(0, false) & 0xffe0) === MP3_FRAME_SYNC << 5) return true;
  return false;
}

export function createAudioContext(): AudioContext {
  const ctx = getOutputAudioContext();
  if (!ctx) throw new Error("AudioContext not yet initialised — call ensureAudioContextRunning() first");
  return ctx;
}

export const ensureAudioContextRunning = _ensureOutputAudioRunning;

export async function playAudioChunk(
  ctx: AudioContext,
  chunk: ArrayBuffer,
): Promise<void> {
  if (chunk.byteLength === 0) return;

  let buffer: AudioBuffer;
  try {
    // decodeAudioData is forgiving: it handles WebM, Ogg, MP3, WAV, etc.
    // We slice to be safe against views over shared memory.
    buffer = await ctx.decodeAudioData(chunk.slice(0));
  } catch (err) {
    // If decode fails (e.g. raw PCM we don't have an encoder for), drop
    // the chunk rather than crash the playback queue. The agentStore
    // will surface the error to the UI.
    if (looksLikeMp3(chunk)) {
      throw new Error("Failed to decode MP3 audio chunk");
    }
    throw new Error(
      `Failed to decode audio chunk (${(err as Error).message})`,
    );
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), (buffer.duration * 1000) + 100);
    source.onended = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
}
