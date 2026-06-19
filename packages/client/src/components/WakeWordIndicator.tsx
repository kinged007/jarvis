import { Ear, Mic, MicOff, AlertCircle } from "lucide-react";

interface WakeWordIndicatorProps {
  isSupported: boolean;
  isListening: boolean;
  isUserDisabled: boolean;
  error: string | null;
  onToggle: () => void;
}

export function WakeWordIndicator({
  isSupported,
  isListening,
  isUserDisabled,
  error,
  onToggle,
}: WakeWordIndicatorProps): React.JSX.Element | null {
  if (!isSupported) return null;

  let stateClass: string;
  let icon: React.JSX.Element;
  let label: string;
  let title: string;

  if (error !== null) {
    stateClass = "jarvis-indicator jarvis-indicator--down";
    icon = <AlertCircle className="size-3.5" />;
    label = "Wakeword: error";
    title = `Wakeword error — ${error}. Click to retry.`;
  } else if (isListening) {
    stateClass = "jarvis-indicator jarvis-indicator--ok jarvis-wakeword-pulse";
    icon = <Ear className="size-3.5" />;
    label = "Wakeword: listening";
    title = "Wakeword listening — click to disable";
  } else if (isUserDisabled) {
    stateClass = "jarvis-indicator jarvis-indicator--muted";
    icon = <MicOff className="size-3.5" />;
    label = "Wakeword: off";
    title = "Wakeword disabled — click to enable";
  } else {
    stateClass = "jarvis-indicator jarvis-indicator--muted";
    icon = <Mic className="size-3.5" />;
    label = "Wakeword: idle";
    title = "Wakeword idle — click to start";
  }

  return (
    <span
      className={stateClass}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      title={title}
      aria-label={title}
    >
      {icon}
      <span className="ml-1.5 text-[10px] font-medium tracking-wide uppercase">
        {label}
      </span>
    </span>
  );
}
