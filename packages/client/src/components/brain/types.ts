import type { BffAgentState } from "../../state/agentStore";

export interface MoodOrbsProps {
  /** Agent state from the BFF, or "speaking" when the UI is playing audio. */
  displayState: BffAgentState | "speaking";
  ttsLevel: number;
  /** Whether the underlying agent (Hermes) is online. */
  agentOnline: boolean;
}

export interface PalettePickerProps {
  current: number;
  onChange: (id: number) => void;
}
