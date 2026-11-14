# Plugin protocol

A Depot plugin is a tool with a panel in the sidebar. The six built-in tools —
Switchyard, Needle, Relay, Pulse, BLACKBOX and Forge — are plugins described by
the same manifest a third-party plugin would use. Loading third-party plugins
is not supported in v1; the manifest format is published now so the built-in
tools are held to it.

**Status.** v1 of the protocol, in use. The manifests live in
`src/protocol/plugins/<id>.json` and the event list in `src/protocol/events.json`;
the Rust bus validates every event against both, and tests keep this document,
the JSON files and the TypeScript types in step.

## `depot.plugin.json`

```json
{
  "id": "needle",
  "name": "Needle",
  "version": "1.0.0",
  "description": "Local file search and indexing.",
  "panel": {
    "icon": "Search",
    "label": "Needle",
    "color": "#3fb950",
    "component": "panels/needle/NeedlePanel"
  },
  "workspace_scoped": true,
  "events": {
    "publishes": ["needle.index_started", "needle.index_complete", "needle.search_complete", "needle.file_found"],
    "subscribes": []
  },
  "embed": { "mode": "native", "bridge": "plugins/needle" },
  "handoff": { "app": "Needle", "args": ["--root", "{workspace.tools.needle.roots[0]}"] },
  "min_depot": "1.0.0"
}
```

### Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string, `^[a-z][a-z0-9_]{1,31}$` | yes | Stable identifier. Prefix of every event the plugin publishes. |
| `name` | string | yes | Display name. |
| `version` | semver string | yes | Plugin version. Built-in plugins use Depot's version. |
| `description` | string | yes | One sentence, shown in Settings. |
| `panel.icon` | string | yes | A [Lucide](https://lucide.dev/icons/) icon name in PascalCase. Must exist in the `lucide-react` version Depot ships (1.73.0). |
| `panel.label` | string | yes | Tooltip and accessible name of the sidebar button. |
| `panel.color` | hex colour | yes | Identity colour; must be one of the `colors.tools` tokens. Used only as an accent, never as the only cue. |
| `panel.component` | string | yes | Path under `src/` of the React component, without extension. |
| `workspace_scoped` | boolean | yes | `true`: the panel reads its settings from `context.json → tools.<id>` and is reset when the workspace changes. |
| `events.publishes` | string[] | yes | Every event type the plugin may publish. Each must start with `<id>.`. The bus rejects anything else. |
| `events.subscribes` | string[] | yes | Event types the panel reacts to. Informational for the bus; used to draw the integration map in Settings. |
| `embed` | object | yes | How the plugin runs. See [Embed modes](#embed-modes). |
| `handoff` | object | no | How to open the standalone app on the same context. See below. |
| `min_depot` | semver string | yes | Lowest Depot version the manifest works with. |

Unknown fields are rejected, so a typo does not silently do nothing.

### Embed modes

| Mode | What runs | Fields | Used by |
|---|---|---|---|
| `native` | A React panel, backed by a Rust bridge in `src-tauri/src/plugins/<id>.rs`. The bridge may itself call a sidecar (ADR-001 in ARCHITECTURE.md). | `bridge` | All six built-in tools |
| `sidecar` | An external program spawned by Rust, speaking JSON on stdout. Must be declared in the Tauri shell-plugin scope with its exact arguments. | `program`, `args`, `required` (`false` = optional; the panel works without it) | BLACKBOX's optional `ocr` review |
| `handoff` | No panel of its own; the sidebar button launches the standalone app. | — | Fallback for a tool whose panel is not built yet |

### Handoff

Each standalone tool already accepts arguments that open it on a given
context (Switchyard uses them today). `handoff.args` may reference the
workspace context with `{…}` placeholders; each placeholder expands to one
argument and is never passed through a shell.

| Tool | Arguments |
|---|---|
| Needle | `--root PATH`, `--query TEXT` |
| Relay | `--url URL`, `--method METHOD` |
| Pulse | `--pid N` |
| BLACKBOX | `--repo PATH` |
| Forge | none |
| Switchyard | none |

## Event catalogue

Each event type also has an **origin** in `events.json` — `core` (depot-core),
`backend` (Rust) or `frontend` (a panel) — and the bus refuses it from anyone
else. Only two are `frontend`: `needle.file_found` and `depot.panel_opened`,
both user actions.

Every event travels in the envelope described in
[ARCHITECTURE.md](ARCHITECTURE.md#envelope): `id`, `type`, `source`,
`workspace`, `ts`, `payload`. The tables below define `payload`.

Conventions:

- Paths are absolute. Times are RFC 3339 strings; durations are
  `*_ms` integers.
- A field marked `?` may be `null`.
- **Timeline** says whether the event is written to the session timeline.
  Events marked "no" are high-rate and live-only.
- Payloads never carry secrets: no header values, no environment values, no
  matched secret text.

### Depot

| Event | Payload | Timeline |
|---|---|---|
| `depot.session_started` | `{ session: string, depot_version: string }` | yes |
| `depot.session_continued` | `{ session: string, previous_file: string }` | yes |
| `depot.session_ended` | `{ session: string, reason: "closed" \| "quit" \| "workspace_switched" }` | yes |
| `depot.workspace_opened` | `{ name: string, root: string }` | yes |
| `depot.panel_opened` | `{ tool: ToolId }` | yes |

### Switchyard

| Event | Payload | Timeline | Subscribers |
|---|---|---|---|
| `switchyard.session_started` | `{ session_id: string, name: string, services: string[] }` | yes | — |
| `switchyard.session_stopped` | `{ session_id: string, reason: "user" \| "failure" }` | yes | — |
| `switchyard.service_started` | `{ service_id: string, name: string, pid: number?, ports: number[] }` | yes | — |
| `switchyard.service_ready` | `{ service_id: string, name: string, pid: number?, ports: number[], startup_ms: number }` | yes | — |
| `switchyard.service_unhealthy` | `{ service_id: string, name: string, pid: number?, ports: number[], reason: "exited" \| "readiness_timeout" \| "port_lost", exit_code: number? }` | yes | **Pulse** |
| `switchyard.service_stopped` | `{ service_id: string, name: string, exit_code: number? }` | yes | — |

### Needle

| Event | Payload | Timeline | Subscribers |
|---|---|---|---|
| `needle.index_started` | `{ roots: string[], incremental: boolean }` | yes | — |
| `needle.index_complete` | `{ roots: string[], documents: number, terms: number, scanned: number, duration_ms: number }` | yes | — |
| `needle.search_complete` | `{ query: string, result_count: number, duration_ms: number }` | yes | — |
| `needle.file_found` | `{ path: string, query: string, score: number }` — published when the user selects a result, not for every result | yes | **Forge** |

### Relay

| Event | Payload | Timeline | Subscribers |
|---|---|---|---|
| `relay.request_sent` | `{ request_id: string, method: string, url: string }` — URL without query values | yes | — |
| `relay.response_received` | `{ request_id: string, status: number, elapsed_ms: number, size_bytes: number }` | yes | status bar |
| `relay.request_failed` | `{ request_id: string, error: string }` | yes | — |
| `relay.mock_started` | `{ port: number, routes: string[] }` — reserved: Depot's Relay panel has no mock server yet | yes | — |
| `relay.mock_stopped` | `{ port: number }` — reserved, as above | yes | — |

### Pulse

| Event | Payload | Timeline | Subscribers |
|---|---|---|---|
| `pulse.snapshot` | `{ process_count: number, listening: Array<{ pid: number, port: number }> }` | **no** | status bar |
| `pulse.port_listening` | `{ pid: number, process_name: string, address: string, port: number, protocol: "tcp" \| "udp" }` — a port that was not listening in the previous snapshot | yes | **Relay** |
| `pulse.port_closed` | `{ pid: number, port: number }` | yes | — |
| `pulse.process_exited` | `{ pid: number, name: string }` — reserved: not published yet | yes | — |

### BLACKBOX

| Event | Payload | Timeline | Subscribers |
|---|---|---|---|
| `blackbox.scan_started` | `{ root: string }` | yes | — |
| `blackbox.scan_complete` | `{ root: string, overall_risk: number, files: number, loc: number, findings: { critical: number, high: number, medium: number, low: number, info: number }, cycles: number }` | yes | **Switchyard** |
| `blackbox.scan_failed` | `{ root: string, error: string }` | yes | — |
| `blackbox.review_complete` | `{ root: string, source: "ocr", status: string, comments: number, by_severity: { critical: number, high: number, medium: number, low: number } }` | yes | — |

`blackbox.scan_complete` reports BLACKBOX's own analysis only. Optional
`ocr` review results arrive separately as `blackbox.review_complete` and never
change `overall_risk`, so the risk badge means the same thing whether or not
`ocr` is installed.

### Forge

| Event | Payload | Timeline | Subscribers |
|---|---|---|---|
| `forge.run_started` | `{ run_id: string, workflow_id: string, name: string, steps: number }` | yes | — |
| `forge.step_started` | `{ run_id: string, step_index: number, step_id: string, type: string, label: string }` | yes | — |
| `forge.step_succeeded` | `{ run_id: string, step_index: number, step_id: string, duration_ms: number }` | yes | — |
| `forge.step_failed` | `{ run_id: string, step_index: number, step_id: string, label: string, error: string, pid: number?, exit_code: number? }` | yes | **Pulse** |
| `forge.run_finished` | `{ run_id: string, outcome: "completed" \| "failed" \| "stopped", failed_steps: number, duration_ms: number }` — a run that continued past errors is `completed` with `failed_steps` > 0 | yes | — |

`pid` is set only for `command` steps.

## Cross-tool integrations in v1

| Event | Publisher → Subscriber | What the subscriber does |
|---|---|---|
| `pulse.port_listening` | Pulse → Relay | Pulse shows **Open in Relay →** on that port's row; it opens Relay with `http://<address>:<port>/`. |
| `needle.file_found` | Needle → Forge | Needle shows **Add to workflow →** on the selected result; it opens Forge's step editor with the path filled in. |
| `blackbox.scan_complete` | BLACKBOX → Switchyard | Switchyard updates the risk badge on the matching project card (matched by `root`). |
| `forge.step_failed` | Forge → Pulse | Pulse filters to the failed step's PID. If the process has already exited, Pulse says so and keeps the filter, rather than showing an unrelated process that reused the PID. |
| `switchyard.service_unhealthy` | Switchyard → Pulse | Pulse highlights that service's process (by PID, or by its ports when the PID is gone). |

A button such as **Open in Relay →** appears only when the subscribing tool is
present, so no tool links to a panel that cannot answer.

## The six built-in manifests

| `id` | `panel.icon` | `panel.color` | `publishes` | `subscribes` |
|---|---|---|---|---|
| `switchyard` | `Waypoints` | `#58a6ff` | `switchyard.*` (6) | `blackbox.scan_complete` |
| `needle` | `Search` | `#3fb950` | `needle.*` (4) | — |
| `relay` | `Send` | `#a371f7` | `relay.*` (5) | `pulse.port_listening` |
| `pulse` | `Activity` | `#f07b2b` | `pulse.*` (4) | `forge.step_failed`, `switchyard.service_unhealthy` |
| `blackbox` | `ScanSearch` | `#f85149` | `blackbox.*` (4) | — |
| `forge` | `Workflow` | `#d29922` | `forge.*` (5) | `needle.file_found` |

All icon names were checked against `lucide-react` 1.73.0.

## Versioning

The protocol version is the manifest's `min_depot`. Adding an optional
payload field is backwards compatible. Removing or renaming a field, or
changing its type, is a new event type (`forge.step_failed_v2`), so old
subscribers and old timeline files keep working.
