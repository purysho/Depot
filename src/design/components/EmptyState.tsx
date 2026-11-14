import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  /** What the person can do next, not a description of the emptiness. */
  description?: ReactNode;
  /** Optional action, normally a ghost Button. */
  action?: ReactNode;
  className?: string;
}

/** Centred in its panel: 32px muted icon, heading, short subtext, optional action. */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 py-8 text-center",
        className,
      )}
    >
      <Icon size={32} strokeWidth={1.5} className="text-text-muted" aria-hidden="true" />
      <h2 className="m-0 mt-1 text-lg font-medium text-text-secondary">{title}</h2>
      {description ? <p className="m-0 max-w-[280px] text-sm text-text-secondary">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
