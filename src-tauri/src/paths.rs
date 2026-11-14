//! Where Depot keeps its files, and the one way files are written.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{DepotError, Result};

/// `~/.depot`, or `$DEPOT_HOME` when set (tests and portable setups).
pub fn depot_home() -> Result<PathBuf> {
    if let Some(custom) = std::env::var_os("DEPOT_HOME") {
        return Ok(PathBuf::from(custom));
    }
    dirs::home_dir()
        .map(|home| home.join(".depot"))
        .ok_or_else(|| DepotError::not_found("Could not find your home folder"))
}

/// Workspace names become folder names, so they are restricted to a safe
/// slug: lowercase letters, digits and `-`, 1–64 characters, starting with a
/// letter or digit. This is what keeps a name like `../x` out of the file
/// system entirely.
pub fn validate_name(name: &str) -> Result<()> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-');
    if valid {
        Ok(())
    } else {
        Err(DepotError::invalid(
            "Workspace names use lowercase letters, digits and hyphens, up to 64 characters",
        ))
    }
}

pub fn workspaces_dir(home: &Path) -> PathBuf {
    home.join("workspaces")
}

pub fn workspace_dir(home: &Path, name: &str) -> Result<PathBuf> {
    validate_name(name)?;
    Ok(workspaces_dir(home).join(name))
}

/// A folder for one tool's data inside one workspace, e.g. `<ws>/needle`.
pub fn tool_dir(home: &Path, workspace: &str, tool: &str) -> Result<PathBuf> {
    Ok(workspace_dir(home, workspace)?.join(tool))
}

/// Write JSON so that a crash leaves either the old file or the new one,
/// never half of either: write `<file>.tmp`, flush to disk, rename over.
pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut tmp_name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    {
        let mut file = fs::File::create(&tmp)?;
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_slugs_and_rejects_everything_else() {
        for ok in ["api", "api-gateway", "a1", "0-day"] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
        let long = "a".repeat(65);
        for bad in ["", "../x", "a/b", "Api", "-x", "a b", "a.b", "naïve", long.as_str()] {
            assert!(validate_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("c.json");
        write_json_atomic(&path, &serde_json::json!({"v": 1})).unwrap();
        write_json_atomic(&path, &serde_json::json!({"v": 2})).unwrap();
        let read: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(read["v"], 2);
        assert!(!dir.path().join("nested").join("c.json.tmp").exists());
    }
}
