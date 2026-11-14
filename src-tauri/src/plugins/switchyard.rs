use serde_json::{json, Map, Value};
use tauri::State;

use crate::error::Result;
use crate::state::AppState;

/// The workspace's Switchyard state file, if it overrides Switchyard's default.
fn base(state: &AppState) -> Result<Map<String, Value>> {
    let mut params = Map::new();
    if let Some(path) = state.current()?.tools.switchyard.state_path {
        params.insert("state_path".into(), json!(path));
    }
    Ok(params)
}

#[tauri::command]
pub async fn switchyard_state(state: State<'_, AppState>) -> Result<Value> {
    state.core("switchyard.state", Value::Object(base(&state)?)).await
}

/// Runs Switchyard's preflight first; returns `{started, checks}`.
#[tauri::command]
pub async fn switchyard_start_session(state: State<'_, AppState>, session_id: String) -> Result<Value> {
    let mut params = base(&state)?;
    params.insert("session_id".into(), json!(session_id));
    state.core("switchyard.start_session", Value::Object(params)).await
}

#[tauri::command]
pub async fn switchyard_stop_session(state: State<'_, AppState>, session_id: String) -> Result<Value> {
    state.core("switchyard.stop_session", json!({"session_id": session_id})).await
}

#[tauri::command]
pub async fn switchyard_status(state: State<'_, AppState>) -> Result<Value> {
    state.core("switchyard.status", json!({})).await
}
