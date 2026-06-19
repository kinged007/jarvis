/**
 * Shared audio format contract.
 *
 * The STT service on the client captures mic audio in this format, sends
 * it over WS to the BFF, and the BFF's STT proxy opens a Deepgram session
 * with matching parameters. Centralising the constants here is the only
 * way the two sides stay in sync.
 *
 * Adding a new field here is a contract change for both packages. The
 * TtsService has its own format (24 kHz linear16, 16-bit) which is
 * separate — Deepgram speaks/opus is unrelated to Deepgram listen/opus.
 */
/** Default capture format for the wakeword → STT pipeline. */
export const STT_AUDIO_FORMAT = {
    sampleRate: 16_000,
    channels: 1,
    bitDepth: 16,
    chunkMs: 100,
    encoding: "linear16",
};
/** Sample count per chunk at STT_AUDIO_FORMAT settings. */
export const STT_SAMPLES_PER_CHUNK = (STT_AUDIO_FORMAT.sampleRate * STT_AUDIO_FORMAT.chunkMs) / 1000;
/** Byte length of a single chunk at STT_AUDIO_FORMAT settings. */
export const STT_BYTES_PER_CHUNK = STT_SAMPLES_PER_CHUNK * (STT_AUDIO_FORMAT.bitDepth / 8) * STT_AUDIO_FORMAT.channels;
export const TTS_AUDIO_FORMAT = {
    encoding: "linear16",
    sampleRate: 24_000,
    channels: 1,
    bitDepth: 16,
    chunkBytes: 16 * 1024,
};
/**
 * Compare an incoming `TtsAudioFormat` (e.g. off the wire) against the
 * constant the BFF is supposed to send. Returns `null` on match, or a
 * human-readable diff string describing the first mismatch. Used by the
 * client to surface "BFF sent the wrong format" loudly instead of
 * silently producing silence.
 */
export function diffTtsFormat(incoming, expected = TTS_AUDIO_FORMAT) {
    if (!incoming)
        return "missing format on tts:utterance";
    const keys = [
        "encoding",
        "sampleRate",
        "channels",
        "bitDepth",
        "chunkBytes",
    ];
    for (const k of keys) {
        if (incoming[k] !== expected[k]) {
            return `${k}: expected ${String(expected[k])}, got ${String(incoming[k])}`;
        }
    }
    return null;
}
//# sourceMappingURL=audioFormat.js.map