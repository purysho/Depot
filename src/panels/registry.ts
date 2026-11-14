import { Activity, ScanSearch, Search, Send, Waypoints, Workflow, type LucideIcon } from "lucide-react";
import type { ToolId } from "../design/tokens";

export interface ToolDefinition {
  id: ToolId;
  name: string;
  description: string;
  icon: LucideIcon;
  /** CSS variable for the tool's identity colour, from tokens.colors.tools. */
  color: string;
  repo: string;
}

// The six built-in tools, in the plan's sidebar order. Each mirrors the
// `panel` block of the tool's depot.plugin.json (docs/PLUGIN_PROTOCOL.md).
// Icon names were checked against lucide-react 1.73.0.
export const tools: readonly ToolDefinition[] = [
  {
    id: "switchyard",
    name: "Switchyard",
    description: "Workspace orchestration, service graphs, run configs",
    icon: Waypoints,
    color: "var(--color-tool-switchyard)",
    repo: "https://github.com/purysho/Switchyard",
  },
  {
    id: "needle",
    name: "Needle",
    description: "Local file search and indexing",
    icon: Search,
    color: "var(--color-tool-needle)",
    repo: "https://github.com/purysho/Needle",
  },
  {
    id: "relay",
    name: "Relay",
    description: "HTTP client, request inspector, mock server",
    icon: Send,
    color: "var(--color-tool-relay)",
    repo: "https://github.com/purysho/Relay",
  },
  {
    id: "pulse",
    name: "Pulse",
    description: "Process and network relationship monitor",
    icon: Activity,
    color: "var(--color-tool-pulse)",
    repo: "https://github.com/purysho/Pulse",
  },
  {
    id: "blackbox",
    name: "BLACKBOX",
    description: "Repository forensics and code analysis",
    icon: ScanSearch,
    color: "var(--color-tool-blackbox)",
    repo: "https://github.com/purysho/BLACKBOX",
  },
  {
    id: "forge",
    name: "Forge",
    description: "Workflow runner for local automations",
    icon: Workflow,
    color: "var(--color-tool-forge)",
    repo: "https://github.com/purysho/Forge",
  },
];

export function toolById(id: ToolId): ToolDefinition {
  const tool = tools.find((t) => t.id === id);
  if (!tool) throw new Error(`Unknown tool: ${id}`);
  return tool;
}
