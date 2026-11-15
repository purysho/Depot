use serde_json::{json, Value};
use tauri::State;

use crate::error::Result;
use crate::state::AppState;

/// Send one request. `request` is `{method, url, params, headers, body}`.
/// A connection failure is a normal result (`ok: false`), not an error.
#[tauri::command]
pub async fn relay_send(state: State<'_, AppState>, request: Value) -> Result<Value> {
    let params = json!({"store_dir": state.tool_dir("relay")?, "request": request});
    state.core("relay.send", params).await
}

#[tauri::command]
pub async fn relay_history(state: State<'_, AppState>) -> Result<Value> {
    state.core("relay.history", json!({"store_dir": state.tool_dir("relay")?})).await
}

#[tauri::command]
pub async fn relay_saved(state: State<'_, AppState>) -> Result<Value> {
    state.core("relay.saved", json!({"store_dir": state.tool_dir("relay")?})).await
}

#[tauri::command]
pub async fn relay_save(state: State<'_, AppState>, name: String, request: Value) -> Result<Value> {
    state.core("relay.save", json!({"store_dir": state.tool_dir("relay")?, "name": name, "request": request})).await
}

#[tauri::command]
pub async fn relay_delete_saved(state: State<'_, AppState>, name: String) -> Result<Value> {
    state.core("relay.delete_saved", json!({"store_dir": state.tool_dir("relay")?, "name": name})).await
}

/// Start Relay's mock server on 127.0.0.1. `routes` is `[{path, status, body}]`;
/// port 0 picks a free port.
#[tauri::command]
pub async fn relay_mock_start(state: State<'_, AppState>, port: u16, routes: Value) -> Result<Value> {
    state.core("relay.mock_start", json!({"port": port, "routes": routes})).await
}

#[tauri::command]
pub async fn relay_mock_stop(state: State<'_, AppState>, port: u16) -> Result<Value> {
    state.core("relay.mock_stop", json!({"port": port})).await
}

#[tauri::command]
pub async fn relay_mock_list(state: State<'_, AppState>) -> Result<Value> {
    state.core("relay.mock_list", json!({})).await
}
