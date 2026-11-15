# depot-core

The sidecar that runs the six tools' Python cores for Depot. Depot's Rust side
starts it and talks to it over stdin/stdout. Background and the reasons for
this design: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#where-the-tools-logic-lives-adr-001).

```
core/depot_core/
├── server.py         # the JSON-lines protocol and thread pool
├── vendor.py         # puts vendor/<tool> on sys.path when run from source
├── params.py         # request parameter checks
└── tools/<tool>.py   # one adapter per tool: calls the tool's core, maps to events
```

## Protocol

One JSON object per line.

| Direction | Shape |
|---|---|
| Depot → core, request | `{"id": 7, "method": "needle.search", "params": {...}, "workspace": "api"}` |
| core → Depot, reply | `{"id": 7, "result": ...}` |
| core → Depot, error | `{"id": 7, "error": {"kind": "invalid" \| "not_found" \| "unknown_method" \| "shutting_down" \| "failed", "message": "..."}}` |
| core → Depot, bus event | `{"event": "needle.search_complete", "payload": {...}, "workspace": "api"}` |
| core → Depot, UI stream | `{"stream": "forge.log", "params": {...}}` |

`workspace` is the workspace the request was made in. Every event and stream
the request causes carries it back, even if it arrives after you switched
workspace, so Depot records it against the right one.

Every `event` must be in `src/protocol/events.json` with origin `core`; a test
checks this. String fields that might hold credentials (URLs, error text,
step labels) go through `redact.py` before they are published, because events
are written to the timeline on disk. Paths in params are absolute and come from Rust, which decides
the layout under `~/.depot/`.

## Methods

| Method | Params | Publishes |
|---|---|---|
| `core.ping` | — | — |
| `core.shutdown` | — | — (refuses new work, drops queued requests, stops every workflow and session (sessions in parallel), and replies only when all have stopped) |
| `needle.build_index` | `roots`, `index_path` | `needle.index_started`, `needle.index_complete` |
| `needle.search` | `index_path`, `query`, `limit?`, `ext?` | `needle.search_complete` |
| `needle.index_info` | `index_path` | — (includes `by_extension` counts) |
| `relay.send` | `store_dir`, `request` | `relay.request_sent`, `relay.response_received` / `relay.request_failed` |
| `relay.history` | `store_dir` | — |
| `relay.saved`, `relay.save`, `relay.delete_saved` | `store_dir`, (`name`, `request`) | — (saved requests, by name) |
| `relay.mock_start` | `port` (0 = any free), `routes` (`path`, `status`, `body`) | `relay.mock_started`; stream `relay.mock_log` |
| `relay.mock_stop`, `relay.mock_list` | (`port`) | `relay.mock_stopped` |
| `pulse.snapshot` | — | `pulse.snapshot`, and `pulse.port_listening` / `pulse.port_closed` for changes since the last snapshot |
| `blackbox.scan` | `root`, `report_path` | `blackbox.scan_started`, `blackbox.scan_complete` / `blackbox.scan_failed` |
| `blackbox.last_report` | `report_path` | — |
| `forge.list`, `forge.save` | `store_dir`, (`workflows`) | — |
| `forge.import`, `forge.export` | `store_dir`, `path`, (`index`) | — (`.forge.json` files; Rust picks `path` with a native dialog) |
| `forge.validate` | `workflow`, `base_dir` | — (the checks `forge.run` makes, without running) |
| `forge.run` | `run_id` (chosen by the panel, before it calls), `workflow_id`, `workflow`, `base_dir` | `forge.run_started`, `forge.step_*`, `forge.run_finished`; stream `forge.log` |
| `forge.stop` | `run_id` | — |
| `forge.active` | — | — (run ids still running in the requesting workspace) |
| `switchyard.state` | `state_path?` | — |
| `switchyard.start_session` | `session_id`, `state_path?`, `runtime_path?` | `switchyard.*`; streams `switchyard.session_event`, `switchyard.log` |
| `switchyard.stop_session` | `session_id` | `switchyard.session_stopped` |
| `switchyard.status` | — | — |

## Forge runs

- **Required fields.** A step with a blank required field (a delete with no
  path, a copy with no target) is refused before anything runs. Forge's engine
  refuses blank paths too, and will not delete a drive root, the home folder,
  or the folder it runs in.
- **Where it runs.** `base_dir` is the workspace folder: a command with no
  working folder runs there, and relative paths are relative to it. depot-core
  never changes its own working folder; each step is resolved instead.
- **Event labels** are a step's own name, or "command step 2": Forge's
  automatic label is the command line, which can carry secrets.

## Shutdown

Depot sends `core.shutdown` and waits (up to 60 s) for the reply, then closes
stdin. Closing stdin without it (Depot crashed) runs the same cleanup; so does
SIGTERM. Once shutdown begins nothing new starts: workflow and session starts
check the flag under the same lock the cleanup takes its list with.

## Running and testing

From the repository root, with the submodules checked out
(`git submodule update --init`):

```bash
python -m unittest discover -s core/tests -v
```

The tests drive the protocol against the real pinned tool cores: a Switchyard
session that starts and stops a real process, a live Pulse snapshot of this
machine, a BLACKBOX scan, a failing Forge command and its PID.

Package it (needs `pip install pyinstaller` and Rust for the target triple):

```bash
python scripts/build-core.py
python scripts/smoke-core.py src-tauri/binaries/depot-core-*
```

## Bumping a tool

```bash
git submodule update --remote vendor/forge     # or check out a tag inside vendor/forge
python -m unittest discover -s core/tests      # does Depot still work with it?
git commit -am "Bump Forge to <version>: <why>"
```
