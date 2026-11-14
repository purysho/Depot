import { FolderOpen } from "lucide-react";
import { Button, EmptyState } from "../../design";
import { useNav } from "../../store/integrations";

/** Shown by every tool panel until a workspace is open. */
export function NoWorkspace({ tool }: { tool: string }) {
  const go = useNav((s) => s.go);
  return (
    <EmptyState
      icon={FolderOpen}
      title="Open a workspace first"
      description={`${tool} works on the folders of the current workspace.`}
      action={
        <Button variant="ghost" onClick={() => go("switchyard")}>
          Choose a workspace
        </Button>
      }
    />
  );
}
