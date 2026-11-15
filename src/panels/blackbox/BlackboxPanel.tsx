import { Bot, ScanSearch, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorNote, ExternalLink, Field, Input, PanelHeader, SectionTitle, Select, severityTone, table } from "../../design";
import { cn } from "../../design/cn";
import { events, ipc, listen, type StreamMessage } from "../../ipc";
import { useWorkspace } from "../../store/workspace";
import { isStreamForActiveWorkspace } from "../../store/bus";
import type { BlackboxReport, Finding, OcrReview, OcrStatus, ReviewTarget, Severity } from "../../types/tools";
import { NoWorkspace } from "../shared/NoWorkspace";
import { useTask } from "../shared/useTask";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
type SourceFilter = "all" | "blackbox" | "ocr";

/** Native findings plus any ocr review, most severe first. */
export function mergeFindings(report: BlackboxReport | null, review: OcrReview | null): Finding[] {
  const all = [...(report?.findings ?? []), ...(review?.findings ?? [])];
  const rank = (s: string) => SEVERITIES.indexOf(s as Severity);
  return all.sort((a, b) => rank(a.severity) - rank(b.severity) || a.file.localeCompare(b.file));
}

export function BlackboxPanel() {
  const context = useWorkspace((s) => s.context);
  const [report, setReport] = useState<BlackboxReport | null>(null);
  const [review, setReview] = useState<OcrReview | null>(null);
  const [ocr, setOcr] = useState<OcrStatus | null>(null);
  const [source, setSource] = useState<SourceFilter>("all");
  const scan = useTask();

  useEffect(() => {
    if (!context) return;
    ipc.blackboxLastReport().then(setReport, () => setReport(null));
    ipc.ocrStatus().then(setOcr, () => setOcr(null));
  }, [context]);

  const findings = useMemo(
    () => mergeFindings(report, review).filter((f) => source === "all" || f.source === source),
    [report, review, source],
  );

  if (!context) return <NoWorkspace tool="BLACKBOX" />;
  const repo = context.tools.blackbox.repo ?? context.root;

  return (
    <>
      <PanelHeader
        icon={ScanSearch}
        color="var(--color-tool-blackbox)"
        title="BLACKBOX"
        subtitle={<span className="font-mono">{repo}</span>}
        actions={
          <Button onClick={() => scan.run(async () => setReport(await ipc.blackboxScan()))} disabled={scan.busy}>
            <ScanSearch aria-hidden="true" />
            {scan.busy ? "Scanning…" : report ? "Scan again" : "Scan repository"}
          </Button>
        }
      />
      {scan.error ? <ErrorNote className="mb-3">{scan.error}</ErrorNote> : null}

      {!report && !scan.busy ? (
        <EmptyState
          icon={ScanSearch}
          title="No scan yet"
          description="A scan reads the repository locally: structure, hotspots, import cycles and secret-like patterns."
        />
      ) : null}

      {report ? (
        <div className="grid gap-6">
          <section aria-label="Summary" className="flex flex-wrap items-end gap-6">
            <div>
              <p className="m-0 text-xs text-text-secondary">Overall risk</p>
              <p className="m-0 text-2xl font-semibold tabular-nums">{Math.round(report.summary.overall_risk)}</p>
            </div>
            <Stat label="Files" value={report.summary.files} />
            <Stat label="Lines" value={report.summary.loc} />
            <Stat label="Import cycles" value={report.summary.cycles} />
            <div className="flex flex-wrap gap-1">
              {SEVERITIES.map((s) => (
                <Badge key={s} tone={severityTone(s)}>
                  {report.by_severity[s]} {s}
                </Badge>
              ))}
            </div>
          </section>

          <OcrSection status={ocr} onReview={setReview} />

          <section>
            <SectionTitle
              aside={
                review ? (
                  <Select aria-label="Show findings from" value={source} onChange={(e) => setSource(e.target.value as SourceFilter)}>
                    <option value="all">All sources</option>
                    <option value="blackbox">BLACKBOX scan</option>
                    <option value="ocr">AI review (ocr)</option>
                  </Select>
                ) : undefined
              }
            >
              Findings ({findings.length})
            </SectionTitle>
            {findings.length === 0 ? <p className="m-0 text-sm text-text-secondary">No findings.</p> : null}
            <ul className="m-0 grid list-none gap-1 p-0">
              {findings.slice(0, 200).map((f, i) => (
                <li key={i}>
                  <details className="rounded-md border border-bg-border bg-bg-surface px-3 py-2 text-sm">
                    <summary className="flex cursor-pointer items-center gap-2">
                      <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
                      <span className="min-w-0 flex-1 truncate">{f.title}</span>
                      <span className="truncate font-mono text-xs text-text-secondary">
                        {f.file}
                        {f.line ? `:${f.line}` : ""}
                      </span>
                      <span className={cn("w-16 text-right text-xs", f.source === "ocr" ? "text-pending" : "text-text-secondary")}>
                        {f.source === "ocr" ? "AI review" : "scan"}
                      </span>
                    </summary>
                    <p className="m-0 mt-2 whitespace-pre-wrap text-text-secondary">{f.detail}</p>
                    {f.suggestion ? (
                      <pre className="m-0 mt-2 overflow-auto rounded-sm bg-bg-base p-2 font-mono text-xs">{f.suggestion}</pre>
                    ) : null}
                  </details>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <SectionTitle>Hotspots</SectionTitle>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>File</th>
                    <th className={cn(table.th, "text-right")}>Risk</th>
                    <th className={cn(table.th, "text-right")}>Lines</th>
                    <th className={cn(table.th, "text-right")}>Complexity</th>
                    <th className={cn(table.th, "text-right")}>Git changes</th>
                    <th className={cn(table.th, "text-right")}>Imported by</th>
                  </tr>
                </thead>
                <tbody>
                  {report.hotspots.slice(0, 15).map((h) => (
                    <tr key={h.path}>
                      <td className={cn(table.td, "max-w-96 truncate font-mono text-xs")}>{h.path}</td>
                      <td className={cn(table.td, "text-right tabular-nums")}>{h.risk}</td>
                      <td className={cn(table.td, "text-right tabular-nums")}>{h.loc}</td>
                      <td className={cn(table.td, "text-right tabular-nums")}>{h.complexity}</td>
                      <td className={cn(table.td, "text-right tabular-nums")}>{h.git_touches}</td>
                      <td className={cn(table.td, "text-right tabular-nums")}>{h.inbound}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="m-0 text-xs text-text-secondary">{label}</p>
      <p className="m-0 text-lg font-medium tabular-nums">{value.toLocaleString()}</p>
    </div>
  );
}

/** Optional AI review through Open Code Review, when `ocr` is installed. */
function OcrSection({ status, onReview }: { status: OcrStatus | null; onReview: (r: OcrReview) => void }) {
  const [kind, setKind] = useState<ReviewTarget["kind"]>("working_tree");
  const [commit, setCommit] = useState("");
  const [from, setFrom] = useState("main");
  const [to, setTo] = useState("HEAD");
  const [progress, setProgress] = useState<string | null>(null);
  const task = useTask();

  useEffect(() => {
    const off = listen<StreamMessage>(events.stream, (m) => {
      if (m.name === "blackbox.ocr_progress" && isStreamForActiveWorkspace(m)) setProgress(String(m.params.line));
    });
    return () => void off.then((f) => f());
  }, []);

  if (!status?.available) {
    return (
      <p className="m-0 text-sm text-text-secondary">
        <Bot size={14} aria-hidden="true" className="mr-1 inline align-[-2px]" />
        An optional AI review is available when{" "}
        <ExternalLink href="https://github.com/alibaba/open-code-review">Open Code Review</ExternalLink>{" "}
        (<code className="font-mono">ocr</code>) is installed. Without it, BLACKBOX's own scan above is complete.
      </p>
    );
  }

  const target: ReviewTarget =
    kind === "commit" ? { kind, commit } : kind === "range" ? { kind, from, to } : { kind: "working_tree" };

  const start = () =>
    task.run(async () => {
      setProgress(null);
      onReview(await ipc.ocrReview(target));
    });

  return (
    <Card>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="AI review of">
            {(id) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as ReviewTarget["kind"])}>
                <option value="working_tree">Uncommitted changes</option>
                <option value="commit">One commit</option>
                <option value="range">A branch range</option>
              </Select>
            )}
          </Field>
          {kind === "commit" ? (
            <Field label="Commit">{(id) => <Input id={id} value={commit} onChange={(e) => setCommit(e.target.value)} placeholder="abc1234" required />}</Field>
          ) : null}
          {kind === "range" ? (
            <>
              <Field label="From">{(id) => <Input id={id} value={from} onChange={(e) => setFrom(e.target.value)} required />}</Field>
              <Field label="To">{(id) => <Input id={id} value={to} onChange={(e) => setTo(e.target.value)} required />}</Field>
            </>
          ) : null}
          {task.busy ? (
            <Button variant="ghost" onClick={() => void ipc.ocrCancel()}>
              <Square aria-hidden="true" />
              Cancel review
            </Button>
          ) : (
            <Button type="submit" variant="ghost">
              <Bot aria-hidden="true" />
              Run AI review
            </Button>
          )}
        </div>
        <p className="m-0 text-xs text-text-secondary">
          Uses <code className="font-mono">ocr</code> {status.version}. It sends the diff under review to the AI provider you configured in ocr; nothing else is sent.
          Results are added to the findings below and do not change the risk score.
        </p>
        {task.busy && progress ? <p className="m-0 truncate font-mono text-xs text-text-secondary">{progress}</p> : null}
        {task.error ? <ErrorNote>{task.error}</ErrorNote> : null}
      </form>
    </Card>
  );
}
