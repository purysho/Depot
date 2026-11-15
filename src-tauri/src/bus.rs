//! The event bus. Every event — from depot-core, from Rust, or from a panel —
//! passes through `Bus::publish`, which checks it against the catalogue and
//! the publisher's manifest, stamps it, records it in the session timeline,
//! and hands it to the sink (the Tauri `depot://bus` event in the app).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{DepotError, Result};
use crate::timeline::Timeline;

const CATALOGUE: &str = include_str!("../../src/protocol/events.json");
const MANIFESTS: [&str; 6] = [
    include_str!("../../src/protocol/plugins/switchyard.json"),
    include_str!("../../src/protocol/plugins/needle.json"),
    include_str!("../../src/protocol/plugins/relay.json"),
    include_str!("../../src/protocol/plugins/pulse.json"),
    include_str!("../../src/protocol/plugins/blackbox.json"),
    include_str!("../../src/protocol/plugins/forge.json"),
];

/// Who is publishing. Each event type in the catalogue says which of these
/// may publish it, so a panel cannot forge, say, `forge.step_failed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    /// The depot-core sidecar (tool cores).
    Core,
    /// Depot's own Rust code.
    Backend,
    /// A panel, through the `bus_publish` command. User actions only.
    Frontend,
}

#[derive(Debug, Clone, Deserialize)]
struct EventSpec {
    timeline: bool,
    origin: Origin,
}

#[derive(Deserialize)]
struct Catalogue {
    events: HashMap<String, EventSpec>,
}

#[derive(Deserialize)]
struct Manifest {
    id: String,
    events: ManifestEvents,
}

#[derive(Deserialize)]
struct ManifestEvents {
    publishes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub source: String,
    pub workspace: String,
    pub ts: String,
    pub payload: Value,
}

/// Where delivered events go. In the app this emits a Tauri event; tests collect them.
pub trait Sink: Send + Sync {
    fn deliver(&self, envelope: &Envelope);
}

struct Session {
    workspace: String,
    timeline: Timeline,
}

pub struct Bus {
    events: HashMap<String, EventSpec>,
    publishes: HashMap<String, HashSet<String>>,
    session: Mutex<Option<Session>>,
    /// The last timeline of each workspace that is no longer open. Work started
    /// there can finish after a switch; its events are written here rather
    /// than lost. Lock order: `session`, then `retired`.
    retired: Mutex<HashMap<String, Timeline>>,
    sink: Box<dyn Sink>,
}

impl Bus {
    pub fn new(sink: Box<dyn Sink>) -> Self {
        let catalogue: Catalogue = serde_json::from_str(CATALOGUE).expect("events.json is valid");
        let publishes = MANIFESTS
            .iter()
            .map(|raw| {
                let m: Manifest = serde_json::from_str(raw).expect("plugin manifest is valid");
                (m.id, m.events.publishes.into_iter().collect())
            })
            .collect();
        Self { events: catalogue.events, publishes, session: Mutex::new(None), retired: Mutex::new(HashMap::new()), sink }
    }

    /// Start a timeline for a newly opened workspace, ending any previous one.
    pub fn open_session(&self, workspace: &str, sessions_dir: &Path, depot_version: &str) -> Result<String> {
        self.close_session("workspace_switched");
        let timeline = Timeline::open(sessions_dir)?;
        let name = timeline.file_name();
        // This workspace's late events now go to its new session.
        self.retired.lock().expect("bus lock").remove(workspace);
        *self.session.lock().expect("bus lock") = Some(Session { workspace: workspace.to_string(), timeline });
        self.publish(Origin::Backend, "depot.session_started", serde_json::json!({"session": name, "depot_version": depot_version}))?;
        Ok(name)
    }

    pub fn close_session(&self, reason: &str) {
        let name = self.session.lock().expect("bus lock").as_ref().map(|s| s.timeline.file_name());
        if let Some(name) = name {
            let _ = self.publish(Origin::Backend, "depot.session_ended", serde_json::json!({"session": name, "reason": reason}));
            if let Some(ended) = self.session.lock().expect("bus lock").take() {
                self.retired.lock().expect("bus lock").insert(ended.workspace, ended.timeline);
            }
        }
    }

    pub fn workspace(&self) -> Option<String> {
        self.session.lock().expect("bus lock").as_ref().map(|s| s.workspace.clone())
    }

    pub fn session_file(&self) -> Option<String> {
        self.session.lock().expect("bus lock").as_ref().map(|s| s.timeline.file_name())
    }

    pub fn publish(&self, origin: Origin, event_type: &str, payload: Value) -> Result<Envelope> {
        self.publish_for(origin, event_type, payload, None)
    }

    /// Publish on behalf of a workspace. Work started in workspace A that
    /// finishes after a switch to B is stamped A, written to A's last
    /// timeline (not B's), and ignored by B's panels (the frontend filters by it).
    pub fn publish_for(&self, origin: Origin, event_type: &str, payload: Value, workspace: Option<&str>) -> Result<Envelope> {
        let spec = self
            .events
            .get(event_type)
            .ok_or_else(|| DepotError::invalid(format!("Unknown event type {event_type}")))?;
        if spec.origin != origin {
            return Err(DepotError::invalid(format!("{event_type} cannot be published from here")));
        }
        let (source, _) = event_type.split_once('.').expect("catalogue types are tool.name");
        if source != "depot" && !self.publishes.get(source).is_some_and(|set| set.contains(event_type)) {
            return Err(DepotError::invalid(format!("{source} does not declare {event_type}")));
        }
        if !payload.is_object() {
            return Err(DepotError::invalid("Event payload must be an object"));
        }

        let mut session = self.session.lock().expect("bus lock");
        let envelope = Envelope {
            id: uuid::Uuid::now_v7().to_string(),
            event_type: event_type.to_string(),
            source: source.to_string(),
            workspace: match workspace {
                Some(ws) => ws.to_string(),
                None => session.as_ref().map(|s| s.workspace.clone()).unwrap_or_default(),
            },
            ts: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            payload,
        };
        if spec.timeline {
            let value = serde_json::to_value(&envelope)?;
            // A full disk must not stop the app working: report and carry on.
            let written = match session.as_mut().filter(|s| s.workspace == envelope.workspace) {
                Some(s) => s.timeline.append(&value),
                None => match self.retired.lock().expect("bus lock").get_mut(&envelope.workspace) {
                    Some(timeline) => timeline.append(&value),
                    None => Ok(()),
                },
            };
            if let Err(err) = written {
                eprintln!("depot: could not write timeline: {err}");
            }
        }
        drop(session);
        self.sink.deliver(&envelope);
        Ok(envelope)
    }

    pub fn origin_of(&self, event_type: &str) -> Option<Origin> {
        self.events.get(event_type).map(|s| s.origin)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    #[derive(Default)]
    struct Collect(Mutex<Vec<Envelope>>);
    impl Sink for Arc<Collect> {
        fn deliver(&self, envelope: &Envelope) {
            self.0.lock().unwrap().push(envelope.clone());
        }
    }

    fn bus() -> (Bus, Arc<Collect>) {
        let collect = Arc::new(Collect::default());
        (Bus::new(Box::new(collect.clone())), collect)
    }

    #[test]
    fn stamps_and_delivers_a_valid_event() {
        let (bus, seen) = bus();
        let env = bus.publish(Origin::Core, "needle.search_complete", json!({"query": "x", "result_count": 1, "duration_ms": 2})).unwrap();
        assert_eq!(env.source, "needle");
        assert!(env.ts.ends_with('Z'));
        assert_eq!(seen.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn rejects_unknown_types_wrong_origins_and_non_object_payloads() {
        let (bus, seen) = bus();
        assert!(bus.publish(Origin::Core, "needle.nonsense", json!({})).is_err());
        // A panel may report a user action, but not fake a tool result.
        assert!(bus.publish(Origin::Frontend, "forge.step_failed", json!({})).is_err());
        assert!(bus.publish(Origin::Frontend, "needle.file_found", json!({"path": "/x", "query": "q", "score": 1})).is_ok());
        assert!(bus.publish(Origin::Core, "needle.index_started", json!([1])).is_err());
        assert_eq!(seen.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn records_timeline_events_but_not_live_only_ones() {
        let dir = tempfile::tempdir().unwrap();
        let (bus, _) = bus();
        let file = bus.open_session("api", dir.path(), "0.1.0").unwrap();
        bus.publish(Origin::Core, "pulse.snapshot", json!({"process_count": 3, "listening": []})).unwrap();
        bus.publish(Origin::Core, "pulse.port_listening", json!({"pid": 1, "process_name": "n", "address": "*", "port": 80, "protocol": "tcp"})).unwrap();
        bus.close_session("quit");
        let page = crate::timeline::read(dir.path(), &file, 0, 10).unwrap();
        let types: Vec<_> = page.events.iter().map(|e| e["type"].as_str().unwrap().to_string()).collect();
        assert_eq!(types, ["depot.session_started", "pulse.port_listening", "depot.session_ended"]);
        assert_eq!(page.events[1]["workspace"], "api");
    }

    #[test]
    fn work_from_another_workspace_keeps_its_name_and_stays_out_of_this_timeline() {
        let dir = tempfile::tempdir().unwrap();
        let (bus, seen) = bus();
        let file = bus.open_session("b", dir.path(), "0.1.0").unwrap();
        let env = bus
            .publish_for(Origin::Core, "blackbox.scan_started", json!({"root": "/a"}), Some("a"))
            .unwrap();
        assert_eq!(env.workspace, "a");
        assert_eq!(seen.0.lock().unwrap().last().unwrap().workspace, "a");
        bus.publish_for(Origin::Core, "blackbox.scan_started", json!({"root": "/b"}), Some("b")).unwrap();
        let page = crate::timeline::read(dir.path(), &file, 0, 10).unwrap();
        let roots: Vec<_> = page.events.iter().filter_map(|e| e["payload"]["root"].as_str()).collect();
        assert_eq!(roots, ["/b"]);
    }

    #[test]
    fn work_that_finishes_after_a_switch_is_recorded_in_its_own_workspaces_timeline() {
        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let (bus, _) = bus();
        let a_file = bus.open_session("a", a_dir.path(), "0.1.0").unwrap();
        bus.publish_for(Origin::Core, "blackbox.scan_started", json!({"root": "/a"}), Some("a")).unwrap();
        let b_file = bus.open_session("b", b_dir.path(), "0.1.0").unwrap();
        // A's scan finishes while B is open.
        let done = json!({"root": "/a", "overall_risk": 1, "files": 1, "loc": 1, "findings": {"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0}, "cycles": 0});
        bus.publish_for(Origin::Core, "blackbox.scan_complete", done, Some("a")).unwrap();
        let types = |dir: &Path, file: &str| -> Vec<String> {
            crate::timeline::read(dir, file, 0, 50).unwrap().events.iter().map(|e| e["type"].as_str().unwrap().to_string()).collect()
        };
        assert!(types(a_dir.path(), &a_file).contains(&"blackbox.scan_complete".to_string()));
        assert!(!types(b_dir.path(), &b_file).contains(&"blackbox.scan_complete".to_string()));

        // Reopening A: its late events go to the new session, not the old file.
        let a2 = bus.open_session("a", a_dir.path(), "0.1.0").unwrap();
        bus.publish_for(Origin::Core, "blackbox.scan_started", json!({"root": "/a2"}), Some("a")).unwrap();
        assert!(types(a_dir.path(), &a2).contains(&"blackbox.scan_started".to_string()));
    }

    #[test]
    fn every_manifest_publishes_only_catalogue_events_under_its_own_prefix() {
        let (bus, _) = bus();
        for (tool, types) in &bus.publishes {
            for t in types {
                assert!(t.starts_with(&format!("{tool}.")), "{t}");
                assert!(bus.events.contains_key(t), "{t} missing from events.json");
            }
        }
        assert_eq!(bus.publishes.len(), 6);
    }
}
