// Shapes returned by the tool bridges (src-tauri/src/plugins/*.rs), which
// pass through what depot-core's adapters return (core/depot_core/tools/*.py).

// ── Switchyard
export interface SwitchyardProject {
  id: string;
  name: string;
  path: string;
  tags: string[];
  pinned: boolean;
  notes: string;
}
export interface SwitchyardService {
  id: string;
  project_id: string;
  name: string;
  command: string;
  depends_on: string[];
  ports: number[];
  readiness: string;
}
export interface SwitchyardSession {
  id: string;
  name: string;
  service_ids: string[];
  status: string;
}
export interface SwitchyardState {
  projects: SwitchyardProject[];
  services: SwitchyardService[];
  sessions: SwitchyardSession[];
}
export interface PreflightCheck {
  level: "PASS" | "WARN" | "ERROR";
  name: string;
  detail: string;
  service_id: string | null;
}
export interface SessionStatus {
  session_id: string;
  status: string;
  services: Array<{ id: string; name: string; status: string; pid: number | null }>;
}

// ── Needle
export interface NeedleResult {
  path: string;
  name: string;
  ext: string;
  size: number;
  mtime: number;
  score: number;
  matched_terms: string[];
  snippet: string;
}
export interface NeedleSearch {
  mode: "search" | "browse";
  query?: string;
  results: NeedleResult[];
  suggestions: Record<string, string[]>;
  duration_ms: number;
}
export interface NeedleIndexInfo {
  documents: number;
  terms: number;
  total_size: number;
  roots: string[];
  updated_at: number | string | null;
  /** File count per extension, most common first. */
  by_extension: Record<string, number>;
}

// ── Relay
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
export interface RelayRequest {
  method: HttpMethod;
  url: string;
  params: Record<string, string>;
  headers: Record<string, string>;
  body: string;
}
export interface RelayResponse {
  status: number;
  reason: string;
  headers: Record<string, string>;
  body: string;
  elapsed_ms: number;
  final_url: string;
  size_bytes: number;
}
export type RelaySendResult =
  | { request_id: string; ok: true; response: RelayResponse }
  | { request_id: string; ok: false; error: string };
export interface RelaySavedItem {
  name: string;
  request: RelayRequest;
}
export interface MockRoute {
  path: string;
  status: number;
  body: string;
}
export interface MockServerInfo {
  port: number;
  url: string;
  routes: MockRoute[];
}
export interface RelayHistoryItem {
  request: RelayRequest;
  status: number | null;
  elapsed_ms: number | null;
}

// ── Pulse
export interface PulseConnection {
  pid: number;
  local: string;
  remote: string;
  state: string;
  protocol: string;
}
export interface PulseProcess {
  pid: number;
  ppid: number;
  name: string;
  memory_bytes: number;
  cpu_seconds: number;
  path: string;
  command_line: string;
  connections: PulseConnection[];
}
export interface ListeningPort {
  pid: number;
  process_name: string;
  address: string;
  port: number;
  protocol: "tcp";
}
export interface PulseSnapshot {
  processes: PulseProcess[];
  listening: ListeningPort[];
}

// ── BLACKBOX
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export interface Finding {
  severity: Severity;
  type: string;
  title: string;
  file: string;
  line: number | null;
  end_line?: number | null;
  detail: string;
  suggestion?: string | null;
  source: "blackbox" | "ocr";
}
export interface Hotspot {
  path: string;
  language: string;
  loc: number;
  complexity: number;
  git_touches: number;
  inbound: number;
  todo_count: number;
  risk: number;
}
export interface BlackboxReport {
  root: string;
  project: string;
  generated_at: string;
  summary: { files: number; source_files: number; loc: number; languages: number; findings: number; cycles: number; overall_risk: number };
  by_severity: Record<Severity, number>;
  languages: Array<{ name: string; files: number }>;
  frameworks: string[];
  hotspots: Hotspot[];
  findings: Finding[];
}
export interface OcrStatus {
  available: boolean;
  path: string | null;
  version: string | null;
}
export type ReviewTarget =
  | { kind: "working_tree" }
  | { kind: "commit"; commit: string }
  | { kind: "range"; from: string; to: string };
export interface OcrReview {
  status: string;
  warnings: Array<{ message?: string } | string>;
  by_severity: Record<Exclude<Severity, "info">, number>;
  findings: Finding[];
}

// ── Forge
export const STEP_TYPES = ["command", "copy", "move", "mkdir", "write", "delete", "http", "wait", "open"] as const;
export type StepType = (typeof STEP_TYPES)[number];
export interface ForgeStep {
  id?: string;
  type: StepType;
  name: string;
  config: Record<string, string | number | boolean | Record<string, string>>;
  timeout: number;
  continue_on_error: boolean;
}
export interface ForgeWorkflow {
  name: string;
  description: string;
  steps: ForgeStep[];
}

/** A third-party plugin found in ~/.depot/plugins (src-tauri/src/third_party.rs). */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  label: string;
  icon: string;
  color: string;
  folder: string;
  program: string;
  /** Where `program` resolved to; approval is tied to this file and the plugin's folder. */
  executable: string | null;
  args: string[];
  workspace_scoped: boolean;
  enabled: boolean;
  /** Enabled once, but its program or arguments changed since. */
  needs_approval: boolean;
  /** Why the manifest cannot be used. */
  error: string | null;
}
