import { ChevronDown } from "lucide-react";
import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../cn";

// Form controls that share the Input spec from the plan (bg.base, 1px border,
// 6px radius, link-coloured border on focus).

const control =
  "rounded-base border border-bg-border bg-bg-base text-text-primary " +
  "transition-colors duration-150 motion-reduce:transition-none " +
  "focus-visible:border-text-link focus-visible:outline-none aria-invalid:border-error " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        spellCheck={false}
        className={cn(control, "w-full min-w-0 px-3 py-[7px] font-mono text-sm placeholder:text-text-secondary", className)}
        {...props}
      />
    );
  },
);

/** A native <select> (keyboard and screen-reader behaviour for free), drawn
 * with the token colours: WebKitGTK otherwise paints a grey system control. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...props },
  ref,
) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <select ref={ref} className={cn(control, "w-full appearance-none py-[7px] pr-8 pl-3 text-base")} {...props} />
      <ChevronDown size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-text-secondary" />
    </span>
  );
});

/** A label above one control. The control is passed as a render function so it gets the id. */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("grid min-w-0 gap-1", className)}>
      <label htmlFor={id} className="text-sm text-text-secondary">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="m-0 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}
