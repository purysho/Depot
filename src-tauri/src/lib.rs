//! Depot's Rust backend.
//!
//! - `workspace` — the workspace context (`~/.depot/workspaces/<name>/context.json`)
//! - `bus` — the typed event bus every tool publishes through
//! - `timeline` — the append-only session log
//! - `core` — the client for depot-core, the sidecar running the tools' Python cores
//! - `plugins` — one bridge per tool
//!
//! Every command the frontend may call is registered below and has a typed
//! wrapper in `src/ipc.ts`.

pub mod bus;
pub mod commands;
pub mod core;
pub mod error;
pub mod paths;
pub mod plugins;
pub mod state;
pub mod timeline;
pub mod workspace;

use std::sync::{Arc, Mutex};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use crate::bus::{Bus, Envelope, Origin, Sink};
use crate::core::{CoreClient, CoreMessage, Launch};
use crate::state::AppState;

pub const BUS_EVENT: &str = "depot://bus";
pub const STREAM_EVENT: &str = "depot://stream";

struct TauriSink(AppHandle);

impl Sink for TauriSink {
    fn deliver(&self, envelope: &Envelope) {
        let _ = self.0.emit(BUS_EVENT, envelope);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let home = paths::depot_home()?;
            let bus = Arc::new(Bus::new(Box::new(TauriSink(handle.clone()))));

            // depot-core's events go onto the bus; its streams go straight to the UI.
            let route_bus = Arc::clone(&bus);
            let route_app = handle.clone();
            let on_message = Arc::new(move |message: CoreMessage| match message {
                CoreMessage::Event { event_type, payload } => {
                    if let Err(err) = route_bus.publish(Origin::Core, &event_type, payload) {
                        eprintln!("depot: dropped event from depot-core: {err}");
                    }
                }
                CoreMessage::Stream { name, params } => {
                    let _ = route_app.emit(STREAM_EVENT, json!({"name": name, "params": params}));
                }
            });
            let launch = Launch::discover().unwrap_or_else(|_| Launch::from_source());
            let core = Arc::new(CoreClient::new(launch, on_message));

            app.manage(AppState { home: home.clone(), workspace: Mutex::new(None), bus, core, ocr: Default::default() });

            // Reopen the last workspace. A missing or broken one just starts empty.
            if let Some(name) = workspace::load_settings(&home).last_workspace {
                let state = handle.state::<AppState>();
                if let Err(err) = commands::open(&handle, &state, &name) {
                    eprintln!("depot: could not reopen workspace {name}: {err}");
                }
            }
            plugins::pulse::start_poller(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            commands::workspace_list,
            commands::workspace_current,
            commands::workspace_create,
            commands::workspace_open,
            commands::workspace_update_tool,
            commands::bus_publish,
            commands::timeline_sessions,
            commands::timeline_read,
            plugins::switchyard::switchyard_state,
            plugins::switchyard::switchyard_start_session,
            plugins::switchyard::switchyard_stop_session,
            plugins::switchyard::switchyard_status,
            plugins::needle::needle_build_index,
            plugins::needle::needle_search,
            plugins::needle::needle_index_info,
            plugins::relay::relay_send,
            plugins::relay::relay_history,
            plugins::pulse::pulse_snapshot,
            plugins::blackbox::blackbox_scan,
            plugins::blackbox::blackbox_last_report,
            plugins::blackbox::ocr_status,
            plugins::blackbox::ocr_review,
            plugins::blackbox::ocr_cancel,
            plugins::forge::forge_list,
            plugins::forge::forge_save,
            plugins::forge::forge_run,
            plugins::forge::forge_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Depot")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let state = app.state::<AppState>();
                state.bus.close_session("quit");
                // Closing depot-core's stdin stops running workflows and sessions.
                state.core.shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn package_and_frontend_versions_agree() {
        // tauri.conf.json takes its version from package.json, so the two
        // manifests must not drift.
        let package: serde_json::Value =
            serde_json::from_str(include_str!("../../package.json")).expect("package.json is valid JSON");
        assert_eq!(package["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(crate::commands::app_version(), env!("CARGO_PKG_VERSION"));
    }
}
