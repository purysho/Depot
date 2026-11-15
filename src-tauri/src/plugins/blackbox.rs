//! BLACKBOX: its own scan runs in depot-core. The optional AI review runs
//! Open Code Review (`ocr`, github.com/alibaba/open-code-review) when the
//! user has installed it on PATH. See src/panels/blackbox/README.md.
//!
//! `ocr` is spawned from Rust with a fixed argument list and no shell, rather
//! than through Tauri's shell plugin, so the webview itself is never granted
//! permission to start programs.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::bus::Origin;
use crate::error::{DepotError, ErrorKind, Result};
use crate::state::AppState;

fn report_path(state: &AppState) -> Result<PathBuf> {
    Ok(state.tool_dir("blackbox")?.join("last-report.json"))
}

#[tauri::command]
pub async fn blackbox_scan(state: State<'_, AppState>) -> Result<Value> {
    let ctx = state.current()?;
    state.core("blackbox.scan", json!({"root": ctx.blackbox_repo(), "report_path": report_path(&state)?})).await
}

#[tauri::command]
pub async fn blackbox_last_report(state: State<'_, AppState>) -> Result<Value> {
    state.core("blackbox.last_report", json!({"report_path": report_path(&state)?})).await
}

// ---------------------------------------------------------------- ocr ----

/// The running review, so it can be cancelled.
#[derive(Default)]
pub struct OcrRun(Arc<Mutex<Option<Child>>>);

impl OcrRun {
    /// Stop the running review, with every process it started. Returns
    /// whether one was running. Used by Cancel and when Depot quits.
    pub fn stop(&self) -> bool {
        let child = self.0.lock().expect("ocr lock").take();
        match child {
            Some(mut c) => {
                kill_tree(&mut c);
                true
            }
            None => false,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct OcrStatus {
    pub available: bool,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
}

/// What to review. Mirrors `ocr review`'s three modes.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReviewTarget {
    /// Staged, unstaged and untracked changes.
    WorkingTree,
    Commit { commit: String },
    Range { from: String, to: String },
}

/// A git ref as typed by the user. Anything starting with `-` could be read
/// as an option, so it is refused; the rest is passed as one argument.
fn checked_ref(value: &str) -> Result<&str> {
    let ok = !value.is_empty()
        && !value.starts_with('-')
        && value.len() <= 200
        && value.chars().all(|c| c.is_ascii_alphanumeric() || "._/~^@{}-".contains(c));
    if ok {
        Ok(value)
    } else {
        Err(DepotError::invalid(format!("Not a git ref: {value}")))
    }
}

pub fn review_args(repo: &Path, target: &ReviewTarget) -> Result<Vec<String>> {
    let mut args = vec!["review".into(), "--repo".into(), repo.display().to_string(), "--format".into(), "json".into()];
    match target {
        ReviewTarget::WorkingTree => {}
        ReviewTarget::Commit { commit } => args.extend(["--commit".into(), checked_ref(commit)?.into()]),
        ReviewTarget::Range { from, to } => {
            args.extend(["--from".into(), checked_ref(from)?.into(), "--to".into(), checked_ref(to)?.into()])
        }
    }
    Ok(args)
}

/// Turns `ocr --format json` output into BLACKBOX findings.
///
/// `ocr`'s comment: path, content, start_line, end_line, category, severity,
/// suggestion_code. BLACKBOX's finding: file, line, severity, type, title,
/// detail. Every mapped finding carries `source: "ocr"`.
pub fn map_review(output: &Value) -> Value {
    let comments = output.get("comments").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut by_severity = json!({"critical": 0, "high": 0, "medium": 0, "low": 0});
    let findings: Vec<Value> = comments
        .iter()
        .map(|c| {
            let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let content = s("content");
            let severity = match s("severity").as_str() {
                sev @ ("critical" | "high" | "medium" | "low") => sev.to_string(),
                _ => "info".to_string(),
            };
            if let Some(n) = by_severity.get_mut(&severity) {
                *n = json!(n.as_u64().unwrap_or(0) + 1);
            }
            let category = if s("category").is_empty() { "other".into() } else { s("category") };
            let title = content.lines().next().unwrap_or("").chars().take(140).collect::<String>();
            json!({
                "severity": severity,
                "type": format!("ocr:{category}"),
                "title": title,
                "file": s("path"),
                "line": c.get("start_line").and_then(Value::as_u64),
                "end_line": c.get("end_line").and_then(Value::as_u64),
                "detail": content,
                "suggestion": c.get("suggestion_code").and_then(Value::as_str),
                "source": "ocr",
            })
        })
        .collect();
    json!({
        "status": output.get("status").and_then(Value::as_str).unwrap_or("unknown"),
        "warnings": output.get("warnings").cloned().unwrap_or(json!([])),
        "summary": output.get("summary").cloned().unwrap_or(Value::Null),
        "by_severity": by_severity,
        "findings": findings,
    })
}

/// The native Open Code Review binary, wherever it was installed from.
///
/// - The install scripts put a native binary named `ocr` (`ocr.exe`) on PATH.
/// - npm installs `ocr` as a Node launcher (`bin/ocr.js`; on Windows an
///   `ocr.cmd` shim) that starts the native `opencodereview[.exe]` from a
///   per-platform package. Depot runs that native binary itself rather than
///   the launcher: the launcher's child inherits its pipes, so cancelling the
///   launcher alone would leave the real review running
///   (open-code-review: bin/ocr.js, scripts/platform.js).
///
/// If a launcher is found but not its native binary, the launcher is used
/// and cancellation kills the whole process tree.
fn find_ocr() -> Option<PathBuf> {
    let native_name = if cfg!(windows) { "opencodereview.exe" } else { "opencodereview" };
    if let Ok(native) = which::which(native_name) {
        return Some(native);
    }
    // No extension: on Windows `which` tries PATHEXT, so this finds ocr.exe
    // from the install script as well as npm's ocr.cmd shim.
    let found = which::which("ocr").ok()?;
    Some(if is_launcher(&found) { native_behind(&found).unwrap_or(found) } else { found })
}

/// A script rather than a native program: npm's Node launcher or Windows shims.
fn is_launcher(path: &Path) -> bool {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let ext = target.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if matches!(ext.as_deref(), Some("js" | "cmd" | "bat" | "ps1")) {
        return true;
    }
    let mut head = [0u8; 2];
    std::fs::File::open(&target).and_then(|mut f| f.read_exact(&mut head)).is_ok() && &head == b"#!"
}

/// Platform package suffix used by open-code-review (scripts/platform.js).
fn platform_key() -> Option<&'static str> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("macos", "aarch64") => "darwin-arm64",
        ("windows", "x86_64") => "win32-x64",
        ("windows", "aarch64") => "win32-arm64",
        _ => return None,
    })
}

/// Where npm puts the native binary next to the launcher at `launcher`.
pub fn native_behind(launcher: &Path) -> Option<PathBuf> {
    let native_name = if cfg!(windows) { "opencodereview.exe" } else { "opencodereview" };
    let key = platform_key()?;
    let canonical = std::fs::canonicalize(launcher).unwrap_or_else(|_| launcher.to_path_buf());
    let mut packages = Vec::new();
    // Unix: the PATH entry is a symlink to <pkg>/bin/ocr.js.
    if canonical.file_name().is_some_and(|n| n == "ocr.js") {
        if let Some(pkg) = canonical.parent().and_then(Path::parent) {
            packages.push(pkg.to_path_buf());
        }
    }
    // Windows: <npm prefix>\ocr.cmd next to <npm prefix>\node_modules.
    if let Some(dir) = launcher.parent() {
        packages.push(dir.join("node_modules").join("@alibaba-group").join("open-code-review"));
    }
    packages.into_iter().find_map(|pkg| {
        let platform_pkg = format!("ocr-{key}");
        [
            pkg.join("node_modules").join("@alibaba-group").join(&platform_pkg),
            pkg.parent().map(|scope| scope.join(&platform_pkg)).unwrap_or_default(),
            pkg.clone(), // legacy layout: <pkg>/bin/opencodereview
        ]
        .into_iter()
        .map(|dir| dir.join("bin").join(native_name))
        .find(|candidate| candidate.is_file())
    })
}

/// Start `program` as the leader of its own process group (Unix) so the
/// whole tree can be stopped together.
fn own_group(cmd: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Stop a process and everything it started.
pub fn kill_tree(child: &mut Child) {
    let pid = child.id().to_string();
    #[cfg(unix)]
    let _ = Command::new("kill").args(["-KILL", "--", &format!("-{pid}")]).status();
    #[cfg(windows)]
    let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &pid]).status();
    let _ = child.kill();
    let _ = child.wait();
}

/// Run a short command and wait at most `limit`; kill it if it hangs.
fn quick_output(program: &Path, args: &[&str], limit: Duration) -> Option<String> {
    let mut child = Command::new(program).args(args).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out.trim().to_string())
}

/// Is `ocr` installed? Checked each time the panel asks, so installing it
/// while Depot runs is picked up without a restart.
#[tauri::command]
pub async fn ocr_status() -> Result<OcrStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(path) = find_ocr() else {
            return OcrStatus { available: false, path: None, version: None };
        };
        let version = quick_output(&path, &["--version"], Duration::from_secs(5));
        // `--version` may print a launcher banner first; keep the last line.
        let version = version.map(|v| v.lines().last().unwrap_or_default().trim().to_string());
        OcrStatus { available: version.is_some(), path: Some(path), version }
    })
    .await
    .map_err(|e| DepotError::core(e.to_string()))
}

#[tauri::command]
pub async fn ocr_review(app: AppHandle, state: State<'_, AppState>, target: ReviewTarget) -> Result<Value> {
    let ocr = find_ocr()
        .ok_or_else(|| DepotError::new(ErrorKind::Unavailable, "Open Code Review (ocr) is not installed on PATH"))?;
    let ctx = state.current()?;
    // Captured now: the review belongs to this workspace even if another one
    // is open by the time it finishes.
    let (repo, workspace) = (ctx.blackbox_repo(), ctx.name);
    let args = review_args(&repo, &target)?;
    let slot = Arc::clone(&state.ocr.0);
    {
        let mut guard = slot.lock().expect("ocr lock");
        if guard.is_some() {
            return Err(DepotError::new(ErrorKind::Busy, "A review is already running"));
        }
        let mut child = own_group(&mut Command::new(&ocr))
            .args(&args)
            .current_dir(&repo)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| DepotError::core(format!("Could not start ocr: {e}")))?;
        let stderr = child.stderr.take().expect("piped");
        let app = app.clone();
        let progress_workspace = workspace.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
                let _ = app.emit(
                    crate::STREAM_EVENT,
                    json!({"name": "blackbox.ocr_progress", "params": {"line": line}, "workspace": progress_workspace}),
                );
            }
        });
        *guard = Some(child);
    }

    let reader_slot = Arc::clone(&slot);
    let (stdout, finished) = tauri::async_runtime::spawn_blocking(move || {
        let mut stdout = reader_slot.lock().expect("ocr lock").as_mut().and_then(|c| c.stdout.take());
        let mut text = String::new();
        if let Some(out) = stdout.as_mut() {
            let _ = out.read_to_string(&mut text);
        }
        // `None` here means ocr_cancel took and killed the process.
        let finished = reader_slot.lock().expect("ocr lock").take().map(|mut c| c.wait());
        (text, finished)
    })
    .await
    .map_err(|e| DepotError::core(e.to_string()))?;

    if finished.is_none() {
        return Err(DepotError::core("Review cancelled"));
    }
    if stdout.trim().is_empty() {
        return Err(DepotError::core(
            "The review stopped without a result. Check that ocr is configured: run `ocr config provider` in a terminal.",
        ));
    }
    let output: Value = serde_json::from_str(stdout.trim())
        .map_err(|_| DepotError::core("ocr did not return JSON. Run `ocr review --format json` in a terminal to see why."))?;
    let review = map_review(&output);
    state.bus.publish_for(
        Origin::Backend,
        "blackbox.review_complete",
        json!({
            "root": repo,
            "source": "ocr",
            "status": review["status"],
            "comments": review["findings"].as_array().map_or(0, Vec::len),
            "by_severity": review["by_severity"],
        }),
        Some(&workspace),
    )?;
    Ok(review)
}

#[tauri::command]
pub async fn ocr_cancel(state: State<'_, AppState>) -> Result<bool> {
    Ok(state.ocr.stop())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_review_arguments_without_a_shell() {
        let repo = Path::new("/r");
        assert_eq!(review_args(repo, &ReviewTarget::WorkingTree).unwrap(), ["review", "--repo", "/r", "--format", "json"]);
        assert_eq!(
            review_args(repo, &ReviewTarget::Range { from: "main".into(), to: "feature/x".into() }).unwrap()[5..],
            ["--from", "main", "--to", "feature/x"]
        );
        assert!(review_args(repo, &ReviewTarget::Commit { commit: "--output=/etc/passwd".into() }).is_err());
        assert!(review_args(repo, &ReviewTarget::Commit { commit: "abc; rm -rf /".into() }).is_err());
    }

    #[test]
    fn maps_ocr_comments_to_findings() {
        // Shape from open-code-review's internal/model/review.go and cmd/opencodereview/output.go.
        let output = json!({
            "status": "completed_with_warnings",
            "warnings": [{"message": "one file skipped"}],
            "comments": [
                {"path": "src/a.go", "content": "Nil map write\nThe map is never initialised.", "start_line": 12, "end_line": 14,
                 "category": "bug", "severity": "high", "suggestion_code": "m := map[string]int{}"},
                {"path": "README.md", "content": "Typo", "start_line": 1, "end_line": 1}
            ]
        });
        let review = map_review(&output);
        let first = &review["findings"][0];
        assert_eq!(first["type"], "ocr:bug");
        assert_eq!(first["title"], "Nil map write");
        assert_eq!(first["line"], 12);
        assert_eq!(first["source"], "ocr");
        assert_eq!(review["findings"][1]["severity"], "info"); // no severity given
        assert_eq!(review["by_severity"]["high"], 1);
        assert_eq!(review["status"], "completed_with_warnings");
    }

    #[test]
    fn finds_the_native_binary_behind_npms_launcher() {
        let Some(key) = platform_key() else { return };
        let native_name = if cfg!(windows) { "opencodereview.exe" } else { "opencodereview" };
        let dir = tempfile::tempdir().unwrap();
        // npm global layout: <prefix>/node_modules/@alibaba-group/{open-code-review, ocr-<key>}
        let scope = dir.path().join("node_modules").join("@alibaba-group");
        let pkg = scope.join("open-code-review");
        std::fs::create_dir_all(pkg.join("bin")).unwrap();
        std::fs::write(pkg.join("bin").join("ocr.js"), "#!/usr/bin/env node\n").unwrap();
        let native = scope.join(format!("ocr-{key}")).join("bin").join(native_name);
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::write(&native, "binary").unwrap();

        // Windows shim: <prefix>/ocr.cmd
        let shim = dir.path().join("ocr.cmd");
        std::fs::write(&shim, "@node ...").unwrap();
        assert!(is_launcher(&shim));
        assert_eq!(native_behind(&shim), Some(native.clone()));

        // Unix: <prefix>/bin/ocr -> ../node_modules/@alibaba-group/open-code-review/bin/ocr.js
        #[cfg(unix)]
        {
            let bin = dir.path().join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::os::unix::fs::symlink(pkg.join("bin").join("ocr.js"), bin.join("ocr")).unwrap();
            assert!(is_launcher(&bin.join("ocr")));
            assert_eq!(native_behind(&bin.join("ocr")).map(|p| std::fs::canonicalize(p).unwrap()), Some(std::fs::canonicalize(&native).unwrap()));
        }
    }

    #[test]
    fn a_native_binary_is_not_mistaken_for_a_launcher() {
        let dir = tempfile::tempdir().unwrap();
        let native = dir.path().join(if cfg!(windows) { "ocr.exe" } else { "ocr" });
        std::fs::write(&native, [0x7f, b'E', b'L', b'F']).unwrap();
        assert!(!is_launcher(&native));
    }

    /// Cancel and quitting Depot both stop the review with OcrRun::stop, and
    /// its grandchildren die with it (the npm launcher case).
    #[cfg(unix)]
    #[test]
    fn stopping_a_review_kills_the_whole_tree() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("grandchild");
        let script = format!("sleep 60 & echo $! > {}; wait", pidfile.display());
        let child = own_group(&mut Command::new("sh")).args(["-c", &script]).spawn().unwrap();
        let run = OcrRun::default();
        *run.0.lock().unwrap() = Some(child);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !pidfile.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let grandchild = std::fs::read_to_string(&pidfile).unwrap().trim().to_string();
        assert!(run.stop());
        assert!(!run.stop(), "nothing left to stop");
        std::thread::sleep(Duration::from_millis(200));
        // A killed process can linger as a zombie when nothing reaps it (as in
        // containers whose PID 1 does not); a zombie is dead for our purposes.
        let state = Command::new("ps").args(["-o", "stat=", "-p", &grandchild]).output().unwrap();
        let state = String::from_utf8_lossy(&state.stdout).trim().to_string();
        assert!(state.is_empty() || state.starts_with('Z'), "grandchild {grandchild} survived: {state}");
    }

    #[test]
    fn maps_an_empty_review() {
        let review = map_review(&json!({"status": "skipped", "comments": []}));
        assert_eq!(review["findings"], json!([]));
    }
}
