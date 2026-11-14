//! The workspace context: which project you are working on, and each tool's
//! settings for it. Stored at `~/.depot/workspaces/<name>/context.json`.
//!
//! Projects, services and sessions are not duplicated here: they belong to
//! Switchyard, whose state file Depot reads through depot-core.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{DepotError, Result};
use crate::paths;

pub const SCHEMA_VERSION: u32 = 1;
pub const TOOLS: [&str; 6] = ["switchyard", "needle", "relay", "pulse", "blackbox", "forge"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceContext {
    pub schema_version: u32,
    pub name: String,
    pub root: PathBuf,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub tools: ToolSettings,
}

/// One block per tool. Every field has a default, so a context written by an
/// older Depot (missing a newer field) still loads.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ToolSettings {
    pub switchyard: SwitchyardSettings,
    pub needle: NeedleSettings,
    pub relay: RelaySettings,
    pub pulse: PulseSettings,
    pub blackbox: BlackboxSettings,
    pub forge: ForgeSettings,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SwitchyardSettings {
    /// Switchyard's state file. `None` means Switchyard's own default
    /// (`~/.switchyard/state.json`), shared with the standalone app.
    pub state_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NeedleSettings {
    /// Folders to index. Empty means the workspace root.
    pub roots: Vec<PathBuf>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RelaySettings {
    /// Pre-filled when the request URL is empty.
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PulseSettings {
    /// Seconds between snapshots. Collection is expensive on Windows, so not lower than 2.
    pub refresh_seconds: u32,
}

impl Default for PulseSettings {
    fn default() -> Self {
        Self { refresh_seconds: 3 }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BlackboxSettings {
    /// Repository to scan. `None` means the workspace root.
    pub repo: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ForgeSettings {}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkspaceSummary {
    pub name: String,
    pub root: PathBuf,
    pub updated_at: DateTime<Utc>,
}

impl WorkspaceContext {
    pub fn needle_roots(&self) -> Vec<PathBuf> {
        if self.tools.needle.roots.is_empty() {
            vec![self.root.clone()]
        } else {
            self.tools.needle.roots.clone()
        }
    }

    pub fn blackbox_repo(&self) -> PathBuf {
        self.tools.blackbox.repo.clone().unwrap_or_else(|| self.root.clone())
    }
}

fn context_path(home: &Path, name: &str) -> Result<PathBuf> {
    Ok(paths::workspace_dir(home, name)?.join("context.json"))
}

pub fn load(home: &Path, name: &str) -> Result<WorkspaceContext> {
    let path = context_path(home, name)?;
    let text = fs::read_to_string(&path).map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => DepotError::not_found(format!("No workspace named {name}")),
        _ => err.into(),
    })?;
    let raw: Value = serde_json::from_str(&text)
        .map_err(|e| DepotError::invalid(format!("{} is not valid JSON: {e}", path.display())))?;
    let version = raw.get("schema_version").and_then(Value::as_u64).unwrap_or(0);
    if version > u64::from(SCHEMA_VERSION) {
        // Refuse rather than half-read a file written by a newer Depot.
        return Err(DepotError::invalid(format!(
            "Workspace {name} was saved by a newer Depot (schema {version}); update Depot to open it"
        )));
    }
    let mut context: WorkspaceContext = serde_json::from_value(raw)
        .map_err(|e| DepotError::invalid(format!("{} could not be read: {e}", path.display())))?;
    context.schema_version = SCHEMA_VERSION; // older versions are upgraded on the next save
    Ok(context)
}

pub fn save(home: &Path, context: &mut WorkspaceContext) -> Result<()> {
    context.updated_at = Utc::now();
    paths::write_json_atomic(&context_path(home, &context.name)?, context)
}

pub fn create(home: &Path, name: &str, root: &Path) -> Result<WorkspaceContext> {
    paths::validate_name(name)?;
    if !root.is_absolute() {
        return Err(DepotError::invalid("The workspace folder must be an absolute path"));
    }
    if !root.is_dir() {
        return Err(DepotError::not_found(format!("Folder not found: {}", root.display())));
    }
    if context_path(home, name)?.exists() {
        return Err(DepotError::invalid(format!("A workspace named {name} already exists")));
    }
    let now = Utc::now();
    let mut context = WorkspaceContext {
        schema_version: SCHEMA_VERSION,
        name: name.to_string(),
        root: root.to_path_buf(),
        created_at: now,
        updated_at: now,
        tools: ToolSettings::default(),
    };
    save(home, &mut context)?;
    Ok(context)
}

pub fn list(home: &Path) -> Result<Vec<WorkspaceSummary>> {
    let dir = paths::workspaces_dir(home);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if paths::validate_name(&name).is_err() {
            continue;
        }
        // A broken context is skipped in the list; opening it reports why.
        if let Ok(ctx) = load(home, &name) {
            out.push(WorkspaceSummary { name: ctx.name, root: ctx.root, updated_at: ctx.updated_at });
        }
    }
    out.sort_by_key(|w| std::cmp::Reverse(w.updated_at));
    Ok(out)
}

/// Merge `patch` into one tool's block. Only that tool's block can change,
/// and the result must still deserialise, so a wrong type is refused.
pub fn update_tool(home: &Path, name: &str, tool: &str, patch: &Value) -> Result<WorkspaceContext> {
    if !TOOLS.contains(&tool) {
        return Err(DepotError::invalid(format!("Unknown tool {tool}")));
    }
    let Value::Object(patch) = patch else {
        return Err(DepotError::invalid("Settings must be an object"));
    };
    let mut context = load(home, name)?;
    let mut tools = serde_json::to_value(&context.tools)?;
    let block = tools.get_mut(tool).and_then(Value::as_object_mut).expect("every tool has a block");
    for (key, value) in patch {
        if !block.contains_key(key) {
            return Err(DepotError::invalid(format!("{tool} has no setting {key}")));
        }
        block.insert(key.clone(), value.clone());
    }
    context.tools = serde_json::from_value(tools)
        .map_err(|e| DepotError::invalid(format!("Invalid {tool} setting: {e}")))?;
    if context.tools.pulse.refresh_seconds < 2 {
        return Err(DepotError::invalid("Pulse refreshes at most every 2 seconds"));
    }
    save(home, &mut context)?;
    Ok(context)
}

/// Remembers the last workspace so Depot reopens it on launch.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub last_workspace: Option<String>,
}

pub fn load_settings(home: &Path) -> AppSettings {
    fs::read_to_string(home.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_settings(home: &Path, settings: &AppSettings) -> Result<()> {
    paths::write_json_atomic(&home.join("settings.json"), settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("depot");
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();
        (dir, home, root)
    }

    #[test]
    fn create_load_and_list() {
        let (_d, home, root) = setup();
        let created = create(&home, "api", &root).unwrap();
        assert_eq!(load(&home, "api").unwrap(), created);
        assert_eq!(list(&home).unwrap()[0].name, "api");
        assert_eq!(created.needle_roots(), vec![root.clone()]);
        assert_eq!(created.tools.pulse.refresh_seconds, 3);
    }

    #[test]
    fn create_refuses_bad_names_missing_folders_and_duplicates() {
        let (_d, home, root) = setup();
        assert!(create(&home, "../escape", &root).is_err());
        assert!(create(&home, "x", &root.join("missing")).is_err());
        assert!(create(&home, "x", Path::new("relative")).is_err());
        create(&home, "x", &root).unwrap();
        assert!(create(&home, "x", &root).is_err());
    }

    #[test]
    fn update_tool_changes_only_that_block_and_checks_types() {
        let (_d, home, root) = setup();
        create(&home, "api", &root).unwrap();
        let ctx = update_tool(&home, "api", "relay", &json!({"base_url": "http://localhost:8080"})).unwrap();
        assert_eq!(ctx.tools.relay.base_url.as_deref(), Some("http://localhost:8080"));
        assert_eq!(load(&home, "api").unwrap().tools.relay.base_url, ctx.tools.relay.base_url);

        assert!(update_tool(&home, "api", "relay", &json!({"base_url": 5})).is_err());
        assert!(update_tool(&home, "api", "relay", &json!({"unknown": 1})).is_err());
        assert!(update_tool(&home, "api", "nope", &json!({})).is_err());
        assert!(update_tool(&home, "api", "pulse", &json!({"refresh_seconds": 1})).is_err());
    }

    #[test]
    fn refuses_a_context_from_a_newer_depot_and_fills_missing_fields() {
        let (_d, home, root) = setup();
        let dir = paths::workspace_dir(&home, "old").unwrap();
        fs::create_dir_all(&dir).unwrap();
        let base = json!({"name": "old", "root": root, "created_at": Utc::now(), "updated_at": Utc::now()});

        let mut newer = base.clone();
        newer["schema_version"] = json!(99);
        fs::write(dir.join("context.json"), newer.to_string()).unwrap();
        assert!(load(&home, "old").unwrap_err().message.contains("newer Depot"));

        let mut older = base;
        older["schema_version"] = json!(1);
        fs::write(dir.join("context.json"), older.to_string()).unwrap();
        assert_eq!(load(&home, "old").unwrap().tools, ToolSettings::default());
    }

    #[test]
    fn missing_workspace_is_not_found() {
        let (_d, home, _root) = setup();
        assert_eq!(load(&home, "ghost").unwrap_err().kind, crate::error::ErrorKind::NotFound);
    }
}
