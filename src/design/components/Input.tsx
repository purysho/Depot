import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/**
 * A native <input> styled to the plan's spec. It has no label of its own:
 * give it a <label htmlFor>, or an aria-label when the context makes the
 * purpose obvious (a search box in a toolbar). Set aria-invalid to show the
 * error border.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = "text", ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        "w-full min-w-0 rounded-base border border-bg-border bg-bg-base px-3 py-[7px]",
        "text-base text-text-primary placeholder:text-text-secondary",
        "transition-colors duration-150 motion-reduce:transition-none",
        // The plan's focus style replaces the outline with a link-coloured border.
        "focus-visible:border-text-link focus-visible:outline-none",
        "aria-invalid:border-error",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
