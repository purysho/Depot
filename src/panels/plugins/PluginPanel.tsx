import { Puzzle } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorNote, PanelHeader, SectionTitle } from "../../design";
import { ipc } from "../../ipc";
import { useNav } from "../../store/integrations";
import { usePlugins } from "../../store/plugins";
import { useWorkspace } from "../../store/workspace";
import type { PluginInfo } from "../../types/tools";
import { pluginIcon } from "./icons";

/** The command as it will run, each argument quoted only when it has spaces. */
export function commandLine(plugin: Pick<PluginInfo, "program" | "args">): string {
  const quote = (s: string) => (s === "" || /[\s"']/.test(s) ? JSON.stringify(s) : s);
  return [plugin.program, ...plugin.args].map(quote).join(" ");
}

/** A third-party handoff plugin: what it runs, and a button to run it. */
export function PluginPanel({ id }: { id: string }) {
  const plugin = usePlugins((s) => s.plugins.find((p) => p.id === id));
  const context = useWorkspace((s) => s.context);
  const go = useNav((s) => s.go);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!plugin) {
    return <EmptyState icon={Puzzle} title="Plugin not found" description="It may have been removed from ~/.depot/plugins." />;
  }

  const launch = async () => {
    setBusy(true);
    setResult(null);
    try {
      const pid = await ipc.pluginsLaunch(plugin.id);
      setResult({ ok: true, text: `Started ${plugin.name} · pid ${pid}` });
    } catch (e) {
      setResult({ ok: false, text: e && typeof e === "object" && "message" in e ? String(e.message) : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const blocked = plugin.workspace_scoped && !context;

  return (
    <>
      <PanelHeader
        icon={pluginIcon(plugin.icon)}
        color={plugin.color}
        title={plugin.name}
        subtitle={`Third-party plugin${plugin.version ? ` · ${plugin.version}` : ""}`}
      />
      <div className="grid max-w-2xl gap-4">
        {plugin.description ? <p className="m-0 text-sm">{plugin.description}</p> : null}
        <Card className="grid gap-2">
          <SectionTitle aside={<Badge tone="info">Runs outside Depot</Badge>}>What it runs</SectionTitle>
          <code className="block overflow-x-auto rounded-base bg-bg-base p-2 font-mono text-xs">{commandLine(plugin)}</code>
          <p className="m-0 text-xs text-text-secondary">
            {"{workspace.root}"} and {"{workspace.name}"} are filled in from the open workspace. Each argument is passed as
            it is, with no shell. From {plugin.folder}
          </p>
        </Card>
        {plugin.error ? <ErrorNote>{plugin.error}</ErrorNote> : null}
        {!plugin.error && !plugin.enabled ? (
          <ErrorNote>
            {plugin.needs_approval
              ? `${plugin.name} changed since you enabled it. Review it in Settings and enable it again.`
              : `${plugin.name} is not enabled. Enable it in Settings once you have checked what it runs.`}
          </ErrorNote>
        ) : null}
        {blocked && plugin.enabled ? <p className="m-0 text-sm text-text-secondary">Open a workspace first: this plugin works on one.</p> : null}
        <div className="flex items-center gap-3">
          {plugin.enabled ? (
            <Button onClick={() => void launch()} disabled={busy || blocked}>
              Open {plugin.name}
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => go("settings")}>
              Go to Settings
            </Button>
          )}
          {result ? (
            result.ok ? (
              <span role="status" className="text-sm text-text-secondary">
                {result.text}
              </span>
            ) : null
          ) : null}
        </div>
        {result && !result.ok ? <ErrorNote>{result.text}</ErrorNote> : null}
      </div>
    </>
  );
}
