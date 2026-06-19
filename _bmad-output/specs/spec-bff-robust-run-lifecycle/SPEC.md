---
id: SPEC-bff-robust-run-lifecycle
companions: []
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability only — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# BFF Robust Run Lifecycle

## Why

The BFF process crashes with an unhandled `AbortError` when a run times out waiting for approval (5-minute default timeout). The crash rips down **all** WebSocket connections — the entire server instance dies. The same abort path is triggered on client disconnect (`cleanupSocket` → `cancelCommand` → `bridge.detach` → `controller.abort`), so either timeout or disconnect can crash the process. The BFF must tolerate both scenarios: surface terminal status to remaining clients, clean up resources, and keep the server alive, without changing Hermes gateway behavior.

## Capabilities

- id: CAP-1
  intent: Run timeout terminates the SSE stream and marks the run failed without crashing the BFF process.
  success: A run that hits the 5-minute timeout results in `agent:run_complete { status: "failed" }` broadcast to connected clients, all per-run resources (SSE stream, timer, TTS buffer) released, and the BFF process stays alive accepting new commands.

- id: CAP-2
  intent: Client WebSocket disconnect triggers full resource cleanup without crashing the BFF process.
  success: When a client disconnects during an active run, the SSE stream is aborted, TTS queue cleared, run cancelled via Hermes API, and remaining clients unaffected. No unhandled rejection or AbortError kills the process.

- id: CAP-3
  intent: AbortController lifecycle is idempotent — consecutive or cross-cutting abort calls do not throw.
  success: Calling `controller.abort()` on an already-aborted controller, or from both the timeout and disconnect paths racing on the same controller, produces no unhandled exception and no process exit.

- id: CAP-4
  intent: Client disconnect during an approval-pending run does not immediately cancel the run — it is given a grace period bounded by the existing run timeout.
  success: A client that disconnects while a run is in `waiting` state has the run continue running. If the client reconnects before the 5-minute run timeout, the agent bridge remains active and the reconnected client can respond to the pending approval. If the timeout fires first, standard timeout cleanup takes over.

## Constraints

- Hermes gateway behavior MUST NOT change — only BFF-side robustness
- Existing WS message contract preserved (no breaking changes to `ClientMessage`/`ServerMessage` shapes)
- No new dependencies
- Run timeout is hardcoded at 5 minutes (300,000 ms)

## Non-goals

- Modifying the Hermes gateway's timeout or approval behavior
- Adding auto-retry or automatic reconnection logic from the client side
- Changing the 5-minute default timeout value
- Adding per-approval-request timeouts (separate from run-level timeout)
- Modifying the agent's approval handling (continue-without-approval, proceed anyway, etc.)

## Success signal

A run that hits the 5-minute timeout broadcasts `agent:run_complete { status: "failed" }` to connected clients, cleans up its SSE stream, and the BFF process stays alive accepting new commands. A client that disconnects mid-run does not cause a process crash; the run continues under its existing timeout, and the server remains available for new connections.

## Assumptions

- The grace period for client reconnection is the remaining run timeout; no separate shorter timer is needed.
- A reconnecting client gets a fresh WebSocket and fresh `SocketState` — resuming the exact run context requires client-side state tracking (out of scope here).

## Open Questions

<!-- None — both questions from the draft were resolved during review. -->
