//! Commands for the three shared services: workspace, bus and timeline.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::bus::{Envelope, Origin};
use crate::error::{DepotError, Result};
use crate::paths;
use crate::state::AppState;
use crate::timeline::{self, Page, SessionFile};
use crate::workspace::{self, WorkspaceContext, WorkspaceSummary};

pub const WORKSPACE_EVENT: &str = "depot://workspace-changed";

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn workspace_list(state: State<'_, AppState>) -> Result<Vec<WorkspaceSummary>> {
    workspace::list(&state.home)
}

#[tauri::command]
pub fn workspace_current(state: State<'_, AppState>) -> Option<WorkspaceContext> {
    state.workspace.lock().expect("workspace lock").clone()
}

#[tauri::command]
pub fn workspace_create(app: AppHandle, state: State<'_, AppState>, name: String, root: PathBuf) -> Result<WorkspaceContext> {
    workspace::create(&state.home, &name, &root)?;
    open(&app, &state, &name)
}

#[tauri::command]
pub fn workspace_open(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<WorkspaceContext> {
    open(&app, &state, &name)
}

/// Open a workspace: load its context, start a new timeline session, and
/// tell every panel. Used by the commands above and on launch.
pub fn open(app: &AppHandle, state: &AppState, name: &str) -> Result<WorkspaceContext> {
    let context = workspace::load(&state.home, name)?;
    let sessions = paths::workspace_dir(&state.home, name)?.join("sessions");
    *state.workspace.lock().expect("workspace lock") = Some(context.clone());
    state.bus.open_session(name, &sessions, env!("CARGO_PKG_VERSION"))?;
    state.bus.publish(
        Origin::Backend,
        "depot.workspace_opened",
        serde_json::json!({"name": context.name, "root": context.root}),
    )?;
    let mut settings = workspace::load_settings(&state.home);
    settings.last_workspace = Some(name.to_string());
    workspace::save_settings(&state.home, &settings)?;
    let _ = app.emit(WORKSPACE_EVENT, &context);
    Ok(context)
}

#[tauri::command]
pub fn workspace_update_tool(app: AppHandle, state: State<'_, AppState>, tool: String, patch: Value) -> Result<WorkspaceContext> {
    let name = state.current()?.name;
    let context = workspace::update_tool(&state.home, &name, &tool, &patch)?;
    *state.workspace.lock().expect("workspace lock") = Some(context.clone());
    let _ = app.emit(WORKSPACE_EVENT, &context);
    Ok(context)
}

/// Publish an event on behalf of a panel. Only events the catalogue marks
/// `origin: frontend` (user actions) are accepted.
#[tauri::command]
pub fn bus_publish(state: State<'_, AppState>, event_type: String, payload: Value) -> Result<Envelope> {
    state.bus.publish(Origin::Frontend, &event_type, payload)
}

#[derive(Serialize)]
pub struct Sessions {
    pub current: Option<String>,
    pub sessions: Vec<SessionFile>,
}

fn sessions_dir(state: &AppState) -> Result<PathBuf> {
    Ok(paths::workspace_dir(&state.home, &state.current()?.name)?.join("sessions"))
}

#[tauri::command]
pub fn timeline_sessions(state: State<'_, AppState>) -> Result<Sessions> {
    Ok(Sessions { current: state.bus.session_file(), sessions: timeline::list_sessions(&sessions_dir(&state)?)? })
}

#[tauri::command]
pub fn timeline_read(state: State<'_, AppState>, session: String, offset: usize, limit: usize) -> Result<Page> {
    if limit == 0 || limit > 1000 {
        return Err(DepotError::invalid("limit must be 1 to 1000"));
    }
    timeline::read(&sessions_dir(&state)?, &session, offset, limit)
}

// ── Third-party plugins (third_party.rs) ─────────────────────────────────

#[tauri::command]
pub fn plugins_list(state: State<'_, AppState>) -> Vec<crate::third_party::PluginInfo> {
    let settings = workspace::load_settings(&state.home);
    crate::third_party::discover(&state.home, &settings.approved_plugins, env!("CARGO_PKG_VERSION"))
}

/// Enable (approving the program and arguments as they are now) or disable.
#[tauri::command]
pub fn plugins_set_enabled(state: State<'_, AppState>, id: String, enabled: bool) -> Result<Vec<crate::third_party::PluginInfo>> {
    let mut settings = workspace::load_settings(&state.home);
    let found = crate::third_party::discover(&state.home, &settings.approved_plugins, env!("CARGO_PKG_VERSION"));
    let plugin = found.iter().find(|p| p.id == id).ok_or_else(|| DepotError::not_found(format!("No plugin {id}")))?;
    if enabled {
        if let Some(error) = &plugin.error {
            return Err(DepotError::invalid(format!("{} cannot be enabled: {error}", plugin.name)));
        }
        settings
            .approved_plugins
            .insert(id, crate::third_party::Approval { program: plugin.program.clone(), args: plugin.args.clone() });
    } else {
        settings.approved_plugins.remove(&id);
    }
    workspace::save_settings(&state.home, &settings)?;
    Ok(crate::third_party::discover(&state.home, &settings.approved_plugins, env!("CARGO_PKG_VERSION")))
}

/// Start an enabled plugin's program and record it in the timeline.
#[tauri::command]
pub fn plugins_launch(state: State<'_, AppState>, id: String) -> Result<u32> {
    let settings = workspace::load_settings(&state.home);
    let found = crate::third_party::discover(&state.home, &settings.approved_plugins, env!("CARGO_PKG_VERSION"));
    let plugin = found.into_iter().find(|p| p.id == id).ok_or_else(|| DepotError::not_found(format!("No plugin {id}")))?;
    let workspace = state.workspace.lock().expect("workspace lock").clone();
    let pid = crate::third_party::launch(&plugin, workspace.as_ref())?;
    state.bus.publish(
        Origin::Backend,
        "depot.plugin_launched",
        serde_json::json!({"plugin": plugin.id, "name": plugin.name, "pid": pid}),
    )?;
    Ok(pid)
}
