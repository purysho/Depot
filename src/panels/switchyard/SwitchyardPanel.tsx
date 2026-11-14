import { Play, RefreshCw, Square, Waypoints } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardTitle,
  ErrorNote,
  PanelHeader,
  SectionTitle,
  runTone,
} from "../../design";
import { ipc } from "../../ipc";
import { useBusEvent } from "../../store/bus";
import { samePath, useLinks } from "../../store/integrations";
import { useWorkspace } from "../../store/workspace";
import type { PreflightCheck, SessionStatus, SwitchyardState } from "../../types/tools";
import { useTask } from "../shared/useTask";
import { TimelineView } from "./TimelineView";
import { WorkspacePicker } from "./WorkspacePicker";

/** True when `path` is `root` or a folder inside it (not merely a name prefix). */
export function isInside(path: string, root: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const [p, r] = [norm(path), norm(root)];
  return p === r || p.startsWith(`${r}/`);
}

function riskTone(risk: number) {
  if (risk >= 60) return "error" as const;
  if (risk >= 30) return "warning" as const;
  return "success" as const;
}

/** The workspace home: sessions, services, projects and the session timeline. */
export function SwitchyardPanel() {
  const context = useWorkspace((s) => s.context);
  const [choosing, setChoosing] = useState(false);

  if (!context || choosing) {
    return (
      <>
        <PanelHeader
          icon={Waypoints}
          color="var(--color-tool-switchyard)"
          title={context ? "Switch workspace" : "Welcome to Depot"}
          subtitle="A workspace scopes every tool to one project folder."
          actions={
            context ? (
              <Button variant="ghost" onClick={() => setChoosing(false)}>
                Back to {context.name}
              </Button>
            ) : undefined
          }
        />
        <WorkspacePicker onDone={() => setChoosing(false)} />
      </>
    );
  }
  return <WorkspaceHome onSwitch={() => setChoosing(true)} />;
}

function WorkspaceHome({ onSwitch }: { onSwitch: () => void }) {
  const context = useWorkspace((s) => s.context)!;
  const risk = useLinks((s) => s.risk);
  const unhealthy = useLinks((s) => s.unhealthy);
  const [state, setState] = useState<SwitchyardState | null>(null);
  const [status, setStatus] = useState<SessionStatus[]>([]);
  const [preflight, setPreflight] = useState<Record<string, PreflightCheck[]>>({});
  const load = useTask();
  const act = useTask();

  const runLoad = load.run;
  const refresh = useCallback(() => {
    void runLoad(async () => {
      const [s, st] = await Promise.all([ipc.switchyardState(), ipc.switchyardStatus()]);
      setState(s);
      setStatus(st);
    });
  }, [runLoad]);

  useEffect(refresh, [refresh, context.name]);
  // Any change in a session refreshes the view.
  useBusEvent("switchyard.session_started", refresh);
  useBusEvent("switchyard.session_stopped", refresh);
  useBusEvent("switchyard.service_ready", refresh);
  useBusEvent("switchyard.service_unhealthy", refresh);
  useBusEvent("switchyard.service_stopped", refresh);

  const start = (id: string) =>
    act.run(async () => {
      const result = await ipc.switchyardStartSession(id);
      setPreflight((p) => ({ ...p, [id]: result.checks.filter((c) => c.level !== "PASS") }));
      refresh();
    });
  const stop = (id: string) => act.run(async () => ipc.switchyardStopSession(id).then(refresh));

  const statusOf = (id: string) => status.find((s) => s.session_id === id);
  const inWorkspace = state?.projects.filter((p) => isInside(p.path, context.root)) ?? [];
  const others = state?.projects.filter((p) => !inWorkspace.includes(p)) ?? [];

  return (
    <>
      <PanelHeader
        icon={Waypoints}
        color="var(--color-tool-switchyard)"
        title={context.name}
        subtitle={<span className="font-mono">{context.root}</span>}
        actions={
          <>
            <Button variant="ghost" onClick={refresh} disabled={load.busy} aria-label="Refresh Switchyard">
              <RefreshCw aria-hidden="true" />
            </Button>
            <Button variant="ghost" onClick={onSwitch}>
              Switch workspace
            </Button>
          </>
        }
      />
      {load.error ? <ErrorNote className="mb-4">{load.error}</ErrorNote> : null}
      {act.error ? <ErrorNote className="mb-4">{act.error}</ErrorNote> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
        <div className="grid min-w-0 content-start gap-6">
          <section>
            <SectionTitle>Sessions</SectionTitle>
            {state && state.sessions.length === 0 ? (
              <p className="m-0 text-sm text-text-secondary">
                No sessions yet. Define services and sessions in Switchyard; they appear here.
              </p>
            ) : null}
            <ul className="m-0 grid list-none gap-2 p-0">
              {state?.sessions.map((session) => {
                const live = statusOf(session.id);
                const running = live && !["STOPPED", "FAILED", "IDLE"].includes(live.status);
                const checks = preflight[session.id] ?? [];
                return (
                  <li key={session.id}>
                    <Card>
                      <div className="flex flex-wrap items-center gap-3">
                        <CardTitle className="flex-1">{session.name}</CardTitle>
                        <Badge tone={runTone(live?.status ?? "IDLE")}>{(live?.status ?? "Idle").toLowerCase()}</Badge>
                        {running ? (
                          <Button variant="ghost" onClick={() => stop(session.id)} disabled={act.busy}>
                            <Square aria-hidden="true" />
                            Stop
                          </Button>
                        ) : (
                          <Button onClick={() => start(session.id)} disabled={act.busy}>
                            <Play aria-hidden="true" />
                            Start
                          </Button>
                        )}
                      </div>
                      {live ? (
                        <ul className="m-0 mt-3 grid list-none gap-1 p-0 text-sm">
                          {live.services.map((svc) => {
                            const bad = unhealthy[svc.id];
                            return (
                              <li key={svc.id} className="flex items-center gap-2">
                                <Badge tone={runTone(svc.status)}>{svc.status.toLowerCase()}</Badge>
                                <span className="min-w-0 flex-1 truncate">{svc.name}</span>
                                {bad ? <span className="text-xs text-error">{bad.reason.replace("_", " ")}</span> : null}
                                {svc.pid ? <span className="font-mono text-xs text-text-secondary">pid {svc.pid}</span> : null}
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <CardDescription className="mt-1">{session.service_ids.length} services</CardDescription>
                      )}
                      {checks.length > 0 ? (
                        <ul className="m-0 mt-3 grid list-none gap-1 p-0 text-sm" aria-label="Preflight">
                          {checks.map((c, i) => (
                            <li key={i} className="flex gap-2">
                              <Badge tone={c.level === "ERROR" ? "error" : "warning"}>{c.level.toLowerCase()}</Badge>
                              <span>
                                {c.name}: {c.detail}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </Card>
                  </li>
                );
              })}
            </ul>
          </section>

          <section>
            <SectionTitle>Projects in this workspace</SectionTitle>
            {state && inWorkspace.length === 0 ? (
              <p className="m-0 text-sm text-text-secondary">
                No Switchyard project lives under {context.root}. Add it in Switchyard to manage its services here.
              </p>
            ) : null}
            <ProjectGrid projects={inWorkspace} risk={risk} />
          </section>

          {others.length > 0 ? (
            <section>
              <SectionTitle>Other Switchyard projects</SectionTitle>
              <ProjectGrid projects={others} risk={risk} />
            </section>
          ) : null}
        </div>

        <section className="min-w-0">
          <SectionTitle>Session timeline</SectionTitle>
          <Card>
            <TimelineView />
          </Card>
        </section>
      </div>
    </>
  );
}

function ProjectGrid({
  projects,
  risk,
}: {
  projects: SwitchyardState["projects"];
  risk: ReturnType<typeof useLinks.getState>["risk"];
}) {
  return (
    <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">
      {projects.map((p) => {
        const r = Object.entries(risk).find(([root]) => samePath(root, p.path))?.[1];
        return (
          <li key={p.id}>
            <Card className="h-full">
              <div className="flex items-start gap-2">
                <CardTitle className="min-w-0 flex-1 truncate">{p.name}</CardTitle>
                {r ? (
                  <Badge tone={riskTone(r.overall_risk)} title="From the latest BLACKBOX scan">
                    Risk {Math.round(r.overall_risk)}
                  </Badge>
                ) : null}
              </div>
              <CardDescription className="mt-1 truncate font-mono">{p.path}</CardDescription>
              {p.tags.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {p.tags.map((t) => (
                    <Badge key={t} tone="info">
                      {t}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
