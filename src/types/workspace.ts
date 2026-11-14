// Mirrors src-tauri/src/workspace.rs.

export interface ToolSettings {
  switchyard: { state_path: string | null };
  needle: { roots: string[] };
  relay: { base_url: string | null };
  pulse: { refresh_seconds: number };
  blackbox: { repo: string | null };
  forge: Record<string, never>;
}

export interface WorkspaceContext {
  schema_version: number;
  name: string;
  root: string;
  created_at: string;
  updated_at: string;
  tools: ToolSettings;
}

export interface WorkspaceSummary {
  name: string;
  root: string;
  updated_at: string;
}

/** Errors from Rust commands: src-tauri/src/error.rs. */
export interface DepotError {
  kind: "not_found" | "invalid" | "io" | "core" | "unavailable" | "busy";
  message: string;
}

export function isDepotError(value: unknown): value is DepotError {
  return typeof value === "object" && value !== null && "kind" in value && "message" in value;
}

/** A message for the person, whatever was thrown. */
export function errorMessage(error: unknown): string {
  if (isDepotError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
