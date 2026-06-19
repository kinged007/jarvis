/**
 * Agent store — Step 4 client skeleton.
 *
 * Owns the BFF connection state and the rolling log of agent activity
 * (CAP-10). Updated exclusively by the WebSocket dispatcher
 * (`useWebSocket`).
 *
 * The `currentTask` field is the active agent turn in flight — it's
 * the human-readable summary shown in the voice status bar center.
 *
 * `logEntries` is capped at 500 to keep the React render cheap; the
 * oldest entries fall off as new ones arrive.
 *
 * Live response tracking: `liveResponseText` accumulates
 * `agent:response_delta` frames for the in-flight turn. On
 * `agent:run_complete` the buffer is finalised into `lastAgentResponse`
 * and cleared. The brain UI shows `liveResponseText` while a run is
 * in progress so the user sees the response stream in real time.
 *
 * Heartbeat tracking: `lastHeartbeatAt` is updated on every
 * `system:heartbeat` frame. The 30s offline indicator (App.tsx)
 * compares `Date.now() - lastHeartbeatAt` against a threshold.
 */

import { create } from "zustand";
import type { ServerAgentApprovalRequest, ServerAgentLongResponse } from "@jarvis/shared";

export type LogLevel = "info" | "tool" | "tool-result" | "commentary" | "error" | "system" | "run";

export type BffAgentState = "offline" | "idle" | "thinking" | "executing" | "waiting" | "error";

export interface LogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
}

export interface AgentState {
  connected: boolean;
  agentReady: boolean;
  currentTask: string | null;
  logEntries: LogEntry[];
  /** Last uptime reported by the BFF (seconds). */
  uptime: number;
  /** Last cleaned agent response text for display under the brain. */
  lastAgentResponse: string | null;
  /** Current commentary text — ephemeral, shown only while audio is playing. */
  currentCommentary: string | null;
  /** URL to show as a clickable notification (from client_browser). */
  browserUrl: string | null;
  /** Live in-flight response text — accumulates `agent:response_delta`. */
  liveResponseText: string;
  /** Run id of the in-flight turn (for correlation), or null. */
  activeRunId: string | null;
  /** Wall-clock ms when the last `system:heartbeat` arrived. */
  lastHeartbeatAt: number | null;
  /** Agent state derived from Hermes events (BFF-driven). */
  agentState: BffAgentState;
  /** Pending tool approval request — non-null triggers the ApprovalModal. */
  pendingApproval: ServerAgentApprovalRequest | null;
  /** Long agent response — non-null triggers the LongResponseModal.
   *  Modal state (open/minimized/closed) is managed by the component. */
  longResponse: ServerAgentLongResponse | null;
}

export interface AgentActions {
  addLogEntry: (entry: Omit<LogEntry, "id" | "ts"> & { ts?: number }) => void;
  setConnected: (connected: boolean) => void;
  setAgentReady: (ready: boolean) => void;
  setCurrentTask: (task: string | null) => void;
  setUptime: (uptime: number) => void;
  setLastAgentResponse: (text: string | null) => void;
  setCurrentCommentary: (text: string | null) => void;
  setBrowserUrl: (url: string | null) => void;
  clearLogs: () => void;
  appendLiveResponse: (delta: string) => void;
  finalizeLiveResponse: () => void;
  clearLiveResponse: () => void;
  setActiveRunId: (runId: string | null) => void;
  recordHeartbeat: () => void;
  setAgentState: (state: BffAgentState) => void;
  setApprovalRequest: (req: ServerAgentApprovalRequest) => void;
  clearApproval: () => void;
  setLongResponse: (res: ServerAgentLongResponse) => void;
  clearLongResponse: () => void;
}

export type AgentStore = AgentState & AgentActions;

const MAX_LOG_ENTRIES = 500;

let logCounter = 0;
function nextLogId(): string {
  logCounter += 1;
  return `log-${Date.now()}-${logCounter}`;
}

const initialState: AgentState = {
  connected: false,
  agentReady: false,
  currentTask: null,
  logEntries: [],
  uptime: 0,
  lastAgentResponse: null,
  currentCommentary: null,
  browserUrl: null,
  liveResponseText: "",
  activeRunId: null,
  lastHeartbeatAt: null,
  agentState: "idle",
  pendingApproval: null,
  longResponse: null,
};

export const useAgentStore = create<AgentStore>((set) => ({
  ...initialState,

  addLogEntry(entry) {
    const log: LogEntry = {
      id: nextLogId(),
      ts: entry.ts ?? Date.now(),
      level: entry.level,
      message: entry.message,
      meta: entry.meta,
    };
    set((state) => {
      const next = state.logEntries.length >= MAX_LOG_ENTRIES
        ? state.logEntries.slice(state.logEntries.length - MAX_LOG_ENTRIES + 1)
        : state.logEntries.slice();
      next.push(log);
      return { logEntries: next };
    });
  },

  setConnected(connected) {
    set({ connected });
  },

  setAgentReady(agentReady) {
    set({ agentReady });
  },

  setCurrentTask(task) {
    set({ currentTask: task });
  },

  setUptime(uptime) {
    set({ uptime });
  },

  setLastAgentResponse(text) {
    set({ lastAgentResponse: text });
  },

  setCurrentCommentary(text) {
    set({ currentCommentary: text });
  },

  setBrowserUrl(url) {
    set({ browserUrl: url });
  },

  appendLiveResponse(delta) {
    set((state) => ({ liveResponseText: state.liveResponseText + delta }));
  },

  finalizeLiveResponse() {
    set((state) => {
      if (!state.liveResponseText) return {};
      return {
        lastAgentResponse: state.liveResponseText,
        liveResponseText: "",
      };
    });
  },

  clearLiveResponse() {
    set({ liveResponseText: "" });
  },

  setActiveRunId(runId) {
    set({ activeRunId: runId });
  },

  recordHeartbeat() {
    set({ lastHeartbeatAt: Date.now() });
  },

  setAgentState(agentState) {
    set({ agentState });
  },

  clearLogs() {
    set({ logEntries: [] });
  },

  setApprovalRequest(req) {
    set({ pendingApproval: req });
  },

  clearApproval() {
    set({ pendingApproval: null });
  },

  setLongResponse(res) {
    set({ longResponse: res });
  },

  clearLongResponse() {
    set({ longResponse: null });
  },
}));
