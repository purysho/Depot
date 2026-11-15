use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

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

/// Pick a file with a native dialog opened here in Rust, so the path is the
/// person's choice and never a string the webview supplied.
async fn choose(app: &AppHandle, save_as: Option<String>) -> Result<Option<PathBuf>> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file().add_filter("Forge workflow", &["json"]);
        let picked = match save_as {
            Some(name) => dialog.set_title("Export workflow").set_file_name(name).blocking_save_file(),
            None => dialog.set_title("Import workflow").blocking_pick_file(),
        };
        picked.and_then(|p| p.as_path().map(Path::to_path_buf))
    })
    .await
    .map_err(|e| DepotError::core(e.to_string()))
}

/// Import a `.forge.json` file (standalone Forge's export format). Returns the
/// updated workflow list, or null if the person cancelled.
#[tauri::command]
pub async fn forge_import(app: AppHandle, state: State<'_, AppState>) -> Result<Value> {
    let Some(path) = choose(&app, None).await? else { return Ok(Value::Null) };
    state.core("forge.import", json!({"store_dir": state.tool_dir("forge")?, "path": path})).await
}

/// Export one workflow to a `.forge.json` file standalone Forge can import.
/// Returns null if the person cancelled.
#[tauri::command]
pub async fn forge_export(app: AppHandle, state: State<'_, AppState>, index: usize, name: String) -> Result<Value> {
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let Some(path) = choose(&app, Some(format!("{}.forge.json", safe.trim_matches('-')))).await? else {
        return Ok(Value::Null);
    };
    state.core("forge.export", json!({"store_dir": state.tool_dir("forge")?, "index": index, "path": path})).await
}
