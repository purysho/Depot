// Design tokens. Values are copied from DEPOT_PLAN.md and are the single
// source of truth for colour, type, spacing and radius.
//
// src/index.css repeats these values as Tailwind v4 `@theme` variables so they
// become utility classes (bg-bg-surface, text-text-secondary, p-5, ...).
// src/design/tokens.test.ts fails if the two ever disagree.

export const colors = {
  // Backgrounds
  bg: {
    base: "#0d1117", // Page / app background
    surface: "#161b22", // Cards, panels, sidebars
    overlay: "#21262d", // Hover states, dropdowns
    border: "#30363d", // All borders
  },

  // Text
  text: {
    primary: "#e6edf3", // Primary content
    secondary: "#8b949e", // Labels, metadata, placeholders
    muted: "#484f58", // Disabled, decorative
    link: "#58a6ff", // Links, repo names, interactive labels
  },

  // Semantic — carry meaning, use consistently
  semantic: {
    success: "#3fb950", // Running, healthy, passing
    warning: "#d29922", // Beta, degraded, slow
    error: "#f85149", // Failed, stopped, blocked
    info: "#58a6ff", // Informational, neutral active state
    pending: "#a371f7", // Starting, loading, waiting
  },

  // Tool identity — used for accent only (icon tint, active tab).
  // Never the only cue: pulse and blackbox are hard to tell apart with
  // red-green colour blindness, so identity always also has an icon and a name.
  tools: {
    switchyard: "#58a6ff",
    needle: "#3fb950",
    relay: "#a371f7",
    pulse: "#f07b2b",
    blackbox: "#f85149",
    forge: "#d29922",
  },
} as const;

// Colours that the plan specifies inside individual component specs rather
// than in the palette above. Kept here so no component carries a raw hex.
export const componentColors = {
  button: {
    primaryBg: "#1f6feb",
    primaryBorder: "#388bfd",
    primaryHover: "#388bfd",
    primaryText: "#ffffff",
  },
  badge: {
    success: "#1b2a1b",
    warning: "#2a2010",
    error: "#2a1515",
    pending: "#1e1a2e",
    info: "#1a2234",
  },
} as const;

export const type = {
  // Font stack — no web fonts, system stack only
  family: {
    sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', sans-serif",
    mono: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', ui-monospace, monospace",
  },

  // Scale — 4px base unit, rem
  size: {
    xs: "0.6875rem", // 11px — badges, timestamps
    sm: "0.75rem", // 12px — labels, metadata
    base: "0.875rem", // 14px — body, most UI
    md: "0.9375rem", // 15px — slightly elevated body
    lg: "1rem", // 16px — section headers
    xl: "1.125rem", // 18px — panel titles
    "2xl": "1.375rem", // 22px — workspace name
  },

  weight: {
    normal: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
  },

  leading: {
    tight: "1.25",
    normal: "1.5",
    loose: "1.75",
  },
} as const;

// 4px base unit. Tailwind's `--spacing` is set to 4px, so p-5 is 20px.
export const space = {
  "0": "0",
  "1": "4px",
  "2": "8px",
  "3": "12px",
  "4": "16px",
  "5": "20px",
  "6": "24px",
  "8": "32px",
  "10": "40px",
  "12": "48px",
} as const;

export const radius = {
  sm: "4px",
  base: "6px",
  md: "8px",
  lg: "10px",
  full: "9999px",
} as const;

// Fixed layout dimensions from the plan's layout diagram.
export const layout = {
  sidebarWidth: "48px",
  statusBarHeight: "28px",
  panelPadding: space["5"],
} as const;

export type ToolId = keyof typeof colors.tools;
export type Tone = "success" | "warning" | "error" | "pending" | "info";
