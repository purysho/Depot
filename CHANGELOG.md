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
  event bus with one shared catalogue of 34 event types, and the session
  timeline (JSON Lines per session).
- Five cross-tool links: Pulse → Relay (**Open in Relay →** on listening
  ports), Needle → Forge (**Add to workflow →**), BLACKBOX → Switchyard (risk
  badge on project cards), Forge → Pulse (filter to a failed step's process),
  Switchyard → Pulse (highlight an unhealthy service's process).
- Optional AI review in BLACKBOX through Open Code Review (`ocr`) when it is
  installed; its findings sit beside BLACKBOX's own and do not change the risk
  score.
- Relay: saved requests, query parameters, and a mock server (routes with a
  status and body, started on any free port, logged live, stopped on quit).
- Forge: import and export `.forge.json` files through the system dialog,
  move steps up and down, and edit a step in place.
- Needle: filter results by file type, open a result in its default app or
  reveal it in the file manager. Programs and scripts are revealed, never
  opened, because opening one runs it.
- Third-party plugins in handoff mode: put a `depot.plugin.json` in
  `~/.depot/plugins/<name>/` and enable it in Settings. Depot shows the exact
  command, runs it only after you approve it, asks again if it changes, and
  records each launch on the timeline (docs/PLUGIN_PROTOCOL.md).
- Code signing for releases, switched on by repository secrets: Developer ID
  signing and notarization on macOS (sidecar included), Azure Trusted Signing
  on Windows. Not yet run with real certificates (docs/RELEASING.md).

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

### Fixed (from code review of 0779633)
- Stopping a Forge workflow could report "stopped" while its command ran on
  (a child that ignored SIGTERM after its shell exited). Forge now waits for
  the whole process group (Forge `9e7eb0a`).
- A Forge run or Switchyard session could start after shutdown had finished
  stopping everything. Forge keeps a stop that arrives before a run starts
  (Forge `9e7eb0a`); Switchyard sessions are started under the lock shutdown
  collects them with, and Switchyard makes launching and stopping exclusive
  (Switchyard `227b70c`).
- Work that finished after a workspace switch was recorded in no timeline. It
  now goes to the last timeline of the workspace it belongs to.
- Forge could reattach to another workspace's run, and a workflow that
  finished before `forge_run` returned stayed "running" forever. Runs are
  listed per workspace, and the panel registers a run before starting it.
- The AI review's completion and progress were attributed to whichever
  workspace was open when it finished; they now belong to the one it started
  in. Quitting Depot also stops a review in progress.
- A plugin folder could inherit another folder's approval by using the same
  id and command text. Approval now includes the plugin's folder and the file
  its program resolves to, and a duplicate id disables every folder using it.

### Fixed (from code review of c80d2e5)
- A Forge command that read stdin consumed Depot's requests, which then never
  got a reply. Forge gives commands an empty stdin (Forge `4647efd`), and
  depot-core keeps its protocol pipes away from every program a tool starts.
- Reopening Forge could bring back a run that finished while Depot was asking
  which runs were active, leaving it "running". Finished runs are remembered
  and not reattached.
- A plugin folder without a valid manifest, named like a plugin's id, could
  shadow that plugin. Such folders are listed as `folder:<name>`.

### Not yet
- Third-party plugins with their own panel code or bus events (`native` and
  `sidecar` modes stay reserved for the built-in tools).
- Signed Linux bundles.

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
