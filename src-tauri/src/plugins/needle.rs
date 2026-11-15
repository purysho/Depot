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

// ── Opening results ──────────────────────────────────────────────────────

/// File types that run something when opened with the system's default
/// handler: "open" on a `.bat` executes it on Windows, `.command` runs in
/// Terminal on macOS, a `.desktop` file launches a program on Linux.
const RUNS_WHEN_OPENED: &[&str] = &[
    "exe", "msi", "bat", "cmd", "com", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "scr", "lnk", "url",
    "reg", "cpl", "hta", "jar", "app", "command", "tool", "desktop", "sh", "bash", "zsh", "fish", "run", "appimage",
    "py", "pyw", "pl", "rb",
];

/// The path a request named, if it is a file inside one of the workspace's
/// indexed folders. Results come from the index, but the webview could ask
/// for any path, so Rust checks rather than trusting it.
pub fn inside_roots(roots: &[std::path::PathBuf], path: &std::path::Path) -> Result<std::path::PathBuf> {
    let target = std::fs::canonicalize(path).map_err(|_| crate::error::DepotError::not_found(format!("File not found: {}", path.display())))?;
    let inside = roots
        .iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .any(|root| target.starts_with(&root));
    if !inside {
        return Err(crate::error::DepotError::invalid("Only files in this workspace's indexed folders can be opened"));
    }
    Ok(target)
}

pub fn runs_when_opened(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| RUNS_WHEN_OPENED.contains(&e.to_ascii_lowercase().as_str()))
}

/// Open a result with the system's default app. Programs and scripts are
/// refused — reveal them instead.
#[tauri::command]
pub async fn needle_open(app: tauri::AppHandle, state: State<'_, AppState>, path: std::path::PathBuf) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let target = inside_roots(&state.current()?.needle_roots(), &path)?;
    if !target.is_file() {
        return Err(crate::error::DepotError::invalid("Only files can be opened"));
    }
    if runs_when_opened(&target) {
        return Err(crate::error::DepotError::invalid(
            "Depot does not open programs or scripts, because opening one runs it. Use Reveal to see it in its folder.",
        ));
    }
    app.opener()
        .open_path(target.display().to_string(), None::<&str>)
        .map_err(|e| crate::error::DepotError::core(format!("Could not open the file: {e}")))
}

/// Show a result in the system file manager.
#[tauri::command]
pub async fn needle_reveal(app: tauri::AppHandle, state: State<'_, AppState>, path: std::path::PathBuf) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let target = inside_roots(&state.current()?.needle_roots(), &path)?;
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|e| crate::error::DepotError::core(format!("Could not show the file: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_files_inside_indexed_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let inside = root.join("notes.md");
        std::fs::write(&inside, "x").unwrap();
        let outside = dir.path().join("secret.txt");
        std::fs::write(&outside, "x").unwrap();
        let roots = vec![root.clone()];
        assert!(inside_roots(&roots, &inside).is_ok());
        assert!(inside_roots(&roots, &outside).is_err());
        // `..` cannot climb out: the path is resolved first.
        assert!(inside_roots(&roots, &root.join("..").join("secret.txt")).is_err());
        assert!(inside_roots(&roots, &root.join("missing.md")).is_err());
        // A sibling folder whose name merely starts with the root's is outside.
        let sibling = dir.path().join("project-old");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sibling.join("a.md"), "x").unwrap();
        assert!(inside_roots(&roots, &sibling.join("a.md")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(dir.path().join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), root.join("link.txt")).unwrap();
        assert!(inside_roots(std::slice::from_ref(&root), &root.join("link.txt")).is_err());
    }

    #[test]
    fn programs_and_scripts_are_not_opened() {
        for p in ["a.exe", "deploy.BAT", "x.ps1", "run.sh", "App.command", "tool.desktop", "s.py"] {
            assert!(runs_when_opened(std::path::Path::new(p)), "{p}");
        }
        for p in ["notes.md", "README", "config.yaml", "main.rs", "index.html"] {
            assert!(!runs_when_opened(std::path::Path::new(p)), "{p}");
        }
    }
}
