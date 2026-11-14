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
