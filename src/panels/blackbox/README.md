# BLACKBOX panel

The panel shows BLACKBOX's own scan of the workspace repository and, when it
is installed, an optional AI review from
[Open Code Review](https://github.com/alibaba/open-code-review) (`ocr`).

| Piece | File |
|---|---|
| Panel | `BlackboxPanel.tsx` |
| Native scan | `core/depot_core/tools/blackbox.py` → BLACKBOX's `scan_repo()` (pinned in `vendor/blackbox`) |
| `ocr` integration | `src-tauri/src/plugins/blackbox.rs` |
| Types | `src/types/tools.ts` (`BlackboxReport`, `Finding`, `OcrStatus`, `OcrReview`, `ReviewTarget`) |

## Native analysis (always available)

**Scan repository** calls `blackbox_scan`, which runs BLACKBOX's scanner in
depot-core. It is local, needs no network and no account, and is the same
code as the standalone BLACKBOX app. The full report summary is saved to
`~/.depot/workspaces/<name>/blackbox/last-report.json` and reloaded when the
panel opens. A finished scan publishes `blackbox.scan_complete`; Switchyard
uses it to put a risk badge on the matching project card.

## Optional AI review with `ocr`

`ocr` is a Go CLI that sends a Git diff to an LLM provider the user configures
in `ocr` itself, and returns line-level review comments as JSON
(`--format json`).

### Detection

When the panel opens it calls `ocr_status`, which finds the **native** Open
Code Review binary and runs it with `--version` (5-second limit). If that
fails, the panel shows one line explaining that the review is optional and
links to the project; nothing else changes. Detection runs each time the panel
opens, so installing `ocr` while Depot is running is picked up without a
restart.

How the native binary is found (`find_ocr` in `plugins/blackbox.rs`):

1. `opencodereview` on `PATH`.
2. `ocr` on `PATH`, using `PATHEXT` on Windows — the install scripts put the
   native binary there as `ocr` / `ocr.exe`.
3. If that `ocr` is npm's launcher (`bin/ocr.js`, or `ocr.cmd` on Windows), the
   native `opencodereview[.exe]` it would start, from the per-platform package
   (`@alibaba-group/ocr-<os>-<arch>/bin/`) or the legacy `bin/` layout, as in
   upstream `scripts/platform.js`.

Depot runs the native binary rather than the npm launcher because the launcher
passes its pipes to the native child: cancelling the launcher alone would leave
the review running and holding the output open. If only the launcher can be
found, it is used, and cancelling still stops the whole tree.

`ocr` is never bundled with Depot.

### Running a review

The person picks what to review and presses **Run AI review**:

| Choice | Arguments |
|---|---|
| Uncommitted changes | `ocr review --repo <repo> --format json` |
| One commit | `… --commit <sha>` |
| A branch range | `… --from <ref> --to <ref>` |

- **Not a Tauri shell-plugin sidecar.** `ocr` is a program the user installed,
  not one bundled with Depot (Tauri's "sidecar" term means a bundled binary).
  It is started from Rust with `std::process::Command`: a fixed argument list
  and no shell. That means the webview is never given permission to start
  programs, which the shell plugin would require.
- Refs are checked before use: anything starting with `-` (which `ocr` could
  read as an option) or containing characters outside a git ref's set is
  refused.
- With `--format json`, `ocr` writes progress to stderr and the result to
  stdout. Rust streams each stderr line to the panel
  (`depot://stream`, name `blackbox.ocr_progress`), which shows the latest one
  under the button.
- One review at a time. **Cancel review** stops the whole process tree
  (`ocr_cancel`): `ocr` starts as the leader of its own process group, which is
  killed as a group on macOS and Linux; on Windows `taskkill /T /F` stops the
  tree.
- The review is never started automatically and never as part of **Scan
  repository**, because it sends code to a third party. The panel says which
  version of `ocr` will run and that the diff goes to the provider configured
  in `ocr`.

### Mapping the output

`ocr`'s JSON (`cmd/opencodereview/output.go` and `internal/model/review.go`
upstream) has `status`, `warnings`, `summary` and `comments`. Each comment
becomes a BLACKBOX finding:

| `ocr` comment | Finding |
|---|---|
| `path` | `file` |
| `start_line`, `end_line` | `line`, `end_line` |
| `severity` (`critical`/`high`/`medium`/`low`, may be empty) | `severity`; empty becomes `info` |
| `category` (`bug`, `security`, …) | `type`, as `ocr:<category>` |
| first line of `content` | `title` |
| `content` | `detail` |
| `suggestion_code` | `suggestion` |
| — | `source: "ocr"` (native findings have `source: "blackbox"`) |

The mapping is `map_review()` in `plugins/blackbox.rs`, a pure function with
tests built on that upstream shape.

AI findings are listed with the native ones, most severe first, with a source
column and a filter. They **do not change the overall risk score**, so a risk
badge means the same thing on a machine with `ocr` as without it. A finished
review publishes `blackbox.review_complete`, which is recorded in the session
timeline.

### Failures

| What happened | What the panel shows |
|---|---|
| `ocr` not installed | The one-line note; the native scan is unaffected |
| Cancelled | "Review cancelled" |
| `ocr` exited with nothing on stdout (usually no provider configured) | An error pointing to `ocr config provider` |
| stdout is not JSON | An error suggesting `ocr review --format json` in a terminal |
| `status` is `completed_with_warnings` / `completed_with_errors` | Comments are still imported |

In every case the native findings stay on screen.
