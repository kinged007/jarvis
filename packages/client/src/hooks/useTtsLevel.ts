import { useEffect, useState } from "react";
import { ttsService } from "../services/tts";

export function useTtsLevel(): number {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    return ttsService.subscribeLevel((l) => setLevel(l));
  }, []);

  return level;
}
