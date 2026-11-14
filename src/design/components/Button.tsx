import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../cn";

export type ButtonVariant = "primary" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const base =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-base border " +
  "text-sm font-medium transition-colors duration-150 motion-reduce:transition-none " +
  "disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0";

// Padding and colours follow the plan's component specs exactly:
// primary 6px 14px, ghost 5px 12px (one pixel less to allow for the same
// visual height with a quieter border).
const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-button-primary-bg border-button-primary-border text-button-primary-text px-3.5 py-1.5 " +
    "enabled:hover:bg-button-primary-hover",
  ghost:
    "bg-transparent border-bg-border text-text-secondary px-3 py-[5px] " +
    "enabled:hover:border-text-secondary enabled:hover:text-text-primary",
};

/**
 * A native <button>. Defaults to type="button" so a button inside a form
 * never submits it by accident.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", type = "button", className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-variant={variant}
      className={cn(base, variants[variant], className)}
      {...props}
    />
  );
});
