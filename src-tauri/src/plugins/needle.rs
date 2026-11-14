use serde_json::{json, Value};
use tauri::State;

use crate::error::Result;
use crate::state::AppState;

fn index_path(state: &AppState) -> Result<std::path::PathBuf> {
    Ok(state.tool_dir("needle")?.join("index.json"))
}

/// Build or update the index of the workspace's folders.
#[tauri::command]
pub async fn needle_build_index(state: State<'_, AppState>) -> Result<Value> {
    let ctx = state.current()?;
    let params = json!({"roots": ctx.needle_roots(), "index_path": index_path(&state)?});
    state.core("needle.build_index", params).await
}

#[tauri::command]
pub async fn needle_search(state: State<'_, AppState>, query: String, limit: Option<u32>, ext: Option<String>) -> Result<Value> {
    let params = json!({"index_path": index_path(&state)?, "query": query, "limit": limit.unwrap_or(50), "ext": ext});
    state.core("needle.search", params).await
}

/// Size and age of the workspace's index, or null before the first build.
#[tauri::command]
pub async fn needle_index_info(state: State<'_, AppState>) -> Result<Value> {
    state.core("needle.index_info", json!({"index_path": index_path(&state)?})).await
}
