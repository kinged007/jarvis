/**
 * useWakeWord — React wrapper around the wakeword service.
 *
 * The service itself lives in `services/wakeword/`. This hook is a thin
 * React adapter that subscribes to wake events, manages auto-start
 * (when BFF+agent are online), exposes toggle state, and polls the
 * service state for UI updates.
 *
 * Auto-start is controlled by `VITE_WAKEWORD_AUTO_START` env var
 * (defaults to `DEFAULT_CLIENT_CONFIG.wakewordAutoStart` which is true).
 * If auto-start fails (e.g. mic denied, model init failure), the
 * service stays disabled until the user activates it.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_CLIENT_CONFIG } from "@jarvis/shared";
import { wakewordService, type WakewordState } from "../services/wakeword";
import { useAgentStore } from "../state/agentStore";

export interface UseWakeWordResult {
  isWakeWordSupported: boolean;
  isListening: boolean;
  isUserDisabled: boolean;
  error: string | null;
  startListening: () => Promise<void>;
  stopListening: () => void;
  toggleWakeword: () => void;
  takePreRollBuffer: () => Float32Array | null;
}

const ENABLED = import.meta.env.VITE_OPENWAKEWORD_ENABLED === "true";
const AUTO_START =
  (import.meta.env.VITE_WAKEWORD_AUTO_START ?? String(DEFAULT_CLIENT_CONFIG.wakewordAutoStart)) === "true";

export function useWakeWord(onWakeWord: () => void): UseWakeWordResult {
  const [state, setState] = useState<WakewordState>(() => wakewordService.getState());
  const [userDisabled, setUserDisabled] = useState(false);
  const autoStartTried = useRef(false);
  const onWakeRef = useRef(onWakeWord);

  // Keep callback ref current (use layout effect to avoid render-time ref access)
  useLayoutEffect(() => {
    onWakeRef.current = onWakeWord;
  });

  // Subscribe to wake events
  useEffect(() => {
    const unsub = wakewordService.onWake(() => onWakeRef.current());
    return unsub;
  }, []);

  // Poll state every 250ms for UI updates
  useEffect(() => {
    if (!ENABLED) {
      setState((s) => {
        const fresh = wakewordService.getState();
        if (s.listening === fresh.listening) return s;
        return { ...fresh, listening: false };
      });
      return;
    }
    setState(wakewordService.getState());
    const interval = setInterval(() => setState(wakewordService.getState()), 250);
    return () => clearInterval(interval);
  }, []);

  // Watch agent store for online status
  const agentReady = useAgentStore((s) => s.agentReady);
  const connected = useAgentStore((s) => s.connected);
  const bffOnline = connected && agentReady;

  // Auto-start when BFF + agent come online
  useEffect(() => {
    if (!ENABLED) return;
    if (!AUTO_START) return;
    if (userDisabled) return;
    if (!bffOnline) return;
    if (autoStartTried.current) return;

    const svc = wakewordService;
    if (!svc.getState().supported) return;
    if (svc.getState().listening) return;

    autoStartTried.current = true;
    svc.start().catch(() => {
      // Auto-start failed — leave disabled for user to activate manually
    });
  }, [bffOnline, userDisabled]);

  // Reset auto-start flag when BFF goes offline
  useEffect(() => {
    if (!bffOnline) {
      autoStartTried.current = false;
    }
  }, [bffOnline]);

  // Cleanup stop on unmount
  useEffect(() => {
    return () => {
      wakewordService.stop();
    };
  }, []);

  const startListening = useCallback(async () => {
    if (!ENABLED) return;
    await wakewordService.start();
    setState(wakewordService.getState());
  }, []);

  const stopListening = useCallback(() => {
    wakewordService.stop();
    setState(wakewordService.getState());
  }, []);

  const toggleWakeword = useCallback(() => {
    const currentlyListening = wakewordService.getState().listening;
    if (currentlyListening) {
      // User is disabling — stop listening
      setUserDisabled(true);
      wakewordService.stop();
      setState(wakewordService.getState());
    } else {
      // User is enabling — start listening
      setUserDisabled(false);
      autoStartTried.current = true;
      void wakewordService.start().then(() => {
        const s = wakewordService.getState();
        console.info(`[wakeword] start() resolved: listening=${s.listening} error=${s.error ?? "null"}`);
        setState(s);
      });
    }
  }, []);

  return {
    isWakeWordSupported: state.supported,
    isListening: state.listening,
    isUserDisabled: userDisabled,
    error: state.error,
    startListening,
    stopListening,
    toggleWakeword,
    takePreRollBuffer: () => wakewordService.takePreRollBuffer(),
  };
}
