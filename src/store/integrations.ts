import { useEffect, useState } from "react";
import { create } from "zustand";
import type { ToolId } from "../design/tokens";
import { events, listen } from "../ipc";
import blackbox from "../protocol/plugins/blackbox.json";
import forge from "../protocol/plugins/forge.json";
import needle from "../protocol/plugins/needle.json";
import pulse from "../protocol/plugins/pulse.json";
import relay from "../protocol/plugins/relay.json";
import switchyard from "../protocol/plugins/switchyard.json";
import type { EventType } from "../types/events";
import type { PulseSnapshot } from "../types/tools";
import { subscribe } from "./bus";
import type { PluginView } from "./plugins";

// The cross-tool layer. Subscriptions are made once at startup, not inside
// panels, so an event lands even when its target panel is not on screen
// (a Forge step can fail while Pulse is hidden).

const manifests = [switchyard, needle, relay, pulse, blackbox, forge];

/** Tools whose manifest subscribes to an event type. */
export function subscribersOf(type: EventType): ToolId[] {
  return manifests.filter((m) => m.events.subscribes.includes(type)).map((m) => m.id as ToolId);
}

// ── Navigation, with an optional "intent" handed to the destination panel.

export type Intent =
  | { tool: "relay"; url: string }
  | { tool: "forge"; addPath: string }
  | { tool: "pulse"; pid: number };

/** A built-in tool, Settings, or a third-party plugin's panel. */
export type View = ToolId | "settings" | PluginView;

interface NavStore {
  view: View;
  intent: Intent | null;
  go: (view: View, intent?: Intent) => void;
  /** Mark the pending intent as handled. */
  clearIntent: () => void;
}

export const useNav = create<NavStore>((set) => ({
  view: "switchyard",
  intent: null,
  go: (view, intent) => set({ view, intent: intent ?? null }),
  clearIntent: () => set({ intent: null }),
}));

/**
 * The pending intent for a tool, read once when its panel mounts (as initial
 * state), then cleared so it is not applied twice.
 */
export function useIntent<T extends Intent["tool"]>(tool: T): Extract<Intent, { tool: T }> | null {
  const [intent] = useState(() => {
    const pending = useNav.getState().intent;
    return pending?.tool === tool ? (pending as Extract<Intent, { tool: T }>) : null;
  });
  const clearIntent = useNav((s) => s.clearIntent);
  useEffect(() => {
    if (intent) clearIntent();
  }, [intent, clearIntent]);
  return intent;
}

// ── State the integrations maintain.

export interface PulseFocus {
  pid: number;
  /** Why Pulse is filtered: shown in the banner. */
  reason: string;
}

export interface Unhealthy {
  name: string;
  reason: string;
  ports: number[];
  pid: number | null;
  ts: string;
}

export interface RiskBadge {
  overall_risk: number;
  findings: { critical: number; high: number; medium: number; low: number; info: number };
  ts: string;
}

interface LinksStore {
  snapshot: PulseSnapshot | null;
  /** forge.step_failed → Pulse filters to this PID. */
  pulseFocus: PulseFocus | null;
  /** switchyard.service_unhealthy → Pulse highlights these, keyed by service id. */
  unhealthy: Record<string, Unhealthy>;
  /** pulse.port_listening → Relay offers these as quick targets. */
  detectedPorts: Array<{ pid: number; process_name: string; address: string; port: number }>;
  /** needle.file_found → Forge offers these when adding a step. */
  foundFiles: Array<{ path: string; query: string }>;
  /** blackbox.scan_complete → Switchyard shows a risk badge on the matching project. */
  risk: Record<string, RiskBadge>;
  /** For the status bar. */
  sessionStartedAt: number | null;
  lastRequestStatus: number | null;
  clearPulseFocus: () => void;
  clearUnhealthy: (serviceId: string) => void;
}

export const useLinks = create<LinksStore>((set) => ({
  snapshot: null,
  pulseFocus: null,
  unhealthy: {},
  detectedPorts: [],
  foundFiles: [],
  risk: {},
  sessionStartedAt: null,
  lastRequestStatus: null,
  clearPulseFocus: () => set({ pulseFocus: null }),
  clearUnhealthy: (serviceId) =>
    set((s) => {
      const next = { ...s.unhealthy };
      delete next[serviceId];
      return { unhealthy: next };
    }),
}));

/** Normalise a path for comparing a scan root with a project path. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export function startIntegrations(): Promise<() => void> {
  const set = useLinks.setState;
  const offs = [
    // 1. Pulse → Relay
    subscribe("pulse.port_listening", ({ payload }) =>
      set((s) => ({
        detectedPorts: [payload, ...s.detectedPorts.filter((p) => p.port !== payload.port)].slice(0, 20),
      })),
    ),
    subscribe("pulse.port_closed", ({ payload }) =>
      set((s) => ({ detectedPorts: s.detectedPorts.filter((p) => !(p.port === payload.port && p.pid === payload.pid)) })),
    ),
    // 2. Needle → Forge
    subscribe("needle.file_found", ({ payload }) =>
      set((s) => ({
        foundFiles: [{ path: payload.path, query: payload.query }, ...s.foundFiles.filter((f) => f.path !== payload.path)].slice(0, 10),
      })),
    ),
    // 3. BLACKBOX → Switchyard
    subscribe("blackbox.scan_complete", ({ payload, ts }) =>
      set((s) => ({ risk: { ...s.risk, [payload.root]: { overall_risk: payload.overall_risk, findings: payload.findings, ts } } })),
    ),
    // 4. Forge → Pulse
    subscribe("forge.step_failed", ({ payload }) => {
      if (payload.pid === null) return; // only command steps have a process
      set({ pulseFocus: { pid: payload.pid, reason: `Forge step “${payload.label}” failed` } });
    }),
    // 5. Switchyard → Pulse
    subscribe("switchyard.service_unhealthy", ({ payload, ts }) =>
      set((s) => ({
        unhealthy: {
          ...s.unhealthy,
          [payload.service_id]: { name: payload.name, reason: payload.reason, ports: payload.ports, pid: payload.pid, ts },
        },
      })),
    ),
    subscribe("switchyard.service_ready", ({ payload }) => useLinks.getState().clearUnhealthy(payload.service_id)),

    // Status bar
    subscribe("switchyard.session_started", ({ ts }) => set({ sessionStartedAt: Date.parse(ts) })),
    subscribe("switchyard.session_stopped", () => set({ sessionStartedAt: null })),
    subscribe("relay.response_received", ({ payload }) => set({ lastRequestStatus: payload.status })),
    subscribe("depot.workspace_opened", () =>
      set({ pulseFocus: null, unhealthy: {}, detectedPorts: [], foundFiles: [], risk: {}, sessionStartedAt: null, lastRequestStatus: null }),
    ),
  ];
  return listen<PulseSnapshot>(events.pulse, (snapshot) => set({ snapshot })).then((unlisten) => () => {
    unlisten();
    offs.forEach((off) => off());
  });
}
