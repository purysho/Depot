import { useEffect, useRef } from "react";
import { events, listen } from "../ipc";
import type { AnyBusEvent, BusEvent, EventType } from "../types/events";

// The one place the frontend listens to `depot://bus`. Rust delivers each
// event once; this fans it out to local subscribers by type.

type Handler<T extends EventType> = (event: BusEvent<T>) => void;

const handlers = new Map<EventType, Set<Handler<EventType>>>();
const anyHandlers = new Set<(event: AnyBusEvent) => void>();

/** Deliver one event to local subscribers. Exported for tests. */
export function dispatch(event: AnyBusEvent): void {
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

let started: Promise<() => void> | null = null;

/**
 * Start listening to Rust. Calling it again while started reuses the same
 * listener; the returned stop function ends it and allows a fresh start
 * (React's development mode mounts, unmounts and remounts once).
 */
export function startBus(): Promise<() => void> {
  if (!started) {
    const listening: Promise<() => void> = listen<AnyBusEvent>(events.bus, dispatch).then((unlisten) => () => {
      if (started === listening) started = null;
      unlisten();
    });
    started = listening;
  }
  return started;
}

/** Subscribe for the lifetime of a component. The latest handler is always used. */
export function useBusEvent<T extends EventType>(type: T, handler: Handler<T>): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => subscribe(type, (e) => ref.current(e)), [type]);
}
