import { useCallback, useEffect, useRef, useState } from "react";
import { createSttService } from "../services/stt/service";
import type { SttService, SttTranscript } from "../services/stt/types";
import { wakewordService } from "../services/wakeword";
import { sendBinary, sendMessage, setActiveSocket } from "../services/ws/sinks";
import { useAuthStore } from "../state/authStore";
import { DemoLogin } from "./DemoLogin";
import { DemoMicMeter } from "./DemoMicMeter";
import { DemoStateIndicator, type DemoState, type DemoEvent } from "./DemoStateIndicator";
import { DemoTranscriptLog, type TranscriptEntry } from "./DemoTranscriptLog";
import { DemoCapturePlayback, type CapturedClip } from "./DemoCapturePlayback";
import "./demo.css";

const PTT_KEY = " ";
const PTT_HOLD_MS = 200;
const BFF_WS_URL = `ws://${window.location.hostname}:${window.location.port}/ws`;

let nextClipId = 1;

function now(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

// --- WAV encoding helpers ---

function writeWavString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function pcmToWavBlob(pcmData: Uint8Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.byteLength;
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  writeWavString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeWavString(view, 8, "WAVE");
  writeWavString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeWavString(view, 36, "data");
  view.setUint32(40, dataSize, true);
  new Uint8Array(buffer, headerSize).set(pcmData);

  return new Blob([buffer], { type: "audio/wav" });
}

export function AudioInputDemo(): React.JSX.Element {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const [demoChecked, setDemoChecked] = useState(false);

  // Check session directly against BFF (not through Vite proxy, to avoid cookie domain issues)
  useEffect(() => {
    const bffOrigin = `${window.location.protocol}//${window.location.hostname}:3001`;
    fetch(`${bffOrigin}/api/auth/whoami`, { credentials: "include" })
      .then((r) => r.json())
      .then((body) => {
        if (body.authenticated) {
          useAuthStore.setState({ isAuthenticated: true, status: "success", error: null });
        }
      })
      .catch(() => {})
      .finally(() => setDemoChecked(true));
  }, []);

  const [activeMode, setActiveMode] = useState<"none" | "wakeword" | "ptt" | "mic">("none");
  const [sttEnabled, setSttEnabled] = useState(false);
  const [demoState, setDemoState] = useState<DemoState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [clips, setClips] = useState<CapturedClip[]>([]);

  const sttEnabledRef = useRef(false);
  const capturedChunksRef = useRef<ArrayBuffer[]>([]);
  const activeModeRef = useRef<"none" | "wakeword" | "ptt" | "mic">("none");
  const pttHeldRef = useRef(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const serviceRef = useRef<SttService | null>(null);
  const eventsRef = useRef<DemoEvent[]>([]);

  // Keep refs in sync
  useEffect(() => { sttEnabledRef.current = sttEnabled; }, [sttEnabled]);
  useEffect(() => { activeModeRef.current = activeMode; }, [activeMode]);

  const addEvent = useCallback((text: string) => {
    const entry = { time: now(), text };
    eventsRef.current = [entry, ...eventsRef.current].slice(0, 50);
    setEvents([...eventsRef.current]);
  }, []);

  // --- Assemble captured chunks into WAV and store as clip ---
  const assembleAndStoreClip = useCallback(() => {
    const chunks = capturedChunksRef.current;
    if (chunks.length === 0) return;

    const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    capturedChunksRef.current = [];

    const wavBlob = pcmToWavBlob(merged, 16000);
    const url = URL.createObjectURL(wavBlob);
    const totalSamples = merged.byteLength / 2;
    const duration = totalSamples / 16000;

    const modeLabel =
      activeModeRef.current === "wakeword" ? "Wakeword" :
      activeModeRef.current === "ptt" ? "PTT" : "Mic Toggle";

    setClips((prev) => [
      {
        id: nextClipId++,
        blob: wavBlob,
        url,
        timestamp: now(),
        durationSec: duration,
        mode: modeLabel,
        sttSent: sttEnabledRef.current,
      },
      ...prev,
    ]);

    addEvent(`Captured ${duration.toFixed(1)}s audio (${modeLabel})`);
  }, [addEvent]);

  // --- WS for transcript receipt ---
  const connectWs = useCallback(() => {
    if (wsRef.current) return;
    try {
      const ws = new WebSocket(BFF_WS_URL);
      ws.onopen = () => {
        setActiveSocket(ws);
        addEvent("WebSocket connected to BFF");
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "stt:transcript" && serviceRef.current) {
            serviceRef.current.emitTranscript({
              text: msg.text ?? "",
              interim: msg.interim ?? false,
              isFinal: msg.isFinal ?? (msg.interim === false),
              speechFinal: msg.speechFinal ?? false,
            });
          }
        } catch { /* binary frame */ }
      };
      ws.onclose = () => {
        setActiveSocket(null);
        wsRef.current = null;
        addEvent("WebSocket disconnected");
      };
      ws.onerror = () => addEvent("WebSocket error");
      wsRef.current = ws;
    } catch (err) {
      addEvent(`WS connect failed: ${(err as Error).message}`);
    }
  }, [addEvent]);

  const disconnectWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
      setActiveSocket(null);
    }
  }, []);

  // --- STT toggle effect ---
  useEffect(() => {
    if (sttEnabled) connectWs();
    else disconnectWs();
    return () => disconnectWs();
  }, [sttEnabled, connectWs, disconnectWs]);

  // --- Chunk sink: collect for playback, optionally send to BFF ---
  // In wakeword mode: collect chunks for batch STT (not streaming).
  // In PTT/Mic modes: send to BFF streaming STT if STT toggle is ON.
  const makeChunkSink = useCallback(
    () => (data: ArrayBuffer) => {
      // Always collect chunks for playback
      capturedChunksRef.current.push(data.slice(0));
      // Only send to streaming STT in PTT/Mic modes (not wakeword — batch handles it)
      if (sttEnabledRef.current && activeModeRef.current !== "wakeword") {
        sendBinary(data);
      }
    },
    [],
  );

  // --- Batch STT: send captured audio to BFF REST endpoint ---
  const sendToBatchStt = useCallback(async () => {
    const chunks = capturedChunksRef.current;
    if (chunks.length === 0) return;

    // Assemble chunks into a single buffer
    const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    capturedChunksRef.current = [];

    // Also store as clip for playback
    const wavBlob = pcmToWavBlob(merged, 16000);
    const url = URL.createObjectURL(wavBlob);
    const duration = (merged.byteLength / 2) / 16000;
    setClips((prev) => [
      { id: nextClipId++, blob: wavBlob, url, timestamp: now(), durationSec: duration, mode: "Wakeword", sttSent: sttEnabledRef.current },
      ...prev,
    ]);

    if (!sttEnabledRef.current) {
      addEvent(`Captured ${duration.toFixed(1)}s audio (STT off — not transcribed)`);
      return;
    }

    // Build WAV for the REST endpoint
    try {
      const bffOrigin = `${window.location.protocol}//${window.location.hostname}:3001`;
      const res = await fetch(`${bffOrigin}/api/stt/transcribe`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "audio/wav" },
        body: wavBlob,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        addEvent(`STT error: ${err?.error?.message ?? res.status}`);
        return;
      }

      const result = (await res.json()) as { transcript: string };
      const text = result.transcript;
      if (text) {
        addEvent(`Transcript: ${text}`);
        setTranscripts((prev) => [...prev, { time: now(), text, interim: false }]);
      } else {
        addEvent("No speech detected");
      }
    } catch (err) {
      addEvent(`STT request failed: ${(err as Error).message}`);
    }
  }, [addEvent]);

  // --- Create demo STT service (runs once) ---
  useEffect(() => {
    const svc = createSttService({
      chunkSink: makeChunkSink(),
      endSink: () => { if (sttEnabledRef.current) sendMessage({ type: "voice:end" }); },
      abortSink: () => {},
    });
    serviceRef.current = svc;

    const offState = svc.onStateChange((s) => {
      if (s.capturing) {
        setDemoState((prev) => {
          if (prev === "wakeword-detected") return "recording";
          if (prev === "recording-ptt") return "recording-ptt";
          return "recording";
        });
      } else {
        // Session ended
        if (activeModeRef.current === "wakeword" && capturedChunksRef.current.length > 0) {
          // Wakeword mode: send captured audio to batch STT endpoint
          setDemoState("shipping");
          addEvent("Sending audio to STT...");
          void sendToBatchStt();
        } else if (activeModeRef.current !== "wakeword" && capturedChunksRef.current.length > 0) {
          assembleAndStoreClip();
        }
        setDemoState("idle");
      }
      if (s.error) {
        setError(s.error);
        setDemoState("error");
        addEvent(`Error: ${s.error}`);
      }
    });

    const offLevel = svc.onMicLevel((l) => setMicLevel(l));

    const offTranscript = svc.onTranscript((t: SttTranscript) => {
      if (t.speechFinal || !t.interim) addEvent(`Transcript: ${t.text}`);
      setTranscripts((prev) => {
        if (t.interim) {
          const last = prev[prev.length - 1];
          if (last?.interim) return [...prev.slice(0, -1), { time: now(), text: t.text, interim: true }];
          return [...prev, { time: now(), text: t.text, interim: true }];
        }
        const filtered = prev.filter((e) => !e.interim || e.text !== t.text);
        return [...filtered, { time: now(), text: t.text, interim: false }];
      });
    });

    return () => { offState(); offLevel(); offTranscript(); };
  }, [makeChunkSink, addEvent, assembleAndStoreClip, sendToBatchStt]);

  // --- Mode activation ---
  const activateWakeword = useCallback(async () => {
    if (activeMode !== "none") return;
    setActiveMode("wakeword");
    setDemoState("loading");
    addEvent("Loading wakeword engine...");
    // Close WS — wakeword service's sendBinary() will be silently dropped.
    // We use the batch STT endpoint instead of streaming.
    disconnectWs();
    try {
      await wakewordService.start();
      setDemoState("wakeword-listening");
      addEvent("Wakeword listening — say \"Hey Jarvis\"");
    } catch (err) {
      setDemoState("error");
      setError((err as Error).message);
      addEvent(`Wakeword failed: ${(err as Error).message}`);
      setActiveMode("none");
    }
  }, [activeMode, addEvent, disconnectWs]);

  const deactivateWakeword = useCallback(async () => {
    if (serviceRef.current?.getState().capturing) serviceRef.current.abortSession();
    try { await wakewordService.stop(); } catch { /* ignore */ }
    setActiveMode("none");
    setDemoState("idle");
    addEvent("Wakeword mode deactivated");
  }, [addEvent]);

  const activatePtt = useCallback(() => {
    if (activeMode !== "none") return;
    setActiveMode("ptt");
    addEvent("PTT mode activated — hold Space to record");
  }, [activeMode, addEvent]);

  const deactivatePtt = useCallback(() => {
    setActiveMode("none");
    setDemoState("idle");
    addEvent("PTT mode deactivated");
  }, [addEvent]);

  const activateMic = useCallback(async () => {
    if (activeMode !== "none") return;
    setActiveMode("mic");
    capturedChunksRef.current = [];
    addEvent("Mic toggle activated — click Stop to finish");
    await serviceRef.current?.startSession();
  }, [activeMode, addEvent]);

  const deactivateMic = useCallback(async () => {
    await serviceRef.current?.endSession();
    setActiveMode("none");
    addEvent("Mic toggle stopped");
  }, [addEvent]);

  const handleModeClick = useCallback(
    async (mode: "wakeword" | "ptt" | "mic") => {
      if (activeMode === "wakeword") await deactivateWakeword();
      else if (activeMode === "ptt") deactivatePtt();
      else if (activeMode === "mic") await deactivateMic();

      if (mode === "wakeword") await activateWakeword();
      else if (mode === "ptt") activatePtt();
      else if (mode === "mic") await activateMic();
    },
    [activeMode, activateWakeword, activatePtt, activateMic, deactivateWakeword, deactivatePtt, deactivateMic],
  );

  // --- Wakeword listener ---
  useEffect(() => {
    const unsub = wakewordService.onWake(() => {
      addEvent("Wake word detected! Recording...");
      setDemoState("wakeword-detected");
      setTimeout(() => setDemoState("recording"), 300);
      capturedChunksRef.current = [];
      void serviceRef.current?.startSession({ forceHold: false });
    });
    return unsub;
  }, [addEvent]);

  // --- PTT keyboard handlers ---
  useEffect(() => {
    if (activeMode !== "ptt") return;

    const isTextInput = (el: Element | null) => {
      if (!el || !(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    };

    const onDown = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY || e.repeat) return;
      if (isTextInput(document.activeElement)) return;
      if (pttHeldRef.current) return;

      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        pttHeldRef.current = true;
        capturedChunksRef.current = [];
        setDemoState("recording-ptt");
        addEvent("PTT: recording");
        void serviceRef.current?.startSession({ forceHold: true });
      }, PTT_HOLD_MS);
    };

    const onUp = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY) return;
      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
        return;
      }
      if (!pttHeldRef.current) return;
      pttHeldRef.current = false;
      addEvent("PTT: stopped");
      void serviceRef.current?.endSession();
    };

    const onBlur = () => {
      if (holdTimerRef.current !== null) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
      if (!pttHeldRef.current) return;
      pttHeldRef.current = false;
      addEvent("PTT: blur — stopped");
      void serviceRef.current?.endSession();
    };

    document.addEventListener("keydown", onDown);
    document.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onDown);
      document.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [activeMode, addEvent]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      void wakewordService.stop();
      serviceRef.current?.abortSession();
      disconnectWs();
      setClips((prev) => { for (const c of prev) URL.revokeObjectURL(c.url); return []; });
    };
  }, [disconnectWs]);

  const handleClearClips = useCallback(() => {
    setClips((prev) => { for (const c of prev) URL.revokeObjectURL(c.url); return []; });
  }, []);

  // --- Auth gate ---
  if (!demoChecked) return (
    <div className="demo-shell">
      <h1 className="demo-title">Audio Input Demo</h1>
      <div className="demo-section" style={{ textAlign: "center", color: "#555", fontSize: "0.75rem" }}>
        Checking session...
      </div>
    </div>
  );

  if (!isAuthenticated) return <DemoLogin />;

  return (
    <div className="demo-shell">
      <h1 className="demo-title">Audio Input Demo</h1>

      {/* STT Toggle */}
      <div className="demo-section">
        <div className="demo-section-title">STT Provider</div>
        <div className="demo-toggle-row">
          <div
            className={`demo-toggle ${sttEnabled ? "demo-toggle--on" : ""}`}
            onClick={() => setSttEnabled((v) => !v)}
            role="switch"
            aria-checked={sttEnabled}
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSttEnabled((v) => !v); } }}
          />
          <span className="demo-toggle-label">Send to STT {sttEnabled ? "(ON)" : "(OFF)"}</span>
        </div>
      </div>

      {/* Mode Buttons */}
      <div className="demo-section">
        <div className="demo-section-title">Input Mode</div>
        <div className="demo-modes">
          <button
            className={`demo-mode-btn ${activeMode === "wakeword" ? "demo-mode-btn--active" : ""}`}
            onClick={() => void handleModeClick("wakeword")}
            disabled={activeMode !== "none" && activeMode !== "wakeword"}
          >
            {activeMode === "wakeword" ? "Stop Wakeword" : "Always Listening (Wakeword)"}
          </button>
          <button
            className={`demo-mode-btn ${activeMode === "ptt" ? "demo-mode-btn--active" : ""}`}
            onClick={() => void handleModeClick("ptt")}
            disabled={activeMode !== "none" && activeMode !== "ptt"}
          >
            {activeMode === "ptt" ? "Stop PTT" : "Keyboard Hold (PTT)"}
          </button>
          <button
            className={`demo-mode-btn ${activeMode === "mic" ? "demo-mode-btn--active" : ""}`}
            onClick={() => void handleModeClick("mic")}
            disabled={activeMode !== "none" && activeMode !== "mic"}
          >
            {activeMode === "mic" ? "Stop Mic" : "Mic Toggle (Press & Release)"}
          </button>
        </div>
        {activeMode === "mic" && (
          <button
            className="demo-mode-btn"
            style={{ marginTop: "0.5rem", width: "100%", borderColor: "#ef4444", color: "#ef4444" }}
            onClick={() => void deactivateMic()}
          >
            Stop Recording
          </button>
        )}
      </div>

      {/* State & Level */}
      <div className="demo-section">
        <div className="demo-section-title">Pipeline State</div>
        <DemoStateIndicator state={demoState} error={error} events={events} />
        <div style={{ marginTop: "0.75rem" }}>
          <div className="demo-section-title">Mic Level</div>
          <DemoMicMeter level={micLevel} />
        </div>
      </div>

      {/* Transcripts */}
      <div className="demo-section">
        <div className="demo-section-title">Transcripts</div>
        <DemoTranscriptLog entries={transcripts} sttEnabled={sttEnabled} />
      </div>

      {/* Captured Audio */}
      <div className="demo-section">
        <div className="demo-section-title">Captured Audio</div>
        <DemoCapturePlayback clips={clips} onClearAll={handleClearClips} />
        {activeMode === "wakeword" && !sttEnabled && (
          <div className="demo-note">Playback for wakeword requires STT ON (audio ships via WS sinks)</div>
        )}
      </div>
    </div>
  );
}
