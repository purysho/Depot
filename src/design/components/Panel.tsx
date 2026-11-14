import { OctagonX, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";
import type { Tone } from "../tokens";

/** Panel title row: tool icon in its identity colour, title, optional subtitle and actions. */
export function PanelHeader({
  icon: Icon,
  color,
  title,
  subtitle,
  actions,
}: {
  icon: LucideIcon;
  color: string;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <Icon size={18} strokeWidth={1.75} aria-hidden="true" style={{ color }} />
      <div className="min-w-0 flex-1">
        <h1 className="m-0 truncate text-xl font-semibold">{title}</h1>
        {subtitle ? <p className="m-0 truncate text-sm text-text-secondary">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Small section heading inside a panel. */
export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-2">
      <h2 className="m-0 text-sm font-medium text-text-secondary">{children}</h2>
      {aside}
    </div>
  );
}

/** An error the person can act on, shown where it happened. */
export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={cn("m-0 flex items-start gap-1.5 text-sm text-error", className)}>
      <OctagonX size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Badge tone for a finding severity. */
export function severityTone(severity: string): Tone {
  switch (severity) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
      return "pending";
    default:
      return "info";
  }
}

/** Badge tone for an HTTP status code. */
export function httpTone(status: number): Tone {
  if (status >= 500) return "error";
  if (status >= 400) return "warning";
  if (status >= 200 && status < 300) return "success";
  return "info";
}

/** Badge tone for a Switchyard session or service status. */
export function runTone(status: string): Tone {
  switch (status.toUpperCase()) {
    case "RUNNING":
    case "READY":
      return "success";
    case "STARTING":
      return "pending";
    case "DEGRADED":
      return "warning";
    case "FAILED":
      return "error";
    default:
      return "info";
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Shared table look: dense rows, recessive borders, secondary header text. */
export const table = {
  wrap: "overflow-auto rounded-md border border-bg-border",
  table: "w-full border-collapse text-sm",
  th: "sticky top-0 bg-bg-surface px-3 py-2 text-left text-xs font-medium text-text-secondary border-b border-bg-border",
  td: "px-3 py-1.5 border-b border-bg-border align-top",
} as const;
