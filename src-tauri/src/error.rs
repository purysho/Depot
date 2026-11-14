//! The one error type that crosses the IPC boundary.
//!
//! Serialises to `{ "kind": "not_found", "message": "..." }`, so the frontend
//! can tell "workspace does not exist" from "disk full" without parsing text.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// The thing asked for does not exist.
    NotFound,
    /// The request itself is wrong: bad name, bad path, unknown event type.
    Invalid,
    /// Reading or writing a file failed.
    Io,
    /// A request to depot-core failed or depot-core is not running.
    Core,
    /// An optional external program (such as `ocr`) is not installed.
    Unavailable,
    /// Something is already happening and a second one cannot start.
    Busy,
}

#[derive(Debug, Clone, PartialEq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct DepotError {
    pub kind: ErrorKind,
    pub message: String,
}

impl DepotError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, message)
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Invalid, message)
    }
    pub fn core(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Core, message)
    }
}

impl From<std::io::Error> for DepotError {
    fn from(err: std::io::Error) -> Self {
        Self::new(ErrorKind::Io, err.to_string())
    }
}

impl From<serde_json::Error> for DepotError {
    fn from(err: serde_json::Error) -> Self {
        Self::new(ErrorKind::Invalid, err.to_string())
    }
}

pub type Result<T> = std::result::Result<T, DepotError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_as_kind_and_message() {
        let value = serde_json::to_value(DepotError::not_found("no workspace api")).unwrap();
        assert_eq!(value, serde_json::json!({"kind": "not_found", "message": "no workspace api"}));
    }
}
