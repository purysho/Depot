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
    /// `{"event": type, "payload": {...}}` — goes onto the bus.
    Event { event_type: String, payload: Value },
    /// `{"stream": name, "params": {...}}` — UI-only (log lines, progress).
    Stream { name: String, params: Value },
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
    if let (Some(t), Some(payload)) = (value.get("event").and_then(Value::as_str), value.get("payload")) {
        return Line::Message(CoreMessage::Event { event_type: t.to_string(), payload: payload.clone() });
    }
    if let (Some(name), Some(params)) = (value.get("stream").and_then(Value::as_str), value.get("params")) {
        return Line::Message(CoreMessage::Stream { name: name.to_string(), params: params.clone() });
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
    /// 1. `$DEPOT_CORE` — an executable to run instead (development, testing).
    /// 2. The bundled sidecar next to Depot's own executable (release builds).
    /// 3. In debug builds only: `python -m depot_core` from this source tree.
    pub fn discover() -> Result<Self> {
        if let Some(custom) = std::env::var_os("DEPOT_CORE") {
            return Ok(Self { program: custom.into(), args: vec![], cwd: None });
        }
        let exe_name = if cfg!(windows) { "depot-core.exe" } else { "depot-core" };
        if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from)) {
            let bundled = dir.join(exe_name);
            if bundled.is_file() {
                return Ok(Self { program: bundled, args: vec![], cwd: None });
            }
        }
        if cfg!(debug_assertions) {
            return Ok(Self::from_source());
        }
        Err(DepotError::new(ErrorKind::Unavailable, "depot-core is missing from this installation"))
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
            let mut line = serde_json::to_vec(&json!({"id": id, "method": method, "params": params}))?;
            line.push(b'\n');
            if let Err(err) = running.stdin.write_all(&line).and_then(|()| running.stdin.flush()) {
                running.pending.lock().expect("pending lock").remove(&id);
                *guard = None;
                return Err(DepotError::core(format!("depot-core is not accepting requests: {err}")));
            }
        }
        rx.await.unwrap_or_else(|_| Err(DepotError::core("depot-core stopped before replying")))
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
            Line::Message(CoreMessage::Event { event_type: "pulse.snapshot".into(), payload: json!({"process_count": 1}) })
        );
        assert_eq!(
            parse_line(r#"{"stream": "forge.log", "params": {"line": "x"}}"#),
            Line::Message(CoreMessage::Stream { name: "forge.log".into(), params: json!({"line": "x"}) })
        );
        assert_eq!(parse_line("Traceback (most recent call last):"), Line::Junk);
    }

    fn python() -> Option<PathBuf> {
        let name = std::env::var("DEPOT_PYTHON").unwrap_or_else(|_| if cfg!(windows) { "python".into() } else { "python3".into() });
        which::which(name).ok()
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
