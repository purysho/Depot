import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceContext } from "../types/workspace";

// Panels talk to Rust only through src/ipc.ts, so mocking it is enough.
const ipcMock = vi.hoisted(() => ({
  busPublish: vi.fn(() => Promise.resolve({})),
  pulseSnapshot: vi.fn(() => new Promise(() => undefined)),
  needleIndexInfo: vi.fn(() => Promise.resolve({ documents: 2, terms: 9, total_size: 100, roots: ["/w"], updated_at: null, by_extension: { ".sh": 1, ".md": 1 } })),
  needleOpen: vi.fn(() => Promise.reject({ kind: "invalid", message: "Depot does not open programs or scripts, because opening one runs it. Use Reveal to see it in its folder." })),
  needleReveal: vi.fn(() => Promise.resolve()),
  needleSearch: vi.fn(() =>
    Promise.resolve({
      mode: "search",
      results: [{ path: "/w/deploy.sh", name: "deploy.sh", ext: ".sh", size: 1, mtime: 0, score: 3, matched_terms: [], snippet: "" }],
      suggestions: {},
      duration_ms: 1,
    }),
  ),
  forgeList: vi.fn(() => Promise.resolve([{ name: "Release", description: "", steps: [] }])),
  forgeActive: vi.fn(() => Promise.resolve([])),
  forgeSave: vi.fn(() => Promise.resolve({ saved: 1 })),
  forgeImport: vi.fn(() => Promise.resolve(null)),
  relayHistory: vi.fn(() => Promise.resolve([])),
  relaySaved: vi.fn(() => Promise.resolve([])),
  relaySave: vi.fn((name: string, request: unknown) => Promise.resolve([{ name, request }])),
  relaySend: vi.fn(() => Promise.resolve({ request_id: "r", ok: true, response: { status: 200, reason: "OK", headers: {}, body: "{}", elapsed_ms: 3, final_url: "", size_bytes: 2 } })),
  relayMockList: vi.fn(() => Promise.resolve([])),
  pluginsList: vi.fn(() => Promise.resolve([] as unknown[])),
  pluginsSetEnabled: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  pluginsLaunch: vi.fn(() => Promise.resolve(4242)),
  relayMockStart: vi.fn(() => Promise.resolve({ port: 49152, url: "http://127.0.0.1:49152", routes: [{ path: "/ping", status: 200, body: "{}" }] })),
}));
vi.mock("../ipc", () => ({
  ipc: ipcMock,
  events: { bus: "b", stream: "s", workspaceChanged: "w", pulse: "p" },
  listen: () => Promise.resolve(() => undefined),
}));

import { useLinks, useNav } from "../store/integrations";
import { useWorkspace } from "../store/workspace";
import { mergeFindings } from "./blackbox/BlackboxPanel";
import { useForgeRun } from "../store/forge";
import { ForgePanel, missingFields } from "./forge/ForgePanel";
import { NeedlePanel } from "./needle/NeedlePanel";
import { PulsePanel, matches, relayUrl, unhealthyFor } from "./pulse/PulsePanel";
import { RelayPanel, formatParams, parseHeaders, parseParams } from "./relay/RelayPanel";
import { isInside } from "./switchyard/SwitchyardPanel";
import { slugify } from "./switchyard/WorkspacePicker";
import { usePlugins } from "../store/plugins";
import { PluginPanel, commandLine } from "./plugins/PluginPanel";
import { PluginSettings } from "./plugins/PluginSettings";
import type { PluginInfo } from "../types/tools";

const notes: PluginInfo = {
  id: "notes",
  name: "Notes",
  version: "1.0.0",
  description: "Open the notes app on this project.",
  label: "Notes",
  icon: "Notebook",
  color: "#6e7681",
  folder: "/home/me/.depot/plugins/notes",
  program: "notes-app",
  args: ["--dir", "{workspace.root}", "two words"],
  workspace_scoped: true,
  enabled: false,
  needs_approval: false,
  error: null,
};

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

  it("parses query parameters like standalone Relay", () => {
    expect(parseParams("page=1\n# no\nredirect=https://x:1/a\ntime: 10:30")).toEqual({ page: "1", redirect: "https://x:1/a", time: "10:30" });
    expect(parseParams(formatParams({ a: "1", b: "x=y" }))).toEqual({ a: "1", b: "x=y" });
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

  it("Relay sends query parameters and saves the request", async () => {
    render(<RelayPanel />);
    fireEvent.change(screen.getByRole("textbox", { name: "URL" }), { target: { value: "http://localhost:9000/items" } });
    fireEvent.change(screen.getByLabelText("Query parameters"), { target: { value: "page=2" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(ipcMock.relaySend).toHaveBeenCalled());
    expect((ipcMock.relaySend.mock.calls[0] as unknown[])[0]).toMatchObject({ method: "GET", url: "http://localhost:9000/items", params: { page: "2" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Name for the saved request" }), { target: { value: "items" } });
    fireEvent.click(screen.getByRole("button", { name: "Save request" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Saved (1)" })).toHaveAttribute("aria-selected", "true"));
    expect(ipcMock.relaySave).toHaveBeenCalledWith("items", expect.objectContaining({ params: { page: "2" } }));
  });

  it("Relay's mock server fills the URL with its address", async () => {
    render(<RelayPanel />);
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "/ping" } });
    fireEvent.click(screen.getByRole("button", { name: "Start mock server" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "URL" })).toHaveValue("http://127.0.0.1:49152/ping"));
    expect(ipcMock.relayMockStart).toHaveBeenCalledWith(0, [{ path: "/ping", status: 200, body: '{\n  "ok": true\n}' }]);
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

  it("Needle filters by type and explains when it will not open a script", async () => {
    render(<NeedlePanel />);
    fireEvent.change(await screen.findByRole("combobox", { name: "File type" }), { target: { value: ".sh" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(ipcMock.needleSearch).toHaveBeenCalledWith("", 50, ".sh"));
    fireEvent.click(await screen.findByRole("button", { name: /deploy\.sh/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Use Reveal to see it in its folder.");
    fireEvent.click(screen.getByRole("button", { name: "Reveal in folder" }));
    expect(ipcMock.needleReveal).toHaveBeenCalledWith("/w/deploy.sh");
  });

  it("Forge opens the step editor with the path from Needle", async () => {
    useNav.setState({ intent: { tool: "forge", addPath: "/w/deploy.sh" } });
    render(<ForgePanel />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "File, folder or URL" })).toHaveValue("/w/deploy.sh"));
    await act(async () => undefined);
  });

  it("a running Forge workflow can still be stopped after visiting another tool", async () => {
    ipcMock.forgeList.mockResolvedValueOnce([{ name: "Release", description: "", steps: [{ type: "wait", name: "", config: { seconds: 60 }, timeout: 0, continue_on_error: false }] }] as never);
    useForgeRun.getState().begin("run-1", 0);
    const first = render(<ForgePanel />);
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    first.unmount(); // navigating to another tool
    ipcMock.forgeList.mockResolvedValueOnce([{ name: "Release", description: "", steps: [{ type: "wait", name: "", config: { seconds: 60 }, timeout: 0, continue_on_error: false }] }] as never);
    render(<ForgePanel />);
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    useForgeRun.setState({ run: null });
  });

  it("a step with a blank required path cannot be added", async () => {
    expect(missingFields({ type: "delete", name: "", config: { path: "   " }, timeout: 0, continue_on_error: false })).toEqual(["path"]);
    expect(missingFields({ type: "copy", name: "", config: { source: "/a" }, timeout: 0, continue_on_error: false })).toEqual(["target"]);
    expect(missingFields({ type: "wait", name: "", config: {}, timeout: 0, continue_on_error: false })).toEqual([]);
    useNav.setState({ intent: { tool: "forge", addPath: "" } });
    render(<ForgePanel />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save step" })).toBeDisabled());
  });

  it("Forge moves and edits steps, and saves the result", async () => {
    const step = (command: string) => ({ type: "command", name: "", config: { command }, timeout: 0, continue_on_error: false });
    ipcMock.forgeList.mockResolvedValueOnce([{ name: "Build", description: "", steps: [step("one"), step("two")] }] as never);
    render(<ForgePanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Move step 2 up" }));
    await waitFor(() => expect(ipcMock.forgeSave).toHaveBeenCalled());
    const moved = (ipcMock.forgeSave.mock.calls.at(-1) as unknown as [Array<{ steps: Array<{ config: { command: string } }> }>])[0];
    expect(moved[0]!.steps.map((s) => s.config.command)).toEqual(["two", "one"]);

    fireEvent.click(screen.getByRole("button", { name: "Edit step 1" }));
    const command = screen.getByRole("textbox", { name: "Command" });
    expect(command).toHaveValue("two");
    fireEvent.change(command, { target: { value: "two --fast" } });
    fireEvent.click(screen.getByRole("button", { name: "Save step" }));
    await waitFor(() => {
      const edited = (ipcMock.forgeSave.mock.calls.at(-1) as unknown as [Array<{ steps: Array<{ config: { command: string } }> }>])[0];
      expect(edited[0]!.steps.map((s) => s.config.command)).toEqual(["two --fast", "one"]);
    });
    expect(screen.getByRole("button", { name: "Move step 1 up" })).toBeDisabled();
  });

  it("Forge import adds the workflow and says to read it before running", async () => {
    ipcMock.forgeImport.mockResolvedValueOnce([
      { name: "Release", description: "", steps: [] },
      { name: "Shared", description: "", steps: [] },
    ] as never);
    render(<ForgePanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Import .forge.json…" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Imported “Shared”. Read its steps before running it.");
    expect(screen.getByRole("heading", { name: "Shared" })).toBeInTheDocument();
  });

  it("every tool panel asks for a workspace when none is open", () => {
    useWorkspace.setState({ context: null });
    for (const Panel of [PulsePanel, RelayPanel, NeedlePanel, ForgePanel]) {
      const { unmount } = render(<Panel />);
      expect(screen.getByRole("heading", { name: "Open a workspace first" })).toBeInTheDocument();
      unmount();
    }
  });

  it("a plugin's command is shown exactly, quoted where it has spaces", () => {
    expect(commandLine(notes)).toBe('notes-app --dir {workspace.root} "two words"');
  });

  it("a disabled plugin cannot be launched from its panel", () => {
    usePlugins.setState({ plugins: [notes] });
    render(<PluginPanel id="notes" />);
    expect(screen.queryByRole("button", { name: "Open Notes" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Notes is not enabled");
  });

  it("an enabled plugin launches and reports its pid", async () => {
    usePlugins.setState({ plugins: [{ ...notes, enabled: true }] });
    render(<PluginPanel id="notes" />);
    fireEvent.click(screen.getByRole("button", { name: "Open Notes" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Started Notes · pid 4242");
    expect(ipcMock.pluginsLaunch).toHaveBeenCalledWith("notes");
  });

  it("a plugin whose command changed asks to be reviewed again", () => {
    usePlugins.setState({ plugins: [{ ...notes, needs_approval: true }] });
    render(<PluginPanel id="notes" />);
    expect(screen.getByRole("alert")).toHaveTextContent("changed since you enabled it");
  });

  it("Settings lists plugins, shows load errors, and enables with the command visible", async () => {
    const broken: PluginInfo = { ...notes, id: "broken", name: "broken", folder: "/p/broken", error: "id relay belongs to a built-in tool" };
    ipcMock.pluginsList.mockResolvedValueOnce([notes, broken]);
    ipcMock.pluginsSetEnabled.mockResolvedValueOnce([{ ...notes, enabled: true }, broken]);
    render(<PluginSettings />);
    expect(await screen.findByText('notes-app --dir {workspace.root} "two words"')).toBeInTheDocument();
    expect(screen.getByText("id relay belongs to a built-in tool")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable broken" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enable Notes" }));
    expect(await screen.findByText("Enabled")).toBeInTheDocument();
    expect(ipcMock.pluginsSetEnabled).toHaveBeenCalledWith("notes", true);
  });
});
