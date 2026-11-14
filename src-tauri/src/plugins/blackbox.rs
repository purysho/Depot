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

fn find_ocr() -> Option<PathBuf> {
    which::which(if cfg!(windows) { "ocr.exe" } else { "ocr" }).ok()
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
        OcrStatus { available: version.is_some(), path: Some(path), version }
    })
    .await
    .map_err(|e| DepotError::core(e.to_string()))
}

#[tauri::command]
pub async fn ocr_review(app: AppHandle, state: State<'_, AppState>, target: ReviewTarget) -> Result<Value> {
    let ocr = find_ocr()
        .ok_or_else(|| DepotError::new(ErrorKind::Unavailable, "Open Code Review (ocr) is not installed on PATH"))?;
    let repo = state.current()?.blackbox_repo();
    let args = review_args(&repo, &target)?;
    let slot = Arc::clone(&state.ocr.0);
    {
        let mut guard = slot.lock().expect("ocr lock");
        if guard.is_some() {
            return Err(DepotError::new(ErrorKind::Busy, "A review is already running"));
        }
        let mut child = Command::new(&ocr)
            .args(&args)
            .current_dir(&repo)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| DepotError::core(format!("Could not start ocr: {e}")))?;
        let stderr = child.stderr.take().expect("piped");
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
                let _ = app.emit("depot://stream", json!({"name": "blackbox.ocr_progress", "params": {"line": line}}));
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
    state.bus.publish(
        Origin::Backend,
        "blackbox.review_complete",
        json!({
            "root": repo,
            "source": "ocr",
            "status": review["status"],
            "comments": review["findings"].as_array().map_or(0, Vec::len),
            "by_severity": review["by_severity"],
        }),
    )?;
    Ok(review)
}

#[tauri::command]
pub async fn ocr_cancel(state: State<'_, AppState>) -> Result<bool> {
    let child = state.ocr.0.lock().expect("ocr lock").take();
    Ok(match child {
        Some(mut c) => {
            let _ = c.kill();
            let _ = c.wait();
            true
        }
        None => false,
    })
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
    fn maps_an_empty_review() {
        let review = map_review(&json!({"status": "skipped", "comments": []}));
        assert_eq!(review["findings"], json!([]));
    }
}
