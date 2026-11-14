import { Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState, ExternalLink, Sidebar, StatusBar } from "./design";
import type { ToolId } from "./design/tokens";
import { Gallery } from "./design/Gallery";
import { appVersion } from "./ipc";
import { toolById, tools } from "./panels/registry";

type View = ToolId | "settings";

export default function App() {
  const [view, setView] = useState<View>("switchyard");
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    appVersion().then(setVersion, () => setVersion(null));
  }, []);

  // Development aid: open the app with #gallery to see every shared component.
  if (import.meta.env.DEV && window.location.hash === "#gallery") return <Gallery />;

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar
          items={tools}
          activeId={view}
          onSelect={(id) => setView(id as ToolId)}
          onOpenSettings={() => setView("settings")}
          settingsActive={view === "settings"}
        />
        <main className="min-w-0 flex-1 overflow-auto p-5">
          {view === "settings" ? <SettingsPlaceholder version={version} /> : <PanelPlaceholder id={view} />}
        </main>
      </div>
      {/* Workspace, session, Pulse and Relay data arrive with the stores in the next build. */}
      <StatusBar workspaceName={null} sessionStartedAt={null} processCount={null} lastRequestStatus={null} />
    </div>
  );
}

function PanelPlaceholder({ id }: { id: ToolId }) {
  const tool = toolById(id);
  return (
    <EmptyState
      icon={tool.icon}
      title={`${tool.name} isn't in Depot yet`}
      description={
        <>
          {tool.description}. Until this panel ships, use the{" "}
          <ExternalLink href={tool.repo}>standalone {tool.name} app</ExternalLink>
          .
        </>
      }
    />
  );
}

function SettingsPlaceholder({ version }: { version: string | null }) {
  return (
    <EmptyState
      icon={Settings}
      title="No settings yet"
      description={version ? `Depot ${version}` : "Depot (running outside the desktop shell)"}
    />
  );
}
