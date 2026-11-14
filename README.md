<div align="center">
  <img src="assets/icon.png" width="96" alt="Depot">
  <h1>Depot</h1>
  <p><strong>A local-first developer environment.</strong></p>
  <p>
    <a href="https://github.com/purysho/Depot/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/purysho/Depot/actions/workflows/ci.yml/badge.svg"></a> ·
    <a href="https://github.com/purysho/Depot/releases"><img alt="Release" src="https://img.shields.io/github/v/release/purysho/Depot?include_prereleases&sort=semver"></a> ·
    <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-202832.svg"></a> ·
    <a href="#download"><img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-a371f7.svg"></a>
  </p>
  <p>
    <strong>Download:</strong> <a href="#download">Windows</a> · <a href="#download">macOS</a> · <a href="#download">Linux</a> · <a href="#run-from-source">Run from source</a>
  </p>
</div>

![Depot's window: the tool sidebar on the left, the Switchyard panel placeholder in the centre, and the status bar along the bottom](docs/screenshots/depot-shell.png)

Depot brings six standalone tools into one window with shared workspace context:

| Tool | What it does |
|---|---|
| [Switchyard](https://github.com/purysho/Switchyard) | Workspace orchestration, service graphs, run configs |
| [Needle](https://github.com/purysho/Needle) | Local file search and indexing |
| [Relay](https://github.com/purysho/Relay) | HTTP client, request inspector, mock server |
| [Pulse](https://github.com/purysho/Pulse) | Process and network relationship monitor |
| [BLACKBOX](https://github.com/purysho/BLACKBOX) | Repository forensics and code analysis |
| [Forge](https://github.com/purysho/Forge) | Workflow runner for local automations |

Each tool also ships as a standalone app. Depot adds the layer they cannot
provide alone: a workspace that scopes every tool to the current project, an
event bus that connects them, and a session timeline that records everything
that happened while you worked.

## Download

There is no release yet. Depot is in alpha: the window, sidebar, status bar
and design system are built, and the tool panels are not. Until they are,
use the standalone apps linked in the table above.

| Platform | File |
|---|---|
| Windows 10/11 (x64) | First release pending — will appear on [Releases](https://github.com/purysho/Depot/releases) |
| macOS (Apple Silicon) | First release pending |
| Linux (x86_64) | First release pending |

## Run from source

Requirements: Node.js 22.12 or newer, Rust (stable), and the
[Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for
your platform (WebView2 on Windows, Xcode Command Line Tools on macOS,
WebKitGTK on Linux).

```bash
npm install
npm run tauri dev
```

Checks, as run in CI:

```bash
npm run typecheck
npm run lint
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

To see every shared UI component, run `npm run dev` and open
`http://localhost:1420/#gallery`.

How it fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/PLUGIN_PROTOCOL.md](docs/PLUGIN_PROTOCOL.md).

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md).

## License
MIT
