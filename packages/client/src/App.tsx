import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import "./App.css";
import { useAgentStore } from "./state/agentStore";
import { useAuthStore } from "./state/authStore";
import { useVoiceStore } from "./state/voiceStore";
import { useWebSocket } from "./hooks/useWebSocket";
import { useAudioPlayback } from "./hooks/useAudioPlayback";
import { useAudioCapture } from "./hooks/useAudioCapture";
import { useTtsLevel } from "./hooks/useTtsLevel";
import { useWakeWord } from "./hooks/useWakeWord";
import { makeServiceLog } from "./services/log";
import { sttService } from "./services/stt";
import { ttsService } from "./services/tts";
import { sendMessage } from "./services/ws/sinks";
import { AuthGate } from "./components/auth/AuthGate";
import { ShortcutBar } from "./components/ShortcutBar";
import { LogModal } from "./components/LogModal";
import { ApprovalModal } from "./components/ApprovalModal";
import { WakeWordIndicator } from "./components/WakeWordIndicator";
import { MoodOrbs } from "./components/brain/MoodOrbs";
import { PalettePicker } from "./components/brain/PalettePicker";
import { Wifi, WifiOff, Bot, BotOff, Loader2, Settings, Clock, AlertTriangle, ExternalLink, X, SkipForward, Square } from "lucide-react";

const HEARTBEAT_TIMEOUT_MS = 30_000;
/** Push-to-talk hotkey. Hold to record, release to send. Set to `""` to disable. */
const PTT_KEY = " ";
/** How long (ms) the key must be held before push-to-talk activates. Prevents accidental taps. */
const PTT_HOLD_MS = 200;

const wsLog = makeServiceLog("ws");
const agentLog = makeServiceLog("agent");

function App(): React.JSX.Element {
  const checkSession = useAuthStore((s) => s.checkSession);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  );
}

function Dashboard(): React.JSX.Element {
  const connected = useAgentStore((s) => s.connected);
  const agentState = useAgentStore((s) => s.agentState);
  const currentTask = useAgentStore((s) => s.currentTask);
  const lastAgentResponse = useAgentStore((s) => s.lastAgentResponse);
  const currentCommentary = useAgentStore((s) => s.currentCommentary);
  const liveResponseText = useAgentStore((s) => s.liveResponseText);
  const lastHeartbeatAt = useAgentStore((s) => s.lastHeartbeatAt);
  const browserUrl = useAgentStore((s) => s.browserUrl);
  const setBrowserUrl = useAgentStore((s) => s.setBrowserUrl);

  const voiceState = useVoiceStore((s) => s.currentState);
  const micLevel = useVoiceStore((s) => s.micLevel);
  const voiceError = useVoiceStore((s) => s.error);
  const onWakeWord = useVoiceStore((s) => s.onWakeWord);
  const onIdle = useVoiceStore((s) => s.onIdle);
  const onProcessing = useVoiceStore((s) => s.onProcessing);
  const startProcessingTimeout = useVoiceStore((s) => s.startProcessingTimeout);
  const ttsLevel = useTtsLevel();

  // Wakeword hook — handles interrupt when agent is active
  const handleWakewordWake = useCallback(() => {
    const agent = useAgentStore.getState();
    const voice = useVoiceStore.getState();
    const isAgentActive =
      agent.agentState === "thinking" ||
      agent.agentState === "executing" ||
      agent.agentState === "waiting";

    if (isAgentActive) {
      // Interrupt the agent — send cancel, clear TTS, start new session
      sendMessage({ type: "cancel" });
      ttsService.stopAll();
      agentLog.info("wakeword interrupt — cancelling agent");
    }

    if (voice.currentState === "speaking") {
      ttsService.stopAll();
    }

    // Transition voice state to listening for new command
    onWakeWord();
  }, [onWakeWord]);

  const {
    isWakeWordSupported,
    isListening,
    isUserDisabled,
    error: wakewordError,
    toggleWakeword,
  } = useWakeWord(handleWakewordWake);

  // Heartbeat-staleness: the BFF sends a `system:heartbeat` frame
  // every 10s. If we haven't seen one in 30s the WS is effectively
  // dead even if the socket itself hasn't closed yet (e.g. NAT
  // timeout, server hung). Drives the "BFF offline" indicator in
  // the top-right.
  const [heartbeatStale, setHeartbeatStale] = useState(false);
  useEffect(() => {
    const id = setInterval(() => {
      if (!connected) {
        setHeartbeatStale(false);
        return;
      }
      if (lastHeartbeatAt === null) {
        setHeartbeatStale(true);
        return;
      }
      setHeartbeatStale(Date.now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS);
    }, 5_000);
    return () => clearInterval(id);
  }, [connected, lastHeartbeatAt]);
  const bffOnline = connected && !heartbeatStale;

  const [moodOrbsPalette, setMoodOrbsPalette] = useState(() => {
    try {
      const v = localStorage.getItem("jarvis:moodOrbsPalette");
      const n = parseInt(v ?? "", 10);
      return n >= 1 && n <= 6 ? n : 1;
    } catch {
      return 1;
    }
  });

  const setPalette = useCallback((id: number) => {
    setMoodOrbsPalette(id);
    try { localStorage.setItem("jarvis:moodOrbsPalette", String(id)); } catch { /* noop */ }
  }, []);

  const [commandText, setCommandText] = useState("");
  const [logModalOpen, setLogModalOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useWebSocket();
  const { stopCurrent, stopAll, isPlaying: audioPlaying, queueDepth } = useAudioPlayback();
  const { isCapturing } = useAudioCapture(sttService);

  // Push-to-talk: hold PTT_KEY to record, release to send.
  // Directly calls sttService.startSession()/endSession() — bypasses the
  // voice state machine to avoid the async race between getUserMedia() and
  // the React effect. key-down = start, key-up = stop. Two independent events.
  const pttHeldRef = useRef(false);

  useEffect(() => {
    if (!PTT_KEY) return;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;

    const isTextInput = (el: Element | null) => {
      if (!el || !(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    };

    const onDown = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY || e.repeat) return;
      if (isTextInput(document.activeElement)) return;
      if (pttHeldRef.current) return;

      holdTimer = setTimeout(() => {
        holdTimer = null;
        // Activate: call startSession directly. No voiceState involved.
        pttHeldRef.current = true;
        void sttService.startSession({ forceHold: true });
      }, PTT_HOLD_MS);
    };

    const onUp = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY) return;
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
        return;
      }
      if (!pttHeldRef.current) return;
      // Deactivate: call endSession directly. No voiceState involved.
      pttHeldRef.current = false;
      void sttService.endSession();
    };

    const onBlur = () => {
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      if (!pttHeldRef.current) return;
      pttHeldRef.current = false;
      void sttService.endSession();
    };

    document.addEventListener("keydown", onDown);
    document.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onDown);
      document.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      if (holdTimer !== null) clearTimeout(holdTimer);
    };
  }, []);

  const openBrowserUrl = useCallback(() => {
    if (!browserUrl) return;
    window.open(browserUrl, "_blank", "noopener,noreferrer");
    setBrowserUrl(null);
  }, [browserUrl, setBrowserUrl]);

  const sendCommand = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!connected) {
      wsLog.error("not connected — cannot send command");
      return;
    }
    ttsService.stopAll();
    sendMessage({ type: "command", text: trimmed });
    agentLog.info(`cmd: ${trimmed.slice(0, 100)}`);
    onProcessing();
    startProcessingTimeout();
    setCommandText("");
  }, [connected, onProcessing, startProcessingTimeout]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendCommand(e.currentTarget.value);
    }
  }, [sendCommand]);

  const handleMicToggle = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    if (voiceState === "listening") {
      onIdle();
    } else {
      onWakeWord();
    }
  }, [voiceState, onWakeWord, onIdle]);

  const isRecording = voiceState === "listening" || isCapturing;
  const isFullyOffline = !bffOnline && agentState === "offline";

  return (
    <div className={`jarvis-shell palette-${moodOrbsPalette}`}>
      {/* Top status bar */}
      <header className="jarvis-statusbar">
        <div className="jarvis-statusbar__group">
          <span className="jarvis-title">J.A.R.V.I.S.</span>
          {isRecording && (
            <span className="jarvis-mic-indicator" title="Recording">{'\u25CF'}</span>
          )}
          {voiceError && (
            <span className="jarvis-mic-error" title={voiceError}>{'\u26A0'}</span>
          )}
          <WakeWordIndicator
            isSupported={isWakeWordSupported}
            isListening={isListening}
            isUserDisabled={isUserDisabled}
            error={wakewordError}
            onToggle={toggleWakeword}
          />
        </div>
        <div className="jarvis-statusbar__group jarvis-statusbar__group--right">
          <span
            className={`jarvis-indicator jarvis-indicator--${bffOnline ? "ok" : "down"}`}
            title={bffOnline ? "BFF connected" : heartbeatStale ? "BFF heartbeat stale" : "BFF disconnected"}
            aria-label={bffOnline ? "BFF connected" : heartbeatStale ? "BFF heartbeat stale" : "BFF disconnected"}
          >
            {bffOnline ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
          </span>
          <span
            className={`jarvis-indicator jarvis-indicator--${
              agentState === "offline" || agentState === "error" ? "down" : "ok"
            }`}
            title={`Agent: ${agentState}`}
            aria-label={`Agent: ${agentState}`}
          >
            {agentState === "offline" && <BotOff className="size-3.5" />}
            {agentState === "idle" && <Bot className="size-3.5" />}
            {agentState === "thinking" && <Loader2 className="size-3.5 animate-spin" />}
            {agentState === "executing" && <Settings className="size-3.5 animate-spin" />}
            {agentState === "waiting" && <Clock className="size-3.5" />}
            {agentState === "error" && <AlertTriangle className="size-3.5" />}
          </span>
        </div>
      </header>

      {/* Two-zone main grid */}
      <main className="jarvis-grid">
        <motion.aside
          className="jarvis-zone jarvis-zone--widgets"
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          aria-label="Widget panel"
        >
          <div className="jarvis-zone__title">WIDGETS</div>
          <div className="jarvis-zone__empty">no widgets yet</div>
        </motion.aside>

        <motion.section
          className="jarvis-zone jarvis-zone--brain"
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          aria-label="AI brain visualization"
        >
          <div className="jarvis-brain__center">
            <MoodOrbs
              displayState={audioPlaying || queueDepth > 0 ? "speaking" : agentState}
              ttsLevel={ttsLevel}
              agentOnline={agentState !== "offline"}
            />
            <PalettePicker current={moodOrbsPalette} onChange={setPalette} />
          </div>
          {currentCommentary && (
            <p className="jarvis-brain__commentary">{currentCommentary}</p>
          )}
          {liveResponseText ? (
            <p className="jarvis-brain__transcript jarvis-brain__transcript--live">
              {liveResponseText}
              <span className="jarvis-brain__caret" aria-hidden="true">{'\u258D'}</span>
            </p>
          ) : lastAgentResponse ? (
            <p className="jarvis-brain__transcript">{lastAgentResponse}</p>
          ) : null}
          <ShortcutBar onLogsClick={() => setLogModalOpen(true)} />
        </motion.section>
      </main>

      {/* Browser URL notification — clickable link (bypasses popup blocker) */}
      {browserUrl && (
        <div className="jarvis-browser-notification">
          <ExternalLink className="size-4" />
          <span
            className="jarvis-browser-notification__link"
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }}
          >
            {browserUrl.length > 60 ? browserUrl.slice(0, 60) + "..." : browserUrl}
          </span>
          <button
            className="jarvis-browser-notification__open"
            onClick={openBrowserUrl}
            aria-label="Open in browser"
            title="Open in browser"
          >
            Open
          </button>
          <button
            className="jarvis-browser-notification__dismiss"
            onClick={() => setBrowserUrl(null)}
            aria-label="Dismiss"
            title="Dismiss"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* Bottom: voice bar + text input + mic button */}
      <footer className="jarvis-footer">
        <div className={`jarvis-voicebar jarvis-voicebar--${voiceState}`}>
          <span className="jarvis-voicebar__dot" />
          <span className="jarvis-voicebar__label">
            {audioPlaying || queueDepth > 0 ? "speaking" : agentState}
            {currentTask ? ` \u00B7 ${currentTask}` : ""}
          </span>
          <div className="jarvis-voicebar__meter" aria-hidden="true">
            <div
              className="jarvis-voicebar__meter-fill"
              style={{ width: `${Math.round(micLevel * 100)}%` }}
            />
          </div>
          {(audioPlaying || queueDepth > 0) && (
            <div className="jarvis-voicebar__controls">
              <button
                className="jarvis-voicebar__ctrl-btn"
                onClick={() => stopCurrent()}
                title="Stop current — play next"
                aria-label="Stop current audio"
              >
                <SkipForward className="size-3.5" />
              </button>
              <button
                className="jarvis-voicebar__ctrl-btn"
                onClick={() => stopAll()}
                title="Stop all"
                aria-label="Stop all audio"
              >
                <Square className="size-3.5" />
              </button>
            </div>
          )}
        </div>
        <div className="jarvis-inputrow">
          <button
            className={`jarvis-mic-btn ${isRecording ? "jarvis-mic-btn--active" : ""}`}
            onClick={handleMicToggle}
            disabled={isFullyOffline}
            aria-label={isRecording ? "Click to stop recording" : "Click to start recording"}
            title={isRecording ? "Stop recording" : "Start recording"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </button>
          <input
            ref={inputRef}
            className="jarvis-input"
            type="text"
            placeholder={isFullyOffline ? "Waiting for connection..." : "Type a command..."}
            value={commandText}
            onChange={(e) => setCommandText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isFullyOffline}
            aria-label="Text command input"
          />
        </div>
      </footer>

      <LogModal open={logModalOpen} onOpenChange={setLogModalOpen} />
      <ApprovalModal />
    </div>
  );
}

export default App;
