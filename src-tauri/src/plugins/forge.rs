use std::sync::Arc;

use serde_json::{json, Value};
use tauri::State;

use crate::error::{DepotError, Result};
use crate::state::AppState;

#[tauri::command]
pub async fn forge_list(state: State<'_, AppState>) -> Result<Value> {
    state.core("forge.list", json!({"store_dir": state.tool_dir("forge")?})).await
}

#[tauri::command]
pub async fn forge_save(state: State<'_, AppState>, workflows: Value) -> Result<Value> {
    state.core("forge.save", json!({"store_dir": state.tool_dir("forge")?, "workflows": workflows})).await
}

/// Start the workflow at `index` and return its run id at once. Progress
/// arrives as forge.* bus events and `forge.log` stream lines.
#[tauri::command]
pub async fn forge_run(state: State<'_, AppState>, index: usize) -> Result<String> {
    let workflows = state.core("forge.list", json!({"store_dir": state.tool_dir("forge")?})).await?;
    let workflow = workflows
        .get(index)
        .cloned()
        .ok_or_else(|| DepotError::not_found("That workflow no longer exists"))?;
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let params = json!({"run_id": run_id, "workflow_id": format!("{index}"), "workflow": workflow});
    let core = Arc::clone(&state.core);
    tauri::async_runtime::spawn(async move {
        // Step failures arrive as events; this is only a broken run (bad workflow, core gone).
        if let Err(err) = core.request("forge.run", params).await {
            eprintln!("depot: forge run failed: {err}");
        }
    });
    Ok(run_id)
}

#[tauri::command]
pub async fn forge_stop(state: State<'_, AppState>, run_id: String) -> Result<Value> {
    state.core("forge.stop", json!({"run_id": run_id})).await
}
