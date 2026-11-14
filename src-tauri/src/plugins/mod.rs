//! One bridge per tool. Each is a set of Tauri commands that fill in the
//! open workspace's paths and settings, then call depot-core (or, for
//! BLACKBOX's optional review, the `ocr` program).

pub mod blackbox;
pub mod forge;
pub mod needle;
pub mod pulse;
pub mod relay;
pub mod switchyard;
