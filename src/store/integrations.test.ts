import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AnyBusEvent, EventPayloads, EventType } from "../types/events";
import { dispatch } from "./bus";
import { renderHook } from "@testing-library/react";
import { samePath, startIntegrations, subscribersOf, useIntent, useLinks, useNav } from "./integrations";
import { startTimeline, useTimeline } from "./timeline";

let n = 0;
function emit<T extends EventType>(type: T, payload: EventPayloads[T]) {
  const event = { id: String(++n), type, source: type.split(".")[0], workspace: "w", ts: "2026-11-14T10:00:00.000Z", payload };
  dispatch(event as AnyBusEvent);
}

let stop: () => void;
let stopTimeline: () => void;
beforeAll(async () => {
  stop = await startIntegrations();
  stopTimeline = startTimeline();
});
afterAll(() => {
  stop();
  stopTimeline();
});

beforeEach(() => emit("depot.workspace_opened", { name: "w", root: "/w" }));

describe("the five cross-tool integrations", () => {
  it("1. pulse.port_listening → Relay keeps detected ports, newest first, and forgets closed ones", () => {
    emit("pulse.port_listening", { pid: 1, process_name: "node", address: "127.0.0.1", port: 5173, protocol: "tcp" });
    emit("pulse.port_listening", { pid: 2, process_name: "api", address: "*", port: 8080, protocol: "tcp" });
    expect(useLinks.getState().detectedPorts.map((p) => p.port)).toEqual([8080, 5173]);
    emit("pulse.port_closed", { pid: 1, port: 5173 });
    expect(useLinks.getState().detectedPorts.map((p) => p.port)).toEqual([8080]);
    expect(subscribersOf("pulse.port_listening")).toEqual(["relay"]);
  });

  it("2. needle.file_found → Forge keeps recent files without duplicates", () => {
    emit("needle.file_found", { path: "/w/a.sh", query: "deploy", score: 1 });
    emit("needle.file_found", { path: "/w/a.sh", query: "deploy", score: 1 });
    expect(useLinks.getState().foundFiles).toEqual([{ path: "/w/a.sh", query: "deploy" }]);
    expect(subscribersOf("needle.file_found")).toEqual(["forge"]);
  });

  it("3. blackbox.scan_complete → Switchyard risk by repository root", () => {
    emit("blackbox.scan_complete", {
      root: "/w/api",
      overall_risk: 42,
      files: 10,
      loc: 100,
      findings: { critical: 0, high: 1, medium: 0, low: 0, info: 2 },
      cycles: 0,
    });
    expect(useLinks.getState().risk["/w/api"]?.overall_risk).toBe(42);
    expect(samePath("C:\\w\\API\\", "c:/w/api")).toBe(true);
  });

  it("4. forge.step_failed → Pulse filters to the PID, but not for steps without a process", () => {
    emit("forge.step_failed", { run_id: "r", step_index: 0, step_id: "s", label: "copy", error: "x", pid: null, exit_code: null });
    expect(useLinks.getState().pulseFocus).toBeNull();
    emit("forge.step_failed", { run_id: "r", step_index: 1, step_id: "s", label: "build", error: "x", pid: 4242, exit_code: 1 });
    expect(useLinks.getState().pulseFocus).toEqual({ pid: 4242, reason: "Forge step “build” failed" });
  });

  it("5. switchyard.service_unhealthy → Pulse highlight, cleared when the service is ready again", () => {
    emit("switchyard.service_unhealthy", { service_id: "api", name: "api", pid: 9, ports: [8080], reason: "exited", exit_code: 1 });
    expect(useLinks.getState().unhealthy.api?.pid).toBe(9);
    emit("switchyard.service_ready", { service_id: "api", name: "api", pid: 10, ports: [8080], startup_ms: 5 });
    expect(useLinks.getState().unhealthy.api).toBeUndefined();
  });

  it("feeds the status bar and resets when another workspace opens", () => {
    emit("relay.response_received", { request_id: "r", status: 404, elapsed_ms: 3, size_bytes: 1 });
    emit("switchyard.session_started", { session_id: "s", name: "dev", services: [] });
    expect(useLinks.getState().lastRequestStatus).toBe(404);
    expect(useLinks.getState().sessionStartedAt).toBe(Date.parse("2026-11-14T10:00:00.000Z"));
    emit("depot.workspace_opened", { name: "other", root: "/o" });
    expect(useLinks.getState().lastRequestStatus).toBeNull();
  });
});

describe("navigation intents", () => {
  it("hands an intent to its panel once, and only to that panel", () => {
    useNav.getState().go("relay", { tool: "relay", url: "http://127.0.0.1:5173/" });
    const forge = renderHook(() => useIntent("forge"));
    expect(forge.result.current).toBeNull();
    const relay = renderHook(() => useIntent("relay"));
    expect(relay.result.current?.url).toBe("http://127.0.0.1:5173/");
    expect(useNav.getState().intent).toBeNull();
    expect(renderHook(() => useIntent("relay")).result.current).toBeNull();
  });
});

describe("timeline store", () => {
  it("records timeline events, skips live-only ones, and restarts on a new session", () => {
    emit("depot.session_started", { session: "s1.jsonl", depot_version: "0.1.0" });
    emit("pulse.snapshot", { process_count: 1, listening: [] });
    emit("needle.search_complete", { query: "q", result_count: 0, duration_ms: 1 });
    const { session, events } = useTimeline.getState();
    expect(session).toBe("s1.jsonl");
    expect(events.map((e) => e.type)).toEqual(["depot.session_started", "needle.search_complete"]);
  });
});

describe("bus restart", () => {
  it("can start again after being stopped (React development remounts)", async () => {
    const { startBus } = await import("./bus");
    const first = await startBus();
    first();
    const second = startBus();
    expect(await second).not.toBe(first);
  });
});

describe("timeline merging", () => {
  it("ignores an event it already has", () => {
    const e = { id: "dup-1", type: "needle.search_complete", source: "needle", workspace: "w", ts: "t", payload: { query: "q", result_count: 0, duration_ms: 1 } } as AnyBusEvent;
    useTimeline.getState().append(e);
    useTimeline.getState().append(e);
    expect(useTimeline.getState().events.filter((x) => x.id === "dup-1")).toHaveLength(1);
  });
});
