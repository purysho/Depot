import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { cn } from "../cn";

export interface ExternalLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
}

/**
 * A link to a web page outside Depot. Inside the desktop app a plain <a>
 * would navigate Depot's own window away, so the click is handed to the
 * system browser through the opener plugin instead. In a normal browser
 * (vite dev, tests) it behaves as a regular new-tab link.
 */
export function ExternalLink({ href, className, onClick, children, ...props }: ExternalLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || !isTauri()) return;
    event.preventDefault();
    openUrl(href).catch((error: unknown) => {
      // Refused by the capability scope or no default browser: say why in
      // the console rather than failing silently.
      console.error(`Could not open ${href}:`, error);
    });
  };

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={handleClick}
      className={cn("text-text-link hover:underline", className)}
      {...props}
    >
      {children}
    </a>
  );
}
