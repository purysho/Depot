//! Pulse runs all the time while a workspace is open: the status bar shows
//! its process count, and other tools react to the ports it sees open.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::Result;
use crate::state::AppState;

/// Full snapshot pushed to the frontend after every refresh.
pub const SNAPSHOT_EVENT: &str = "depot://pulse";

#[tauri::command]
pub async fn pulse_snapshot(app: AppHandle, state: State<'_, AppState>) -> Result<Value> {
    let snapshot = state.core("pulse.snapshot", json!({})).await?;
    let _ = app.emit(SNAPSHOT_EVENT, &snapshot);
    Ok(snapshot)
}

/// One loop for the life of the app. It sleeps while no workspace is open,
/// and never overlaps itself: the next snapshot starts only after the last
/// one finished, so a slow machine slows Pulse down rather than piling up.
pub fn start_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let state = app.state::<AppState>();
            let interval = match state.current() {
                Ok(ctx) => {
                    let core = Arc::clone(&state.core);
                    match core.request("pulse.snapshot", json!({})).await {
                        Ok(snapshot) => {
                            let _ = app.emit(SNAPSHOT_EVENT, &snapshot);
                        }
                        Err(err) => eprintln!("depot: pulse snapshot failed: {err}"),
                    }
                    u64::from(ctx.tools.pulse.refresh_seconds.max(2))
                }
                Err(_) => 1,
            };
            tokio::time::sleep(Duration::from_secs(interval)).await;
        }
    });
}
