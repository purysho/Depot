import { useEffect, useRef } from "react";
import { events, listen } from "../ipc";
import type { AnyBusEvent, BusEvent, EventType } from "../types/events";

// The one place the frontend listens to `depot://bus`. Rust delivers each
// event once; this fans it out to local subscribers by type.

type Handler<T extends EventType> = (event: BusEvent<T>) => void;

const handlers = new Map<EventType, Set<Handler<EventType>>>();
const anyHandlers = new Set<(event: AnyBusEvent) => void>();

// The workspace whose events panels should see. Taken from the bus itself
// (depot.workspace_opened), not from the workspace store, so it changes in
// the same order as the events: nothing from the new workspace is dropped
// while the store catches up, and nothing from the old one gets through.
let activeWorkspace: string | null = null;

/** Set the active workspace at startup, unless the bus already knows a newer one. */
export function initActiveWorkspace(name: string | null): void {
  activeWorkspace ??= name;
}

/**
 * Should panels see this event? Work started in another workspace can finish
 * after a switch; Rust stamps it with its own workspace, and it is dropped
 * here. Depot's own lifecycle events always pass.
 */
export function isForActiveWorkspace(event: AnyBusEvent): boolean {
  if (event.source === "depot" || !event.workspace || activeWorkspace === null) return true;
  return event.workspace === activeWorkspace;
}

/** The same check for a UI stream line (`depot://stream`). */
export function isStreamForActiveWorkspace(message: { workspace?: string | null }): boolean {
  return !message.workspace || activeWorkspace === null || message.workspace === activeWorkspace;
}

/** Deliver one event to local subscribers. Exported for tests. */
export function dispatch(event: AnyBusEvent): void {
  if (event.type === "depot.workspace_opened") activeWorkspace = event.payload.name;
  if (!isForActiveWorkspace(event)) return;
  for (const h of handlers.get(event.type) ?? []) {
    try {
      h(event as BusEvent<EventType>);
    } catch (error) {
      // One broken subscriber must not stop the others.
      console.error(`bus subscriber for ${event.type} failed`, error);
    }
  }
  for (const h of anyHandlers) h(event);
}

export function subscribe<T extends EventType>(type: T, handler: Handler<T>): () => void {
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }
  set.add(handler as Handler<EventType>);
  return () => set.delete(handler as Handler<EventType>);
}

export function subscribeAll(handler: (event: AnyBusEvent) => void): () => void {
  anyHandlers.add(handler);
  return () => anyHandlers.delete(handler);
}

let listening: Promise<() => void> | null = null;
let users = 0;

/**
 * Start listening to Rust. Every caller gets its own stop function, and the
 * one shared listener ends only when the last caller has stopped. This is
 * what keeps the bus alive through React's development-mode double mount,
 * where the first mount's cleanup can run after the second mount started.
 */
export function startBus(): Promise<() => void> {
  users += 1;
  listening ??= listen<AnyBusEvent>(events.bus, dispatch);
  const mine = listening;
  let stopped = false;
  return Promise.resolve(() => {
    if (stopped) return;
    stopped = true;
    users -= 1;
    if (users === 0 && listening === mine) {
      listening = null;
      void mine.then((unlisten) => unlisten());
    }
  });
}

/** Subscribe for the lifetime of a component. The latest handler is always used. */
export function useBusEvent<T extends EventType>(type: T, handler: Handler<T>): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => subscribe(type, (e) => ref.current(e)), [type]);
}
