import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AnyBusEvent, EventPayloads, FrontendEventType } from "./types/events";
import type {
  BlackboxReport,
  ForgeWorkflow,
  NeedleIndexInfo,
  NeedleSearch,
  OcrReview,
  OcrStatus,
  PreflightCheck,
  PulseSnapshot,
  RelayHistoryItem,
  RelayRequest,
  RelaySendResult,
  ReviewTarget,
  SessionStatus,
  SwitchyardState,
} from "./types/tools";
import type { DepotError, WorkspaceContext, WorkspaceSummary } from "./types/workspace";

// The only file that calls Rust. Each wrapper names the command it mirrors in
// src-tauri/src/{commands.rs,plugins/*.rs}. Rejections are DepotError
// objects ({kind, message}).

const outsideDepot: DepotError = {
  kind: "unavailable",
  message: "This needs the Depot desktop app (it is running in a plain browser).",
};

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(outsideDepot);
  return tauriInvoke<T>(command, args);
}

/** Subscribe to a Tauri event. Outside Depot it never fires. */
export function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(() => undefined);
  return tauriListen<T>(event, (e) => handler(e.payload));
}

export const events = {
  bus: "depot://bus",
  stream: "depot://stream",
  workspaceChanged: "depot://workspace-changed",
  pulse: "depot://pulse",
} as const;

export interface StreamMessage {
  name: string;
  params: Record<string, unknown>;
}

export const ipc = {
  appVersion: () => (isTauri() ? invoke<string>("app_version") : Promise.resolve(null)),

  // workspace (commands.rs)
  workspaceList: () => invoke<WorkspaceSummary[]>("workspace_list"),
  workspaceCurrent: () => invoke<WorkspaceContext | null>("workspace_current"),
  workspaceCreate: (name: string, root: string) => invoke<WorkspaceContext>("workspace_create", { name, root }),
  workspaceOpen: (name: string) => invoke<WorkspaceContext>("workspace_open", { name }),
  workspaceUpdateTool: (tool: string, patch: Record<string, unknown>) =>
    invoke<WorkspaceContext>("workspace_update_tool", { tool, patch }),

  // bus and timeline (commands.rs)
  busPublish: <T extends FrontendEventType>(eventType: T, payload: EventPayloads[T]) =>
    invoke<AnyBusEvent>("bus_publish", { eventType, payload }),
  timelineSessions: () =>
    invoke<{ current: string | null; sessions: Array<{ name: string; bytes: number }> }>("timeline_sessions"),
  timelineRead: (session: string, offset: number, limit: number) =>
    invoke<{ events: AnyBusEvent[]; next_offset: number | null }>("timeline_read", { session, offset, limit }),

  // plugins/switchyard.rs
  switchyardState: () => invoke<SwitchyardState>("switchyard_state"),
  switchyardStartSession: (sessionId: string) =>
    invoke<{ started: boolean; checks: PreflightCheck[] }>("switchyard_start_session", { sessionId }),
  switchyardStopSession: (sessionId: string) => invoke<unknown>("switchyard_stop_session", { sessionId }),
  switchyardStatus: () => invoke<SessionStatus[]>("switchyard_status"),

  // plugins/needle.rs
  needleBuildIndex: () => invoke<{ documents: number; scanned: number; duration_ms: number }>("needle_build_index"),
  needleSearch: (query: string, limit = 50) => invoke<NeedleSearch>("needle_search", { query, limit }),
  needleIndexInfo: () => invoke<NeedleIndexInfo | null>("needle_index_info"),

  // plugins/relay.rs
  relaySend: (request: RelayRequest) => invoke<RelaySendResult>("relay_send", { request }),
  relayHistory: () => invoke<RelayHistoryItem[]>("relay_history"),

  // plugins/pulse.rs
  pulseSnapshot: () => invoke<PulseSnapshot>("pulse_snapshot"),

  // plugins/blackbox.rs
  blackboxScan: () => invoke<BlackboxReport>("blackbox_scan"),
  blackboxLastReport: () => invoke<BlackboxReport | null>("blackbox_last_report"),
  ocrStatus: () => invoke<OcrStatus>("ocr_status"),
  ocrReview: (target: ReviewTarget) => invoke<OcrReview>("ocr_review", { target }),
  ocrCancel: () => invoke<boolean>("ocr_cancel"),

  // plugins/forge.rs
  forgeList: () => invoke<ForgeWorkflow[]>("forge_list"),
  forgeSave: (workflows: ForgeWorkflow[]) => invoke<{ saved: number }>("forge_save", { workflows }),
  forgeRun: (index: number) => invoke<string>("forge_run", { index }),
  forgeStop: (runId: string) => invoke<unknown>("forge_stop", { runId }),
  forgeActive: () => invoke<string[]>("forge_active"),
};

/** Kept for the Settings panel. */
export const appVersion = ipc.appVersion;
