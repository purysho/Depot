import { Settings } from "lucide-react";
import { useState } from "react";
import { Button, ErrorNote, Field, Input, PanelHeader, SectionTitle } from "../design";
import { useWorkspace } from "../store/workspace";
import { PluginSettings } from "./plugins/PluginSettings";

/** Settings for the open workspace. Each change is validated and saved by Rust. */
export function SettingsPanel({ version }: { version: string | null }) {
  const { context, updateTool, error } = useWorkspace();
  // Remounted when the workspace changes (see App), so initial state is enough.
  const [baseUrl, setBaseUrl] = useState(context?.tools.relay.base_url ?? "");
  const [refresh, setRefresh] = useState(String(context?.tools.pulse.refresh_seconds ?? 3));
  const [repo, setRepo] = useState(context?.tools.blackbox.repo ?? "");
  const [saved, setSaved] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaved(false);
    try {
      await updateTool("relay", { base_url: baseUrl.trim() || null });
      await updateTool("pulse", { refresh_seconds: Number(refresh) });
      await updateTool("blackbox", { repo: repo.trim() || null });
      setSaved(true);
    } catch {
      // shown through `error`
    }
  };

  return (
    <>
      <PanelHeader
        icon={Settings}
        color="var(--color-text-secondary)"
        title="Settings"
        subtitle={version ? `Depot ${version}` : "Depot (running outside the desktop shell)"}
      />
      {context ? (
        <form onSubmit={save} className="grid max-w-xl gap-4">
          <SectionTitle>Workspace {context.name}</SectionTitle>
          <Field label="Relay base URL" hint="Filled in when a new request has no URL.">
            {(id) => <Input id={id} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:8080" />}
          </Field>
          <Field label="Pulse refresh (seconds)" hint="2 or more. Collecting process data is costly on Windows.">
            {(id) => <Input id={id} type="number" min={2} max={60} value={refresh} onChange={(e) => setRefresh(e.target.value)} />}
          </Field>
          <Field label="BLACKBOX repository" hint="Leave empty to scan the workspace folder.">
            {(id) => <Input id={id} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={context.root} />}
          </Field>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div className="flex items-center gap-3">
            <Button type="submit">Save settings</Button>
            {saved ? (
              <span role="status" className="text-sm text-text-secondary">
                Saved.
              </span>
            ) : null}
          </div>
        </form>
      ) : (
        <p className="m-0 text-sm text-text-secondary">Open a workspace to change its settings.</p>
      )}
      <div className="mt-8">
        <PluginSettings />
      </div>
    </>
  );
}
