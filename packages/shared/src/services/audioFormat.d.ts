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
export interface AudioFormat {
    /** Sample rate in Hz. */
    sampleRate: number;
    /** Number of channels. JARVIS is mono only. */
    channels: 1;
    /** Bits per sample. Int16 LE is the lowest-common-denominator for STT. */
    bitDepth: 16;
    /** Chunk duration in ms — the unit at which the client ships audio. */
    chunkMs: number;
    /** Deepgram `encoding` query-param value. */
    encoding: "opus" | "linear16";
}
/** Default capture format for the wakeword → STT pipeline. */
export declare const STT_AUDIO_FORMAT: AudioFormat;
/** Sample count per chunk at STT_AUDIO_FORMAT settings. */
export declare const STT_SAMPLES_PER_CHUNK: number;
/** Byte length of a single chunk at STT_AUDIO_FORMAT settings. */
export declare const STT_BYTES_PER_CHUNK: number;
/**
 * TTS delivery format. The BFF's TTS service emits audio in this format
 * and the client's TTS service consumes it without transcoding.
 *
 * The shape is the wire format carried on every `tts:utterance` frame
 * (see `ServerTtsUtterance` in `messages.ts`). The client decodes bytes
 * based on this contract; if the BFF ever sends something else the
 * client warns via `assertTtsFormat` rather than silently producing
 * garbage audio.
 */
export interface TtsAudioFormat {
    encoding: "linear16";
    sampleRate: 24_000;
    channels: 1;
    bitDepth: 16;
    /** Bytes per broadcast chunk. 16 KB is small enough to interleave with
     *  WS control frames but large enough to keep WS frame overhead sane. */
    chunkBytes: number;
}
export declare const TTS_AUDIO_FORMAT: TtsAudioFormat;
/**
 * Compare an incoming `TtsAudioFormat` (e.g. off the wire) against the
 * constant the BFF is supposed to send. Returns `null` on match, or a
 * human-readable diff string describing the first mismatch. Used by the
 * client to surface "BFF sent the wrong format" loudly instead of
 * silently producing silence.
 */
export declare function diffTtsFormat(incoming: TtsAudioFormat | undefined, expected?: TtsAudioFormat): string | null;
//# sourceMappingURL=audioFormat.d.ts.map