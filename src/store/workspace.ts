import { create } from "zustand";
import { events, ipc, listen } from "../ipc";
import type { WorkspaceContext, WorkspaceSummary } from "../types/workspace";
import { errorMessage } from "../types/workspace";
import { initActiveWorkspace } from "./bus";

// A cache of the workspace context Rust owns (context.json). Never written
// to directly: every change goes through Rust, which pushes the new context
// back on `depot://workspace-changed`.

interface WorkspaceStore {
  context: WorkspaceContext | null;
  workspaces: WorkspaceSummary[];
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  open: (name: string) => Promise<void>;
  create: (name: string, root: string) => Promise<void>;
  updateTool: (tool: keyof WorkspaceContext["tools"], patch: Record<string, unknown>) => Promise<void>;
}

export const useWorkspace = create<WorkspaceStore>((set) => {
  const attempt = async (work: () => Promise<unknown>) => {
    set({ error: null });
    try {
      await work();
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    }
  };
  return {
    context: null,
    workspaces: [],
    loaded: false,
    error: null,
    refresh: async () => {
      try {
        const [context, workspaces] = await Promise.all([ipc.workspaceCurrent(), ipc.workspaceList()]);
        initActiveWorkspace(context?.name ?? null);
        set({ context, workspaces, loaded: true });
      } catch {
        set({ loaded: true }); // outside Depot: nothing to load
      }
    },
    open: (name) => attempt(() => ipc.workspaceOpen(name)),
    create: (name, root) =>
      attempt(async () => {
        await ipc.workspaceCreate(name, root);
        set({ workspaces: await ipc.workspaceList() });
      }),
    updateTool: (tool, patch) => attempt(() => ipc.workspaceUpdateTool(tool, patch)),
  };
});

export function startWorkspace(): Promise<() => void> {
  void useWorkspace.getState().refresh();
  return listen<WorkspaceContext>(events.workspaceChanged, (context) => {
    useWorkspace.setState({ context });
    void ipc.workspaceList().then((workspaces) => useWorkspace.setState({ workspaces }), () => undefined);
  });
}
