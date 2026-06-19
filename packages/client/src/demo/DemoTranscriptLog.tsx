export interface TranscriptEntry {
  time: string;
  text: string;
  interim: boolean;
}

export function DemoTranscriptLog({
  entries,
  sttEnabled,
}: {
  entries: TranscriptEntry[];
  sttEnabled: boolean;
}) {
  if (!sttEnabled) {
    return (
      <div className="demo-note">
        STT disabled — transcripts will not appear
      </div>
    );
  }

  return (
    <div className="demo-transcript-log">
      {entries.length === 0 && (
        <div style={{ color: "#333", fontSize: "0.75rem", padding: "0.5rem" }}>
          Waiting for transcripts...
        </div>
      )}
      {entries.map((e, i) => (
        <div key={i} className="demo-transcript-entry">
          <span className="demo-transcript-time">{e.time}</span>
          <span
            className={`demo-transcript-badge ${
              e.interim ? "demo-transcript-badge--interim" : "demo-transcript-badge--final"
            }`}
          >
            {e.interim ? "interim" : "final"}
          </span>
          {e.text}
        </div>
      ))}
    </div>
  );
}
