import { X, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAgentStore } from "@/state/agentStore";

interface LogModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LogModal({ open, onOpenChange }: LogModalProps) {
  const logEntries = useAgentStore((s) => s.logEntries);
  const clearLogs = useAgentStore((s) => s.clearLogs);
  const recentLogs = logEntries.slice(-100).reverse();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby="log-modal-description"
        className="top-[5vh] translate-y-0 !max-w-[calc(100vw-32px)] h-[80vh] border-border bg-card flex flex-col !rounded-[var(--rounded-widget)]"
        style={{
          boxShadow: "0 0 32px rgba(0,240,255,0.15), inset 0 0 24px rgba(0,240,255,0.04)",
          border: "1px solid rgba(0,240,255,0.2)",
        }}
      >
        <DialogTitle className="sr-only">System Logs</DialogTitle>
        <DialogDescription id="log-modal-description" className="sr-only">
          Debug log entries from the JARVIS agent system
        </DialogDescription>

        <div className="flex items-center justify-between shrink-0 pb-3 border-b border-border">
          <span className="font-mono text-xs tracking-[0.3em] uppercase text-muted-foreground">
            LOG ({logEntries.length})
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7 hover:text-destructive"
              onClick={clearLogs}
              title="Clear all logs"
            >
              <Trash2 className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 hover:text-primary"
              onClick={() => onOpenChange(false)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 mt-2 -mx-3 px-3">
          {recentLogs.length === 0 ? (
            <p className="text-muted-foreground font-mono text-xs italic py-2 px-1">
              no activity yet
            </p>
          ) : (
            <ul className="list-none m-0 p-0 font-mono text-[10px] leading-[1.35]">
                {recentLogs.map((entry) => (
                <li
                  key={entry.id}
                  className={`grid py-[3px] px-2 gap-1 border-l-2 ${
                    entry.level === "commentary"
                      ? "border-primary text-foreground"
                      : entry.level === "error"
                        ? "border-destructive text-destructive"
                        : entry.level === "tool"
                          ? "border-primary/40 text-foreground"
                          : entry.level === "tool-result"
                            ? "border-border text-muted-foreground"
                            : entry.level === "run"
                              ? "border-accent text-foreground"
                              : entry.level === "system"
                                ? "border-border text-muted-foreground"
                                : "border-border text-muted-foreground"
                  }`}
                  style={{ gridTemplateColumns: "52px 56px 1fr" }}
                >
                  <span className="text-secondary-foreground/60 shrink-0">
                    {new Date(entry.ts).toLocaleTimeString()}
                  </span>
                  <span className="text-secondary-foreground/60 tracking-[0.08em] shrink-0">
                    {entry.level.toUpperCase()}
                  </span>
                  <span className="break-all">{entry.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
