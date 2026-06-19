import { useEffect, useRef, useState, useCallback } from "react";
import { ensureAudioContextRunning } from "../lib/audio";
import { ttsService } from "../services/tts";

/**
 * Thin React adapter over the TTS service. Polls the queue depth
 * and playing flag every 150ms so the UI can render the play
 * controls without subscribing to a store.
 */
export interface UseAudioPlaybackResult {
  isReady: boolean;
  queueDepth: number;
  isPlaying: boolean;
  stopCurrent: () => void;
  stopAll: () => void;
}

export function useAudioPlayback(): UseAudioPlaybackResult {
  const [, setTick] = useState(0);
  const readyRef = useRef(false);

  useEffect(() => {
    void ensureAudioContextRunning()
      .then(() => { readyRef.current = true; setTick((n) => n + 1); })
      .catch(() => { readyRef.current = false; });
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 150);
    return () => clearInterval(id);
  }, []);

  const sc = useCallback(() => ttsService.stopCurrent(), []);
  const sa = useCallback(() => ttsService.stopAll(), []);

  return {
    isReady: readyRef.current,
    queueDepth: ttsService.getQueueDepth(),
    isPlaying: ttsService.isPlaying(),
    stopCurrent: sc,
    stopAll: sa,
  };
}
