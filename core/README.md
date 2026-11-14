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
| Depot → core, request | `{"id": 7, "method": "needle.search", "params": {...}}` |
| core → Depot, reply | `{"id": 7, "result": ...}` |
| core → Depot, error | `{"id": 7, "error": {"kind": "invalid" \| "not_found" \| "unknown_method" \| "failed", "message": "..."}}` |
| core → Depot, bus event | `{"event": "needle.search_complete", "payload": {...}}` |
| core → Depot, UI stream | `{"stream": "forge.log", "params": {...}}` |

Every `event` must be in `src/protocol/events.json` with origin `core`; a test
checks this. Paths in params are absolute and come from Rust, which decides
the layout under `~/.depot/`.

## Methods

| Method | Params | Publishes |
|---|---|---|
| `core.ping` | — | — |
| `needle.build_index` | `roots`, `index_path` | `needle.index_started`, `needle.index_complete` |
| `needle.search` | `index_path`, `query`, `limit?`, `ext?` | `needle.search_complete` |
| `needle.index_info` | `index_path` | — |
| `relay.send` | `store_dir`, `request` | `relay.request_sent`, `relay.response_received` / `relay.request_failed` |
| `relay.history` | `store_dir` | — |
| `pulse.snapshot` | — | `pulse.snapshot`, and `pulse.port_listening` / `pulse.port_closed` for changes since the last snapshot |
| `blackbox.scan` | `root`, `report_path` | `blackbox.scan_started`, `blackbox.scan_complete` / `blackbox.scan_failed` |
| `blackbox.last_report` | `report_path` | — |
| `forge.list`, `forge.save` | `store_dir`, (`workflows`) | — |
| `forge.run` | `run_id`, `workflow_id`, `workflow` | `forge.run_started`, `forge.step_*`, `forge.run_finished`; stream `forge.log` |
| `forge.stop` | `run_id` | — |
| `switchyard.state` | `state_path?` | — |
| `switchyard.start_session` | `session_id`, `state_path?`, `runtime_path?` | `switchyard.*`; streams `switchyard.session_event`, `switchyard.log` |
| `switchyard.stop_session` | `session_id` | `switchyard.session_stopped` |
| `switchyard.status` | — | — |

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
