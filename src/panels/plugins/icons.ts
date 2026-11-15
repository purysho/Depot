import {
  BookOpen, Bot, Box, Bug, ChartLine, Cloud, Container, Cpu, Database, FileText, Gauge, GitBranch,
  Globe, Layers, Mail, Network, Notebook, Package, Puzzle, Rocket, Server, Shield, Terminal, Wrench,
  type LucideIcon,
} from "lucide-react";

// The icons a third-party manifest may name in panel.icon. A fixed set keeps
// the bundle small and the sidebar consistent; anything else shows Puzzle.
const icons: Record<string, LucideIcon> = {
  BookOpen, Bot, Box, Bug, ChartLine, Cloud, Container, Cpu, Database, FileText, Gauge, GitBranch,
  Globe, Layers, Mail, Network, Notebook, Package, Puzzle, Rocket, Server, Shield, Terminal, Wrench,
};

export const pluginIconNames = Object.keys(icons);

export function pluginIcon(name: string): LucideIcon {
  return Object.hasOwn(icons, name) ? (icons[name] as LucideIcon) : Puzzle;
}
