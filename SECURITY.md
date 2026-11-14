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
core Tauri permissions and opening web links in the system browser. Each tool
that needs more (for example spawning a sidecar program) is granted the
narrowest scope that works, listed in that file.

Planned features that change this picture, and how:

- **Relay's mock server** will listen only after you start it, on `127.0.0.1`.
- **BLACKBOX's optional `ocr` review** runs the separately installed
  [Open Code Review](https://github.com/alibaba/open-code-review) CLI, which
  sends the diff under review to the LLM provider *you* configured in `ocr`.
  It runs only when you press its button, never as part of a normal scan.
- **Forge** runs the commands you put in a workflow, with your permissions.
  That is its purpose, not a vulnerability.

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
