/**
 * Sentence chunker for streaming TTS.
 *
 * The agent emits a single `response` event with the full turn text.
 * To get low first-audio latency, we split that text on sentence
 * boundaries and enqueue each sentence as its own TTS utterance. This
 * way synthesis of sentence #1 starts before sentence #5 has even been
 * tokenised by the agent.
 *
 * Conservative strategy (matches the v1 design):
 *   - Split on `[.!?]` followed by whitespace, OR on `\n+`.
 *   - Keep the terminator attached to the preceding chunk so the TTS
 *     prosody stays natural ("Hello there." is one utterance, not two).
 *   - Drop empty / whitespace-only chunks.
 *   - If the input has no terminator, the whole text becomes a single
 *     chunk (we never lose text).
 *
 * Pure, no IO, no dependencies. Unit-tested in `chunker.test.ts`.
 */

const TERMINATOR_RUN = /([.!?])(?=\s|$)|([\n]+)/g;

export function chunkSentences(text: string): string[] {
  if (!text) return [];

  const trimmed = text.trim();
  if (!trimmed) return [];

  const chunks: string[] = [];
  let cursor = 0;

  for (const match of trimmed.matchAll(TERMINATOR_RUN)) {
    const idx = match.index;
    if (idx === undefined) continue;
    // Include the terminator so the TTS speaks it.
    const end = idx + match[0].length;
    const piece = trimmed.slice(cursor, end).trim();
    if (piece) chunks.push(piece);
    cursor = end;
  }

  // Tail without a terminator — attach to the last chunk if there is
  // one, otherwise return as a single chunk. Never drop text.
  const tail = trimmed.slice(cursor).trim();
  if (tail) {
    if (chunks.length === 0) {
      chunks.push(tail);
    } else {
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${tail}`.trim();
    }
  }

  return chunks;
}
