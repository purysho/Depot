import { Radio, Send, Trash } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, ErrorNote, Field, Input, PanelHeader, Select, Textarea, httpTone } from "../../design";
import { cn } from "../../design/cn";
import { events, ipc, listen, type StreamMessage } from "../../ipc";
import { useIntent, useLinks } from "../../store/integrations";
import { useWorkspace } from "../../store/workspace";
import type { HttpMethod, MockServerInfo, RelayHistoryItem, RelayRequest, RelaySavedItem, RelaySendResult } from "../../types/tools";
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

/** "page=1" lines → query parameters. Same rule as standalone Relay: split on
 * whichever of "=" or ":" comes first, so "redirect=https://x" keeps its colon. */
export function parseParams(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const colon = line.indexOf(":");
    const at = eq >= 0 && (colon < 0 || eq < colon) ? eq : colon;
    if (at <= 0) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

export function formatParams(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
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
  const [params, setParams] = useState("");
  const [headers, setHeaders] = useState("Accept: application/json");
  const [body, setBody] = useState("");
  const [result, setResult] = useState<RelaySendResult | null>(null);
  const [history, setHistory] = useState<RelayHistoryItem[]>([]);
  const [saved, setSaved] = useState<RelaySavedItem[]>([]);
  const [list, setList] = useState<"history" | "saved">("history");
  const [saveName, setSaveName] = useState("");
  const send = useTask();
  const store = useTask();

  const loadLists = useCallback(() => {
    ipc.relayHistory().then(setHistory, () => setHistory([]));
    ipc.relaySaved().then(setSaved, () => setSaved([]));
  }, []);

  useEffect(() => {
    if (context) loadLists();
  }, [context, loadLists]);

  if (!context) return <NoWorkspace tool="Relay" />;

  const request = (): RelayRequest => ({ method, url, params: parseParams(params), headers: parseHeaders(headers), body });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void send.run(async () => {
      setResult(await ipc.relaySend(request()));
      loadLists();
    });
  };

  const load = (r: RelayRequest) => {
    setMethod(r.method);
    setUrl(r.url);
    setParams(formatParams(r.params));
    setHeaders(formatHeaders(r.headers));
    setBody(r.body);
  };

  const saveRequest = (event: React.FormEvent) => {
    event.preventDefault();
    const name = saveName.trim() || `${method} ${url}`;
    void store.run(async () => {
      setSaved(await ipc.relaySave(name, request()));
      setSaveName("");
      setList("saved");
    });
  };

  const hasBody = !["GET", "HEAD"].includes(method);

  return (
    <>
      <PanelHeader icon={Send} color="var(--color-tool-relay)" title="Relay" subtitle="Requests, saved requests and history are kept in this workspace." />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
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
            <div className={cn("grid gap-3", hasBody ? "lg:grid-cols-3" : "lg:grid-cols-2")}>
              <Field label="Query parameters" hint="One per line: name=value">
                {(id) => <Textarea id={id} rows={4} value={params} onChange={(e) => setParams(e.target.value)} placeholder="page=1" />}
              </Field>
              <Field label="Headers" hint="One per line: Name: value">
                {(id) => <Textarea id={id} rows={4} value={headers} onChange={(e) => setHeaders(e.target.value)} />}
              </Field>
              {hasBody ? (
                <Field label="Body">
                  {(id) => <Textarea id={id} rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder='{"name": "value"}' />}
                </Field>
              ) : null}
            </div>
          </form>
          <form onSubmit={saveRequest} className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Name for the saved request"
              placeholder={url ? `${method} ${url}` : "Name for the saved request"}
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              className="max-w-sm"
            />
            <Button type="submit" variant="ghost" disabled={!url || store.busy}>
              Save request
            </Button>
          </form>
          {send.error ? <ErrorNote>{send.error}</ErrorNote> : null}
          {store.error ? <ErrorNote>{store.error}</ErrorNote> : null}
          <ResponseView result={result} />
          <MockServerCard onUse={(u) => setUrl(u)} />
        </div>

        <aside className="min-w-0">
          <div role="tablist" aria-label="Requests" className="mb-2 flex gap-1">
            {(["history", "saved"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={list === tab}
                onClick={() => setList(tab)}
                className={cn(
                  "rounded-sm px-2 py-1 text-sm",
                  list === tab ? "bg-bg-overlay text-text-primary" : "text-text-secondary hover:text-text-primary",
                )}
              >
                {tab === "history" ? `History (${history.length})` : `Saved (${saved.length})`}
              </button>
            ))}
          </div>
          <div role="tabpanel">
            {list === "history" ? (
              <>
                {history.length === 0 ? <p className="m-0 text-sm text-text-secondary">Sent requests appear here.</p> : null}
                <ul className="m-0 grid list-none gap-1 p-0">
                  {history.slice(0, 40).map((item, i) => (
                    <li key={i}>
                      <RequestRow request={item.request} onLoad={() => load(item.request)}>
                        {item.status ? <Badge tone={httpTone(item.status)}>{item.status}</Badge> : <Badge tone="error">failed</Badge>}
                      </RequestRow>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                {saved.length === 0 ? <p className="m-0 text-sm text-text-secondary">Save a request to keep it here.</p> : null}
                <ul className="m-0 grid list-none gap-1 p-0">
                  {saved.map((item) => (
                    <li key={item.name} className="flex items-center gap-1">
                      <RequestRow request={item.request} label={item.name} onLoad={() => load(item.request)} />
                      <Button
                        variant="ghost"
                        aria-label={`Delete saved request ${item.name}`}
                        onClick={() => store.run(async () => setSaved(await ipc.relayDeleteSaved(item.name)))}
                      >
                        <Trash aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

function RequestRow({ request, label, onLoad, children }: { request: RelayRequest; label?: string; onLoad: () => void; children?: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onLoad}
      className="flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-bg-overlay"
    >
      <span className="w-14 shrink-0 font-mono text-xs text-text-secondary">{request.method}</span>
      <span className="min-w-0 flex-1 truncate">{label ?? request.url}</span>
      {children}
    </button>
  );
}

/** Relay's local mock server: answer one route on 127.0.0.1 to test against. */
function MockServerCard({ onUse }: { onUse: (url: string) => void }) {
  const [servers, setServers] = useState<MockServerInfo[]>([]);
  const [port, setPort] = useState("0");
  const [path, setPath] = useState("/");
  const [status, setStatus] = useState("200");
  const [body, setBody] = useState('{\n  "ok": true\n}');
  const [log, setLog] = useState<string[]>([]);
  const task = useTask();

  useEffect(() => {
    ipc.relayMockList().then(setServers, () => setServers([]));
    const off = listen<StreamMessage>(events.stream, (m) => {
      if (m.name === "relay.mock_log") setLog((l) => [...l, String(m.params.line)].slice(-50));
    });
    return () => void off.then((f) => f());
  }, []);

  const start = (event: React.FormEvent) => {
    event.preventDefault();
    void task.run(async () => {
      const server = await ipc.relayMockStart(Number(port) || 0, [{ path: path || "/", status: Number(status) || 200, body }]);
      setServers((s) => [...s.filter((x) => x.port !== server.port), server]);
      onUse(`${server.url}${path.startsWith("/") ? path : `/${path}`}`);
    });
  };

  return (
    <Card>
      <details>
        <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
          <Radio size={14} aria-hidden="true" className="text-text-secondary" />
          Mock server
          {servers.length ? <Badge tone="success">{servers.length} running</Badge> : null}
        </summary>
        <form onSubmit={start} className="mt-3 grid gap-3">
          <div className="flex flex-wrap gap-3">
            <Field label="Port" hint="0 picks a free port" className="w-28">
              {(id) => <Input id={id} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />}
            </Field>
            <Field label="Path" className="min-w-40 flex-1">
              {(id) => <Input id={id} value={path} onChange={(e) => setPath(e.target.value)} />}
            </Field>
            <Field label="Status" className="w-24">
              {(id) => <Input id={id} inputMode="numeric" value={status} onChange={(e) => setStatus(e.target.value)} />}
            </Field>
          </div>
          <Field label="Response body">{(id) => <Textarea id={id} rows={4} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
          <div>
            <Button type="submit" variant="ghost" disabled={task.busy}>
              Start mock server
            </Button>
          </div>
          {task.error ? <ErrorNote>{task.error}</ErrorNote> : null}
        </form>
        {servers.length ? (
          <ul className="m-0 mt-3 grid list-none gap-1 p-0 text-sm">
            {servers.map((s) => (
              <li key={s.port} className="flex flex-wrap items-center gap-2">
                <Badge tone="success">listening</Badge>
                <span className="font-mono">{s.url}</span>
                <span className="text-text-secondary">{s.routes.map((r) => `${r.path} → ${r.status}`).join(", ")}</span>
                <Button variant="ghost" onClick={() => onUse(`${s.url}${s.routes[0]?.path ?? "/"}`)}>
                  Use in request
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => task.run(async () => {
                    await ipc.relayMockStop(s.port);
                    setServers((all) => all.filter((x) => x.port !== s.port));
                  })}
                >
                  Stop
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {log.length ? (
          <pre className="m-0 mt-3 max-h-32 overflow-auto rounded-sm bg-bg-base p-2 font-mono text-xs text-text-secondary">{log.join("\n")}</pre>
        ) : null}
      </details>
    </Card>
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
