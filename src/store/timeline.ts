import { create } from "zustand";
import { ipc } from "../ipc";
import type { AnyBusEvent } from "../types/events";
import { eventOrigins } from "../types/events";
import catalogue from "../protocol/events.json";
import { subscribeAll } from "./bus";

// The most recent events of the current session, for the timeline view.
// The session file on disk is the record; this is a window onto its end.

export const TIMELINE_WINDOW = 500;

const recorded = new Set(
  Object.entries(catalogue.events)
    .filter(([, spec]) => spec.timeline)
    .map(([type]) => type),
);

interface TimelineStore {
  session: string | null;
  events: AnyBusEvent[];
  append: (event: AnyBusEvent) => void;
  load: () => Promise<void>;
}

export const useTimeline = create<TimelineStore>((set, get) => ({
  session: null,
  events: [],
  append: (event) => {
    // Same rule as Rust: live-only events are not part of the timeline.
    if (!recorded.has(event.type)) return;
    if (get().events.some((e) => e.id === event.id)) return;
    if (event.type === "depot.session_started") {
      set({ session: event.payload.session, events: [event] });
      return;
    }
    set({ events: [...get().events, event].slice(-TIMELINE_WINDOW) });
  },
  load: async () => {
    try {
      const { current } = await ipc.timelineSessions();
      if (!current) return set({ session: null, events: [] });
      const collected: AnyBusEvent[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page: { events: AnyBusEvent[]; next_offset: number | null } = await ipc.timelineRead(current, offset, 1000);
        collected.push(...page.events);
        offset = page.next_offset;
      }
      // Events can arrive live while the file is read: merge by id, keep order.
      const byId = new Map<string, AnyBusEvent>();
      for (const e of [...collected, ...get().events]) byId.set(e.id, e);
      // Ids are UUIDv7, which sort by creation time.
      const merged = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      set({ session: current, events: merged.slice(-TIMELINE_WINDOW) });
    } catch {
      // No workspace open, or outside Depot.
    }
  },
}));

export function startTimeline(): () => void {
  void useTimeline.getState().load();
  return subscribeAll((event) => useTimeline.getState().append(event));
}

/** For tests: is this type known? Guards against typos in filters. */
export const isKnownEvent = (type: string) => type in eventOrigins;
