//! Depot's Rust backend.
//!
//! Every command the frontend may call is registered in `run()` and has a
//! typed wrapper in `src/ipc.ts`. The workspace context, event bus and
//! session timeline described in docs/ARCHITECTURE.md are added as modules
//! here (`workspace`, `bus`, `timeline`) in the next build.

/// The version from Cargo.toml, shown in Settings.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![app_version])
        .run(tauri::generate_context!())
        .expect("error while running Depot");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_version_is_the_package_version() {
        assert_eq!(app_version(), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn package_and_frontend_versions_agree() {
        // tauri.conf.json takes its version from package.json, so the two
        // manifests must not drift.
        let package: serde_json::Value =
            serde_json::from_str(include_str!("../../package.json")).expect("package.json is valid JSON");
        assert_eq!(package["version"], env!("CARGO_PKG_VERSION"));
    }
}
