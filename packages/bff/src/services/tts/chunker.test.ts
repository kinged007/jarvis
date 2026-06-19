/**
 * Unit tests for the sentence chunker. Runnable with:
 *   pnpm -F @jarvis/bff exec tsx src/services/tts/chunker.test.ts
 *
 * Uses Node's built-in test runner — no external deps.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkSentences } from "./chunker.js";

test("empty string returns []", () => {
  assert.deepEqual(chunkSentences(""), []);
});

test("whitespace-only string returns []", () => {
  assert.deepEqual(chunkSentences("   \n\t  "), []);
});

test("single sentence no terminator -> one chunk", () => {
  assert.deepEqual(chunkSentences("Hello there"), ["Hello there"]);
});

test("two sentences split on period", () => {
  assert.deepEqual(
    chunkSentences("Hello there. How are you?"),
    ["Hello there.", "How are you?"],
  );
});

test("three sentences with mixed terminators", () => {
  assert.deepEqual(
    chunkSentences("First. Second! Third?"),
    ["First.", "Second!", "Third?"],
  );
});

test("newlines act as boundaries", () => {
  assert.deepEqual(
    chunkSentences("Line one.\nLine two.\nLine three."),
    ["Line one.", "Line two.", "Line three."],
  );
});

test("trailing tail merges into last chunk", () => {
  assert.deepEqual(
    chunkSentences("First sentence. unfinished tail"),
    ["First sentence. unfinished tail"],
  );
});

test("multiple whitespace runs collapse", () => {
  assert.deepEqual(
    chunkSentences("First.   Second.\n\n\tThird."),
    ["First.", "Second.", "Third."],
  );
});

test("leading and trailing whitespace stripped", () => {
  assert.deepEqual(
    chunkSentences("   Hello.   World.   "),
    ["Hello.", "World."],
  );
});

test("abbreviation followed by space IS split (known conservative tradeoff)", () => {
  // The chunker is regex-based and conservative on purpose: it only
  // splits on `[.!?]` followed by whitespace. "Dr." is followed by a
  // space, so it splits into two chunks. Deepgram handles the short
  // "Dr." chunk gracefully (slight intonation glitch is acceptable).
  // A future enhancement could keep an abbreviation set to suppress
  // this, but it's not worth the complexity today.
  assert.deepEqual(
    chunkSentences("Dr. Smith went home."),
    ["Dr.", "Smith went home."],
  );
});

test("long paragraph splits correctly", () => {
  const text =
    "The quick brown fox. Jumps over the lazy dog. And runs away into the night!";
  assert.deepEqual(chunkSentences(text), [
    "The quick brown fox.",
    "Jumps over the lazy dog.",
    "And runs away into the night!",
  ]);
});

test("ellipsis followed by space splits (last dot has whitespace after)", () => {
  // "Wait..." has three dots in a row. Our regex matches the *last*
  // dot (index 6) because that's the only one followed by whitespace.
  // So we get ["Wait...", "what?"].
  assert.deepEqual(chunkSentences("Wait... what?"), ["Wait...", "what?"]);
});
