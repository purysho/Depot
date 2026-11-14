import type { HTMLAttributes } from "react";
import { cn } from "../cn";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Shows the hover border. Set it only when the whole card does something
   * on click; a hover effect on a card that does nothing misleads. The card
   * is a <div>, so the action itself must be a <button> or <a> inside it
   * (stretched over the card if needed) to stay reachable by keyboard.
   */
  interactive?: boolean;
}

/** Surface container: 1px border, 8px radius, 16px × 18px padding. */
export function Card({ interactive = false, className, ...props }: CardProps) {
  return (
    <div
      data-interactive={interactive || undefined}
      className={cn(
        "rounded-md border border-bg-border bg-bg-surface px-[18px] py-4",
        interactive &&
          "transition-colors duration-150 hover:border-text-link motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("m-0 text-lg font-semibold text-text-primary", className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("m-0 text-sm text-text-secondary", className)} {...props} />;
}
