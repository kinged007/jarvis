/**
 * Shared microphone session for the JARVIS client.
 *
 * `useWakeWord` opens a single `MediaStream` for the entire session
 * (one permission prompt, held open across the app's lifetime) and
 * attaches an `AnalyserNode` so both the wake word loop and the
 * capture/level meter can read from the same source. `useAudioCapture`
 * reuses that same stream to start a `MediaRecorder` on wake-word
 * detection — no second permission prompt, no audio gap.
 *
 * Module-level singleton by design: JARVIS is a single-user kiosk
 * dashboard, so cross-component coordination via a plain object is
 * simpler than threading refs through React context. This matches
 * the pattern used by `pushTtsChunk` in `useAudioPlayback.ts`.
 */

export interface AudioSession {
  /** The live mic stream. Null until `start()` is called. */
  stream: MediaStream | null;
  /** Analyser used to derive the mic-level meter. Null until `start()`. */
  analyser: AnalyserNode | null;
  /** AudioContext that owns the analyser. Null until `start()`. */
  context: AudioContext | null;
  /** True while a wake-word or capture session owns the mic. */
  active: boolean;
}

const session: AudioSession = {
  stream: null,
  analyser: null,
  context: null,
  active: false,
};

/**
 * Open the mic (or refresh the existing one) and wire up the analyser.
 * Safe to call multiple times — returns the existing session on repeat.
 */
export async function ensureAudioSession(): Promise<AudioSession> {
  if (session.stream && session.context && session.analyser) {
    session.active = true;
    return session;
  }

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia is not available in this environment");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("Web Audio API not available in this environment");
  }

  const context = new Ctor();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.5;
  source.connect(analyser);

  session.stream = stream;
  session.context = context;
  session.analyser = analyser;
  session.active = true;
  return session;
}

/**
 * Mark the session as no longer in use. Does NOT close the underlying
 * stream — we keep it open across wake-word / capture / follow-up
 * windows so the user is not re-prompted. Pass `release: true` to
 * fully tear down (used on logout).
 */
export function releaseAudioSession(opts: { release?: boolean } = {}): void {
  session.active = false;
  if (!opts.release) return;
  session.stream?.getTracks().forEach((t) => t.stop());
  session.stream = null;
  if (session.context && session.context.state !== "closed") {
    void session.context.close().catch(() => undefined);
  }
  session.context = null;
  session.analyser = null;
}

/** Snapshot read-only view of the current session. */
export function getAudioSession(): Readonly<AudioSession> {
  return session;
}

/**
 * Compute an RMS mic level in [0, 1] from the shared analyser. Cheap
 * enough to call from a rAF loop; the analyser buffer is reused.
 */
const levelBuffer = new Float32Array(512);
export function readMicLevel(): number {
  if (!session.analyser) return 0;
  // Use a 512-sample window regardless of fftSize; AnalyserNode only
  // exposes up to its fftSize, so this is safe.
  const size = Math.min(levelBuffer.length, session.analyser.fftSize);
  if (size === 0) return 0;
  // getFloatTimeDomainData writes into the provided buffer with the
  // analyser's frequencyBinCount length. We use a sliced view so we
  // never read past the analyser's actual window.
  const view = levelBuffer.subarray(0, size);
  session.analyser.getFloatTimeDomainData(view);
  let sumSquares = 0;
  for (let i = 0; i < view.length; i += 1) {
    const v = view[i] ?? 0;
    sumSquares += v * v;
  }
  const rms = Math.sqrt(sumSquares / view.length);
  // RMS for a sine wave at full scale is ~0.707. Boost the curve a
  // little so quiet speech still moves the meter visibly.
  return Math.min(1, rms * 2.2);
}
