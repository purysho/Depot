//! The session timeline: one JSON Lines file per Depot session, at
//! `~/.depot/workspaces/<name>/sessions/<start>.jsonl`. Each line is one bus
//! envelope. The file is only ever appended to, and each line is flushed as
//! it is written, so a crash costs at most a partial last line, which the
//! reader skips.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;
use serde_json::Value;

use crate::error::{DepotError, Result};

/// A session file is closed and a new one started past this size.
pub const ROTATE_BYTES: u64 = 50 * 1024 * 1024;

pub struct Timeline {
    dir: PathBuf,
    path: PathBuf,
    file: File,
    bytes: u64,
    limit: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SessionFile {
    /// File name, e.g. `2026-11-14T15-04-05Z.jsonl`. Also the id used to read it.
    pub name: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Page {
    pub events: Vec<Value>,
    /// Line number to pass as `offset` for the next page, or `None` at the end.
    pub next_offset: Option<usize>,
}

/// `2026-11-14T15-04-05Z` — no colons, which Windows forbids in file names.
fn stamp() -> String {
    Utc::now().format("%Y-%m-%dT%H-%M-%SZ").to_string()
}

fn new_file(dir: &Path) -> Result<(PathBuf, File)> {
    fs::create_dir_all(dir)?;
    let base = stamp();
    for n in 0..1000 {
        let name = if n == 0 { format!("{base}.jsonl") } else { format!("{base}-{n}.jsonl") };
        let path = dir.join(name);
        // create_new: never append to, or clobber, an existing session.
        match OpenOptions::new().append(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(DepotError::invalid("Too many sessions started in one second"))
}

impl Timeline {
    pub fn open(sessions_dir: &Path) -> Result<Self> {
        Self::open_with_limit(sessions_dir, ROTATE_BYTES)
    }

    pub fn open_with_limit(sessions_dir: &Path, limit: u64) -> Result<Self> {
        let (path, file) = new_file(sessions_dir)?;
        Ok(Self { dir: sessions_dir.to_path_buf(), path, file, bytes: 0, limit })
    }

    pub fn file_name(&self) -> String {
        self.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    }

    /// Append one envelope. When the file passes the size limit, a new file
    /// is started and its first line links back to the old one.
    pub fn append(&mut self, envelope: &Value) -> Result<()> {
        if self.bytes >= self.limit {
            let previous = self.file_name();
            let (path, file) = new_file(&self.dir)?;
            self.path = path;
            self.file = file;
            self.bytes = 0;
            let link = serde_json::json!({
                "type": "depot.session_continued",
                "source": "depot",
                "workspace": envelope.get("workspace"),
                "ts": Utc::now().to_rfc3339(),
                "id": uuid::Uuid::now_v7().to_string(),
                "payload": {"session": self.file_name(), "previous_file": previous},
            });
            self.write_line(&link)?;
        }
        self.write_line(envelope)
    }

    fn write_line(&mut self, value: &Value) -> Result<()> {
        let mut line = serde_json::to_vec(value)?;
        line.push(b'\n');
        self.file.write_all(&line)?;
        self.file.flush()?;
        self.bytes += line.len() as u64;
        Ok(())
    }
}

pub fn list_sessions(sessions_dir: &Path) -> Result<Vec<SessionFile>> {
    if !sessions_dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(sessions_dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".jsonl") {
            out.push(SessionFile { name, bytes: entry.metadata()?.len() });
        }
    }
    out.sort_by(|a, b| b.name.cmp(&a.name)); // newest first; names sort by time
    Ok(out)
}

/// Read up to `limit` events starting at line `offset`. Lines that do not
/// parse (a crash mid-write) are skipped rather than failing the read.
pub fn read(sessions_dir: &Path, name: &str, offset: usize, limit: usize) -> Result<Page> {
    // The name comes from the frontend: allow a plain file name only.
    if name.contains(['/', '\\']) || name.contains("..") || !name.ends_with(".jsonl") {
        return Err(DepotError::invalid("Not a session file name"));
    }
    let file = File::open(sessions_dir.join(name)).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => DepotError::not_found(format!("No session {name}")),
        _ => e.into(),
    })?;
    let mut events = Vec::new();
    let mut lines = BufReader::new(file).lines().enumerate().skip(offset);
    let mut next_offset = None;
    for (index, line) in lines.by_ref() {
        if events.len() == limit {
            next_offset = Some(index);
            break;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line?) {
            events.push(value);
        }
    }
    Ok(Page { events, next_offset })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope(n: u32) -> Value {
        json!({"id": n.to_string(), "type": "needle.search_complete", "source": "needle", "workspace": "w", "ts": "t", "payload": {"n": n}})
    }

    #[test]
    fn appends_and_pages_through_events() {
        let dir = tempfile::tempdir().unwrap();
        let mut tl = Timeline::open(dir.path()).unwrap();
        for n in 0..5 {
            tl.append(&envelope(n)).unwrap();
        }
        let name = tl.file_name();
        let first = read(dir.path(), &name, 0, 3).unwrap();
        assert_eq!(first.events.len(), 3);
        assert_eq!(first.next_offset, Some(3));
        let rest = read(dir.path(), &name, 3, 3).unwrap();
        assert_eq!(rest.events[1]["payload"]["n"], 4);
        assert_eq!(rest.next_offset, None);
    }

    #[test]
    fn skips_a_partial_last_line_after_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        let mut tl = Timeline::open(dir.path()).unwrap();
        tl.append(&envelope(1)).unwrap();
        let name = tl.file_name();
        drop(tl);
        let mut f = OpenOptions::new().append(true).open(dir.path().join(&name)).unwrap();
        f.write_all(b"{\"id\": \"2\", \"ty").unwrap();
        let page = read(dir.path(), &name, 0, 10).unwrap();
        assert_eq!(page.events.len(), 1);
    }

    #[test]
    fn rotates_and_links_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut tl = Timeline::open_with_limit(dir.path(), 10).unwrap();
        let first = tl.file_name();
        tl.append(&envelope(1)).unwrap();
        tl.append(&envelope(2)).unwrap();
        let second = tl.file_name();
        assert_ne!(first, second);
        let page = read(dir.path(), &second, 0, 10).unwrap();
        assert_eq!(page.events[0]["type"], "depot.session_continued");
        assert_eq!(page.events[0]["payload"]["previous_file"], first);
        assert_eq!(list_sessions(dir.path()).unwrap().len(), 2);
    }

    #[test]
    fn two_sessions_in_one_second_get_distinct_files() {
        let dir = tempfile::tempdir().unwrap();
        let a = Timeline::open(dir.path()).unwrap().file_name();
        let b = Timeline::open(dir.path()).unwrap().file_name();
        assert_ne!(a, b);
    }

    #[test]
    fn refuses_paths_as_session_names() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["../x.jsonl", "a/b.jsonl", "x.json"] {
            assert!(read(dir.path(), bad, 0, 1).is_err(), "{bad}");
        }
    }
}
