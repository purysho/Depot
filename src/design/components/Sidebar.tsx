import { Settings, type LucideIcon } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { cn } from "../cn";
import { Tooltip, TooltipGroup } from "./Tooltip";

export interface SidebarItem {
  id: string;
  name: string;
  icon: LucideIcon;
  /** CSS colour for the active icon tint, e.g. var(--color-tool-needle). */
  color: string;
}

export interface SidebarProps {
  items: readonly SidebarItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onOpenSettings?: () => void;
  settingsActive?: boolean;
}

const buttonBase =
  "relative flex size-9 items-center justify-center rounded-base text-text-secondary " +
  "transition-colors duration-150 motion-reduce:transition-none hover:bg-bg-overlay hover:text-text-primary";

/**
 * 48px icon rail. The active tool is marked three ways — a bar on the left
 * edge, a raised background, and the tool's colour on the icon — so it never
 * depends on colour alone. Up/Down arrows move between tools; Tab also works.
 */
export function Sidebar({ items, activeId, onSelect, onOpenSettings, settingsActive = false }: SidebarProps) {
  const listRef = useRef<HTMLUListElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    event.preventDefault();
    const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <nav
      aria-label="Tools"
      className="flex h-full w-12 shrink-0 flex-col items-center border-r border-bg-border bg-bg-surface py-2"
    >
      <TooltipGroup>
        <ul ref={listRef} onKeyDown={onKeyDown} className="m-0 flex list-none flex-col items-center gap-1 p-0">
          {items.map(({ id, name, icon: Icon, color }) => {
            const active = id === activeId;
            return (
              <li key={id} className="relative">
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-1.5 bottom-1.5 -left-1.5 w-0.5 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                ) : null}
                <Tooltip label={name}>
                  <button
                    type="button"
                    aria-label={name}
                    aria-current={active ? "page" : undefined}
                    onClick={() => onSelect(id)}
                    className={cn(buttonBase, active && "bg-bg-overlay")}
                    style={active ? { color } : undefined}
                  >
                    <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </Tooltip>
              </li>
            );
          })}
        </ul>
        {onOpenSettings ? (
          <div className="mt-auto flex w-full flex-col items-center border-t border-bg-border pt-2">
            <Tooltip label="Settings">
              <button
                type="button"
                aria-label="Settings"
                aria-current={settingsActive ? "page" : undefined}
                onClick={onOpenSettings}
                className={cn(buttonBase, settingsActive && "bg-bg-overlay text-text-primary")}
              >
                <Settings size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
        ) : null}
      </TooltipGroup>
    </nav>
  );
}
