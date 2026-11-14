import { Activity, OctagonX, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, ErrorNote, Input, PanelHeader, formatBytes, table } from "../../design";
import { cn } from "../../design/cn";
import { ipc } from "../../ipc";
import { subscribersOf, useIntent, useLinks, useNav, type Unhealthy } from "../../store/integrations";
import { useWorkspace } from "../../store/workspace";
import type { ListeningPort, PulseProcess } from "../../types/tools";
import { NoWorkspace } from "../shared/NoWorkspace";
import { useTask } from "../shared/useTask";

const MAX_ROWS = 300;

/** Process matches a filter on name, PID, path or command line (Pulse's own rule). */
export function matches(proc: PulseProcess, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return (
    String(proc.pid) === f ||
    proc.name.toLowerCase().includes(f) ||
    proc.path.toLowerCase().includes(f) ||
    proc.command_line.toLowerCase().includes(f)
  );
}

/** Which unhealthy Switchyard service, if any, a process belongs to: by PID, else by port. */
export function unhealthyFor(
  proc: PulseProcess,
  ports: number[],
  unhealthy: Record<string, Unhealthy>,
): Unhealthy | undefined {
  return Object.values(unhealthy).find(
    (u) => (u.pid !== null && u.pid === proc.pid) || u.ports.some((p) => ports.includes(p)),
  );
}

export function PulsePanel() {
  const context = useWorkspace((s) => s.context);
  const snapshot = useLinks((s) => s.snapshot);
  const focus = useLinks((s) => s.pulseFocus);
  const unhealthy = useLinks((s) => s.unhealthy);
  const clearFocus = useLinks((s) => s.clearPulseFocus);
  const clearUnhealthy = useLinks((s) => s.clearUnhealthy);
  const go = useNav((s) => s.go);
  const intent = useIntent("pulse");
  const [filter, setFilter] = useState(intent ? String(intent.pid) : "");
  const refresh = useTask();
  const relayListens = subscribersOf("pulse.port_listening").includes("relay");

  // A first snapshot straight away rather than waiting for the poller.
  const runRefresh = refresh.run;
  useEffect(() => {
    if (context && !useLinks.getState().snapshot) void runRefresh(() => ipc.pulseSnapshot());
  }, [context, runRefresh]);

  const portsByPid = useMemo(() => {
    const map = new Map<number, ListeningPort[]>();
    for (const p of snapshot?.listening ?? []) map.set(p.pid, [...(map.get(p.pid) ?? []), p]);
    return map;
  }, [snapshot]);

  const effectiveFilter = focus ? String(focus.pid) : filter;
  const rows = useMemo(() => {
    const all = snapshot?.processes ?? [];
    const filtered = all.filter((p) => matches(p, effectiveFilter));
    // Unhealthy services and processes with open ports first: they are what you came for.
    const weight = (p: PulseProcess) =>
      (unhealthyFor(p, (portsByPid.get(p.pid) ?? []).map((x) => x.port), unhealthy) ? 0 : 2) - (portsByPid.has(p.pid) ? 1 : 0);
    return filtered.sort((a, b) => weight(a) - weight(b) || a.name.localeCompare(b.name));
  }, [snapshot, effectiveFilter, portsByPid, unhealthy]);

  if (!context) return <NoWorkspace tool="Pulse" />;

  const focusGone = focus && snapshot && !snapshot.processes.some((p) => p.pid === focus.pid);

  return (
    <>
      <PanelHeader
        icon={Activity}
        color="var(--color-tool-pulse)"
        title="Pulse"
        subtitle={
          snapshot
            ? `${snapshot.processes.length} processes · ${snapshot.listening.length} listening ports · every ${context.tools.pulse.refresh_seconds}s`
            : "Collecting the first snapshot…"
        }
        actions={
          <Button variant="ghost" onClick={() => refresh.run(() => ipc.pulseSnapshot())} disabled={refresh.busy}>
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      {focus ? (
        <div role="status" className="mb-3 flex items-center gap-2 rounded-md border border-bg-border bg-badge-error px-3 py-2 text-sm">
          <OctagonX size={14} aria-hidden="true" className="text-error" />
          <span className="flex-1">
            {focus.reason}. Showing PID {focus.pid}
            {focusGone ? " — that process has already exited." : "."}
          </span>
          <Button
            variant="ghost"
            onClick={() => {
              clearFocus();
              setFilter("");
            }}
          >
            <X aria-hidden="true" />
            Clear filter
          </Button>
        </div>
      ) : null}

      {Object.entries(unhealthy).map(([id, u]) => (
        <div key={id} role="status" className="mb-3 flex items-center gap-2 rounded-md border border-bg-border bg-badge-warning px-3 py-2 text-sm">
          <Badge tone="error">Unhealthy</Badge>
          <span className="flex-1">
            Switchyard service <strong className="font-medium">{u.name}</strong>: {u.reason.replace("_", " ")}
            {u.ports.length ? ` (port ${u.ports.join(", ")})` : ""}.{" "}
            {snapshot?.processes.some((p) => unhealthyFor(p, (portsByPid.get(p.pid) ?? []).map((x) => x.port), { [id]: u }))
              ? "Its process is highlighted below."
              : "Its process is no longer running."}
          </span>
          <Button variant="ghost" onClick={() => clearUnhealthy(id)} aria-label={`Dismiss ${u.name}`}>
            <X aria-hidden="true" />
          </Button>
        </div>
      ))}

      <div className="mb-3 flex items-center gap-2">
        <Input
          aria-label="Filter processes"
          placeholder="Filter by name, PID, path or command"
          value={effectiveFilter}
          onChange={(e) => {
            if (focus) clearFocus();
            setFilter(e.target.value);
          }}
          className="max-w-md"
        />
        <span className="text-sm text-text-secondary">{rows.length} shown</span>
      </div>
      {refresh.error ? <ErrorNote className="mb-3">{refresh.error}</ErrorNote> : null}

      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th className={table.th}>Process</th>
              <th className={cn(table.th, "text-right")}>PID</th>
              <th className={cn(table.th, "text-right")}>Parent</th>
              <th className={cn(table.th, "text-right")}>Memory</th>
              <th className={cn(table.th, "text-right")}>CPU time</th>
              <th className={table.th}>Listening</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && snapshot ? (
              <tr>
                <td colSpan={6} className={cn(table.td, "py-6 text-center text-text-secondary")}>
                  No process matches “{effectiveFilter}”.
                </td>
              </tr>
            ) : null}
            {rows.slice(0, MAX_ROWS).map((p) => {
              const ports = portsByPid.get(p.pid) ?? [];
              const bad = unhealthyFor(p, ports.map((x) => x.port), unhealthy);
              return (
                <tr key={p.pid} className={cn(bad && "bg-badge-error")}>
                  <td className={cn(table.td, "max-w-80", bad && "border-l-2 border-l-error")}>
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium" title={p.command_line || p.path}>
                        {p.name}
                      </span>
                      {bad ? <Badge tone="error">{bad.name}: {bad.reason.replace("_", " ")}</Badge> : null}
                    </div>
                  </td>
                  <td className={cn(table.td, "text-right font-mono tabular-nums")}>{p.pid}</td>
                  <td className={cn(table.td, "text-right font-mono tabular-nums text-text-secondary")}>{p.ppid || "—"}</td>
                  <td className={cn(table.td, "text-right tabular-nums")}>{p.memory_bytes ? formatBytes(p.memory_bytes) : "—"}</td>
                  <td className={cn(table.td, "text-right tabular-nums")}>{p.cpu_seconds ? `${p.cpu_seconds.toFixed(1)}s` : "—"}</td>
                  <td className={table.td}>
                    <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
                      {ports.map((port) => (
                        <li key={port.port} className="flex items-center gap-1">
                          <span className="font-mono text-xs">:{port.port}</span>
                          {relayListens ? (
                            <button
                              type="button"
                              className="rounded-sm px-1 text-xs text-text-link hover:underline"
                              onClick={() => go("relay", { tool: "relay", url: relayUrl(port) })}
                            >
                              Open in Relay →
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > MAX_ROWS ? (
        <p className="m-0 mt-2 text-sm text-text-secondary">
          Showing {MAX_ROWS} of {rows.length}. Type in the filter to narrow the list.
        </p>
      ) : null}
    </>
  );
}

/** A URL Relay can call for a listening port: wildcard addresses become localhost. */
export function relayUrl(port: { address: string; port: number }): string {
  const wildcard = ["*", "0.0.0.0", "::", ""].includes(port.address);
  const host = wildcard ? "127.0.0.1" : port.address.includes(":") ? `[${port.address}]` : port.address;
  return `http://${host}:${port.port}/`;
}
