//! Client for depot-core, the sidecar that runs the tools' Python cores.
//!
//! One process, started on first use. Requests and replies are JSON lines on
//! its stdin/stdout (protocol in core/README.md). A reader thread matches
//! replies to waiting requests by id and passes everything else — bus events
//! and UI streams — to `on_message`. If the process dies, waiting requests
//! fail with a `core` error and the next request starts a fresh one.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::error::{DepotError, ErrorKind, Result};

/// A message from depot-core that is not a reply.
#[derive(Debug, Clone, PartialEq)]
pub enum CoreMessage {
    /// `{"event": type, "payload": {...}, "workspace": name}` — goes onto the bus.
    /// `workspace` is the one the causing request was made in, if any.
    Event { event_type: String, payload: Value, workspace: Option<String> },
    /// `{"stream": name, "params": {...}}` — UI-only (log lines, progress).
    Stream { name: String, params: Value, workspace: Option<String> },
}

#[derive(Debug, PartialEq)]
enum Line {
    Reply { id: u64, result: std::result::Result<Value, DepotError> },
    Message(CoreMessage),
    Junk,
}

fn error_kind(kind: &str) -> ErrorKind {
    match kind {
        "not_found" => ErrorKind::NotFound,
        "invalid" | "unknown_method" => ErrorKind::Invalid,
        _ => ErrorKind::Core,
    }
}

fn parse_line(line: &str) -> Line {
    let Ok(value) = serde_json::from_str::<Value>(line) else { return Line::Junk };
    if let Some(id) = value.get("id").and_then(Value::as_u64) {
        let result = match value.get("error") {
            Some(err) => Err(DepotError::new(
                error_kind(err.get("kind").and_then(Value::as_str).unwrap_or("failed")),
                err.get("message").and_then(Value::as_str).unwrap_or("depot-core failed").to_string(),
            )),
            None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
        };
        return Line::Reply { id, result };
    }
    let workspace = value.get("workspace").and_then(Value::as_str).map(str::to_string);
    if let (Some(t), Some(payload)) = (value.get("event").and_then(Value::as_str), value.get("payload")) {
        return Line::Message(CoreMessage::Event { event_type: t.to_string(), payload: payload.clone(), workspace });
    }
    if let (Some(name), Some(params)) = (value.get("stream").and_then(Value::as_str), value.get("params")) {
        return Line::Message(CoreMessage::Stream { name: name.to_string(), params: params.clone(), workspace });
    }
    Line::Junk
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>>;

struct Running {
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
}

/// How to start depot-core.
#[derive(Debug, Clone)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
}

impl Launch {
    /// 1. `$DEPOT_CORE` — an executable to run instead (testing a packaged sidecar).
    /// 2. Debug builds: `python -m depot_core` from this source tree, always,
    ///    so a stale packaged sidecar left in target/ can never shadow edits.
    /// 3. Release builds: the bundled sidecar next to Depot's own executable.
    pub fn discover() -> Result<Self> {
        if let Some(custom) = std::env::var_os("DEPOT_CORE") {
            return Ok(Self { program: custom.into(), args: vec![], cwd: None });
        }
        if cfg!(debug_assertions) {
            return Ok(Self::from_source());
        }
        let exe_name = if cfg!(windows) { "depot-core.exe" } else { "depot-core" };
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|dir| dir.join(exe_name)))
            .filter(|bundled| bundled.is_file())
            .map(|program| Self { program, args: vec![], cwd: None })
            .ok_or_else(|| DepotError::new(ErrorKind::Unavailable, "depot-core is missing from this installation"))
    }

    /// Run the sidecar from source with the system Python (3.10+).
    pub fn from_source() -> Self {
        let core_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("core");
        let python = std::env::var_os("DEPOT_PYTHON")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "python" } else { "python3" }));
        Self { program: python, args: vec!["-m".into(), "depot_core".into()], cwd: Some(core_dir) }
    }
}

pub struct CoreClient {
    launch: Launch,
    running: Mutex<Option<Running>>,
    next_id: AtomicU64,
    on_message: Arc<dyn Fn(CoreMessage) + Send + Sync>,
}

impl CoreClient {
    pub fn new(launch: Launch, on_message: Arc<dyn Fn(CoreMessage) + Send + Sync>) -> Self {
        Self { launch, running: Mutex::new(None), next_id: AtomicU64::new(1), on_message }
    }

    fn spawn(&self) -> Result<Running> {
        let mut cmd = Command::new(&self.launch.program);
        cmd.args(&self.launch.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(cwd) = &self.launch.cwd {
            cmd.current_dir(cwd);
        }
        cmd.env("PYTHONUNBUFFERED", "1").env("PYTHONIOENCODING", "utf-8");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| {
            DepotError::core(format!("Could not start depot-core ({}): {e}", self.launch.program.display()))
        })?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let pending: Pending = Arc::default();

        let reader_pending = pending.clone();
        let on_message = self.on_message.clone();
        std::thread::Builder::new()
            .name("depot-core-out".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    match parse_line(&line) {
                        Line::Reply { id, result } => {
                            if let Some(tx) = reader_pending.lock().expect("pending lock").remove(&id) {
                                let _ = tx.send(result);
                            }
                        }
                        Line::Message(message) => on_message(message),
                        Line::Junk => eprintln!("depot-core: unexpected output: {line}"),
                    }
                }
                // The process is gone: nobody will answer what is still waiting.
                for (_, tx) in reader_pending.lock().expect("pending lock").drain() {
                    let _ = tx.send(Err(DepotError::core("depot-core stopped before replying")));
                }
            })
            .expect("spawn reader thread");
        std::thread::Builder::new()
            .name("depot-core-err".into())
            .spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
                    eprintln!("depot-core: {line}");
                }
            })
            .expect("spawn stderr thread");
        Ok(Running { child, stdin, pending })
    }

    /// Send one request and wait for its reply.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_in(None, method, params).await
    }

    /// Send one request on behalf of a workspace. Events the request causes,
    /// even long after (a workflow finishing), come back tagged with it.
    pub async fn request_in(&self, workspace: Option<&str>, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.running.lock().expect("core lock");
            let alive = guard.as_mut().is_some_and(|r| matches!(r.child.try_wait(), Ok(None)));
            if !alive {
                *guard = Some(self.spawn()?);
            }
            let running = guard.as_mut().expect("just started");
            running.pending.lock().expect("pending lock").insert(id, tx);
            let mut message = json!({"id": id, "method": method, "params": params});
            if let Some(ws) = workspace {
                message["workspace"] = json!(ws);
            }
            let mut line = serde_json::to_vec(&message)?;
            line.push(b'\n');
            if let Err(err) = running.stdin.write_all(&line).and_then(|()| running.stdin.flush()) {
                running.pending.lock().expect("pending lock").remove(&id);
                *guard = None;
                return Err(DepotError::core(format!("depot-core is not accepting requests: {err}")));
            }
        }
        rx.await.unwrap_or_else(|_| Err(DepotError::core("depot-core stopped before replying")))
    }

    /// Quit cleanly: ask depot-core to stop every workflow and service and
    /// wait for it to confirm (up to `limit`), then close it. Asking first
    /// matters: closing stdin alone gives no way to know when cleanup is done,
    /// and killing depot-core mid-cleanup would leave services running.
    pub fn shutdown_gracefully(&self, limit: std::time::Duration) {
        let alive = self
            .running
            .lock()
            .expect("core lock")
            .as_mut()
            .is_some_and(|r| matches!(r.child.try_wait(), Ok(None)));
        if alive {
            let confirmed = tauri::async_runtime::block_on(async {
                tokio::time::timeout(limit, self.request("core.shutdown", json!({}))).await
            });
            if !matches!(confirmed, Ok(Ok(_))) {
                eprintln!("depot: depot-core did not confirm shutdown within {limit:?}");
            }
        }
        self.shutdown();
    }

    /// Close stdin so depot-core stops its work and exits, then reap it.
    pub fn shutdown(&self) {
        if let Some(mut running) = self.running.lock().expect("core lock").take() {
            drop(running.stdin);
            for _ in 0..50 {
                if matches!(running.child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            let _ = running.child.kill();
            let _ = running.child.wait();
        }
    }
}

impl Drop for CoreClient {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_replies_errors_events_and_streams() {
        assert_eq!(parse_line(r#"{"id": 3, "result": {"a": 1}}"#), Line::Reply { id: 3, result: Ok(json!({"a": 1})) });
        let Line::Reply { result: Err(err), .. } = parse_line(r#"{"id": 4, "error": {"kind": "not_found", "message": "gone"}}"#) else {
            panic!("expected error reply")
        };
        assert_eq!((err.kind, err.message.as_str()), (ErrorKind::NotFound, "gone"));
        assert_eq!(
            parse_line(r#"{"event": "pulse.snapshot", "payload": {"process_count": 1}}"#),
            Line::Message(CoreMessage::Event { event_type: "pulse.snapshot".into(), payload: json!({"process_count": 1}), workspace: None })
        );
        assert_eq!(
            parse_line(r#"{"stream": "forge.log", "params": {"line": "x"}}"#),
            Line::Message(CoreMessage::Stream { name: "forge.log".into(), params: json!({"line": "x"}), workspace: None })
        );
        assert_eq!(
            parse_line(r#"{"event": "needle.index_started", "payload": {}, "workspace": "api"}"#),
            Line::Message(CoreMessage::Event { event_type: "needle.index_started".into(), payload: json!({}), workspace: Some("api".into()) })
        );
        assert_eq!(parse_line("Traceback (most recent call last):"), Line::Junk);
    }

    fn python() -> Option<PathBuf> {
        let name = std::env::var("DEPOT_PYTHON").unwrap_or_else(|_| if cfg!(windows) { "python".into() } else { "python3".into() });
        which::which(name).ok()
    }

    /// Quitting waits until Switchyard's services are really gone (review
    /// finding: a fixed five-second cutoff killed depot-core mid-cleanup).
    #[cfg(unix)]
    #[test]
    fn graceful_shutdown_returns_only_after_services_have_stopped() {
        let Some(py) = python() else {
            eprintln!("skipping: no python");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state.json");
        // Build a Switchyard state with one long-running service, using
        // Switchyard's own code so the file format is always right.
        let vendor = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/switchyard");
        let script = format!(
            "import sys; sys.path.insert(0, {vendor:?})\n\
             import switchyard_core as sy, pathlib\n\
             p = sy.new_project({root:?}, 'demo')\n\
             ss = [sy.new_service(p, f'stubborn{{i}}', {cmd:?}) for i in range(3)]\n\
             se = sy.new_session('dev', [s.id for s in ss]); se.id = 'dev'\n\
             sy.save_state(sy.WorkspaceState(projects=[p], services=ss, sessions=[se]), pathlib.Path({state:?}))\n",
            vendor = vendor.display().to_string(),
            root = dir.path().display().to_string(),
            // Ignores SIGTERM, so Switchyard waits out each service's grace
            // period before killing it: three take longer than the old 5 s cutoff.
            cmd = format!(
                "{} -c 'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'",
                py.display()
            ),
            state = state.display().to_string(),
        );
        assert!(Command::new(&py).args(["-c", &script]).status().unwrap().success());

        let mut launch = Launch::from_source();
        launch.program = py;
        let client = CoreClient::new(launch, Arc::new(|_| {}));
        let params = json!({"session_id": "dev", "state_path": state, "runtime_path": dir.path().join("rt.json")});
        let started = tauri::async_runtime::block_on(client.request("switchyard.start_session", params)).unwrap();
        assert_eq!(started["started"], true, "{started}");
        let mut pids: Vec<String> = Vec::new();
        for _ in 0..150 {
            let status = tauri::async_runtime::block_on(client.request("switchyard.status", json!({}))).unwrap();
            pids = status[0]["services"].as_array().unwrap().iter().filter_map(|s| s["pid"].as_u64()).map(|p| p.to_string()).collect();
            if pids.len() == 3 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert_eq!(pids.len(), 3, "all three services started");
        // Let the Python processes install their SIGTERM handlers.
        std::thread::sleep(std::time::Duration::from_millis(500));

        let started_at = std::time::Instant::now();
        client.shutdown_gracefully(std::time::Duration::from_secs(30));
        assert!(started_at.elapsed() > std::time::Duration::from_secs(5), "this setup should need more than the old cutoff");

        // Each service runs as `sh -c python …` in its own process group led
        // by the shell. Check every member of each group: an orphaned program
        // whose shell already exited is exactly the failure to catch.
        let table = Command::new("ps").args(["-eo", "pgid=,pid=,stat="]).output().unwrap();
        let table = String::from_utf8_lossy(&table.stdout);
        for leader in &pids {
            for row in table.lines() {
                let cols: Vec<&str> = row.split_whitespace().collect();
                if cols.len() == 3 && cols[0] == leader {
                    assert!(cols[2].starts_with('Z'), "process {} of service group {leader} outlived Depot", cols[1]);
                }
            }
        }
    }

    /// End to end against the real sidecar and the pinned tool cores.
    /// Skipped when no Python is available; CI always has one.
    #[tokio::test(flavor = "current_thread")]
    async fn talks_to_the_real_sidecar_and_restarts_it() {
        let Some(py) = python() else {
            eprintln!("skipping: no python");
            return;
        };
        let mut launch = Launch::from_source();
        launch.program = py;
        let seen: Arc<Mutex<Vec<CoreMessage>>> = Arc::default();
        let sink = seen.clone();
        let client = CoreClient::new(launch, Arc::new(move |m| sink.lock().unwrap().push(m)));

        let pong = client.request("core.ping", json!({})).await.unwrap();
        assert!(pong["tools"]["needle"].is_string());

        let err = client.request("nope.nothing", json!({})).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);

        // Kill it behind the client's back: the next request starts a new one.
        client.running.lock().unwrap().as_mut().unwrap().child.kill().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(client.request("core.ping", json!({})).await.is_ok());

        let dir = tempfile::tempdir().unwrap();
        client
            .request("relay.history", json!({"store_dir": dir.path()}))
            .await
            .unwrap();
        client.shutdown();
    }
}
