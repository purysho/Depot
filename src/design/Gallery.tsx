import { CircleCheck, CircleExclamationPoint, Inbox, LoaderCircle, OctagonX, Info, Play } from "lucide-react";
import { useState, type ReactNode } from "react";
import { tools } from "../panels/registry";
import { Badge } from "./components/Badge";
import { Button } from "./components/Button";
import { Card, CardDescription, CardTitle } from "./components/Card";
import { EmptyState } from "./components/EmptyState";
import { Input } from "./components/Input";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";

/** Every shared component on one page, for review and screenshots. Dev only. */
export function Gallery() {
  const [active, setActive] = useState("needle");
  const [startedAt] = useState(() => Date.now() - 3_723_000);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar items={tools} activeId={active} onSelect={setActive} onOpenSettings={() => setActive("settings")} />
        <main className="min-w-0 flex-1 overflow-auto p-5">
          <h1 className="m-0 mb-5 text-xl font-semibold">Design system</h1>
          <div className="grid max-w-3xl gap-5">
            <Section title="Buttons">
              <Button>
                <Play aria-hidden="true" />
                Start session
              </Button>
              <Button variant="ghost">Cancel</Button>
              <Button disabled>Disabled</Button>
            </Section>

            <Section title="Badges">
              <Badge tone="success" icon={<CircleCheck aria-hidden="true" />}>Running</Badge>
              <Badge tone="warning" icon={<CircleExclamationPoint aria-hidden="true" />}>Degraded</Badge>
              <Badge tone="error" icon={<OctagonX aria-hidden="true" />}>Stopped</Badge>
              <Badge tone="pending" icon={<LoaderCircle aria-hidden="true" />}>Starting</Badge>
              <Badge tone="info" icon={<Info aria-hidden="true" />}>3 findings</Badge>
            </Section>

            <Section title="Input">
              <label className="grid w-72 gap-1 text-sm text-text-secondary">
                Request URL
                <Input placeholder="http://localhost:8080/health" />
              </label>
              <label className="grid w-72 gap-1 text-sm text-text-secondary">
                Port
                <Input defaultValue="80a" aria-invalid="true" />
              </label>
            </Section>

            <Section title="Cards">
              <Card interactive className="w-72">
                <CardTitle>api-gateway</CardTitle>
                <CardDescription className="mt-1">~/work/api-gateway · 4 services</CardDescription>
                <div className="mt-3 flex gap-2">
                  <Badge tone="success">Running</Badge>
                  <Badge tone="warning">Risk 42</Badge>
                </div>
              </Card>
              <Card className="w-72">
                <CardTitle>Static card</CardTitle>
                <CardDescription className="mt-1">No hover border: it does nothing on click.</CardDescription>
              </Card>
            </Section>

            <Section title="Empty state">
              <Card className="h-56 w-full">
                <EmptyState
                  icon={Inbox}
                  title="No requests yet"
                  description="Send a request and it will appear here with its status and timing."
                  action={<Button variant="ghost">New request</Button>}
                />
              </Card>
            </Section>
          </div>
        </main>
      </div>
      <StatusBar
        workspaceName="api-gateway"
        onWorkspaceClick={() => undefined}
        sessionStartedAt={startedAt}
        processCount={14}
        lastRequestStatus={404}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="m-0 mb-2 text-sm font-medium text-text-secondary">{title}</h2>
      <div className="flex flex-wrap items-start gap-3">{children}</div>
    </section>
  );
}
