---
id: SPEC-approval-modal-ui
companions: []
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability only.

# Tool Approval Modal UI

## Why

The web UI has no user-facing path to see or respond to agent tool approval requests. When a tool requiring human approval executes, the agent transitions to `"waiting"` state and blocks indefinitely. The `demo.mjs` CLI client handles this with an interactive prompt showing choices (`once`, `session`, `always`, `deny`), but the web UI only logs the request. This gap means web UI users have no way to unblock the agent when a non-YOLO tool needs approval.

## Capabilities

- id: CAP-1
  intent: User sees a modal dialog when the agent requires tool approval, displaying the tool name, a human-readable message, formatted arguments, and choice buttons.
  success: When the BFF broadcasts `agent:approval_request`, an ApprovalModal opens on the web UI showing the tool name, message, formatted key-value args, and the set of choice buttons from `msg.choices`.

- id: CAP-2
  intent: User clicks an approval choice button to transmit their decision back to the agent, closing the modal.
  success: Clicking any choice button sends `agent:approval_response` over WebSocket via `sendMessage()`, the modal closes, `pendingApproval` is cleared from the store, and the agent proceeds with the approved (or denied) tool.

- id: CAP-3
  intent: Approval modal dismisses automatically when the approval is resolved externally (server-side auto-resolution or run completion).
  success: When `agent:approval_resolved` or `agent:run_complete` arrives, the modal closes and `pendingApproval` is cleared from the store.

- id: CAP-4
  intent: If a new approval request arrives while a modal is already open, the modal updates in-place to show the new request rather than stacking modals.
  success: Receiving a second `agent:approval_request` while `pendingApproval` is non-null updates the stored request; the modal re-renders with the new tool details.

## Constraints

- Must use the existing shadcn/ui `Dialog` component from `components/ui/dialog.tsx`.
- Must match the neon dark theme via CSS custom properties defined in `index.css`.
- Must not block or interfere with TTS audio playback (the modal is a visual overlay only).
- Must use `sendMessage()` from `services/ws/sinks.ts` for sending the response back over WebSocket.
- Approval state (`pendingApproval`) must be stored in the existing Zustand `agentStore` (no new store).
- The modal cannot be dismissed by the user — no close button, no click-outside-to-close, no Escape-key dismissal. The only way to close the modal is by responding with a choice or the approval being resolved externally.
- The Deny button must be visually distinct with red (`--destructive`) styling.
- Arguments must be displayed in a formatted, human-readable format (key-value pairs).

## Non-goals

- Approval policy management (yolo/approve-all configuration).
- Approval history, audit log, or persistent record.
- Auto-deny timeout (user must explicitly respond or wait indefinitely).
- Keyboard shortcuts specific to approval choices.
- Visual indicator beyond the existing `"waiting"` agent state display in the status bar and voice bar.

## Success signal

A user connects via the web UI, sends a command that triggers a tool requiring approval, sees the ApprovalModal with the tool name and choice buttons, clicks "once", and the agent proceeds with tool execution — all without touching the CLI.

## Assumptions

- The BFF approval pipeline (`agent:approval_request` broadcast → `agent:approval_response` relay → Hermes `POST /v1/runs/{id}/approval`) is correct and tested (confirmed via code review of bridge.ts, router.ts, apiClient.ts).
- Hermes processes one approval request at a time per run; a new `approval.request` SSE event supersedes any pending approval.
- The `agentStore.setApprovalRequest()` / `agentStore.clearApproval()` API additions are the right surface (no new Zustand store needed).
