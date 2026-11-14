import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import { FolderOpen } from "lucide-react";
import { useState } from "react";
import { Button, Card, CardDescription, CardTitle, ErrorNote, Field, Input, SectionTitle } from "../../design";
import { useWorkspace } from "../../store/workspace";

/** A workspace name from a folder name: "My API" → "my-api". */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Lists workspaces to open, and creates a new one from a folder. */
export function WorkspacePicker({ onDone }: { onDone?: () => void }) {
  const { workspaces, context, open: openWorkspace, create, error } = useWorkspace();
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState(false);

  const chooseFolder = async () => {
    const picked = await open({ directory: true, multiple: false, title: "Choose the workspace folder" });
    if (typeof picked === "string") {
      setRoot(picked);
      if (!name) setName(slugify(picked.split(/[\\/]/).filter(Boolean).pop() ?? ""));
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await create(name, root);
      setName("");
      setRoot("");
      onDone?.();
    } catch {
      // shown through `error`
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid max-w-3xl gap-6">
      {workspaces.length > 0 ? (
        <section>
          <SectionTitle>Your workspaces</SectionTitle>
          <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">
            {workspaces.map((w) => (
              <li key={w.name}>
                <Card interactive className="relative">
                  <CardTitle>
                    <button
                      type="button"
                      onClick={() => openWorkspace(w.name).then(onDone, () => undefined)}
                      className="text-left after:absolute after:inset-0 after:content-['']"
                      aria-current={context?.name === w.name ? "true" : undefined}
                    >
                      {w.name}
                    </button>
                  </CardTitle>
                  <CardDescription className="mt-1 truncate font-mono">{w.root}</CardDescription>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <SectionTitle>New workspace</SectionTitle>
        <form onSubmit={submit} className="grid gap-3 rounded-md border border-bg-border bg-bg-surface p-4">
          <Field label="Folder" hint="Every tool works inside this folder: Needle indexes it, BLACKBOX scans it.">
            {(id) => (
              <div className="flex gap-2">
                <Input id={id} value={root} onChange={(e) => setRoot(e.target.value)} placeholder="/home/you/work/project" required />
                {isTauri() ? (
                  <Button variant="ghost" onClick={chooseFolder}>
                    <FolderOpen aria-hidden="true" />
                    Choose…
                  </Button>
                ) : null}
              </div>
            )}
          </Field>
          <Field label="Name" hint="Lowercase letters, digits and hyphens.">
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(slugify(e.target.value) || e.target.value.toLowerCase())}
                pattern="[a-z0-9][a-z0-9-]{0,63}"
                required
              />
            )}
          </Field>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div>
            <Button type="submit" disabled={busy || !name || !root}>
              Create workspace
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
