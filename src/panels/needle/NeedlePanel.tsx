import { Copy, ExternalLink as OpenIcon, FolderOpen, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, ErrorNote, Input, PanelHeader, Select, formatBytes } from "../../design";
import { cn } from "../../design/cn";
import { ipc } from "../../ipc";
import { subscribersOf, useNav } from "../../store/integrations";
import { useWorkspace } from "../../store/workspace";
import type { NeedleIndexInfo, NeedleResult, NeedleSearch } from "../../types/tools";
import { errorMessage } from "../../types/workspace";
import { NoWorkspace } from "../shared/NoWorkspace";
import { useTask } from "../shared/useTask";

export function NeedlePanel() {
  const context = useWorkspace((s) => s.context);
  const go = useNav((s) => s.go);
  const [info, setInfo] = useState<NeedleIndexInfo | null | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [ext, setExt] = useState("");
  const [search, setSearch] = useState<NeedleSearch | null>(null);
  const [selected, setSelected] = useState<NeedleResult | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const build = useTask();
  const find = useTask();
  const forgeListens = subscribersOf("needle.file_found").includes("forge");

  const loadInfo = useCallback(() => {
    ipc.needleIndexInfo().then(setInfo, () => setInfo(null));
  }, []);

  useEffect(() => {
    if (context) loadInfo();
  }, [context, loadInfo]);

  if (!context) return <NoWorkspace tool="Needle" />;

  const buildIndex = () => build.run(async () => ipc.needleBuildIndex().then(loadInfo));

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setSelected(null);
    // An empty query with a type chosen lists the indexed files of that type.
    void find.run(async () => setSearch(await ipc.needleSearch(query, 50, ext || undefined)));
  };

  const pick = (result: NeedleResult) => {
    setSelected(result);
    // A user action, so the panel publishes it; Forge keeps it for "Add to workflow".
    ipc.busPublish("needle.file_found", { path: result.path, query, score: result.score }).catch((e) => setNote(errorMessage(e)));
  };

  const copy = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setNote("Path copied.");
    } catch {
      setNote("Could not copy: the clipboard is not available.");
    }
  };

  const roots = context.tools.needle.roots.length ? context.tools.needle.roots : [context.root];

  return (
    <>
      <PanelHeader
        icon={Search}
        color="var(--color-tool-needle)"
        title="Needle"
        subtitle={
          info
            ? `${info.documents.toLocaleString()} files · ${formatBytes(info.total_size)} indexed from ${roots.join(", ")}`
            : info === null
              ? `No index yet for ${roots.join(", ")}`
              : "Reading the index…"
        }
        actions={
          <Button variant={info ? "ghost" : "primary"} onClick={buildIndex} disabled={build.busy}>
            <RefreshCw aria-hidden="true" />
            {build.busy ? "Indexing…" : info ? "Update index" : "Build index"}
          </Button>
        }
      />
      {build.error ? <ErrorNote className="mb-3">{build.error}</ErrorNote> : null}

      {info === null && !build.busy ? (
        <EmptyState
          icon={Search}
          title="Build the index to search"
          description="Needle reads the text files in this workspace once, then searches them instantly. Nothing leaves your machine."
          action={<Button onClick={buildIndex}>Build index</Button>}
        />
      ) : (
        <>
          <form onSubmit={submit} className="mb-3 flex gap-2">
            <Input
              aria-label="Search files"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Words to find, or "an exact phrase"'
            />
            {info && Object.keys(info.by_extension ?? {}).length > 1 ? (
              <Select aria-label="File type" value={ext} onChange={(e) => setExt(e.target.value)}>
                <option value="">All types</option>
                {Object.entries(info.by_extension ?? {}).map(([e, count]) => (
                  <option key={e} value={e === "(none)" ? "" : e} disabled={e === "(none)"}>
                    {e} ({count})
                  </option>
                ))}
              </Select>
            ) : null}
            <Button type="submit" disabled={find.busy}>
              Search
            </Button>
          </form>
          {find.error ? <ErrorNote className="mb-3">{find.error}</ErrorNote> : null}
          {note ? (
            <p role="status" className="m-0 mb-3 text-sm text-text-secondary">
              {note}
            </p>
          ) : null}
          {search ? (
            <p className="m-0 mb-2 text-sm text-text-secondary">
              {search.results.length} {search.results.length === 1 ? "result" : "results"} in {search.duration_ms} ms
              {Object.keys(search.suggestions).length
                ? ` · also matched ${Object.values(search.suggestions).flat().slice(0, 4).join(", ")}`
                : ""}
            </p>
          ) : null}
          <ul className="m-0 grid list-none gap-1 p-0">
            {search?.results.map((r) => {
              const isSelected = selected?.path === r.path;
              return (
                <li key={r.path}>
                  <div className={cn("rounded-md border px-3 py-2", isSelected ? "border-text-link bg-bg-surface" : "border-transparent")}>
                    <button type="button" onClick={() => pick(r)} className="block w-full text-left" aria-pressed={isSelected}>
                      <span className="font-medium">{r.name}</span>
                      <span className="ml-2 font-mono text-xs text-text-secondary">{r.path}</span>
                      {r.snippet ? <span className="mt-1 line-clamp-2 block font-mono text-xs text-text-secondary">{r.snippet}</span> : null}
                    </button>
                    {isSelected ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {forgeListens ? (
                          <Button onClick={() => go("forge", { tool: "forge", addPath: r.path })}>Add to workflow →</Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          onClick={() => ipc.needleOpen(r.path).then(() => setNote(null), (e) => setNote(errorMessage(e)))}
                        >
                          <OpenIcon aria-hidden="true" />
                          Open
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => ipc.needleReveal(r.path).then(() => setNote(null), (e) => setNote(errorMessage(e)))}
                        >
                          <FolderOpen aria-hidden="true" />
                          Reveal in folder
                        </Button>
                        <Button variant="ghost" onClick={() => copy(r.path)}>
                          <Copy aria-hidden="true" />
                          Copy path
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {search && search.results.length === 0 ? (
            <EmptyState icon={Search} title="No matches" description="Try fewer words, or update the index if files changed." />
          ) : null}
        </>
      )}
    </>
  );
}
