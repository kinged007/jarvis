---
id: SPEC-long-response-modal
companions: []
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability only — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Long Response Modal & TTS Trimming

## Why

The agent often generates long-form responses (multi-paragraph, tables, diagrams) that are impractical for TTS audio playback — the user must either endure minutes of spoken text or manually skip. Simultaneously, the chat interface's compact layout makes consuming rich markdown responses cumbersome. This is an opportunity to improve UX by detecting long responses server-side, delivering a brief spoken summary via TTS, and rendering the full content in a dedicated markdown-capable modal that the user can minimize, restore, and dismiss on their own terms.

## Capabilities

- id: CAP-1
  intent: BFF detects when the final agent response exceeds a configurable word-count threshold and signals the client.
  success: A unit test verifies that `run.completed` with a 150‑word response triggers the long‑response path when the threshold is 100, and a 50‑word response follows the normal path.

- id: CAP-2
  intent: BFF trims the TTS utterance for long responses to only the text before the first line break, so the spoken audio is brief.
  success: Integration test verifies that `tts.enqueue("response", ...)` receives only `"This is a summary.\nDetails follow..."` up to the first `\n` when the threshold is exceeded.

- id: CAP-3
  intent: BFF transmits the full response text alongside a "long response" signal to the web UI via a new WebSocket message type.
  success: Integration test verifies a `ServerAgentLongResponse` message is broadcast (and only when threshold exceeded) carrying the complete `event.output` text.

- id: CAP-4
  intent: Web UI renders a persistent modal dialog for long responses that can be minimized by clicking outside and restored via a floating indicator, with true dismissal only via its close button.
  success: Manual test: a long response opens the modal → clicking backdrop minimizes to a floating button → clicking the button restores the modal → clicking the close button permanently dismisses it with no way to restore.

- id: CAP-5
  intent: The long-response modal renders full markdown including tables, Mermaid diagrams, and inline images.
  success: A sample markdown payload containing a GFM table, a ` ```mermaid ` fence block, and an `![](url)` image renders correctly in the modal — table borders and alignment, SVG diagram, and loaded image are all visible.

## Constraints

- The word-count threshold must be configurable via environment variable (`LONG_RESPONSE_THRESHOLD_WORDS`), default 100.
- Only the **final** response (`run.completed`) is evaluated — reasoning commentary and streaming deltas are unaffected.
- TTS trimming must not alter the full response text stored in `agent:response` or the agent store log — only the TTS utterance text is shortened.
- The long-response modal is purely client-side state; the BFF has no knowledge of whether it is open, minimized, or closed.
- The modal must use the existing Radix UI `Dialog` primitives and shadcn `DialogContent` from `@/components/ui/dialog`, following the `ApprovalModal` pattern.
- Mermaid rendering must **not** bundle a monolithic diagramming library; prefer `mermaid` loaded dynamically or a lightweight Mermaid‑to‑SVG renderer.
- The minimized indicator must be unobtrusive (e.g. a small floating button at the bottom‑right) and must not block interaction with the main UI.

## Non-goals

- No streaming into the modal — it opens only when the full `agent:response` is received.
- No BFF‑side markdown processing or rendering — the BFF only measures word count and forwards raw text.
- No server‑side persistence for modal state (minimized/closed).
- No configurable truncation strategies beyond first‑line‑break in v1.
- No per‑user toggle to disable long‑response detection in v1.
- No "replay audio" or "speak full response" button in the modal.

## Success signal

A user sends a prompt that produces a 500+ word agent response. The TTS audio is brief (only the first paragraph before a line break). A modal opens over the chat UI showing the full markdown response — tables have proper borders, Mermaid diagrams render as SVGs, and inline images display. The user clicks outside the modal; it minimizes to a small floating button. They click the button; the modal restores. They click the close (X) button; the modal disappears permanently.

## Assumptions

- The first line break (`\n`) is a reasonable proxy for the lead‑in sentence or paragraph in most agent responses.
- The `run.completed` handler in `bridge.ts` (`packages/bff/src/services/agent/bridge.ts:351`) is the correct insertion point for word‑count detection.
- A new `agent:long_response` message type in `packages/shared/src/messages.ts` is acceptable and fits the existing `domain:action` naming convention.
- The client already has or can reuse a markdown rendering component; if not, one will be introduced.
- Mermaid rendering can be handled client-side via a lightweight approach (dynamic `mermaid` import or `mermaid-to-svg` library) without bloating the bundle.
- The configurable threshold will be read from `process.env.LONG_RESPONSE_THRESHOLD_WORDS` in the BFF, default 100.

## Open Questions

- What is the exact default word-count threshold? (Suggested: 100.)
- Should the minimized indicator show a preview of the response (e.g. first 10 words)?
- Should Mermaid rendering be blocked by a user‑gesture CSP requirement (inline script needed by `mermaid`)? If so, sandboxed iframe or server‑side SVG pre‑rendering may be needed.
