export interface CapturedClip {
  id: number;
  blob: Blob;
  url: string;
  timestamp: string;
  durationSec: number;
  mode: string;
  sttSent: boolean;
}

export function DemoCapturePlayback({
  clips,
  onClearAll,
}: {
  clips: CapturedClip[];
  onClearAll: () => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <span style={{ fontSize: "0.65rem", color: "#555" }}>
          {clips.length} clip{clips.length !== 1 ? "s" : ""}
        </span>
        {clips.length > 0 && (
          <button className="demo-clear-btn" onClick={onClearAll}>
            Clear All
          </button>
        )}
      </div>
      {clips.length === 0 && (
        <div className="demo-capture-empty">
          No captured audio yet
        </div>
      )}
      {clips.map((clip) => (
        <div key={clip.id} className="demo-capture-card">
          <div className="demo-capture-header">
            <span className="demo-capture-time">{clip.timestamp}</span>
            <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
              <span className="demo-capture-mode">{clip.mode}</span>
              <span
                className={`demo-capture-mode ${
                  clip.sttSent ? "demo-capture-mode--stt" : "demo-capture-mode--no-stt"
                }`}
              >
                {clip.sttSent ? "STT sent" : "STT off"}
              </span>
              <span style={{ fontSize: "0.6rem", color: "#555" }}>
                {clip.durationSec.toFixed(1)}s
              </span>
            </div>
          </div>
          <audio className="demo-capture-audio" controls src={clip.url} />
        </div>
      ))}
    </div>
  );
}
