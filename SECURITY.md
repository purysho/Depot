# Security Policy

## Supported versions

The latest release is supported. Older releases do not receive security
patches. Depot is in alpha; there is no release yet.

## Reporting a vulnerability

Open a GitHub issue titled `[SECURITY] <brief description>` that names the
affected area but leaves out exploit details, or contact the maintainer
directly through the GitHub profile if the details are sensitive.

Please do not disclose publicly until the maintainer has had a chance to
respond. We aim to acknowledge within 72 hours and patch within 14 days for
confirmed vulnerabilities.

## Threat model

Depot is a local desktop application. It does not:

- open listening network ports by default
- send telemetry, usage data, or crash reports
- require an account or sign-in
- upload files, code, or configuration to any server

All state is stored under `~/.depot/` as plain JSON and JSON Lines files.

The webview is locked down: a Content Security Policy allows only Depot's own
scripts, and `src-tauri/capabilities/default.json` grants the window only the
core Tauri permissions, opening http(s) and mailto links in the system
browser, and the open-folder dialog.

What runs, and with what reach:

- **depot-core**, a sidecar bundled with Depot, runs the six tools' own
  Python code. Depot starts it with a fixed command and talks to it over
  stdin/stdout; it opens no ports.
- **Relay** sends requests only to the URL you enter. As in standalone Relay,
  any URL scheme Python's `urllib` accepts works, including `file://`, which
  reads a local file you can already read.
- **Switchyard** sessions started from Depot run the service commands
  defined in Switchyard, with your permissions, and stop when Depot quits.
- **Forge** runs the commands you put in a workflow, with your permissions.
  That is its purpose, not a vulnerability.
- **BLACKBOX's optional AI review** runs the separately installed
  [Open Code Review](https://github.com/alibaba/open-code-review) CLI, which
  sends the diff under review to the LLM provider *you* configured in `ocr`.
  It runs only when you press its button, never as part of a scan, and is
  started from Rust with fixed arguments; git refs that could be read as
  options are refused.
- **Pulse** reads process and connection lists through the operating
  system's own tools. Its snapshots include full command lines, which can
  contain secrets passed as arguments; they stay in memory and are not
  written to the timeline.
- **Events** recorded in the timeline never include header values, URL
  credentials or query strings, Forge command lines, or the text of detected
  secrets; error messages are cleaned of URLs and `key=value` credentials
  before they are recorded (`core/depot_core/redact.py`). A step label you
  type yourself is recorded, so do not put secrets in step names.
- **Forge** refuses steps with blank required fields before running anything,
  and will not delete a drive root, your home folder or the folder it runs in.
  Commands without a working folder run in the workspace folder.
- **Needle** opens a result with its default app only if it is inside the
  workspace's indexed folders (checked after resolving links) and is not a
  program or script; those are revealed in the file manager instead.
- **Third-party plugins** (`~/.depot/plugins/`) run nothing until you enable
  them in Settings, which shows the exact program and arguments and the file
  it runs. That approval is stored with the plugin's folder and that file; if
  any of them changes, the plugin stops running until you approve it again,
  and a second folder claiming the same id disables both. Rust starts the program
  with an argument list and no shell, and the only substitutions are the
  workspace folder and name. Plugins cannot load code into Depot or use the
  event bus. A plugin you enable runs with your permissions, like any program
  you install: only enable ones you trust.
- **Relay's mock server** listens on 127.0.0.1 only, on a port you choose or
  a free one, until you stop it or quit Depot.
- The webview cannot start programs or publish tool results: only Rust
  starts processes, and the bus accepts just two user-action events from it.

Vulnerabilities we care about:

- Command injection through workspace settings, event payloads, or plugin manifests
- A webview able to call a command or plugin not granted in the capabilities file
- Reads or writes outside `~/.depot/` and the folders a workspace names (for
  example a workspace name containing `../`)
- Timeline or workspace file corruption leading to data loss
- Secrets written to the timeline or workspace files

Out of scope:

- Attacks requiring physical access to the machine
- Attacks that require an account on the machine that can already read or change your files
- Vulnerabilities in dependencies we do not control (report upstream)
