import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyBusEvent } from "../types/events";

// A fake Tauri listener that counts how many are active.
const listeners = vi.hoisted(() => ({ active: 0, started: 0 }));
const ipcMock = vi.hoisted(() => ({ forgeRun: vi.fn<(index: number, runId: string) => Promise<string>>(), forgeActive: vi.fn() }));
vi.mock("../ipc", () => ({
  ipc: ipcMock,
  events: { bus: "depot://bus" },
  listen: () => {
    listeners.started += 1;
    listeners.active += 1;
    // Resolve later, as Tauri does, so setup and cleanup can overlap.
    return new Promise((resolve) => setTimeout(() => resolve(() => (listeners.active -= 1)), 5));
  },
}));

import { dispatch, isForActiveWorkspace, isStreamForActiveWorkspace, startBus, subscribe } from "./bus";

const flush = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  listeners.active = 0;
  listeners.started = 0;
});

describe("bus listener ownership", () => {
  it("survives React's development double mount (overlapping setup and cleanup)", async () => {
    // Mount 1 starts, mount 2 starts before mount 1's cleanup runs.
    const first = startBus();
    const second = startBus();
    (await first)(); // mount 1 cleanup
    await flush();
    expect(listeners.started).toBe(1);
    expect(listeners.active).toBe(1); // still listening for mount 2
    (await second)(); // mount 2 cleanup
    await flush();
    expect(listeners.active).toBe(0);
  });

  it("a stop function is idempotent", async () => {
    const a = await startBus();
    const b = await startBus();
    a();
    a();
    await flush();
    expect(listeners.active).toBe(1);
    b();
    await flush();
    expect(listeners.active).toBe(0);
  });
});

const event = (workspace: string, type = "blackbox.scan_started", source = "blackbox") =>
  ({ id: Math.random().toString(), type, source, workspace, ts: "", payload: { root: "/x", name: workspace } }) as unknown as AnyBusEvent;

describe("events from another workspace", () => {
  it("are dropped after a switch, and the switch itself always passes", () => {
    const seen: string[] = [];
    const off = subscribe("blackbox.scan_started", (e) => seen.push(e.workspace));
    dispatch(event("a", "depot.workspace_opened", "depot"));
    dispatch(event("a"));
    dispatch(event("b", "depot.workspace_opened", "depot"));
    dispatch(event("a")); // a scan started in "a" finishing after the switch
    dispatch(event("b"));
    off();
    expect(seen).toEqual(["a", "b"]);
    expect(isForActiveWorkspace(event("anything", "depot.session_started", "depot"))).toBe(true);
  });
});

describe("forge run store", () => {
  it("settles a step interrupted by Stop", async () => {
    const { startForge, useForgeRun } = await import("./forge");
    const stop = await startForge();
    useForgeRun.getState().begin("r1", 0);
    dispatch(event("w", "depot.workspace_opened", "depot"));
    useForgeRun.getState().begin("r1", 0);
    const forge = (type: string, payload: object) =>
      dispatch({ id: Math.random().toString(), type, source: "forge", workspace: "w", ts: "", payload } as unknown as AnyBusEvent);
    forge("forge.step_started", { run_id: "r1", step_index: 0, step_id: "a", type: "wait", label: "wait step 1" });
    forge("forge.run_finished", { run_id: "r1", outcome: "stopped", failed_steps: 0, duration_ms: 5 });
    expect(useForgeRun.getState().run?.steps[0]).toBe("stopped");
    expect(useForgeRun.getState().run?.outcome).toBe("stopped");
    stop();
  });

  it("keeps the outcome of a workflow that finishes before forge_run returns", async () => {
    const { startForge, useForgeRun } = await import("./forge");
    const stop = await startForge();
    dispatch(event("w", "depot.workspace_opened", "depot"));
    // depot-core runs the whole workflow, and its events arrive, before the
    // IPC call that started it has returned.
    ipcMock.forgeRun.mockImplementationOnce(async (_index, runId) => {
      dispatch({ id: "f1", type: "forge.run_finished", source: "forge", workspace: "w", ts: "", payload: { run_id: runId, outcome: "completed", failed_steps: 0, duration_ms: 1 } } as AnyBusEvent);
      return runId;
    });
    await useForgeRun.getState().start(0);
    expect(useForgeRun.getState().run?.outcome).toBe("completed");
    stop();
  });

  it("forgets a run that depot-core refused to start", async () => {
    const { useForgeRun } = await import("./forge");
    ipcMock.forgeRun.mockRejectedValueOnce({ kind: "invalid", message: "path is empty" });
    await expect(useForgeRun.getState().start(0)).rejects.toMatchObject({ kind: "invalid" });
    expect(useForgeRun.getState().run).toBeNull();
  });
});

describe("stream lines", () => {
  it("are shown only in the workspace that produced them", () => {
    dispatch(event("a", "depot.workspace_opened", "depot"));
    expect(isStreamForActiveWorkspace({ workspace: "a" })).toBe(true);
    expect(isStreamForActiveWorkspace({ workspace: "b" })).toBe(false);
    expect(isStreamForActiveWorkspace({})).toBe(true);
  });
});
