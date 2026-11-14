import { invoke, isTauri } from "@tauri-apps/api/core";

// Typed wrappers around Tauri commands. Every command the frontend calls is
// declared here, next to the Rust signature it mirrors, so the IPC boundary
// lives in one file. See docs/ARCHITECTURE.md, "Rust/React IPC boundary".

/** Rust: `fn app_version() -> String` in src-tauri/src/lib.rs */
export async function appVersion(): Promise<string | null> {
  // Outside the Tauri webview (vite dev in a browser, tests) there is no
  // backend to call.
  if (!isTauri()) return null;
  return invoke<string>("app_version");
}
