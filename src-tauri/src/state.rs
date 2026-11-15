//! Shared app state, available to every command.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::bus::Bus;
use crate::core::CoreClient;
use crate::error::{DepotError, Result};
use crate::paths;
use crate::plugins::blackbox::OcrRun;
use crate::workspace::WorkspaceContext;

pub struct AppState {
    pub home: PathBuf,
    pub workspace: Mutex<Option<WorkspaceContext>>,
    pub bus: Arc<Bus>,
    pub core: Arc<CoreClient>,
    pub ocr: OcrRun,
}

impl AppState {
    /// The open workspace, or an error the UI can show as "open a workspace first".
    pub fn current(&self) -> Result<WorkspaceContext> {
        self.workspace
            .lock()
            .expect("workspace lock")
            .clone()
            .ok_or_else(|| DepotError::not_found("Open a workspace first"))
    }

    /// `~/.depot/workspaces/<name>/<tool>` for the open workspace.
    pub fn tool_dir(&self, tool: &str) -> Result<PathBuf> {
        paths::tool_dir(&self.home, &self.current()?.name, tool)
    }

    /// Call depot-core on behalf of the open workspace (if any), so events
    /// the call causes are attributed to it even if it finishes after a switch.
    pub async fn core(&self, method: &str, params: Value) -> Result<Value> {
        let workspace = self.workspace.lock().expect("workspace lock").as_ref().map(|c| c.name.clone());
        self.core.request_in(workspace.as_deref(), method, params).await
    }
}
