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
    let ctx = state.current()?;
    let workflows = state.core("forge.list", json!({"store_dir": state.tool_dir("forge")?})).await?;
    let workflow = workflows
        .get(index)
        .cloned()
        .ok_or_else(|| DepotError::not_found("That workflow no longer exists"))?;
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    // base_dir: commands without a working folder, and relative paths, run in
    // the workspace rather than wherever depot-core was started.
    let params = json!({"run_id": run_id, "workflow_id": format!("{index}"), "workflow": workflow, "base_dir": ctx.root});
    // Check first and wait for the answer, so a problem such as a blank
    // delete path is shown to the person instead of lost in a background task.
    state.core("forge.validate", json!({"workflow": params["workflow"], "base_dir": params["base_dir"]})).await?;
    let core = Arc::clone(&state.core);
    let workspace = ctx.name.clone();
    tauri::async_runtime::spawn(async move {
        // Progress and step failures arrive as events.
        if let Err(err) = core.request_in(Some(&workspace), "forge.run", params).await {
            eprintln!("depot: forge run failed: {err}");
        }
    });
    Ok(run_id)
}

/// Runs still going in depot-core, so a reopened panel can reattach.
#[tauri::command]
pub async fn forge_active(state: State<'_, AppState>) -> Result<Value> {
    state.core("forge.active", json!({})).await
}

#[tauri::command]
pub async fn forge_stop(state: State<'_, AppState>, run_id: String) -> Result<Value> {
    state.core("forge.stop", json!({"run_id": run_id})).await
}
