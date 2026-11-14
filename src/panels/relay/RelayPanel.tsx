import { Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, ErrorNote, Field, Input, PanelHeader, SectionTitle, Select, Textarea, httpTone } from "../../design";
import { cn } from "../../design/cn";
import { ipc } from "../../ipc";
import { useIntent, useLinks } from "../../store/integrations";
import { useWorkspace } from "../../store/workspace";
import type { HttpMethod, RelayHistoryItem, RelayRequest, RelaySendResult } from "../../types/tools";
import { NoWorkspace } from "../shared/NoWorkspace";
import { useTask } from "../shared/useTask";

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** "Accept: application/json" lines → object. Lines without a colon are ignored. */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const at = line.indexOf(":");
    if (!line || line.startsWith("#") || at <= 0) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

export function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

export function RelayPanel() {
  const context = useWorkspace((s) => s.context);
  const detected = useLinks((s) => s.detectedPorts);
  const intent = useIntent("relay");
  const [method, setMethod] = useState<HttpMethod>("GET");
  const [url, setUrl] = useState(intent?.url ?? context?.tools.relay.base_url ?? "");
  const [headers, setHeaders] = useState("Accept: application/json");
  const [body, setBody] = useState("");
  const [result, setResult] = useState<RelaySendResult | null>(null);
  const [history, setHistory] = useState<RelayHistoryItem[]>([]);
  const send = useTask();

  const loadHistory = useCallback(() => {
    ipc.relayHistory().then(setHistory, () => setHistory([]));
  }, []);

  useEffect(() => {
    if (context) loadHistory();
  }, [context, loadHistory]);

  if (!context) return <NoWorkspace tool="Relay" />;

  const request = (): RelayRequest => ({ method, url, params: {}, headers: parseHeaders(headers), body });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void send.run(async () => {
      setResult(await ipc.relaySend(request()));
      loadHistory();
    });
  };

  const load = (item: RelayHistoryItem) => {
    setMethod(item.request.method);
    setUrl(item.request.url);
    setHeaders(formatHeaders(item.request.headers));
    setBody(item.request.body);
  };

  const hasBody = !["GET", "HEAD"].includes(method);

  return (
    <>
      <PanelHeader icon={Send} color="var(--color-tool-relay)" title="Relay" subtitle="Requests and history are kept in this workspace." />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="grid min-w-0 content-start gap-4">
          <form onSubmit={submit} className="grid gap-3">
            <div className="flex gap-2">
              <Select aria-label="Method" value={method} onChange={(e) => setMethod(e.target.value as HttpMethod)}>
                {METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </Select>
              <Input aria-label="URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:8080/health" required />
              <Button type="submit" disabled={send.busy || !url}>
                {send.busy ? "Sending…" : "Send"}
              </Button>
            </div>
            {detected.length ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-text-secondary">Seen by Pulse:</span>
                {detected.slice(0, 6).map((p) => (
                  <button
                    key={`${p.pid}:${p.port}`}
                    type="button"
                    className="rounded-full border border-bg-border px-2 py-0.5 text-xs hover:border-text-link"
                    onClick={() => setUrl(`http://127.0.0.1:${p.port}/`)}
                  >
                    {p.process_name} :{p.port}
                  </button>
                ))}
              </div>
            ) : null}
            <div className={cn("grid gap-3", hasBody && "md:grid-cols-2")}>
              <Field label="Headers" hint="One per line: Name: value">
                {(id) => <Textarea id={id} rows={5} value={headers} onChange={(e) => setHeaders(e.target.value)} />}
              </Field>
              {hasBody ? (
                <Field label="Body">
                  {(id) => <Textarea id={id} rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder='{"name": "value"}' />}
                </Field>
              ) : null}
            </div>
          </form>
          {send.error ? <ErrorNote>{send.error}</ErrorNote> : null}
          <ResponseView result={result} />
        </div>

        <aside className="min-w-0">
          <SectionTitle>History</SectionTitle>
          {history.length === 0 ? <p className="m-0 text-sm text-text-secondary">Sent requests appear here.</p> : null}
          <ul className="m-0 grid list-none gap-1 p-0">
            {history.slice(0, 40).map((item, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => load(item)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-bg-overlay"
                >
                  <span className="w-14 shrink-0 font-mono text-xs text-text-secondary">{item.request.method}</span>
                  <span className="min-w-0 flex-1 truncate">{item.request.url}</span>
                  {item.status ? (
                    <Badge tone={httpTone(item.status)}>{item.status}</Badge>
                  ) : (
                    <Badge tone="error">failed</Badge>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </>
  );
}

function ResponseView({ result }: { result: RelaySendResult | null }) {
  if (!result) return null;
  if (!result.ok) return <ErrorNote>Request failed: {result.error}</ErrorNote>;
  const r = result.response;
  return (
    <section aria-label="Response" className="grid gap-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge tone={httpTone(r.status)}>
          {r.status} {r.reason}
        </Badge>
        <span className="text-text-secondary tabular-nums">{Math.round(r.elapsed_ms)} ms</span>
        <span className="text-text-secondary tabular-nums">{r.size_bytes.toLocaleString()} B</span>
      </div>
      <pre className="m-0 max-h-[50vh] overflow-auto rounded-md border border-bg-border bg-bg-surface p-3 font-mono text-sm whitespace-pre-wrap">
        {r.body || <span className="text-text-secondary">(empty body)</span>}
      </pre>
      <details className="text-sm">
        <summary className="cursor-pointer text-text-secondary">Response headers ({Object.keys(r.headers).length})</summary>
        <pre className="m-0 mt-2 overflow-auto font-mono text-xs">{formatHeaders(r.headers)}</pre>
      </details>
    </section>
  );
}
