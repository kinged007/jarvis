import { useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAgentStore } from "@/state/agentStore";
import { sendMessage } from "@/services/ws/sinks";
import { Shield, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";

const CHOICE_LABELS: Record<string, { label: string; icon: React.ReactNode }> = {
  once: { label: "Approve Once", icon: <ShieldCheck className="size-4" /> },
  session: { label: "Approve Session", icon: <Shield className="size-4" /> },
  always: { label: "Approve Always", icon: <Shield className="size-4" /> },
  deny: { label: "Deny", icon: <ShieldOff className="size-4" /> },
};

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function FormattedArgs({ args }: { args: Record<string, unknown> | null | undefined }) {
  const entries = Object.entries(args ?? {});
  if (entries.length === 0) {
    return <span className="text-muted-foreground italic text-xs">no arguments</span>;
  }

  return (
    <dl className="grid gap-1.5 font-mono text-[11px] leading-relaxed">
      {entries.map(([key, value]) => (
        <div key={key} className="grid grid-cols-[auto,1fr] gap-2">
          <dt className="text-muted-foreground whitespace-nowrap pr-2">{key}</dt>
          <dd className="text-foreground break-all">{formatValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ApprovalModal() {
  const pendingApproval = useAgentStore((s) => s.pendingApproval);
  const clearApproval = useAgentStore((s) => s.clearApproval);

  const handleChoice = useCallback(
    (choice: "once" | "session" | "always" | "deny") => {
      if (!pendingApproval) return;
      sendMessage({
        type: "agent:approval_response",
        runId: pendingApproval.runId,
        requestId: pendingApproval.requestId,
        choice,
      });
      clearApproval();
    },
    [pendingApproval, clearApproval],
  );

  const open = pendingApproval !== null;

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="!max-w-sm border-border bg-card !rounded-[var(--rounded-widget)]"
        style={{
          boxShadow: "0 0 24px rgba(255, 140, 0, 0.18), inset 0 0 16px rgba(255, 140, 0, 0.04)",
          border: "1px solid rgba(255, 140, 0, 0.3)",
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-mono tracking-wider uppercase text-amber-400">
            <ShieldAlert className="size-4" />
            Approval Required
          </DialogTitle>
          {pendingApproval && (
            <DialogDescription asChild>
              <div className="flex flex-col gap-3 pt-1">
                <div>
                  <span className="block text-[10px] font-mono uppercase tracking-[0.15em] text-muted-foreground mb-1">
                    Tool
                  </span>
                  <span className="text-sm font-mono text-foreground">
                    {pendingApproval.tool}
                  </span>
                </div>

                {pendingApproval.message && (
                  <div>
                    <span className="block text-[10px] font-mono uppercase tracking-[0.15em] text-muted-foreground mb-1">
                      Details
                    </span>
                    <p className="text-xs text-foreground/80 leading-relaxed">
                      {pendingApproval.message}
                    </p>
                  </div>
                )}

                <div>
                  <span className="block text-[10px] font-mono uppercase tracking-[0.15em] text-muted-foreground mb-1">
                    Arguments
                  </span>
                  <FormattedArgs args={pendingApproval.args} />
                </div>
              </div>
            </DialogDescription>
          )}
        </DialogHeader>

        <DialogFooter showCloseButton={false}>
          <div className="grid grid-cols-2 gap-2 w-full">
            {pendingApproval?.choices.map((choice) => {
              const config = CHOICE_LABELS[choice] ?? { label: choice, icon: null };
              return (
                <Button
                  key={choice}
                  variant={choice === "deny" ? "destructive" : "outline"}
                  size="sm"
                  className="flex-1 min-w-[80px] font-mono text-[11px] tracking-wide"
                  onClick={() => handleChoice(choice)}
                >
                  {config.icon}
                  <span className="ml-1.5">{config.label}</span>
                </Button>
              );
            })}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
