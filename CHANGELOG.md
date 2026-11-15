# Changelog

All notable changes to Depot are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- All six panels: Switchyard (workspace home: sessions, service health,
  projects, session timeline), Pulse, Relay, Needle, BLACKBOX and Forge, plus
  workspace settings.
- depot-core, a sidecar that runs the six tools' own Python cores, pinned as
  git submodules under `vendor/`. Packaged with PyInstaller and bundled with
  Depot; smoke-tested in CI on every platform.
- The workspace context (`~/.depot/workspaces/<name>/context.json`), the
  event bus with one shared catalogue of 33 event types, and the session
  timeline (JSON Lines per session).
- Five cross-tool links: Pulse → Relay (**Open in Relay →** on listening
  ports), Needle → Forge (**Add to workflow →**), BLACKBOX → Switchyard (risk
  badge on project cards), Forge → Pulse (filter to a failed step's process),
  Switchyard → Pulse (highlight an unhealthy service's process).
- Optional AI review in BLACKBOX through Open Code Review (`ocr`) when it is
  installed; its findings sit beside BLACKBOX's own and do not change the risk
  score.

### Fixed (from code review of 273f741)
- A Forge delete step with a blank path deleted the contents of depot-core's
  working folder. Blank required fields are refused in the step editor, in
  depot-core and in Forge itself (Forge `ed01627`).
- Quitting Depot could leave Switchyard services running: depot-core was
  killed after 5 s while services were still stopping. Depot now waits for
  depot-core to confirm everything has stopped, sessions stop in parallel, and
  Switchyard stops a service's whole process group (Switchyard `759af30`).
- A workflow queued just before shutdown could start after cleanup ran.
  Shutdown now refuses new work and drops the queue first.
- Results of work started in one workspace and finishing after a switch were
  recorded in the new workspace's timeline. Events now carry the workspace of
  the request that caused them.
- The event bus could stop listening in development builds (React's
  double mount). Each caller now owns its subscription.
- Forge commands without a working folder ran in depot-core's folder; they now
  run in the workspace folder, and relative paths resolve against it.
- Leaving the Forge panel lost control of a running workflow. Run state now
  lives outside the panel and is restored when it reopens.
- The timeline could record credentials from Relay URLs (`user:password@`),
  Relay error text, and Forge step labels taken from command lines.
- On Windows, an npm-installed `ocr` was not detected, and cancelling an
  npm-installed review could leave the native process running. Depot now runs
  the native binary and stops the whole process tree.

### Not yet
- Relay's mock server, saved requests and request parameters; Needle's
  extension filter; Forge's workflow import/export, step reordering and
  editing (remove and re-add for now). Each exists in the standalone app.
- Opening or revealing a Needle result in the system file manager (copy path
  for now).
- Third-party plugins: the manifest format is published, loading is not built.
- Code signing.

### Earlier in this release
- Tauri v2 desktop shell with React 18, TypeScript, Tailwind CSS v4 and Vite.
- Design system: tokens for colour, type, spacing and radius, and the shared
  components `Sidebar`, `StatusBar`, `Badge`, `Card`, `Button`, `Input`,
  `EmptyState`, `Tooltip` and `ExternalLink`.
- The window layout: a 48px tool sidebar, a panel area, and a 28px status bar.
- `docs/ARCHITECTURE.md` (workspace context, event bus, session timeline, IPC
  boundary, state) and `docs/PLUGIN_PROTOCOL.md` (manifest schema and the event
  catalogue for all six tools).
- CI on Windows, macOS and Linux: typecheck, lint, Vitest, `cargo test`, and a
  debug bundle. A tag-triggered workflow that builds draft releases.
