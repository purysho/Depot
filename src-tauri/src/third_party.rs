//! Third-party plugins: tools that are not built into Depot.
//!
//! A plugin is a folder in `~/.depot/plugins/` holding a `depot.plugin.json`
//! manifest (docs/PLUGIN_PROTOCOL.md). In this version only **handoff**
//! plugins load: Depot gives the plugin a sidebar entry and a panel, and its
//! button starts the plugin's own program with workspace-aware arguments.
//! Loading a third party's code into Depot's webview would hand it every
//! Depot command, so that is not offered.
//!
//! Safety:
//! - Nothing runs until the person enables the plugin. Enabling records the
//!   exact program and arguments shown at that moment; if the manifest later
//!   changes them, the plugin needs approving again.
//! - The program is started from Rust with an argument list and no shell.
//! - Third-party plugins cannot publish bus events; Depot records each launch
//!   itself (`depot.plugin_launched`).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::error::{DepotError, Result};
use crate::workspace::WorkspaceContext;

pub const MANIFEST: &str = "depot.plugin.json";
const BUILT_IN: [&str; 7] = ["switchyard", "needle", "relay", "pulse", "blackbox", "forge", "depot"];
const PLACEHOLDERS: [&str; 2] = ["{workspace.root}", "{workspace.name}"];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    id: String,
    name: String,
    version: String,
    description: String,
    panel: Panel,
    workspace_scoped: bool,
    #[serde(default)]
    events: Events,
    embed: Embed,
    #[serde(default)]
    handoff: Option<Handoff>,
    min_depot: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Panel {
    icon: String,
    label: String,
    color: String,
    #[serde(default)]
    #[allow(dead_code)] // part of the shared manifest format; unused by handoff plugins
    component: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Events {
    #[serde(default)]
    publishes: Vec<String>,
    #[serde(default)]
    subscribes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Embed {
    mode: String,
    #[serde(default)]
    #[allow(dead_code)] // native mode's bridge; refused for third-party plugins in check()
    bridge: Option<String>,
}

/// What a handoff plugin starts. `app` is the built-in tools' name for their
/// standalone app; a third-party plugin gives `program` instead.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Handoff {
    #[serde(default)]
    #[allow(dead_code)]
    app: Option<String>,
    #[serde(default)]
    program: Option<String>,
    #[serde(default)]
    args: Vec<String>,
}

/// What the person approved when enabling a plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Approval {
    pub program: String,
    pub args: Vec<String>,
}

/// One discovered plugin, valid or not, as shown in Settings and the sidebar.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub label: String,
    pub icon: String,
    pub color: String,
    pub folder: PathBuf,
    pub program: String,
    pub args: Vec<String>,
    pub workspace_scoped: bool,
    pub enabled: bool,
    /// Enabled once, but its program or arguments have changed since.
    pub needs_approval: bool,
    /// Why the manifest cannot be used; the plugin is listed but cannot run.
    pub error: Option<String>,
}

pub fn plugins_dir(home: &Path) -> PathBuf {
    home.join("plugins")
}

/// `^[a-z][a-z0-9_]{1,31}$`, as docs/PLUGIN_PROTOCOL.md specifies.
fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && (2..=32).contains(&id.len())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn valid_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn semver(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.trim().split('.').map(|p| p.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

fn check(manifest: &Manifest, depot_version: &str) -> std::result::Result<(), String> {
    if !valid_id(&manifest.id) {
        return Err("id must be 2–32 lowercase letters, digits or _, starting with a letter".into());
    }
    if BUILT_IN.contains(&manifest.id.as_str()) {
        return Err(format!("id {} belongs to a built-in tool", manifest.id));
    }
    if manifest.name.trim().is_empty() || manifest.name.len() > 40 {
        return Err("name must be 1–40 characters".into());
    }
    if !valid_color(&manifest.panel.color) {
        return Err("panel.color must be a hex colour like #6e7681".into());
    }
    if manifest.embed.mode != "handoff" {
        return Err(format!(
            "embed.mode \"{}\" is not supported for third-party plugins in this version; use \"handoff\"",
            manifest.embed.mode
        ));
    }
    let handoff = manifest.handoff.clone().unwrap_or_default();
    if handoff.program.as_deref().is_none_or(|p| p.trim().is_empty()) {
        return Err("handoff.program is required".into());
    }
    if !manifest.events.publishes.is_empty() || !manifest.events.subscribes.is_empty() {
        return Err("third-party plugins cannot publish or subscribe to events yet; leave events empty".into());
    }
    for arg in &handoff.args {
        let mut rest = arg.as_str();
        while let Some(start) = rest.find('{') {
            let end = rest[start..].find('}').map(|e| start + e + 1).ok_or("unclosed { in handoff.args")?;
            let placeholder = &rest[start..end];
            if !PLACEHOLDERS.contains(&placeholder) {
                return Err(format!("unknown placeholder {placeholder}; use {}", PLACEHOLDERS.join(" or ")));
            }
            rest = &rest[end..];
        }
    }
    match (semver(&manifest.min_depot), semver(depot_version)) {
        (Some(need), Some(have)) if need > have => Err(format!("needs Depot {} or newer", manifest.min_depot)),
        (None, _) => Err("min_depot must be a version like 0.1.0".into()),
        _ => Ok(()),
    }
}

/// Every plugin folder, with each manifest checked. Invalid ones are listed
/// with their error so the person can see why a plugin does not appear.
pub fn discover(home: &Path, approved: &BTreeMap<String, Approval>, depot_version: &str) -> Vec<PluginInfo> {
    let Ok(entries) = fs::read_dir(plugins_dir(home)) else { return Vec::new() };
    let mut folders: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.is_dir()).collect();
    folders.sort();
    let mut seen = std::collections::HashSet::new();
    folders
        .into_iter()
        .map(|folder| {
            let fallback_id = folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let parsed = fs::read_to_string(folder.join(MANIFEST))
                .map_err(|_| format!("no {MANIFEST} in this folder"))
                .and_then(|text| serde_json::from_str::<Manifest>(&text).map_err(|e| format!("{MANIFEST}: {e}")));
            match parsed {
                Err(error) => PluginInfo {
                    id: fallback_id.clone(),
                    name: fallback_id,
                    version: String::new(),
                    description: String::new(),
                    label: String::new(),
                    icon: "Puzzle".into(),
                    color: "#6e7681".into(),
                    folder,
                    program: String::new(),
                    args: Vec::new(),
                    workspace_scoped: false,
                    enabled: false,
                    needs_approval: false,
                    error: Some(error),
                },
                Ok(m) => {
                    let mut error = check(&m, depot_version).err();
                    if error.is_none() && !seen.insert(m.id.clone()) {
                        error = Some(format!("another plugin already uses the id {}", m.id));
                    }
                    let handoff = m.handoff.clone().unwrap_or_default();
                    let program = handoff.program.unwrap_or_default();
                    let current = Approval { program: program.clone(), args: handoff.args.clone() };
                    let approval = approved.get(&m.id);
                    let ok = error.is_none();
                    PluginInfo {
                        enabled: ok && approval == Some(&current),
                        needs_approval: ok && approval.is_some_and(|a| a != &current),
                        id: m.id,
                        name: m.name,
                        version: m.version,
                        description: m.description,
                        label: m.panel.label,
                        icon: m.panel.icon,
                        color: m.panel.color,
                        folder,
                        program,
                        args: handoff.args,
                        workspace_scoped: m.workspace_scoped,
                        error,
                    }
                }
            }
        })
        .collect()
}

/// Expand `{workspace.root}` and `{workspace.name}` in each argument. Each
/// argument stays one argument: nothing is split or passed to a shell.
pub fn expand_args(args: &[String], workspace: Option<&WorkspaceContext>, scoped: bool) -> Result<Vec<String>> {
    let needs_workspace = scoped || args.iter().any(|a| PLACEHOLDERS.iter().any(|p| a.contains(p)));
    let ws = match (needs_workspace, workspace) {
        (true, None) => return Err(DepotError::not_found("Open a workspace first")),
        (_, ws) => ws,
    };
    Ok(args
        .iter()
        .map(|a| match ws {
            Some(ws) => a.replace("{workspace.root}", &ws.root.display().to_string()).replace("{workspace.name}", &ws.name),
            None => a.clone(),
        })
        .collect())
}

/// Where the program is: an absolute path, a path relative to the plugin's
/// folder (`./bin/tool`), or a name looked up on PATH.
pub fn resolve_program(program: &str, folder: &Path) -> Result<PathBuf> {
    let candidate = Path::new(program);
    let path = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else if program.contains('/') || program.contains('\\') {
        folder.join(candidate)
    } else {
        return which::which(program).map_err(|_| DepotError::not_found(format!("{program} is not installed on PATH")));
    };
    if path.is_file() {
        Ok(path)
    } else {
        Err(DepotError::not_found(format!("Program not found: {}", path.display())))
    }
}

/// Start an enabled plugin's program. Returns its PID. The program runs on
/// its own: it is not stopped when Depot quits, as with any app Depot opens.
pub fn launch(plugin: &PluginInfo, workspace: Option<&WorkspaceContext>) -> Result<u32> {
    if let Some(error) = &plugin.error {
        return Err(DepotError::invalid(format!("{} cannot run: {error}", plugin.name)));
    }
    if !plugin.enabled {
        return Err(DepotError::invalid(if plugin.needs_approval {
            format!("{} changed since it was enabled. Review it in Settings and enable it again.", plugin.name)
        } else {
            format!("Enable {} in Settings first.", plugin.name)
        }));
    }
    let program = resolve_program(&plugin.program, &plugin.folder)?;
    let args = expand_args(&plugin.args, workspace, plugin.workspace_scoped)?;
    let cwd = workspace.map(|w| w.root.clone()).unwrap_or_else(|| plugin.folder.clone());
    let mut child = Command::new(&program)
        .args(&args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| DepotError::core(format!("Could not start {}: {e}", program.display())))?;
    let pid = child.id();
    // Reap it when it exits, so it never lingers as a zombie under Depot.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(home: &Path, folder: &str, manifest: serde_json::Value) {
        let dir = plugins_dir(home).join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MANIFEST), manifest.to_string()).unwrap();
    }

    fn manifest(id: &str, program: &str, args: &[&str]) -> serde_json::Value {
        json!({
            "id": id, "name": "Notes", "version": "1.0.0", "description": "Open the notes app.",
            "panel": {"icon": "Notebook", "label": "Notes", "color": "#6e7681"},
            "workspace_scoped": true,
            "embed": {"mode": "handoff"},
            "handoff": {"program": program, "args": args},
            "min_depot": "0.1.0"
        })
    }

    #[test]
    fn valid_plugins_load_disabled_until_approved() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "notes", manifest("notes", "notes-app", &["--dir", "{workspace.root}"]));
        let found = discover(dir.path(), &BTreeMap::new(), "0.1.0");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].error, None);
        assert!(!found[0].enabled);

        let mut approved = BTreeMap::new();
        approved.insert("notes".to_string(), Approval { program: "notes-app".into(), args: vec!["--dir".into(), "{workspace.root}".into()] });
        assert!(discover(dir.path(), &approved, "0.1.0")[0].enabled);
    }

    #[test]
    fn a_changed_program_needs_approving_again() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "notes", manifest("notes", "something-else", &[]));
        let mut approved = BTreeMap::new();
        approved.insert("notes".to_string(), Approval { program: "notes-app".into(), args: vec![] });
        let p = &discover(dir.path(), &approved, "0.1.0")[0];
        assert!(!p.enabled);
        assert!(p.needs_approval);
        assert!(launch(p, None).unwrap_err().message.contains("changed since it was enabled"));
    }

    #[test]
    fn invalid_manifests_are_listed_with_the_reason() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a", manifest("relay", "x", &[]));
        let mut native = manifest("panelplug", "x", &[]);
        native["embed"] = json!({"mode": "native", "bridge": "plugins/x"});
        write(dir.path(), "b", native);
        write(dir.path(), "c", manifest("badargs", "x", &["{home}"]));
        let mut future = manifest("future", "x", &[]);
        future["min_depot"] = json!("9.0.0");
        write(dir.path(), "d", future);
        let mut extra = manifest("extra", "x", &[]);
        extra["surprise"] = json!(true);
        write(dir.path(), "e", extra);
        write(dir.path(), "f", manifest("dupe", "x", &[]));
        write(dir.path(), "g", manifest("dupe", "x", &[]));
        let mut events = manifest("events", "x", &[]);
        events["events"] = json!({"publishes": ["events.done"], "subscribes": []});
        write(dir.path(), "h", events);
        fs::create_dir_all(plugins_dir(dir.path()).join("empty")).unwrap();

        let found = discover(dir.path(), &BTreeMap::new(), "0.1.0");
        let error = |folder: &str| found.iter().find(|p| p.folder.ends_with(folder)).unwrap().error.clone().unwrap_or_default();
        assert!(error("a").contains("built-in"));
        assert!(error("b").contains("not supported"));
        assert!(error("c").contains("unknown placeholder"));
        assert!(error("d").contains("needs Depot 9.0.0"));
        assert!(error("e").contains("unknown field"));
        assert_eq!(error("f"), "");
        assert!(error("g").contains("already uses the id"));
        assert!(error("h").contains("cannot publish"));
        assert!(error("empty").contains("no depot.plugin.json"));
    }

    #[test]
    fn placeholders_expand_to_single_arguments() {
        let ws = WorkspaceContext {
            schema_version: 1,
            name: "api".into(),
            root: PathBuf::from("/work/my api"),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            tools: Default::default(),
        };
        let args = vec!["--root={workspace.root}".to_string(), "{workspace.name}".to_string(), "; rm -rf /".to_string()];
        assert_eq!(expand_args(&args, Some(&ws), false).unwrap(), ["--root=/work/my api", "api", "; rm -rf /"]);
        assert!(expand_args(&args, None, false).is_err());
        assert_eq!(expand_args(&["plain".to_string()], None, false).unwrap(), ["plain"]);
    }

    #[cfg(unix)]
    #[test]
    fn launches_an_enabled_plugin_with_its_arguments_and_no_shell() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("args.txt");
        let folder = plugins_dir(dir.path()).join("echo");
        fs::create_dir_all(folder.join("bin")).unwrap();
        let script = folder.join("bin").join("record");
        fs::write(&script, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\n", out.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        write(dir.path(), "echo", manifest("echo", "./bin/record", &["{workspace.name}", "$(whoami); echo hi"]));
        let mut approved = BTreeMap::new();
        approved.insert("echo".to_string(), Approval { program: "./bin/record".into(), args: vec!["{workspace.name}".into(), "$(whoami); echo hi".into()] });
        let plugin = discover(dir.path(), &approved, "0.1.0").remove(0);
        let ws = WorkspaceContext {
            schema_version: 1,
            name: "api".into(),
            root: dir.path().to_path_buf(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            tools: Default::default(),
        };
        launch(&plugin, Some(&ws)).unwrap();
        for _ in 0..50 {
            if out.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
        // The shell syntax arrives as literal text: it was never run.
        assert_eq!(fs::read_to_string(&out).unwrap(), "api\n$(whoami); echo hi\n");
    }
}
