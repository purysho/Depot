# Architecture

Depot is a Tauri v2 desktop app: a Rust backend that owns all state and
everything that touches the operating system, and a React + TypeScript
frontend that renders it. Three shared services connect the six tools:

- the **workspace context** — which project you are working on, and each
  tool's settings for it
- the **event bus** — typed messages one tool publishes and others react to
- the **session timeline** — an append-only record of what happened while
  you worked

```
┌──────────────────────────── webview (React) ─────────────────────────────┐
│  Sidebar   Panels (switchyard · needle · relay · pulse · blackbox · forge) │
│                 │ read/write                  ▲ events                    │
│        Zustand stores: workspace · timeline · bus bindings · panel UI      │
│                 │ src/ipc.ts (invoke)         │ listen("depot://…")       │
└─────────────────┼─────────────────────────────┼───────────────────────────┘
          Tauri commands                   Tauri events
┌─────────────────┼─────────────────────────────┼───────────────────────────┐
│                 ▼            Rust (src-tauri) │                           │
│   workspace.rs ──► bus.rs ──► timeline.rs     │                           │
│   (context.json)   (validate,  (sessions/*.jsonl)                         │
│                     stamp, fan out) ──────────┘                           │
│   plugins/<tool>.rs — one bridge per tool (see ADR-001)                    │
└───────────────────────────────────────────────────────────────────────────┘
                     ~/.depot/  (all state, local only)
```

**Status.** This document describes the target design. As of v0.1.0 the
shell, design system, CI and the IPC pattern (`app_version`) exist; the
workspace context, bus, timeline and panels are the next build. Sections say
"planned" where nothing exists yet.

## On-disk layout

```
~/.depot/
├── settings.json                     # last workspace, window size (planned)
└── workspaces/
    └── <name>/
        ├── context.json              # workspace context
        ├── sessions/
        │   └── 2026-11-14T15-04-05Z.jsonl   # one timeline per Depot session
        ├── needle/index.json         # per-tool data, written only by that tool's bridge
        ├── relay/history.json
        └── blackbox/last-report.json
```

`<name>` is a slug: lowercase letters, digits and `-`, 1–64 characters. Rust
validates it before building any path, so a workspace name can never reach
outside `~/.depot/workspaces/`. Timestamps in file names use `-` instead of
`:` because Windows forbids colons in file names.

Every JSON file is written atomically — write `<file>.tmp`, flush, rename over
the target — the same rule the standalone tools follow.

## Workspace context (planned)

A workspace scopes every tool to one project: Needle indexes its folders,
Relay's base URL points at its services, Pulse watches its ports, BLACKBOX
scans its repository.

`~/.depot/workspaces/<name>/context.json`:

```json
{
  "schema_version": 1,
  "name": "api-gateway",
  "created_at": "2026-11-14T15:04:05Z",
  "updated_at": "2026-11-14T15:20:41Z",
  "root": "/home/me/work/api-gateway",
  "projects": [
    { "id": "gateway", "name": "gateway", "path": "/home/me/work/api-gateway", "tags": ["go"] }
  ],
  "tools": {
    "switchyard": { "state_path": "~/.switchyard/state.json", "default_session": "dev" },
    "needle":     { "roots": ["/home/me/work/api-gateway"], "extensions": null },
    "relay":      { "base_url": "http://localhost:8080" },
    "pulse":      { "watch_ports": [8080, 5432], "refresh_seconds": 3 },
    "blackbox":   { "repo": "/home/me/work/api-gateway", "ocr": { "enabled": false } },
    "forge":      { "workflow_ids": ["deploy-local"] }
  }
}
```

- `schema_version` is checked on load. A newer version than Depot knows is
  refused with an error rather than half-read; an older one is migrated in
  memory and written back on the next save.
- Each `tools.<id>` block is owned by that tool and typed on both sides. A
  tool may only change its own block (`workspace_update_tool(tool, patch)`).
- Paths are stored absolute. `~` is expanded on load, never stored expanded
  for paths outside the user's home.
- No secrets. Like Switchyard's environment profiles, a token needed by a
  tool is referenced by environment-variable name, never stored by value.

**Commands:** `workspace_list`, `workspace_open(name)`,
`workspace_create(name, root)`, `workspace_update_tool(tool, patch)`,
`workspace_close`. **Event:** `depot://workspace-changed` with the new context,
so every panel re-reads it after any change, including one made by another
panel.

## Event bus (planned)

Tools never call each other. A tool publishes an event; any tool that
declared it in `events.subscribes` reacts. This is what lets Pulse offer
"Open in Relay →" without Pulse knowing anything about Relay.

### Envelope

```ts
interface BusEvent<T extends EventType = EventType> {
  id: string;            // ULID, sortable by time
  type: T;               // "pulse.port_listening"
  source: ToolId | "depot";
  workspace: string;     // workspace name at publish time
  ts: string;            // RFC 3339, set by Rust
  payload: EventPayloads[T];
}
```

Every event type and its payload is listed in
[PLUGIN_PROTOCOL.md](PLUGIN_PROTOCOL.md#event-catalogue). `EventPayloads` is a
TypeScript map from type to payload, so `subscribe("pulse.port_listening", e =>
e.payload.port)` is checked at compile time.

### Flow

1. A panel calls `publish(type, payload)` (TS) — or a Rust bridge calls
   `bus.publish(...)` directly, for events produced in the backend such as
   Pulse snapshots or Forge step results.
2. Rust (`bus.rs`) checks that the publisher's manifest lists the type in
   `events.publishes`, validates the payload shape, stamps `id`, `ts` and
   `workspace`, and appends it to the timeline.
3. Rust emits one Tauri event, `depot://bus`, carrying the envelope.
4. The frontend listens once (`src/store/bus.ts`) and fans the event out to
   local subscribers by `type`.

**Why through Rust, when a JS-only pub/sub would be simpler:** backend
producers (process watchers, sidecars) need to publish too; one place
validates and timestamps every event; and the timeline sees every event
without each panel remembering to record it. The cost is one IPC round trip
per publish, well under a millisecond, which is irrelevant at UI event rates.

**Guarantees.** Delivery is in order per publisher and at most once. The bus
is not a queue: a panel that is not mounted misses live events, and catches up
by reading the workspace context or the timeline. High-rate events (Pulse
snapshots) are marked `timeline: false` and are not persisted.

## Session timeline (planned)

A Depot session starts when a workspace is opened and ends when it is closed
or Depot quits. Each session writes one JSON Lines file:

`~/.depot/workspaces/<name>/sessions/<start-timestamp>.jsonl`

Each line is one bus envelope, exactly as delivered. The first line is
`depot.session_started`, the last `depot.session_ended` (missing after a crash).

- **Append only.** The file is opened in append mode and each line is
  flushed as it is written. A crash can leave at most a partial last line;
  the reader skips a final line that does not parse.
- **What each tool writes** is the set of event types it publishes, minus
  those marked `timeline: false`. The catalogue in PLUGIN_PROTOCOL.md marks
  each one.
- **Size.** A session file is closed and a new one started at 50 MB, with a
  `depot.session_continued` line linking the two.
- The frontend store (`src/store/timeline.ts`) keeps the most recent 500
  events of the current session in memory for the timeline view; older events
  and past sessions are read from disk on demand
  (`timeline_read(session, offset, limit)`).

## Plugin protocol

Each tool is described by a `depot.plugin.json` manifest: identity, its
sidebar entry, whether it is workspace-scoped, the events it publishes and
subscribes to, and how it is embedded. The full schema, the embed modes and
the event catalogue are in [PLUGIN_PROTOCOL.md](PLUGIN_PROTOCOL.md).

The six built-in tools ship with Depot; their manifests are compiled in. The
sidebar is built from `src/panels/registry.ts`, which mirrors their `panel`
blocks.

## Rust/React IPC boundary

| Direction | Mechanism | Used for |
|---|---|---|
| React → Rust, request/response | Tauri command (`invoke`) | Reading and changing state, starting work |
| Rust → React, broadcast | Tauri event (`emit` / `listen`) | `depot://bus`, `depot://workspace-changed` |
| Rust → React, one stream per call | Tauri `Channel` | Output of one long call: a Forge run's log, `ocr`'s progress |

Rules:

- **One file calls `invoke`:** `src/ipc.ts`. Each export is a typed wrapper
  next to a comment naming the Rust function it mirrors. Components and stores
  import from there, never from `@tauri-apps/api/core` directly.
- **Commands are `snake_case` verbs on a noun** (`workspace_open`,
  `timeline_read`) and are registered in one `generate_handler!` list in
  `lib.rs`.
- **Errors cross the boundary typed.** Commands return
  `Result<T, DepotError>`, where `DepotError` serialises to
  `{ "kind": "not_found" | "invalid" | "io" | …, "message": string }`, so the UI
  can tell "workspace does not exist" from "disk full".
- **Types are written on both sides** (serde structs in Rust, interfaces in
  `src/types/`). To stop them drifting, Rust tests serialise each type to a
  fixture in `tests/fixtures/`, and Vitest tests parse the same fixtures into
  the TypeScript types. Generating TypeScript from Rust (`specta`, `ts-rs`) is
  worth revisiting once the surface is larger.
- **Permissions are explicit.** `src-tauri/capabilities/default.json` grants
  the main window only `core:default` and opening URLs in the system browser.
  Each plugin (for example the shell plugin for sidecars) is added there with
  the narrowest scope that works.
- **Outside Tauri** (Vite in a browser, Vitest) `isTauri()` is false and the
  wrappers return empty results instead of throwing, so the UI can be built and
  tested without the Rust side.

## State management

| State | Owner | Lives in | Survives restart |
|---|---|---|---|
| Workspace context | Rust | `context.json` | yes |
| Timeline | Rust | `sessions/*.jsonl` | yes |
| Tool data (Needle index, Relay history, last BLACKBOX report) | Rust bridge for that tool | `workspaces/<name>/<tool>/` | yes |
| Workspace store (`src/store/workspace.ts`) | Zustand | memory, mirrors `context.json` | no — reloaded from Rust |
| Timeline store (`src/store/timeline.ts`) | Zustand | memory, last 500 events | no |
| Bus bindings (`src/store/bus.ts`) | module | the single `listen()` and subscriber map | no |
| Panel UI state (selection, filters, open tab) | Zustand slice per panel | memory | no |

The rule: **anything that must survive a restart is owned by Rust and written
to disk; Zustand holds a cache of it plus ephemeral UI state.** Stores never
write to `localStorage`, so there is exactly one copy of persistent state and
it can be inspected and backed up as plain files.

Store updates from Rust are pushed (`depot://workspace-changed`,
`depot://bus`); a store never polls.

## Design system

`src/design/tokens.ts` holds every colour, type size, spacing step and radius
from the plan. `src/index.css` repeats them as Tailwind v4 `@theme` variables
and removes Tailwind's default palette, so only token classes exist; a test
fails if the two files disagree. Shared components live in
`src/design/components/` and are built in plain Tailwind — no component library
dependency. Run `npm run dev` and open `http://localhost:1420/#gallery` to see
every component.

Accessibility rules the components follow:

- Tool identity colour is never the only cue. Pulse orange and BLACKBOX red
  are hard to tell apart with red-green colour blindness (ΔE 4.8 under
  deuteranopia, measured), so an active tool is also marked by an edge bar and
  a raised background, and every tool has a distinct icon and name.
- Status is never colour alone: badges always carry a text label, and the
  session indicator says "Session 1:02:13" or "No session".
- `text.muted` (`#484f58`, 2.3:1 on the background) is used only for disabled
  and decorative elements; readable secondary text uses `text.secondary`
  (6.2:1).
- One visible focus style for keyboard users; tooltips follow Radix UI's
  behaviour (open on keyboard focus, close on Escape, hover delay with a skip
  window).

## CI and build

`.github/workflows/ci.yml`, on every push and pull request, on Ubuntu, macOS
and Windows:

1. `npm ci`
2. `npm run typecheck` — `tsc -b`
3. `npm run lint` — ESLint with TypeScript and React Hooks rules
4. `npm test` — Vitest, including the token consistency test
5. `cargo test` in `src-tauri`
6. `npm run tauri build -- --debug` — a full debug bundle, proving the app
   packages on each platform

Ubuntu installs WebKitGTK and the other system libraries Tauri needs first.

`.github/workflows/release.yml`, on a `v*` tag: builds release bundles on the
three platforms with `tauri-apps/tauri-action` and attaches them to a **draft**
GitHub Release, which a maintainer reviews and publishes. Bundles are unsigned
until signing secrets are configured.

Local development:

```bash
npm install
npm run tauri dev
```

## Decision records

### ADR-001: Where panel logic comes from

**Status:** Proposed — needs a decision before the panels are built.
**Date:** 2026-11-14

**Context.** The six tools already exist as Python apps. Their cores are UI-free
and tested: `needle/indexer.py` (≈450 lines), `blackbox_core/scanner.py`
(≈400), `forge/engine.py`, `relay/http_client.py`, `pulse/providers.py`.
Switchyard's core is larger still. Depot needs the same behaviour behind its
panels. The plan names `src-tauri/src/plugins/<tool>.rs` an "IPC bridge" but
does not say what it bridges to.

**Options.**

| | A. Rewrite each core in Rust | B. One Python sidecar for all cores | C. Hybrid |
|---|---|---|---|
| Duplicated logic | All of it, forever | None | Some |
| Standalone apps and Depot agree | Only by discipline | By construction | Partly |
| Bundle size | Smallest | +≈12 MB (one PyInstaller binary) | In between |
| macOS process data (Pulse gap) | Fixed via `sysinfo` | Still thin | Fixed |
| Effort to first panel | High | Medium (a stdio JSON-lines protocol) | Medium |

**Recommendation: B, with Pulse as the one exception.** Bundle one sidecar,
`depot-core`, that imports the five tool cores at pinned release tags and
answers JSON-lines requests on stdin/stdout (`{"id":1,"method":"needle.search","params":{…}}`).
Each `plugins/<tool>.rs` is a thin typed client of that protocol and the
publisher of that tool's bus events. Pulse's collector is written in Rust on
`sysinfo` instead, because it runs every few seconds (no IPC hop per refresh)
and because it closes the macOS gap the Python version has. Switchyard is
bridged the same way as the others; its state file stays at
`~/.switchyard/state.json`, so Depot and the standalone app share it.

**Consequences.** Bug fixes land once, in the tool's own repository, and reach
Depot by bumping a pin. Depot's release build gains a PyInstaller step. The
standalone repositories need a small headless entry point each, which is also
useful for testing them. If profiling later shows a core is too slow through
the sidecar, that core alone moves to Rust (option C).

### ADR-002: Tailwind v4 theme in CSS, not `tailwind.config.ts`

**Status:** Accepted.

The plan gives a `tailwind.config.ts`; Tailwind v4 reads its theme from CSS
`@theme` blocks instead (a JS config still works only through a compatibility
`@config` directive). The plan's values are expressed in `src/index.css`, with
`tokens.ts` as the source of truth and a test tying the two together. The
`md` and `2xl` type sizes from `tokens.ts`, missing from the plan's Tailwind
block, are included so every token has a class.
