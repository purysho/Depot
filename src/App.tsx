import { useEffect, useState } from "react";
import { Sidebar, StatusBar } from "./design";
import type { ToolId } from "./design/tokens";
import { Gallery } from "./design/Gallery";
import { ipc } from "./ipc";
import { BlackboxPanel } from "./panels/blackbox/BlackboxPanel";
import { ForgePanel } from "./panels/forge/ForgePanel";
import { NeedlePanel } from "./panels/needle/NeedlePanel";
import { PulsePanel } from "./panels/pulse/PulsePanel";
import { tools } from "./panels/registry";
import { RelayPanel } from "./panels/relay/RelayPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { SwitchyardPanel } from "./panels/switchyard/SwitchyardPanel";
import { startBus } from "./store/bus";
import { startForge } from "./store/forge";
import { startIntegrations, useLinks, useNav } from "./store/integrations";
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

  useEffect(() => {
    ipc.appVersion().then(setVersion, () => setVersion(null));
  }, []);

  // Record which panel is open, for the session timeline.
  useEffect(() => {
    if (view !== "settings" && context) void ipc.busPublish("depot.panel_opened", { tool: view }).catch(() => undefined);
  }, [view, context]);

  // Development aid: open the app with #gallery to see every shared component.
  if (import.meta.env.DEV && window.location.hash === "#gallery") return <Gallery />;

  const Panel = view === "settings" ? null : panels[view];

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar
          items={tools}
          activeId={view}
          onSelect={(id) => go(id as ToolId)}
          onOpenSettings={() => go("settings")}
          settingsActive={view === "settings"}
        />
        <main className="flex min-w-0 flex-1 flex-col overflow-auto p-5">
          {/* Keyed by workspace: switching workspace starts every panel fresh. */}
          {Panel ? <Panel key={context?.name ?? ""} /> : <SettingsPanel key={context?.name ?? ""} version={version} />}
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
