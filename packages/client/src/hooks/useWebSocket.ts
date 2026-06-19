/**
 * useWebSocket — single real-time channel to the JARVIS BFF.
 *
 * Lifecycle:
 *   1. Wait for auth store to report `isAuthenticated`.
 *   2. Open the WebSocket (cookie rides on same-origin upgrade).
 *   3. On `open`, send `{ type: "auth", token: "" }` as first frame.
 *   4. On `open`, register the socket with `services/ws/sinks.ts` so
 *      the STT service and the text-input flow can use the send
 *      functions without going through React.
 *   5. On every `message`, dispatch to appropriate stores/services.
 *   6. On `close` (unclean), schedule exponential-backoff reconnect.
 *
 * Logging is delegated to `wsLog` (transport) and `agentLog` (forwarded
 * agent events). See `services/log.ts` for the service-tagged log
 * contract.
 */

import { useCallback, useEffect, useState } from "react";
import type { ServerMessage } from "@jarvis/shared";
import { DEFAULT_CLIENT_CONFIG } from "@jarvis/shared";
import { WS_RECONNECT_BASE_MS, WS_RECONNECT_MAX_MS } from "../lib/constants";
import { useAuthStore } from "../state/authStore";
import { useAgentStore } from "../state/agentStore";
import { useVoiceStore } from "../state/voiceStore";
import { makeServiceLog } from "../services/log";
import { getActiveSocket, setActiveSocket } from "../services/ws/sinks";
import { sttService } from "../services/stt";
import { ttsService } from "../services/tts";

const wsLog = makeServiceLog("ws");
const agentLog = makeServiceLog("agent");

const BFF_ORIGIN = DEFAULT_CLIENT_CONFIG.bffOrigin;

function bffOriginToWsUrl(origin: string, path: string): string {
  const effectiveOrigin = origin || window.location.origin;
  const wsProto = effectiveOrigin.startsWith("https://") ? "wss:" : "ws:";
  const hostAndRest = effectiveOrigin.replace(/^https?:\/\//, "");
  return `${wsProto}//${hostAndRest}${path}`;
}

function dispatchServerMessage(msg: ServerMessage): void {
  const agent = useAgentStore.getState();
  const voice = useVoiceStore.getState();

  switch (msg.type) {
    case "system:status": {
      agent.setConnected(msg.connected);
      agent.setAgentReady(msg.agentReady);
      agent.setUptime(msg.uptime);
      // Drive agentState from agentReady for coarse online/offline.
      // The bridge's agent:state refines this for run-specific states.
      if (!msg.agentReady) {
        agent.setAgentState("offline");
      } else if (useAgentStore.getState().agentState === "offline") {
        agent.setAgentState("idle");
      }
      wsLog.system(`status: ${msg.connected ? "online" : "offline"} (uptime ${Math.round(msg.uptime)}s)`);
      if (!msg.connected) {
        voice.onError("agent offline");
      }
      return;
    }
    case "system:heartbeat":
      // Heartbeats keep the offline indicator green. Recorded here so
      // a separate 30s timer in the UI can compare against
      // `Date.now() - lastHeartbeatAt`.
      agent.recordHeartbeat();
      return;
    case "agent:state": {
      agent.setAgentState(msg.state);
      agentLog.debug(`agent state → ${msg.state}`);
      return;
    }
    case "stt:transcript": {
      sttService.emitTranscript({
        text: msg.text,
        interim: msg.interim,
        isFinal: !msg.interim,
        speechFinal: false,
      });
      if (msg.interim) {
        agentLog.info(`stt interim: ${msg.text}`);
        return;
      }
      voice.onTranscript(msg.text);
      agent.setCurrentTask(msg.text);
      agentLog.info(`heard: ${msg.text}`);
      return;
    }
    case "agent:commentary": {
      voice.clearProcessingTimeout();
      voice.onProcessing();
      agent.setCurrentCommentary(msg.text);
      agent.addLogEntry({
        level: "commentary",
        message: msg.text || "(empty)",
        meta: msg.runId ? { runId: msg.runId } : undefined,
      });
      return;
    }
    case "agent:response": {
      voice.clearProcessingTimeout();
      voice.onSpeaking();
      agent.setCurrentTask(null);
      // The terminal `agent:response` carries the full text the
      // deltas streamed. If the run was already finalised by
      // `agent:run_complete`, this is the canonical text. Always
      // overwrite — deltas may have been dropped on a partial run.
      agent.setLastAgentResponse(msg.text);
      agent.addLogEntry({
        level: "info",
        message: msg.text || "(empty response)",
        meta: msg.runId ? { runId: msg.runId, kind: "response" } : { kind: "response" },
      });
      return;
    }
    case "agent:response_delta": {
      // Streamed fragment. Append to the live response buffer so the
      // brain UI shows the response in real time. NOT logged — would
      // flood the log with one entry per token.
      voice.clearProcessingTimeout();
      voice.onProcessing();
      agent.appendLiveResponse(msg.delta);
      agent.setActiveRunId(msg.runId);
      return;
    }
    case "agent:run_complete": {
      // Terminal marker. Stop the spinner / processing timeout, log
      // the outcome, and finalise the live response buffer into the
      // canonical `lastAgentResponse`.
      voice.clearProcessingTimeout();
      voice.onIdle();
      const isFinal = msg.status === "completed" || msg.status === "cancelled";
      if (isFinal) {
        agent.finalizeLiveResponse();
      } else {
        // For `failed`, the live buffer is still useful — keep it
        // but move it to lastAgentResponse so it's visible.
        agent.finalizeLiveResponse();
      }
      const meta: Record<string, unknown> = { runId: msg.runId, status: msg.status };
      if (msg.error) meta["error"] = msg.error;
      if (msg.usage) meta["usage"] = msg.usage;
      agent.addLogEntry({
        level: msg.status === "completed" ? "run" : "error",
        message: `run ${msg.status}${msg.error ? `: ${msg.error}` : ""}`,
        meta,
      });
      agent.setCurrentTask(null);
      agent.setActiveRunId(null);
      agent.clearApproval();
      return;
    }
    case "agent:approval_request": {
      voice.clearProcessingTimeout();
      agent.addLogEntry({
        level: "info",
        message: `approval requested: ${msg.tool}`,
        meta: {
          runId: msg.runId,
          requestId: msg.requestId,
          tool: msg.tool,
          args: msg.args,
          choices: msg.choices,
        },
      });
      agent.setApprovalRequest(msg);
      return;
    }
    case "agent:approval_resolved": {
      agent.addLogEntry({
        level: "info",
        message: `approval resolved: ${msg.choice}`,
        meta: { runId: msg.runId, resolved: msg.resolved },
      });
      agent.clearApproval();
      return;
    }
    case "agent:long_response": {
      agent.addLogEntry({
        level: "info",
        message: `long response (${msg.text.split(/\s+/).filter(Boolean).length} words)`,
        meta: { runId: msg.runId },
      });
      agent.setLongResponse(msg);
      return;
    }
    case "agent:tool_call":
      voice.clearProcessingTimeout();
      agent.setCurrentTask(`tool: ${msg.tool}`);
      agent.addLogEntry({
        level: "tool",
        message: msg.tool,
        meta: { args: msg.args, runId: msg.runId, ...(msg.preview ? { preview: msg.preview } : {}) },
      });
      return;
    case "agent:tool_result":
      agent.addLogEntry({
        level: "tool-result",
        message: msg.tool,
        meta: {
          output: msg.output,
          runId: msg.runId,
          ...(msg.duration !== undefined ? { duration: msg.duration } : {}),
          ...(msg.error ? { error: true } : {}),
        },
      });
      return;
    case "agent:browser_open":
      voice.clearProcessingTimeout();
      agentLog.info(`browser_open: ${msg.url}`);
      agent.setBrowserUrl(msg.url);
      return;
    case "server:cancelled_ack":
      // The BFF acknowledged a client-initiated cancel. Drop the
      // processing state and go idle. Deliberately NOT a voice error —
      // the user just sent a new command, this is the expected path.
      voice.clearProcessingTimeout();
      voice.onIdle();
      agentLog.info("cancel acknowledged");
      return;
    case "tts:utterance":
      ttsService.startUtterance(msg.id, msg.kind, msg.text, msg.format);
      return;
    case "tts:utterance_end":
      ttsService.endUtterance(msg.id);
      return;
    case "tts:error": {
      const detail = msg.provider ? ` (${msg.provider})` : "";
      wsLog.error(`tts error for ${msg.id}${detail}: ${msg.message}`);
      // End the utterance so the client releases its slot, even
      // though no audio arrived.
      ttsService.endUtterance(msg.id);
      return;
    }
    case "error":
      voice.clearProcessingTimeout();
      voice.onError(msg.message);
      wsLog.error(msg.message);
      return;
  }
}

export interface UseWebSocketResult {
  isConnected: boolean;
  reconnect: () => void;
}

let gReconnectAttempts = 0;
let gReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let gIntentionalClose = false;

function clearReconnectTimer(): void {
  if (gReconnectTimer !== null) {
    clearTimeout(gReconnectTimer);
    gReconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (!useAuthStore.getState().isAuthenticated) return;
  if (gIntentionalClose) return;

  const delay = Math.min(
    WS_RECONNECT_MAX_MS,
    WS_RECONNECT_BASE_MS * 2 ** Math.min(gReconnectAttempts, 10),
  );
  gReconnectAttempts += 1;
  gReconnectTimer = setTimeout(() => {
    gReconnectTimer = null;
    connectInternal();
  }, delay);
  wsLog.info(`reconnect in ${delay}ms (attempt ${gReconnectAttempts})`);
}

function connectInternal(): void {
  clearReconnectTimer();
  if (!useAuthStore.getState().isAuthenticated) return;
  const existing = getActiveSocket();
  if (existing && existing.readyState === WebSocket.OPEN) return;
  if (existing) {
    try { existing.close(); } catch { /* ignore */ }
    setActiveSocket(null);
  }

  const wsUrl = bffOriginToWsUrl(BFF_ORIGIN, "/ws");
  const socket = new WebSocket(wsUrl);
  socket.binaryType = "arraybuffer";
  setActiveSocket(socket);

  socket.addEventListener("open", () => {
    gReconnectAttempts = 0;
    try { socket.send(JSON.stringify({ type: "auth", token: "" })); } catch { /* ignore */ }
    useAgentStore.getState().setConnected(true);
    useVoiceStore.getState().setWsSend((m) => {
      if (socket.readyState === socket.OPEN) {
        if (m.type === "voice:chunk") socket.send(m.data);
        else socket.send(JSON.stringify(m));
      }
    });
    wsLog.system("connected");
  });

  socket.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") {
      ttsService.pushChunk(ev.data as ArrayBuffer);
      return;
    }
    let parsed: ServerMessage | null = null;
    try {
      parsed = JSON.parse(ev.data) as ServerMessage;
    } catch (err) {
      wsLog.error(`invalid JSON: ${(err as Error).message}`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      wsLog.error("untyped message received");
      return;
    }
    try {
      dispatchServerMessage(parsed);
    } catch (err) {
      wsLog.error(`dispatch error: ${(err as Error).message}`);
    }
  });

  socket.addEventListener("close", () => {
    useAgentStore.getState().setConnected(false);
    wsLog.warn("disconnected");
    if (getActiveSocket() === socket) setActiveSocket(null);
    if (!gIntentionalClose) {
      scheduleReconnect();
    }
  });

  socket.addEventListener("error", () => {
    wsLog.error("socket error");
  });
}

function disconnectInternal(): void {
  gIntentionalClose = true;
  clearReconnectTimer();
  const socket = getActiveSocket();
  if (socket) {
    try { socket.close(1000, "logout"); } catch { /* ignore */ }
    setActiveSocket(null);
  }
  useAgentStore.getState().setConnected(false);
}

export function useWebSocket(): UseWebSocketResult {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      gIntentionalClose = false;
      connectInternal();
      setIsConnected(true);
    } else {
      disconnectInternal();
      setIsConnected(false);
    }
  }, [isAuthenticated]);

  const reconnect = useCallback(() => {
    gIntentionalClose = false;
    gReconnectAttempts = 0;
    connectInternal();
  }, []);

  return { reconnect, isConnected };
}
