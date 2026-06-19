export type DemoState =
  | "idle"
  | "loading"
  | "wakeword-listening"
  | "wakeword-detected"
  | "recording"
  | "recording-ptt"
  | "shipping"
  | "error";

export interface DemoEvent {
  time: string;
  text: string;
}

const STATE_LABELS: Record<DemoState, string> = {
  idle: "Idle",
  loading: "Loading...",
  "wakeword-listening": "Listening for wake word...",
  "wakeword-detected": "Wake detected! Recording...",
  recording: "Recording...",
  "recording-ptt": "Capturing... (hold key)",
  shipping: "Shipping audio...",
  error: "Error",
};

export function DemoStateIndicator({
  state,
  error,
  events,
}: {
  state: DemoState;
  error: string | null;
  events: DemoEvent[];
}) {
  return (
    <div>
      <div className="demo-state">
        <div className={`demo-state-dot demo-state-dot--${state}`} />
        <span className="demo-state-label">
          {state === "error" && error ? `Error: ${error}` : STATE_LABELS[state]}
        </span>
      </div>
      <div className="demo-event-log">
        {events.length === 0 && (
          <div className="demo-event-entry" style={{ color: "#333" }}>
            No events yet
          </div>
        )}
        {events.map((e, i) => (
          <div key={i} className="demo-event-entry">
            <span className="demo-event-time">{e.time}</span>
            {e.text}
          </div>
        ))}
      </div>
    </div>
  );
}
