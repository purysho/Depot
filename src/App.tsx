import { useEffect, useMemo, useState } from "react";
import { Sidebar, StatusBar } from "./design";
import type { ToolId } from "./design/tokens";
import { Gallery } from "./design/Gallery";
import { ipc } from "./ipc";
import { BlackboxPanel } from "./panels/blackbox/BlackboxPanel";
import { ForgePanel } from "./panels/forge/ForgePanel";
import { NeedlePanel } from "./panels/needle/NeedlePanel";
import { pluginIcon } from "./panels/plugins/icons";
import { PluginPanel } from "./panels/plugins/PluginPanel";
import { PulsePanel } from "./panels/pulse/PulsePanel";
import { tools } from "./panels/registry";
import { RelayPanel } from "./panels/relay/RelayPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { SwitchyardPanel } from "./panels/switchyard/SwitchyardPanel";
import { startBus } from "./store/bus";
import { startForge } from "./store/forge";
import { startIntegrations, useLinks, useNav, type View } from "./store/integrations";
import { pluginView, usePlugins } from "./store/plugins";
import { startTimeline } from "./store/timeline";
import { startWorkspace, useWorkspace } from "./store/workspace";

const panels: Record<ToolId, () => React.JSX.Element> = {
  switchyard: SwitchyardPanel,
  needle: NeedlePanel,
  relay: RelayPanel,
  pulse: PulsePanel,
  blackbox: BlackboxPanel,
  forge: ForgePanel,
};

/** Start the shared services once for the life of the window. */
function useServices(): void {
  useEffect(() => {
    const stops: Array<() => void> = [];
    let cancelled = false;
    const keep = (stop: () => void) => (cancelled ? stop() : stops.push(stop));
    void startBus().then(keep);
    void startIntegrations().then(keep);
    void startForge().then(keep);
    void startWorkspace().then(keep);
    keep(startTimeline());
    void usePlugins.getState().load();
    return () => {
      cancelled = true;
      stops.forEach((stop) => stop());
    };
  }, []);
}

export default function App() {
  useServices();
  const view = useNav((s) => s.view);
  const go = useNav((s) => s.go);
  const context = useWorkspace((s) => s.context);
  const snapshot = useLinks((s) => s.snapshot);
  const sessionStartedAt = useLinks((s) => s.sessionStartedAt);
  const lastRequestStatus = useLinks((s) => s.lastRequestStatus);
  const [version, setVersion] = useState<string | null>(null);
  const plugins = usePlugins((s) => s.plugins);

  // Built-in tools first, then enabled third-party plugins.
  const items = useMemo(
    () => [
      ...tools,
      ...plugins
        .filter((p) => p.enabled)
        .map((p) => ({ id: pluginView(p.id), name: p.label || p.name, icon: pluginIcon(p.icon), color: p.color })),
    ],
    [plugins],
  );

  useEffect(() => {
    ipc.appVersion().then(setVersion, () => setVersion(null));
  }, []);

  // Record which panel is open, for the session timeline.
  useEffect(() => {
    // Plugin launches are recorded by Rust (depot.plugin_launched) instead.
    if (tools.some((t) => t.id === view) && context) {
      void ipc.busPublish("depot.panel_opened", { tool: view as ToolId }).catch(() => undefined);
    }
  }, [view, context]);

  // Development aid: open the app with #gallery to see every shared component.
  if (import.meta.env.DEV && window.location.hash === "#gallery") return <Gallery />;

  const panel = (): React.JSX.Element => {
    const key = context?.name ?? "";
    if (view === "settings") return <SettingsPanel key={key} version={version} />;
    if (view.startsWith("plugin:")) return <PluginPanel key={`${key}/${view}`} id={view.slice("plugin:".length)} />;
    const Panel = panels[view as ToolId];
    return <Panel key={key} />;
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar
          items={items}
          activeId={view}
          onSelect={(id) => go(id as View)}
          onOpenSettings={() => go("settings")}
          settingsActive={view === "settings"}
        />
        <main className="flex min-w-0 flex-1 flex-col overflow-auto p-5">
          {/* Keyed by workspace: switching workspace starts every panel fresh. */}
          {panel()}
        </main>
      </div>
      <StatusBar
        workspaceName={context?.name ?? null}
        onWorkspaceClick={() => go("switchyard")}
        sessionStartedAt={sessionStartedAt}
        processCount={snapshot ? snapshot.processes.length : null}
        lastRequestStatus={lastRequestStatus}
      />
    </div>
  );
}
