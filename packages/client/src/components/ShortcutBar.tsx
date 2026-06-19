import { ScrollText, SquareTerminal, Cog } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ShortcutBarProps {
  className?: string;
  onLogsClick?: () => void;
  onTerminalClick?: () => void;
  onSettingsClick?: () => void;
}

const tt = "border-border bg-card text-foreground text-xs font-mono px-2 py-1 [&_svg]:hidden";

export function ShortcutBar({ className, onLogsClick, onTerminalClick, onSettingsClick }: ShortcutBarProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className={cn("flex items-center justify-center gap-1 py-1.5", className)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
              onClick={onLogsClick}
            >
              <ScrollText className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className={tt}>Logs</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
              onClick={onTerminalClick}
            >
              <SquareTerminal className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className={tt}>Terminal</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
              onClick={onSettingsClick}
            >
              <Cog className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className={tt}>Settings</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
