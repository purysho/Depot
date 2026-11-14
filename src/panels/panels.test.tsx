import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceContext } from "../types/workspace";

// Panels talk to Rust only through src/ipc.ts, so mocking it is enough.
const ipcMock = vi.hoisted(() => ({
  busPublish: vi.fn(() => Promise.resolve({})),
  pulseSnapshot: vi.fn(() => new Promise(() => undefined)),
  needleIndexInfo: vi.fn(() => Promise.resolve({ documents: 2, terms: 9, total_size: 100, roots: ["/w"], updated_at: null })),
  needleSearch: vi.fn(() =>
    Promise.resolve({
      mode: "search",
      results: [{ path: "/w/deploy.sh", name: "deploy.sh", ext: ".sh", size: 1, mtime: 0, score: 3, matched_terms: [], snippet: "" }],
      suggestions: {},
      duration_ms: 1,
    }),
  ),
  forgeList: vi.fn(() => Promise.resolve([{ name: "Release", description: "", steps: [] }])),
  relayHistory: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../ipc", () => ({
  ipc: ipcMock,
  events: { bus: "b", stream: "s", workspaceChanged: "w", pulse: "p" },
  listen: () => Promise.resolve(() => undefined),
}));

import { useLinks, useNav } from "../store/integrations";
import { useWorkspace } from "../store/workspace";
import { mergeFindings } from "./blackbox/BlackboxPanel";
import { ForgePanel } from "./forge/ForgePanel";
import { NeedlePanel } from "./needle/NeedlePanel";
import { PulsePanel, matches, relayUrl, unhealthyFor } from "./pulse/PulsePanel";
import { RelayPanel, parseHeaders } from "./relay/RelayPanel";
import { isInside } from "./switchyard/SwitchyardPanel";
import { slugify } from "./switchyard/WorkspacePicker";

const context: WorkspaceContext = {
  schema_version: 1,
  name: "w",
  root: "/w",
  created_at: "",
  updated_at: "",
  tools: {
    switchyard: { state_path: null },
    needle: { roots: [] },
    relay: { base_url: "http://localhost:9000" },
    pulse: { refresh_seconds: 3 },
    blackbox: { repo: null },
    forge: {},
  },
};

const proc = (pid: number, name: string, extra: Partial<import("../types/tools").PulseProcess> = {}) => ({
  pid,
  ppid: 1,
  name,
  memory_bytes: 1024,
  cpu_seconds: 1,
  path: `/usr/bin/${name}`,
  command_line: `${name} --serve`,
  connections: [],
  ...extra,
});

beforeEach(() => {
  useWorkspace.setState({ context });
  useNav.setState({ view: "switchyard", intent: null });
  useLinks.setState({ snapshot: null, pulseFocus: null, unhealthy: {}, detectedPorts: [], foundFiles: [] });
  vi.clearAllMocks();
});

describe("helpers", () => {
  it("filters processes like standalone Pulse", () => {
    expect(matches(proc(42, "node"), "42")).toBe(true);
    expect(matches(proc(42, "node"), "--serve")).toBe(true);
    expect(matches(proc(42, "node"), "4")).toBe(false); // PID must match exactly
  });

  it("finds an unhealthy service by PID, or by port once the PID is gone", () => {
    const u = { name: "api", reason: "exited", ports: [8080], pid: null, ts: "" };
    expect(unhealthyFor(proc(1, "x"), [8080], { api: u })).toBe(u);
    expect(unhealthyFor(proc(1, "x"), [9090], { api: u })).toBeUndefined();
  });

  it("turns listening addresses into URLs Relay can call", () => {
    expect(relayUrl({ address: "*", port: 5173 })).toBe("http://127.0.0.1:5173/");
    expect(relayUrl({ address: "::1", port: 80 })).toBe("http://[::1]:80/");
  });

  it("parses headers and ignores comments and junk", () => {
    expect(parseHeaders("Accept: a/b\n# x: y\njunk\nX-Url: http://h:1")).toEqual({ Accept: "a/b", "X-Url": "http://h:1" });
  });

  it("merges scan and AI findings, most severe first", () => {
    const f = (severity: string, source: string, file = "a") => ({ severity, source, file, type: "", title: "", line: null, detail: "" }) as never;
    const merged = mergeFindings({ findings: [f("info", "blackbox"), f("high", "blackbox")] } as never, { findings: [f("critical", "ocr")] } as never);
    expect(merged.map((x) => x.severity)).toEqual(["critical", "high", "info"]);
  });

  it("checks folders, not name prefixes", () => {
    expect(isInside("/w/api", "/w")).toBe(true);
    expect(isInside("/w2", "/w")).toBe(false);
    expect(isInside("C:\\W\\Api", "c:/w")).toBe(true);
  });

  it("makes workspace names from folder names", () => {
    expect(slugify("My API (v2)")).toBe("my-api-v2");
  });
});

describe("integration UI", () => {
  it("Pulse offers Open in Relay → on listening ports, and it carries the URL", () => {
    useLinks.setState({
      snapshot: {
        processes: [proc(10, "vite")],
        listening: [{ pid: 10, process_name: "vite", address: "*", port: 5173, protocol: "tcp" }],
      },
    });
    render(<PulsePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Open in Relay →" }));
    expect(useNav.getState()).toMatchObject({ view: "relay", intent: { tool: "relay", url: "http://127.0.0.1:5173/" } });
  });

  it("Relay starts on the URL Pulse handed over, not the base URL", () => {
    useNav.setState({ intent: { tool: "relay", url: "http://127.0.0.1:5173/" } });
    render(<RelayPanel />);
    expect(screen.getByRole("textbox", { name: "URL" })).toHaveValue("http://127.0.0.1:5173/");
  });

  it("Pulse filters to a failed Forge step's PID and says when it has exited", () => {
    useLinks.setState({
      snapshot: { processes: [proc(1, "a"), proc(2, "b")], listening: [] },
      pulseFocus: { pid: 99, reason: "Forge step “build” failed" },
    });
    render(<PulsePanel />);
    expect(screen.getByRole("status")).toHaveTextContent("Showing PID 99 — that process has already exited.");
    expect(screen.getByRole("textbox", { name: "Filter processes" })).toHaveValue("99");
  });

  it("Pulse highlights the process of an unhealthy Switchyard service", () => {
    useLinks.setState({
      snapshot: { processes: [proc(7, "api"), proc(8, "other")], listening: [] },
      unhealthy: { svc: { name: "api", reason: "exited", ports: [], pid: 7, ts: "" } },
    });
    render(<PulsePanel />);
    expect(screen.getAllByText("api: exited")).toHaveLength(1);
  });

  it("Needle publishes file_found on selection and offers Add to workflow →", async () => {
    render(<NeedlePanel />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Search files" }), { target: { value: "deploy" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: /deploy\.sh/ }));
    expect(ipcMock.busPublish).toHaveBeenCalledWith("needle.file_found", { path: "/w/deploy.sh", query: "deploy", score: 3 });
    fireEvent.click(screen.getByRole("button", { name: "Add to workflow →" }));
    expect(useNav.getState().intent).toEqual({ tool: "forge", addPath: "/w/deploy.sh" });
  });

  it("Forge opens the step editor with the path from Needle", async () => {
    useNav.setState({ intent: { tool: "forge", addPath: "/w/deploy.sh" } });
    render(<ForgePanel />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "File, folder or URL" })).toHaveValue("/w/deploy.sh"));
    await act(async () => undefined);
  });

  it("every tool panel asks for a workspace when none is open", () => {
    useWorkspace.setState({ context: null });
    for (const Panel of [PulsePanel, RelayPanel, NeedlePanel, ForgePanel]) {
      const { unmount } = render(<Panel />);
      expect(screen.getByRole("heading", { name: "Open a workspace first" })).toBeInTheDocument();
      unmount();
    }
  });
});
