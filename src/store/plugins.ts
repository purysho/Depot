import { create } from "zustand";
import { ipc } from "../ipc";
import type { PluginInfo } from "../types/tools";

// Third-party plugins found in ~/.depot/plugins (src-tauri/src/third_party.rs).
// Rust discovers, validates and launches them; this store only lists them.

interface PluginStore {
  plugins: PluginInfo[];
  error: string | null;
  load: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
}

const message = (e: unknown) => (e && typeof e === "object" && "message" in e ? String(e.message) : String(e));

export const usePlugins = create<PluginStore>((set) => ({
  plugins: [],
  error: null,
  load: async () => {
    try {
      set({ plugins: await ipc.pluginsList(), error: null });
    } catch (e) {
      set({ error: message(e) });
    }
  },
  setEnabled: async (id, enabled) => {
    try {
      set({ plugins: await ipc.pluginsSetEnabled(id, enabled), error: null });
    } catch (e) {
      set({ error: message(e) });
    }
  },
}));

/** The view id for a plugin's panel. */
export const pluginView = (id: string) => `plugin:${id}` as const;
export type PluginView = ReturnType<typeof pluginView>;
