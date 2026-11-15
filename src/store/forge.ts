import { create } from "zustand";
import { events, ipc, listen, type StreamMessage } from "../ipc";
import { subscribe } from "./bus";

// The Forge run in progress, kept outside the panel: leaving Forge for
// another tool unmounts the panel, but the run carries on in depot-core and
// must still be stoppable when you come back.

export type StepState = "running" | "done" | "failed" | "stopped";

export interface ForgeRun {
  runId: string;
  /** Which workflow it is running, or null when reattached after a reload. */
  workflowIndex: number | null;
  log: string[];
  steps: Record<number, StepState>;
  failedPid: Record<number, number | null>;
  outcome: "completed" | "failed" | "stopped" | null;
}

interface ForgeStore {
  run: ForgeRun | null;
  begin: (runId: string, workflowIndex: number | null) => void;
  /**
   * Start a workflow. The run is registered before depot-core is asked to
   * start it: a fast workflow can finish before the request returns, and its
   * events must find the run already here.
   */
  start: (workflowIndex: number) => Promise<void>;
  /** After a window reload: pick up a run depot-core is still executing. */
  reattach: () => Promise<void>;
  update: (runId: string, change: (run: ForgeRun) => Partial<ForgeRun>) => void;
}

const LOG_LINES = 500;

// Runs seen finishing, so a forge.active reply that was already out of date
// when it arrived (the run finished while the request was in flight) does
// not bring a finished run back as "running".
const finished = new Set<string>();
const FINISHED_KEPT = 50;
function rememberFinished(runId: string): void {
  finished.add(runId);
  if (finished.size > FINISHED_KEPT) finished.delete(finished.values().next().value as string);
}

export const useForgeRun = create<ForgeStore>((set, get) => ({
  run: null,
  begin: (runId, workflowIndex) => set({ run: { runId, workflowIndex, log: [], steps: {}, failedPid: {}, outcome: null } }),
  start: async (workflowIndex) => {
    const runId = crypto.randomUUID().replaceAll("-", "");
    get().begin(runId, workflowIndex);
    try {
      await ipc.forgeRun(workflowIndex, runId);
    } catch (e) {
      // Refused before it started (a blank path, say): there is no run.
      if (get().run?.runId === runId) set({ run: null });
      throw e;
    }
  },
  reattach: async () => {
    if (get().run) return;
    try {
      const [runId] = await ipc.forgeActive();
      if (runId && !get().run && !finished.has(runId)) get().begin(runId, null);
    } catch {
      // No workspace, or outside Depot.
    }
  },
  update: (runId, change) => {
    const run = get().run;
    if (run && run.runId === runId) set({ run: { ...run, ...change(run) } });
  },
}));

/** Subscribe once for the life of the window. */
export function startForge(): Promise<() => void> {
  const { update } = useForgeRun.getState();
  const offs = [
    subscribe("forge.step_started", ({ payload: p }) => update(p.run_id, (r) => ({ steps: { ...r.steps, [p.step_index]: "running" } }))),
    subscribe("forge.step_succeeded", ({ payload: p }) => update(p.run_id, (r) => ({ steps: { ...r.steps, [p.step_index]: "done" } }))),
    subscribe("forge.step_failed", ({ payload: p }) =>
      update(p.run_id, (r) => ({ steps: { ...r.steps, [p.step_index]: "failed" }, failedPid: { ...r.failedPid, [p.step_index]: p.pid } })),
    ),
    // A step interrupted by Stop gets no event of its own: settle it here.
    subscribe("forge.run_finished", ({ payload: p }) => {
      rememberFinished(p.run_id);
      update(p.run_id, (r) => ({
        outcome: p.outcome,
        steps: Object.fromEntries(Object.entries(r.steps).map(([i, s]) => [i, s === "running" ? "stopped" : s])),
      }));
    }),
    // A run belongs to the workspace it started in; a new workspace starts clean.
    subscribe("depot.workspace_opened", () => useForgeRun.setState({ run: null })),
  ];
  return listen<StreamMessage>(events.stream, (m) => {
    if (m.name !== "forge.log") return;
    update(String(m.params.run_id), (r) => ({ log: [...r.log, String(m.params.line)].slice(-LOG_LINES) }));
  }).then((unlisten) => () => {
    unlisten();
    offs.forEach((off) => off());
  });
}
