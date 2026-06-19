import { useRef, useEffect } from "react";
import type { MoodOrbsProps } from "./types";
import "./MoodOrbs.css";

function jitter(t: number, phase: number): number {
  return (
    Math.sin(t * 3.7 + phase) * 0.5 +
    Math.sin(t * 7.3 + phase * 2.1) * 0.3 +
    Math.sin(t * 13.1 + phase * 3.7) * 0.2
  );
}

const BLOB_INDICES: [string, number][] = [
  ["blob-1", 1],
  ["blob-2", 2],
  ["blob-3", 3],
  ["blob-4", 4],
  ["blob-1 alt", 5],
  ["blob-2 alt", 6],
  ["blob-3 alt", 7],
  ["blob-4 alt", 8],
];

const EASE_RATE = 3;

const CAPTIONS: Record<string, string> = {
  offline: "agent offline",
  idle: "idle",
  thinking: "thinking…",
  executing: "executing…",
  waiting: "waiting…",
  error: "error",
  speaking: "speaking",
};

export function MoodOrbs({ displayState, ttsLevel, agentOnline }: MoodOrbsProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const rafRef = useRef<number | null>(null);
  const tRef = useRef(0);
  const amplitudeRef = useRef(0);
  const targetAmpRef = useRef(0);
  const displayStateRef = useRef(displayState);
  const ttsLevelRef = useRef(ttsLevel);

  useEffect(() => { displayStateRef.current = displayState; }, [displayState]);
  useEffect(() => { ttsLevelRef.current = ttsLevel; }, [ttsLevel]);

  useEffect(() => {
    let lastTime = performance.now();

    function loop(now: number): void {
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      const state = displayStateRef.current;
      if (state === "offline") {
        targetAmpRef.current = 0;
      } else if (state === "speaking") {
        targetAmpRef.current = 1 + ttsLevelRef.current * 3;
      } else if (state === "thinking" || state === "executing") {
        targetAmpRef.current = 0.7;
      } else if (state === "waiting") {
        targetAmpRef.current = 0.4;
      } else {
        targetAmpRef.current = 0;
      }

      const target = targetAmpRef.current;
      let amp = amplitudeRef.current;
      if (Math.abs(target - amp) > 0.001) {
        amp = amp + (target - amp) * (1 - Math.exp(-dt * EASE_RATE));
      } else {
        amp = target;
      }
      amplitudeRef.current = amp;

      if (svgRef.current) {
        tRef.current += dt;
        const t = tRef.current;
        for (const [, idx] of BLOB_INDICES) {
          const phase = idx * 1.7;
          const jx = jitter(t + 0.5, phase) * 5 * amp;
          const jy = jitter(t, phase + 1.3) * 5 * amp;
          const js = 1 + jitter(t + 1.7, phase + 0.8) * 0.05 * amp;
          svgRef.current.style.setProperty(`--jx-${idx}`, jx.toFixed(2));
          svgRef.current.style.setProperty(`--jy-${idx}`, jy.toFixed(2));
          svgRef.current.style.setProperty(`--js-${idx}`, js.toFixed(3));
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    }

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Map displayState to a CSS class. New states reuse existing animation
  // classes where they match: thinking/executing → processing, waiting → subtle.
  const cssState =
    displayState === "thinking" || displayState === "executing" ? "processing"
    : displayState === "waiting" ? "listening"
    : displayState;

  return (
    <div className={`moodorbs moodorbs--${cssState}${!agentOnline ? " moodorbs--offline" : ""}`}>
      <div className="moodorbs__blobs">
        <svg ref={svgRef} viewBox="0 0 1200 1200">
          <g className="blob blob-1">
            <path />
          </g>
          <g className="blob blob-2">
            <path />
          </g>
          <g className="blob blob-3">
            <path />
          </g>
          <g className="blob blob-4">
            <path />
          </g>
          <g className="blob blob-1 alt">
            <path />
          </g>
          <g className="blob blob-2 alt">
            <path />
          </g>
          <g className="blob blob-3 alt">
            <path />
          </g>
          <g className="blob blob-4 alt">
            <path />
          </g>
        </svg>
      </div>
      <div className="moodorbs__caption">
        <span>{CAPTIONS[displayState] ?? displayState}</span>
      </div>
    </div>
  );
}
