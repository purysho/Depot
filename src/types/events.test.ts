import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import catalogue from "../protocol/events.json";
import { eventOrigins } from "./events";

const manifests = ["switchyard", "needle", "relay", "pulse", "blackbox", "forge"].map(
  (id) => JSON.parse(readFileSync(resolve(process.cwd(), `src/protocol/plugins/${id}.json`), "utf8")) as {
    id: string;
    events: { publishes: string[]; subscribes: string[] };
    panel: { color: string; icon: string };
  },
);

describe("event catalogue", () => {
  it("TypeScript and events.json list the same events with the same origins", () => {
    const fromJson = Object.fromEntries(Object.entries(catalogue.events).map(([k, v]) => [k, v.origin]));
    expect(eventOrigins).toEqual(fromJson);
  });

  it("every event is documented in PLUGIN_PROTOCOL.md", () => {
    const doc = readFileSync(resolve(process.cwd(), "docs/PLUGIN_PROTOCOL.md"), "utf8");
    const missing = Object.keys(eventOrigins).filter((t) => !doc.includes(`\`${t}\``));
    expect(missing).toEqual([]);
  });

  it("every subscription names a real event", () => {
    for (const m of manifests) {
      for (const t of m.events.subscribes) expect(Object.keys(eventOrigins)).toContain(t);
    }
  });
});
