import { ArrowDown, ArrowUp, Download, Pencil, Play, Plus, Square, Trash, Upload, Workflow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, PanelHeader, SectionTitle, Select, Textarea } from "../../design";
import { cn } from "../../design/cn";
import { ipc } from "../../ipc";
import { useForgeRun } from "../../store/forge";
import { useIntent, useLinks, useNav } from "../../store/integrations";
import { useWorkspace } from "../../store/workspace";
import { STEP_TYPES, type ForgeStep, type ForgeWorkflow, type StepType } from "../../types/tools";
import { NoWorkspace } from "../shared/NoWorkspace";
import { useTask } from "../shared/useTask";

/** Each step type's fields, as Forge's own step editor has them (forge/app.py). */
export const FIELDS: Record<StepType, Array<[key: string, label: string, multiline?: boolean]>> = {
  command: [["command", "Command"], ["cwd", "Working folder"]],
  copy: [["source", "Source"], ["target", "Target"]],
  move: [["source", "Source"], ["target", "Target"]],
  mkdir: [["path", "Folder"]],
  write: [["path", "File"], ["content", "Content", true]],
  delete: [["path", "Path to delete"]],
  http: [["method", "Method"], ["url", "URL"]],
  wait: [["seconds", "Seconds"]],
  open: [["path", "File, folder or URL"]],
};

/** Fields a step cannot run without (depot-core and Forge refuse them too). */
export const REQUIRED: Partial<Record<StepType, string[]>> = {
  command: ["command"],
  copy: ["source", "target"],
  move: ["source", "target"],
  mkdir: ["path"],
  write: ["path"],
  delete: ["path"],
  http: ["url"],
  open: ["path"],
};

/** The required fields a step leaves blank. */
export function missingFields(step: ForgeStep): string[] {
  return (REQUIRED[step.type] ?? []).filter((key) => !String(step.config[key] ?? "").trim());
}

/** Where a path from Needle goes for each step type. */
const PATH_FIELD: Partial<Record<StepType, string>> = { copy: "source", move: "source", write: "path", delete: "path", open: "path", mkdir: "path" };

export function ForgePanel() {
  const context = useWorkspace((s) => s.context);
  const found = useLinks((s) => s.foundFiles);
  const go = useNav((s) => s.go);
  const intent = useIntent("forge");
  const [workflows, setWorkflows] = useState<ForgeWorkflow[]>([]);
  const [selected, setSelected] = useState(0);
  // A file chosen in Needle opens the step editor with the path filled in.
  const [draft, setDraft] = useState<ForgeStep | null>(
    intent ? { type: "open", name: "", config: { path: intent.addPath }, timeout: 0, continue_on_error: false } : null,
  );
  const [newName, setNewName] = useState("");
  // Index of the step being edited, or null when the editor adds a new step.
  const [editing, setEditing] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Kept in a store, not here: the run outlives this panel when you switch tools.
  const run = useForgeRun((s) => s.run);
  const beginRun = useForgeRun((s) => s.begin);
  const reattach = useForgeRun((s) => s.reattach);
  const task = useTask();

  const load = useCallback(() => {
    ipc.forgeList().then(setWorkflows, () => setWorkflows([]));
  }, []);
  useEffect(() => {
    if (context) {
      load();
      void reattach();
    }
  }, [context, load, reattach]);

  if (!context) return <NoWorkspace tool="Forge" />;

  const save = (next: ForgeWorkflow[]) =>
    task.run(async () => {
      await ipc.forgeSave(next);
      setWorkflows(next);
    });

  const workflow = workflows[selected];
  const running = run !== null && run.outcome === null;
  // Step badges belong to the workflow that ran, not whichever is selected.
  const shown = run && (run.workflowIndex === null || run.workflowIndex === selected) ? run : null;
  const draftMissing = draft ? missingFields(draft) : [];

  const addWorkflow = (event: React.FormEvent) => {
    event.preventDefault();
    if (!newName.trim()) return;
    void save([...workflows, { name: newName.trim(), description: "", steps: [] }]).then(() => {
      setSelected(workflows.length);
      setNewName("");
    });
  };

  const updateSteps = (change: (steps: ForgeStep[]) => ForgeStep[]) =>
    save(workflows.map((w, i) => (i === selected ? { ...w, steps: change(w.steps) } : w)));

  const saveStep = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || !workflow || draftMissing.length) return;
    const step = { ...draft, config: draft.type === "wait" ? { seconds: Number(draft.config.seconds) || 1 } : draft.config };
    void updateSteps((steps) => (editing === null ? [...steps, step] : steps.map((s, j) => (j === editing ? step : s)))).then(() => {
      setDraft(null);
      setEditing(null);
    });
  };

  const removeStep = (index: number) => updateSteps((steps) => steps.filter((_, j) => j !== index));

  const moveStep = (index: number, by: -1 | 1) =>
    updateSteps((steps) => {
      const next = [...steps];
      const [step] = next.splice(index, 1);
      next.splice(index + by, 0, step!);
      return next;
    });

  const editStep = (index: number) => {
    setEditing(index);
    setDraft(structuredClone(workflow!.steps[index]!));
  };

  const importWorkflow = () =>
    task.run(async () => {
      const next = await ipc.forgeImport();
      if (!next) return; // cancelled
      setWorkflows(next);
      setSelected(next.length - 1);
      setNote(`Imported “${next[next.length - 1]?.name}”. Read its steps before running it.`);
    });

  const exportWorkflow = () =>
    task.run(async () => {
      const done = await ipc.forgeExport(selected, workflow!.name);
      if (done) setNote(`Exported “${done.name}” to ${done.path}.`);
    });

  const start = () =>
    task.run(async () => {
      const runId = await ipc.forgeRun(selected);
      beginRun(runId, selected);
    });

  return (
    <>
      <PanelHeader icon={Workflow} color="var(--color-tool-forge)" title="Forge" subtitle="Workflows are kept in this workspace." />
      {task.error ? <ErrorNote className="mb-3">{task.error}</ErrorNote> : null}
      <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside>
          <SectionTitle>Workflows</SectionTitle>
          <ul className="m-0 mb-3 grid list-none gap-1 p-0">
            {workflows.map((w, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => setSelected(i)}
                  aria-current={i === selected ? "true" : undefined}
                  className={cn("w-full rounded-sm px-2 py-1 text-left text-sm hover:bg-bg-overlay", i === selected && "bg-bg-overlay")}
                >
                  {w.name} <span className="text-xs text-text-secondary">· {w.steps.length}</span>
                </button>
              </li>
            ))}
          </ul>
          <form onSubmit={addWorkflow} className="flex gap-2">
            <Input aria-label="New workflow name" placeholder="New workflow" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Button type="submit" variant="ghost" aria-label="Add workflow" disabled={!newName.trim()}>
              <Plus aria-hidden="true" />
            </Button>
          </form>
          <Button variant="ghost" className="mt-2 w-full" onClick={importWorkflow} disabled={task.busy}>
            <Upload aria-hidden="true" />
            Import .forge.json…
          </Button>
        </aside>

        {workflow ? (
          <div className="grid min-w-0 content-start gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="m-0 flex-1 text-lg font-semibold">{workflow.name}</h2>
              {running ? (
                <Button variant="ghost" onClick={() => task.run(() => ipc.forgeStop(run!.runId))}>
                  <Square aria-hidden="true" />
                  Stop
                </Button>
              ) : (
                <Button onClick={start} disabled={workflow.steps.length === 0 || task.busy}>
                  <Play aria-hidden="true" />
                  Run
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(null);
                  setDraft({ type: "command", name: "", config: {}, timeout: 0, continue_on_error: false });
                }}
              >
                <Plus aria-hidden="true" />
                Add step
              </Button>
              <Button variant="ghost" onClick={exportWorkflow} disabled={task.busy} aria-label={`Export ${workflow.name}`}>
                <Download aria-hidden="true" />
                Export
              </Button>
            </div>
            {note ? (
              <p role="status" className="m-0 text-sm text-text-secondary">
                {note}
              </p>
            ) : null}

            <ol className="m-0 grid list-none gap-1 p-0">
              {workflow.steps.map((step, i) => {
                const state = shown?.steps[i];
                const pid = shown?.failedPid[i];
                return (
                  <li key={i} className="flex items-center gap-2 rounded-md border border-bg-border bg-bg-surface px-3 py-2 text-sm">
                    <span className="w-5 text-right font-mono text-xs text-text-secondary">{i + 1}</span>
                    <span className="w-16 font-mono text-xs text-text-secondary">{step.type}</span>
                    <span className="min-w-0 flex-1 truncate">{step.name || describeStep(step)}</span>
                    {state === "running" ? <Badge tone="pending">running</Badge> : null}
                    {state === "done" ? <Badge tone="success">done</Badge> : null}
                    {state === "failed" ? <Badge tone="error">failed</Badge> : null}
                    {state === "stopped" ? <Badge tone="info">stopped</Badge> : null}
                    {state === "failed" && pid ? (
                      <button type="button" className="text-xs text-text-link hover:underline" onClick={() => go("pulse", { tool: "pulse", pid })}>
                        Show in Pulse →
                      </button>
                    ) : null}
                    <Button variant="ghost" aria-label={`Move step ${i + 1} up`} onClick={() => moveStep(i, -1)} disabled={running || i === 0}>
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`Move step ${i + 1} down`}
                      onClick={() => moveStep(i, 1)}
                      disabled={running || i === workflow.steps.length - 1}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                    <Button variant="ghost" aria-label={`Edit step ${i + 1}`} onClick={() => editStep(i)} disabled={running}>
                      <Pencil aria-hidden="true" />
                    </Button>
                    <Button variant="ghost" aria-label={`Remove step ${i + 1}`} onClick={() => removeStep(i)} disabled={running}>
                      <Trash aria-hidden="true" />
                    </Button>
                  </li>
                );
              })}
            </ol>
            {workflow.steps.length === 0 && !draft ? <p className="m-0 text-sm text-text-secondary">No steps yet. Add the first one.</p> : null}

            {draft ? (
              <Card>
                <form onSubmit={saveStep} className="grid gap-3">
                  <div className="flex flex-wrap gap-3">
                    <Field label="Step type">
                      {(id) => (
                        <Select
                          id={id}
                          value={draft.type}
                          onChange={(e) => {
                            const type = e.target.value as StepType;
                            // Keep a path the person already entered when switching type.
                            const path = Object.values(draft.config).find((v) => typeof v === "string" && v.includes("/"));
                            const key = PATH_FIELD[type];
                            setDraft({ ...draft, type, config: key && path ? { [key]: path } : {} });
                          }}
                        >
                          {STEP_TYPES.map((t) => (
                            <option key={t}>{t}</option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label="Label (optional)" className="flex-1">
                      {(id) => <Input id={id} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}
                    </Field>
                  </div>
                  {FIELDS[draft.type].map(([key, label, multiline]) => (
                    <Field key={key} label={label}>
                      {(id) =>
                        multiline ? (
                          <Textarea id={id} rows={4} value={String(draft.config[key] ?? "")} onChange={(e) => setDraft({ ...draft, config: { ...draft.config, [key]: e.target.value } })} />
                        ) : (
                          <Input
                            id={id}
                            required={REQUIRED[draft.type]?.includes(key)}
                            aria-invalid={draftMissing.includes(key) && String(draft.config[key] ?? "") !== "" ? true : undefined}
                            value={String(draft.config[key] ?? "")}
                            onChange={(e) => setDraft({ ...draft, config: { ...draft.config, [key]: e.target.value } })}
                          />
                        )
                      }
                    </Field>
                  ))}
                  {found.length && PATH_FIELD[draft.type] ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-text-secondary">From Needle:</span>
                      {found.slice(0, 5).map((f) => (
                        <button
                          key={f.path}
                          type="button"
                          className="max-w-64 truncate rounded-full border border-bg-border px-2 py-0.5 font-mono text-xs hover:border-text-link"
                          onClick={() => setDraft({ ...draft, config: { ...draft.config, [PATH_FIELD[draft.type]!]: f.path } })}
                          title={f.path}
                        >
                          {f.path.split(/[\\/]/).pop()}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex gap-2">
                    <Button type="submit" disabled={draftMissing.length > 0} title={draftMissing.length ? `Fill in: ${draftMissing.join(", ")}` : undefined}>
                      Save step
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setDraft(null);
                        setEditing(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              </Card>
            ) : null}

            {run ? (
              <section aria-label="Run log">
                <SectionTitle aside={run.outcome ? <Badge tone={run.outcome === "completed" ? "success" : run.outcome === "stopped" ? "info" : "error"}>{run.outcome}</Badge> : <Badge tone="pending">running</Badge>}>
                  Log
                </SectionTitle>
                <pre className="m-0 max-h-80 overflow-auto rounded-md border border-bg-border bg-bg-surface p-3 font-mono text-xs whitespace-pre-wrap">
                  {run.log.join("\n") || "Starting…"}
                </pre>
              </section>
            ) : null}
          </div>
        ) : (
          <EmptyState
            icon={Workflow}
            title="No workflows yet"
            description={
              draft
                ? `Name a workflow on the left to add ${String(Object.values(draft.config)[0] ?? "the file").split(/[\\/]/).pop()} to it.`
                : "Name a workflow on the left, then add steps: commands, file operations, HTTP calls."
            }
          />
        )}
      </div>
    </>
  );
}

function describeStep(step: ForgeStep): string {
  const c = step.config;
  switch (step.type) {
    case "command":
      return String(c.command ?? "Run command");
    case "copy":
    case "move":
      return `${step.type === "copy" ? "Copy" : "Move"} ${c.source ?? ""} → ${c.target ?? ""}`;
    case "http":
      return `${c.method ?? "GET"} ${c.url ?? ""}`;
    case "wait":
      return `Wait ${c.seconds ?? 1}s`;
    default:
      return `${step.type} ${c.path ?? ""}`;
  }
}
