# Changelog

All notable changes to Depot are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Tauri v2 desktop shell with React 18, TypeScript, Tailwind CSS v4 and Vite.
- Design system: tokens for colour, type, spacing and radius, and the shared
  components `Sidebar`, `StatusBar`, `Badge`, `Card`, `Button`, `Input`,
  `EmptyState`, `Tooltip` and `ExternalLink`.
- The window layout: a 48px tool sidebar, a panel area, and a 28px status bar.
  Each tool's panel is a placeholder that links to the standalone app.
- `docs/ARCHITECTURE.md` (workspace context, event bus, session timeline, IPC
  boundary, state) and `docs/PLUGIN_PROTOCOL.md` (manifest schema and the event
  catalogue for all six tools).
- CI on Windows, macOS and Linux: typecheck, lint, Vitest, `cargo test`, and a
  debug bundle. A tag-triggered workflow that builds draft releases.
