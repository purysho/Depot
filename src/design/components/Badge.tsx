import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";
import type { Tone } from "../tokens";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Optional leading icon, e.g. a Lucide icon at size 12. */
  icon?: ReactNode;
  /** The label is required: status is never shown by colour alone. */
  children: ReactNode;
}

const tones: Record<Tone, string> = {
  success: "bg-badge-success text-success",
  warning: "bg-badge-warning text-warning",
  error: "bg-badge-error text-error",
  pending: "bg-badge-pending text-pending",
  info: "bg-badge-info text-info",
};

/** Status pill. The plan's mapping: running → success, beta → warning, stopped → error. */
export function Badge({ tone = "info", icon, className, children, ...props }: BadgeProps) {
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5",
        "text-xs font-medium [&_svg]:size-3 [&_svg]:shrink-0",
        tones[tone],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  );
}
