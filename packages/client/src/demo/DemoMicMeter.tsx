export function DemoMicMeter({ level }: { level: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, level)) * 100);
  return (
    <div>
      <div className="demo-meter-track">
        <div className="demo-meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <div style={{ fontSize: "0.6rem", color: "#555", marginTop: "0.2rem", textAlign: "right" }}>
        {pct}%
      </div>
    </div>
  );
}
