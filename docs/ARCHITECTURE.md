# Architecture

Depot is a Tauri v2 desktop app with three layers:

- a **React + TypeScript frontend** that renders the panels
- a **Rust backend** that owns all state and every call that leaves the webview
- **depot-core**, a sidecar process that runs the six tools' own Python cores

Three shared services connect the tools:

- the **workspace context** — which project you are working on, and each
  tool's settings for it
- the **event bus** — typed messages one tool publishes and others react to
- the **session timeline** — an append-only record of what happened while
  you worked

```
┌───────────────────────────── webview (React) ─────────────────────────────┐
│  Sidebar · Panels (switchyard needle relay pulse blackbox forge) · Status  │
│  Zustand stores: workspace · timeline · integrations · panel UI state      │
│        │ src/ipc.ts (invoke)                 ▲ depot://bus, depot://pulse,  │
│        │                                     │ depot://stream, …            │
└────────┼─────────────────────────────────────┼────────────────────────────┘
         ▼                Rust (src-tauri)     │
   commands.rs ─ workspace.rs ─ bus.rs ─ timeline.rs ─► sessions/*.jsonl
   plugins/<tool>.rs ─ core.rs ── stdin/stdout JSON lines ──┐
                    └─ blackbox.rs ── `ocr` (optional, user-installed)
                                                             ▼
                        depot-core (Python): core/depot_core/tools/<tool>.py
                        → vendor/<tool> (git submodules, pinned commits)
                                      ~/.depot/ (all state, local only)
```

**Status (v0.1.0, unreleased).** All of this is built: the three services,
the six panels, and the five cross-tool integrations. What is not built is
listed in CHANGELOG.md under "Not yet".

## Where the tools' logic lives (ADR-001)

**Status:** Accepted, 2026-11-14.

**Decision.** Depot does not reimplement the tools. The six existing Python
cores — Needle's indexer, Relay's HTTP client, Pulse's collectors, BLACKBOX's
scanner, Forge's runner, Switchyard's session controller — are git
submodules under `vendor/`, each pinned to a commit, and run inside one
sidecar process, **depot-core**. Each `src-tauri/src/plugins/<tool>.rs` is a
thin typed bridge to it.

**Why.** Maintenance. Rewriting five cores in Rust would leave two
implementations of every tool to keep in step forever, and the standalone apps
and Depot would drift. With the cores shared:

- a bug fix lands once, in the tool's own repository, and reaches Depot when
  the pin is bumped (`git submodule update --remote vendor/<tool>`, then commit);
- Depot's CI tests depot-core against exactly the pinned code, so an upstream
  change that breaks Depot fails Depot's CI at the bump, not in a user's hands;
- the standalone apps and Depot read the same data the same way (Switchyard's
  `~/.switchyard/state.json` is shared).

An earlier draft of this decision kept Pulse in Rust to fix its thin macOS
data. That was dropped: a second Pulse would drift from the standalone app,
and the macOS gap is better fixed once, in Pulse itself.

**Costs accepted.** The release bundle carries an 8.7 MB sidecar (one
PyInstaller executable, measured on Linux). Each call pays a JSON-lines round
trip, which is negligible beside the work itself (a Pulse snapshot or a scan).
Depot depends on module-level APIs of the tools rather than on a published
package interface; `core/tests/` is the contract that catches a break.

**Upstream changes made for this.** Forge's runner gained an optional
`on_event` callback (purysho/Forge `adcf9b7`) so Depot gets step results and
the failing PID as data instead of parsing log text.

## depot-core

`core/depot_core/` — about 900 lines of protocol and adapters, no tool logic.

- **Protocol.** One JSON object per line on stdin/stdout:
  - request `{"id": 7, "method": "needle.search", "params": {...}}`
  - reply `{"id": 7, "result": ...}` or `{"id": 7, "error": {"kind", "message"}}`
  - bus event `{"event": "needle.search_complete", "payload": {...}}`
  - UI stream `{"stream": "forge.log", "params": {...}}`
- **Concurrency.** Requests run on a pool of 16 threads, so a long scan does
  not block a search. One lock serialises writes to stdout. Anything a tool
  prints goes to stderr, never into the protocol stream.
- **Lifecycle.** Started on the first request (`core.rs`). If it dies, waiting
  requests fail with a `core` error and the next request starts a new one.
  Closing its stdin (Depot quitting) stops running workflows and sessions,
  then lets in-flight replies finish.
- **Which binary runs.** `$DEPOT_CORE` if set; in debug builds always
  `python -m depot_core` from `core/` (so a stale packaged sidecar can never
  shadow source edits); in release builds the bundled `depot-core` next to
  Depot's executable.
- **Packaging.** `scripts/build-core.py` builds one PyInstaller executable
  named for Tauri's `externalBin` (`src-tauri/binaries/depot-core-<triple>`);
  `scripts/smoke-core.py` calls every tool through the packaged binary, which
  catches a module PyInstaller left out. Release builds pass
  `--config src-tauri/tauri.bundle.conf.json` to include it.

## On-disk layout

```
~/.depot/                             ($DEPOT_HOME overrides, for tests)
├── settings.json                     # last open workspace, reopened on launch
└── workspaces/
    └── <name>/
        ├── context.json              # workspace context
        ├── sessions/
        │   └── 2026-11-14T15-04-05Z.jsonl   # one timeline per Depot session
        ├── needle/index.json
        ├── relay/history.json, saved.json
        ├── blackbox/last-report.json
        └── forge/workflows.json
```

`<name>` is a slug — lowercase letters, digits and `-`, 1–64 characters — and
is validated in Rust before any path is built, so a workspace name can never
reach outside `~/.depot/workspaces/`. Timestamps in file names use `-` instead
of `:` because Windows forbids colons in file names.

Every JSON file is written atomically: write `<file>.tmp`, flush to disk,
rename over the target. (The tools' own stores do the same.)

Switchyard's projects, services and sessions stay in Switchyard's own state
file, shared with the standalone app; a workspace can point at a different one
(`tools.switchyard.state_path`).

## Workspace context

`~/.depot/workspaces/<name>/context.json` (`src-tauri/src/workspace.rs`):

```json
{
  "schema_version": 1,
  "name": "api-gateway",
  "root": "/home/me/work/api-gateway",
  "created_at": "2026-11-14T15:04:05Z",
  "updated_at": "2026-11-14T15:20:41Z",
  "tools": {
    "switchyard": { "state_path": null },
    "needle":     { "roots": [] },
    "relay":      { "base_url": "http://localhost:8080" },
    "pulse":      { "refresh_seconds": 3 },
    "blackbox":   { "repo": null },
    "forge":      {}
  }
}
```

- Empty or `null` means "the default": Needle indexes the workspace root,
  BLACKBOX scans it, Switchyard uses its own state file.
- `schema_version` is checked on load. A newer version than Depot knows is
  refused with an error rather than half-read; every field has a default, so a
  file from an older Depot loads and is upgraded on the next save.
- `workspace_update_tool(tool, patch)` changes one tool's block only. Unknown
  keys and wrong types are refused, and Pulse cannot refresh more often than
  every 2 seconds.
- No secrets are stored here.

**Commands:** `workspace_list`, `workspace_current`, `workspace_create`,
`workspace_open`, `workspace_update_tool`. **Event:** `depot://workspace-changed`
carries the new context after any change. The frontend remounts every panel
when the workspace changes, so no panel carries state from one workspace into
another.

## Event bus

Tools never call each other. A tool publishes; any tool that declared the type
in `events.subscribes` reacts. Pulse can offer **Open in Relay →** without
knowing anything about Relay.

### One catalogue

`src/protocol/events.json` lists every event type (33), whether the timeline
records it, and **who may publish it**: `core` (depot-core), `backend` (Rust)
or `frontend` (a panel — user actions only: `needle.file_found`,
`depot.panel_opened`). Rust reads it with `include_str!`; TypeScript checks
its `EventPayloads` map against it at compile time and in a test; a test also
checks that every type is documented in PLUGIN_PROTOCOL.md and that every
event depot-core publishes is in it. Payload fields are documented in
[PLUGIN_PROTOCOL.md](PLUGIN_PROTOCOL.md#event-catalogue).

### Envelope

```ts
interface BusEvent<T extends EventType> {
  id: string;           // UUIDv7: unique and sortable by time
  type: T;              // "pulse.port_listening"
  source: ToolId | "depot";
  workspace: string;    // workspace open when it was published
  ts: string;           // RFC 3339, set by Rust
  payload: EventPayloads[T];
}
```

### Flow

1. depot-core writes `{"event": …}` (most events); Rust code calls
   `bus.publish` (`depot.*`, `blackbox.review_complete`); a panel calls
   `ipc.busPublish` (user actions).
2. `bus.rs` refuses an unknown type, a publisher whose origin does not match
   the catalogue, a type the tool's manifest does not declare, or a payload
   that is not an object. Payload *fields* are typed on both ends rather than
   schema-checked at runtime.
3. It stamps `id`, `ts` and `workspace`, appends the envelope to the timeline
   if the type is recorded, and emits one Tauri event, `depot://bus`.
4. The frontend listens once (`src/store/bus.ts`) and fans out to local
   subscribers by type.

**Why through Rust:** one place validates and timestamps every event, backend
producers publish the same way as panels, and the timeline sees everything
without each panel remembering to record it.

**Guarantees.** In order per publisher, at most once. The bus is not a queue:
cross-tool subscriptions are therefore made once at startup
(`src/store/integrations.ts`), not inside panels, so an event lands even when
its target panel is not on screen.

## Session timeline

A Depot session starts when a workspace is opened and ends when another is
opened or Depot quits. Each writes one JSON Lines file,
`sessions/<start>.jsonl`, one bus envelope per line, beginning with
`depot.session_started` and ending with `depot.session_ended` (missing after a
crash).

- Append only; each line is flushed as written. A crash costs at most a
  partial last line, which the reader skips.
- Past 50 MB a new file starts with `depot.session_continued`, naming the
  previous file.
- `pulse.snapshot` (every few seconds) is not recorded; everything else is.
- The frontend keeps the last 500 events of the current session
  (`src/store/timeline.ts`), merging what it reads from the file with what
  arrives live, by event id. `timeline_sessions` and `timeline_read` page
  through any session; session names are checked so a request cannot name a
  path.

## Plugin protocol

Each tool has a manifest in `src/protocol/plugins/<id>.json`: identity, its
sidebar entry, the events it publishes and subscribes to, and how it is
embedded. Rust uses `events.publishes` to validate publishers; the frontend
uses `events.subscribes` to decide whether to offer a cross-tool button. The
full schema is in [PLUGIN_PROTOCOL.md](PLUGIN_PROTOCOL.md).

## Rust/React IPC boundary

| Direction | Mechanism | Used for |
|---|---|---|
| React → Rust | Tauri command (`invoke`) | Reading and changing state, starting work |
| Rust → React, broadcast | Tauri event | `depot://bus`, `depot://workspace-changed`, `depot://pulse` (full snapshot) |
| Rust → React, UI-only | Tauri event `depot://stream` | Forge log lines, Switchyard service output, `ocr` progress |

- **One file calls `invoke`:** `src/ipc.ts`, one typed wrapper per command,
  each naming the Rust function it mirrors. 28 commands, registered in one
  `generate_handler!` list in `lib.rs`.
- **Errors cross typed:** `{ kind: "not_found" | "invalid" | "io" | "core" |
  "unavailable" | "busy", message }` (`error.rs`), shown as written.
- **Permissions:** `capabilities/default.json` grants the window
  `core:default`, opening http(s)/mailto links in the system browser, and the
  open-folder dialog. Nothing can spawn a program from the webview: depot-core
  and `ocr` are started by Rust with fixed argument lists and no shell.
- **Outside Tauri** (Vite in a browser, Vitest) every wrapper rejects with an
  `unavailable` error and listeners never fire, so UI work and tests do not
  need the Rust side.

## State management

| State | Owner | Lives in | Survives restart |
|---|---|---|---|
| Workspace context | Rust | `context.json` | yes |
| Timeline | Rust | `sessions/*.jsonl` | yes |
| Tool data (index, history, report, workflows) | the tool's core, via depot-core | `workspaces/<name>/<tool>/` | yes |
| Switchyard projects/services/sessions | Switchyard's core | `~/.switchyard/state.json` | yes |
| `useWorkspace` | Zustand | mirrors `context.json` | reloaded from Rust |
| `useTimeline` | Zustand | last 500 events | reloaded from the file |
| `useLinks` (integration state, latest Pulse snapshot, status bar) | Zustand | memory | no |
| `useNav` (open panel, pending intent) | Zustand | memory | no |
| Panel UI (inputs, selection) | React state | memory | no |

The rule: **anything that must survive a restart is written to disk by Rust or
by the tool's own core; React holds caches and UI state.** Nothing uses
`localStorage`.

Navigation between tools carries an *intent* (`{tool: "relay", url}`,
`{tool: "forge", addPath}`, `{tool: "pulse", pid}`), read once by the
destination panel as initial state and then cleared.

## Design system

`src/design/tokens.ts` holds every colour, type size, spacing step and radius
from the plan. `src/index.css` repeats them as a Tailwind v4 `@theme` and
removes Tailwind's default palette, so only token classes exist; a test fails
if the two disagree. Components in `src/design/components/` are plain
Tailwind. `npm run dev` → `http://localhost:1420/#gallery` shows them all.

Accessibility rules the components follow:

- Tool identity colour is never the only cue (Pulse orange and BLACKBOX red
  measure ΔE 4.8 apart under deuteranopia): the active tool also has an edge
  bar and a raised background, and every tool has its own icon and name.
- Status is never colour alone: badges carry a text label.
- `text.muted` (2.3:1) is for disabled and decorative elements only; readable
  secondary text uses `text.secondary` (6.2:1).
- Tooltips follow Radix UI's behaviour (open on keyboard focus, close on
  Escape, hover delay with a skip window); native form controls keep their
  keyboard and screen-reader behaviour.

## CI and build

`.github/workflows/ci.yml`, every push and pull request, on Ubuntu, macOS and
Windows, with the submodules checked out:

1. `npm ci`, `npm run typecheck`, `npm run lint`, `npm test` (Vitest)
2. `python -m unittest discover -s core/tests` — depot-core against the pinned cores
3. `cargo test` — includes an end-to-end test against the real sidecar
4. build depot-core with PyInstaller and smoke-test the packaged binary
5. `npm run tauri build -- --debug --config src-tauri/tauri.bundle.conf.json`

`.github/workflows/release.yml`, on a `v*` tag: the same tests, then
platform-native bundles with the sidecar via `tauri-apps/tauri-action`,
attached to a **draft** release. Bundles are unsigned until signing secrets
exist.

Local development:

```bash
git submodule update --init
npm install
npm run tauri dev        # runs depot-core from source with python3 (or $DEPOT_PYTHON)
```

## Other decisions

### ADR-002: Tailwind v4 theme in CSS, not `tailwind.config.ts`

**Status:** Accepted. Tailwind v4 reads its theme from CSS `@theme` blocks. The
plan's values are in `src/index.css`, with `tokens.ts` as the source of truth
and a test tying the two together.

### ADR-003: `ocr` runs from Rust, not through the shell plugin

**Status:** Accepted. Open Code Review is a program the user installs, not one
Depot bundles, so it is not a Tauri sidecar in Tauri's sense. Running it from
Rust with `std::process::Command` (fixed arguments, no shell, refs checked)
means the webview never needs permission to start programs. Details:
[src/panels/blackbox/README.md](../src/panels/blackbox/README.md).
