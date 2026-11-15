import { useTimeline } from "../../store/timeline";
import type { AnyBusEvent } from "../../types/events";

/** One line of plain language per event. */
export function describe(event: AnyBusEvent): string {
  switch (event.type) {
    case "depot.session_started":
      return "Depot session started";
    case "depot.session_continued":
      return "Timeline continued in a new file";
    case "depot.session_ended":
      return "Depot session ended";
    case "depot.workspace_opened":
      return `Opened workspace ${event.payload.name}`;
    case "depot.panel_opened":
      return `Opened ${event.payload.tool}`;
    case "depot.plugin_launched":
      return `Launched plugin ${event.payload.name} · pid ${event.payload.pid}`;
    case "switchyard.session_started":
      return `Started session ${event.payload.name}`;
    case "switchyard.session_stopped":
      return event.payload.reason === "failure" ? "Session stopped after a failure" : "Session stopped";
    case "switchyard.service_started":
      return `${event.payload.name} started${event.payload.pid ? ` · pid ${event.payload.pid}` : ""}`;
    case "switchyard.service_ready":
      return `${event.payload.name} ready in ${event.payload.startup_ms} ms`;
    case "switchyard.service_unhealthy":
      return `${event.payload.name} unhealthy: ${event.payload.reason.replace("_", " ")}`;
    case "switchyard.service_stopped":
      return `${event.payload.name} stopped`;
    case "needle.index_started":
      return event.payload.incremental ? "Updating the index" : "Building the index";
    case "needle.index_complete":
      return `Indexed ${event.payload.documents} files`;
    case "needle.search_complete":
      return `Searched “${event.payload.query}” · ${event.payload.result_count} results`;
    case "needle.file_found":
      return `Picked ${event.payload.path}`;
    case "relay.request_sent":
      return `${event.payload.method} ${event.payload.url}`;
    case "relay.response_received":
      return `Response ${event.payload.status} in ${event.payload.elapsed_ms} ms`;
    case "relay.request_failed":
      return `Request failed: ${event.payload.error}`;
    case "pulse.port_listening":
      return `${event.payload.process_name} listening on :${event.payload.port}`;
    case "pulse.port_closed":
      return `Port :${event.payload.port} closed`;
    case "pulse.process_exited":
      return `${event.payload.name} exited`;
    case "pulse.snapshot":
      return `${event.payload.process_count} processes`;
    case "relay.mock_started":
      return `Mock server on :${event.payload.port}`;
    case "relay.mock_stopped":
      return `Mock server on :${event.payload.port} stopped`;
    case "blackbox.scan_started":
      return "Scanning the repository";
    case "blackbox.scan_complete":
      return `Scanned ${event.payload.files} files · risk ${event.payload.overall_risk}`;
    case "blackbox.scan_failed":
      return `Scan failed: ${event.payload.error}`;
    case "blackbox.review_complete":
      return `AI review: ${event.payload.comments} comments`;
    case "forge.run_started":
      return `Running ${event.payload.name}`;
    case "forge.step_started":
      return `Step ${event.payload.step_index + 1}: ${event.payload.label}`;
    case "forge.step_succeeded":
      return `Step ${event.payload.step_index + 1} done in ${event.payload.duration_ms} ms`;
    case "forge.step_failed":
      return `Step “${event.payload.label}” failed: ${event.payload.error}`;
    case "forge.run_finished":
      return `Workflow ${event.payload.outcome}${event.payload.failed_steps ? ` with ${event.payload.failed_steps} failed step(s)` : ""}`;
  }
}

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** The most recent events of this Depot session, newest first. */
export function TimelineView({ limit = 40 }: { limit?: number }) {
  const events = useTimeline((s) => s.events);
  const shown = events.slice(-limit).reverse();
  if (shown.length === 0) {
    return <p className="m-0 text-sm text-text-secondary">Nothing has happened in this session yet.</p>;
  }
  return (
    <ol className="m-0 grid list-none gap-1 p-0 text-sm" aria-label="Session timeline">
      {shown.map((e) => (
        <li key={e.id} className="grid grid-cols-[auto_6rem_1fr] items-baseline gap-3">
          <time dateTime={e.ts} className="font-mono text-xs text-text-secondary tabular-nums">
            {time.format(new Date(e.ts))}
          </time>
          <span className="truncate text-xs text-text-secondary">{e.source}</span>
          <span className="min-w-0 truncate">{describe(e)}</span>
        </li>
      ))}
    </ol>
  );
}
