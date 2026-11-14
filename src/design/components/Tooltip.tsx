import {
  cloneElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "../cn";

// Behaviour follows Radix UI's Tooltip (radix-ui/primitives,
// packages/react/tooltip): open after a hover delay, open at once when the
// trigger gets keyboard focus, never open on the focus that follows a mouse
// press, close on Escape, blur, pointer leave or press, and skip the delay
// when moving straight from one tooltip to the next.

const DEFAULT_DELAY = 700;
const DEFAULT_SKIP_DELAY = 300;

interface GroupState {
  delay: number;
  /** Records that a tooltip in the group just closed. */
  markClosed: () => void;
  /** True if a tooltip closed within the skip-delay window. */
  closedRecently: () => boolean;
}

const GroupContext = createContext<GroupState | null>(null);

/** Shares the "skip delay" window between sibling tooltips, like Radix's Provider. */
export function TooltipGroup({
  children,
  delay = DEFAULT_DELAY,
  skipDelay = DEFAULT_SKIP_DELAY,
}: {
  children: ReactNode;
  delay?: number;
  skipDelay?: number;
}) {
  const lastClosedAt = useRef(0);
  const value = useMemo<GroupState>(
    () => ({
      delay,
      markClosed: () => {
        lastClosedAt.current = Date.now();
      },
      closedRecently: () => Date.now() - lastClosedAt.current < skipDelay,
    }),
    [delay, skipDelay],
  );
  return <GroupContext.Provider value={value}>{children}</GroupContext.Provider>;
}

export interface TooltipProps {
  label: string;
  /** A single focusable element, normally a <button>. */
  children: ReactElement<{ "aria-describedby"?: string }>;
  side?: "right" | "top";
  /**
   * When the trigger already has an accessible name with the same text
   * (an icon button with aria-label), leave this false: the tooltip is then
   * visual only, so screen readers do not read the name twice. Set it true
   * when the tooltip adds information, and it is linked with aria-describedby.
   */
  describes?: boolean;
}

export function Tooltip({ label, children, side = "right", describes = false }: TooltipProps) {
  const group = useContext(GroupContext);
  const delay = group?.delay ?? DEFAULT_DELAY;

  const [open, setOpenState] = useState(false);
  const openRef = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const pointerDown = useRef(false);
  const id = useId();

  const clearTimer = () => window.clearTimeout(timer.current);

  const setOpen = useCallback((next: boolean) => {
    openRef.current = next;
    setOpenState(next);
  }, []);

  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    if (openRef.current) group?.markClosed();
    setOpen(false);
  }, [group, setOpen]);

  const openSoon = () => {
    clearTimer();
    if (group?.closedRecently()) {
      setOpen(true);
    } else {
      timer.current = window.setTimeout(() => setOpen(true), delay);
    }
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Escape closes the tooltip wherever focus is, as in Radix.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <span
      className="relative inline-flex"
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") openSoon();
      }}
      onPointerLeave={close}
      onPointerDown={() => {
        pointerDown.current = true;
        // Released anywhere, not only over the trigger, as in Radix.
        document.addEventListener(
          "pointerup",
          () => {
            pointerDown.current = false;
          },
          { once: true },
        );
        close();
      }}
      onFocus={() => {
        if (!pointerDown.current) {
          clearTimer();
          setOpen(true);
        }
      }}
      onBlur={() => {
        pointerDown.current = false;
        close();
      }}
    >
      {describes ? cloneElement(children, { "aria-describedby": open ? id : undefined }) : children}
      {open ? (
        <span
          id={id}
          role={describes ? "tooltip" : undefined}
          aria-hidden={describes ? undefined : true}
          className={cn(
            "pointer-events-none absolute z-50 whitespace-nowrap rounded-sm border border-bg-border",
            "bg-bg-overlay px-2 py-1 text-xs font-medium text-text-primary",
            side === "right" && "left-full top-1/2 ml-2 -translate-y-1/2",
            side === "top" && "bottom-full left-1/2 mb-2 -translate-x-1/2",
          )}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
