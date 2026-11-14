import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../cn";

export interface StatusBarProps {
  /** Current workspace name, or null before one is chosen. */
  workspaceName: string | null;
  /** Opens the workspace switcher. Without it the name is plain text. */
  onWorkspaceClick?: () => void;
  /** Start time (ms since epoch) of the active Switchyard session, or null. */
  sessionStartedAt: number | null;
  /** Number of processes Pulse is tracking, or null when Pulse has no data. */
  processCount: number | null;
  /** HTTP status of Relay's last request, or null when none has been sent. */
  lastRequestStatus: number | null;
}

/** 0:42, 12:03, 1:02:13 — hours appear only once needed. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Text colour for an HTTP status class. The code is always shown as text too. */
export function statusTone(code: number): string {
  if (code >= 500) return "text-error";
  if (code >= 400) return "text-warning";
  if (code >= 300) return "text-info";
  if (code >= 200) return "text-success";
  return "text-text-secondary";
}

/** Ticks once a second. Keyed by start time, so a new session starts fresh. */
function SessionClock({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="text-text-primary">{formatElapsed(now - startedAt)}</span>;
}

/** 28px bar along the bottom of the window: workspace · session · Pulse and Relay. */
export function StatusBar({
  workspaceName,
  onWorkspaceClick,
  sessionStartedAt,
  processCount,
  lastRequestStatus,
}: StatusBarProps) {
  const name = workspaceName ?? "No workspace";

  return (
    <footer
      aria-label="Status"
      className="grid h-7 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-t border-bg-border bg-bg-surface px-3 text-xs text-text-secondary"
    >
      <div className="min-w-0">
        {onWorkspaceClick ? (
          <button
            type="button"
            onClick={onWorkspaceClick}
            aria-haspopup="dialog"
            aria-label={`Workspace: ${name}. Switch workspace`}
            className="inline-flex max-w-full items-center gap-1 rounded-sm px-1 py-0.5 text-text-primary hover:bg-bg-overlay"
          >
            <span className="truncate">{name}</span>
            <ChevronDown size={12} aria-hidden="true" className="shrink-0 text-text-secondary" />
          </button>
        ) : (
          <span className="truncate px-1 text-text-primary">{name}</span>
        )}
      </div>

      <div className="flex items-center gap-1.5 tabular-nums">
        <span
          aria-hidden="true"
          className={cn("size-2 rounded-full", sessionStartedAt !== null ? "bg-success" : "bg-text-muted")}
        />
        {sessionStartedAt !== null ? (
          <span>
            Session <SessionClock key={sessionStartedAt} startedAt={sessionStartedAt} />
          </span>
        ) : (
          <span>No session</span>
        )}
      </div>

      <div className="flex items-center justify-end gap-3 tabular-nums">
        <span>{processCount === null ? "Pulse idle" : `${processCount} ${processCount === 1 ? "process" : "processes"}`}</span>
        <span>
          Relay{" "}
          {lastRequestStatus === null ? (
            <span>—</span>
          ) : (
            <span className={cn("font-medium", statusTone(lastRequestStatus))}>{lastRequestStatus}</span>
          )}
        </span>
      </div>
    </footer>
  );
}
