// Payload of every bus event, keyed by type. Kept in step with
// src/protocol/events.json (the list Rust validates against) by
// `eventOrigins` below and the test in src/types/events.test.ts.
// Field meanings: docs/PLUGIN_PROTOCOL.md#event-catalogue.

import type { ToolId } from "../design/tokens";

type Severities = { critical: number; high: number; medium: number; low: number };

export interface EventPayloads {
  "depot.session_started": { session: string; depot_version: string };
  "depot.session_continued": { session: string; previous_file: string };
  "depot.session_ended": { session: string; reason: "closed" | "quit" | "workspace_switched" };
  "depot.workspace_opened": { name: string; root: string };
  "depot.panel_opened": { tool: ToolId };
  "depot.plugin_launched": { plugin: string; name: string; pid: number };

  "switchyard.session_started": { session_id: string; name: string; services: string[] };
  "switchyard.session_stopped": { session_id: string; reason: "user" | "failure" };
  "switchyard.service_started": { service_id: string; name: string; pid: number | null; ports: number[] };
  "switchyard.service_ready": { service_id: string; name: string; pid: number | null; ports: number[]; startup_ms: number };
  "switchyard.service_unhealthy": {
    service_id: string;
    name: string;
    pid: number | null;
    ports: number[];
    reason: "exited" | "readiness_timeout" | "port_lost";
    exit_code: number | null;
  };
  "switchyard.service_stopped": { service_id: string; name: string; exit_code: number | null };

  "needle.index_started": { roots: string[]; incremental: boolean };
  "needle.index_complete": { roots: string[]; documents: number; terms: number; scanned: number; duration_ms: number };
  "needle.search_complete": { query: string; result_count: number; duration_ms: number };
  "needle.file_found": { path: string; query: string; score: number };

  "relay.request_sent": { request_id: string; method: string; url: string };
  "relay.response_received": { request_id: string; status: number; elapsed_ms: number; size_bytes: number };
  "relay.request_failed": { request_id: string; error: string };
  "relay.mock_started": { port: number; routes: string[] };
  "relay.mock_stopped": { port: number };

  "pulse.snapshot": { process_count: number; listening: Array<{ pid: number; port: number }> };
  "pulse.port_listening": { pid: number; process_name: string; address: string; port: number; protocol: "tcp" | "udp" };
  "pulse.port_closed": { pid: number; port: number };
  "pulse.process_exited": { pid: number; name: string };

  "blackbox.scan_started": { root: string };
  "blackbox.scan_complete": {
    root: string;
    overall_risk: number;
    files: number;
    loc: number;
    findings: Severities & { info: number };
    cycles: number;
  };
  "blackbox.scan_failed": { root: string; error: string };
  "blackbox.review_complete": { root: string; source: "ocr"; status: string; comments: number; by_severity: Severities };

  "forge.run_started": { run_id: string; workflow_id: string; name: string; steps: number };
  "forge.step_started": { run_id: string; step_index: number; step_id: string; type: string; label: string };
  "forge.step_succeeded": { run_id: string; step_index: number; step_id: string; duration_ms: number };
  "forge.step_failed": {
    run_id: string;
    step_index: number;
    step_id: string;
    label: string;
    error: string;
    pid: number | null;
    exit_code: number | null;
  };
  "forge.run_finished": { run_id: string; outcome: "completed" | "failed" | "stopped"; failed_steps: number; duration_ms: number };
}

export type EventType = keyof EventPayloads;

export interface BusEvent<T extends EventType = EventType> {
  id: string;
  type: T;
  source: ToolId | "depot";
  workspace: string;
  ts: string;
  payload: EventPayloads[T];
}

/** Any event, narrowed by `type`. */
export type AnyBusEvent = { [T in EventType]: BusEvent<T> }[EventType];

export type Origin = "core" | "backend" | "frontend";

// Checked against EventType: adding a payload above without an entry here,
// or an entry here without a payload, is a compile error. `as const` keeps
// each origin literal, which FrontendEventType below relies on.
export const eventOrigins = {
  "depot.session_started": "backend",
  "depot.session_continued": "backend",
  "depot.session_ended": "backend",
  "depot.workspace_opened": "backend",
  "depot.panel_opened": "frontend",
  "depot.plugin_launched": "backend",
  "switchyard.session_started": "core",
  "switchyard.session_stopped": "core",
  "switchyard.service_started": "core",
  "switchyard.service_ready": "core",
  "switchyard.service_unhealthy": "core",
  "switchyard.service_stopped": "core",
  "needle.index_started": "core",
  "needle.index_complete": "core",
  "needle.search_complete": "core",
  "needle.file_found": "frontend",
  "relay.request_sent": "core",
  "relay.response_received": "core",
  "relay.request_failed": "core",
  "relay.mock_started": "core",
  "relay.mock_stopped": "core",
  "pulse.snapshot": "core",
  "pulse.port_listening": "core",
  "pulse.port_closed": "core",
  "pulse.process_exited": "core",
  "blackbox.scan_started": "core",
  "blackbox.scan_complete": "core",
  "blackbox.scan_failed": "core",
  "blackbox.review_complete": "backend",
  "forge.run_started": "core",
  "forge.step_started": "core",
  "forge.step_succeeded": "core",
  "forge.step_failed": "core",
  "forge.run_finished": "core",
} as const satisfies Record<EventType, Origin>;

/** Events a panel may publish itself (user actions). */
export type FrontendEventType = {
  [T in EventType]: (typeof eventOrigins)[T] extends "frontend" ? T : never;
}[EventType];
