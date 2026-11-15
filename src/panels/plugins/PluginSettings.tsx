import { useEffect } from "react";
import { Badge, Button, ErrorNote, SectionTitle } from "../../design";
import { usePlugins } from "../../store/plugins";
import { pluginIcon } from "./icons";
import { commandLine } from "./PluginPanel";

/**
 * Third-party plugins found in ~/.depot/plugins. Enabling one approves the
 * command shown next to it; if its manifest changes that command later, it
 * stops running until it is enabled again.
 */
export function PluginSettings() {
  const { plugins, error, load, setEnabled } = usePlugins();
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="grid max-w-2xl gap-3" aria-labelledby="plugins-title">
      <SectionTitle aside={<Button variant="ghost" onClick={() => void load()}>Rescan</Button>}>
        <span id="plugins-title">Plugins</span>
      </SectionTitle>
      <p className="m-0 text-sm text-text-secondary">
        Put a plugin's folder, with its depot.plugin.json, in ~/.depot/plugins. Plugins open their own program; check
        the command before enabling one, because it runs with your permissions.
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {plugins.length === 0 ? <p className="m-0 text-sm text-text-secondary">No plugins found.</p> : null}
      <ul className="m-0 grid list-none gap-2 p-0">
        {plugins.map((p) => {
          const Icon = pluginIcon(p.icon);
          return (
            <li key={p.folder} className="grid gap-1 rounded-base border border-bg-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Icon size={16} strokeWidth={1.75} aria-hidden="true" style={{ color: p.color }} />
                <span className="font-medium">{p.name}</span>
                {p.version ? <span className="text-xs text-text-secondary">{p.version}</span> : null}
                {p.error ? (
                  <Badge tone="error">Cannot load</Badge>
                ) : p.enabled ? (
                  <Badge tone="success">Enabled</Badge>
                ) : p.needs_approval ? (
                  <Badge tone="warning">Changed — review</Badge>
                ) : (
                  <Badge tone="pending">Off</Badge>
                )}
                <span className="flex-1" />
                {p.error ? null : (
                  <Button
                    variant={p.enabled ? "ghost" : "primary"}
                    onClick={() => void setEnabled(p.id, !p.enabled)}
                    aria-label={`${p.enabled ? "Disable" : "Enable"} ${p.name}`}
                  >
                    {p.enabled ? "Disable" : "Enable"}
                  </Button>
                )}
              </div>
              {p.description ? <p className="m-0 text-sm">{p.description}</p> : null}
              {p.error ? (
                <p className="m-0 text-sm text-error">{p.error}</p>
              ) : (
                <>
                  <code className="block overflow-x-auto font-mono text-xs text-text-secondary">{commandLine(p)}</code>
                  {p.executable && p.executable !== p.program ? (
                    <p className="m-0 text-xs text-text-secondary">Runs {p.executable}</p>
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
