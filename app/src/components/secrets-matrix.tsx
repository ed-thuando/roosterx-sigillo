// Secrets Matrix: grid of secrets (rows) × environments (columns).
// Shows every secret name across all readable environments in one view, with
// each env's value inline. Values are masked by default; the per-row eye reveals.
// Editing a cell (or adding a new key row) drafts a change; Save writes drafts
// grouped per environment via saveSecretsAction. A per-row arrow fills every
// environment with the key's known value; per-env .env import/download and
// per-key delete round out the actions.

"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import { KeyIcon, EyeIcon, EyeOffIcon, ArrowRightIcon, DownloadIcon, UploadIcon, PlusIcon, TrashIcon } from "lucide-react";
import { Badge } from "sigillo-app/src/components/ui/badge";
import { Button } from "sigillo-app/src/components/ui/button";
import { Frame } from "sigillo-app/src/components/ui/frame";
import { Input } from "sigillo-app/src/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "sigillo-app/src/components/ui/table";
import { cn } from "sigillo-app/src/lib/utils";
import { parseEnv } from "sigillo-app/src/lib/parse-env";
import { useLoaderData } from "spiceflow/react";
import { deleteSecretAction, saveSecretsAction } from "../actions.ts";

type Environment = { id: string; name: string; slug: string };

// draftValues[secretName][envId] = pending value for that cell
type DraftValues = Record<string, Record<string, string>>;

export function SecretsMatrix() {
  const { environments, allSecretNames, secretsByEnv, canWriteSecret } =
    useLoaderData("/dash/projects/:projectId/envs/:envSlug");

  const secretNames = useMemo(() => [...allSecretNames].sort(), [allSecretNames]);

  // Always show every readable environment as a column.
  const selectedEnvs = environments;

  const [draftValues, setDraftValues] = useState<DraftValues>({});
  const [rowVisible, setRowVisible] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  // Env targeted by the hidden file input for .env import.
  const [importEnvId, setImportEnvId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Draft rows for brand-new secret keys (name + per-env values), saved with the rest.
  const [newRows, setNewRows] = useState<{ id: string; name: string; values: Record<string, string> }[]>([]);

  const setDraft = useCallback((name: string, envId: string, value: string) => {
    setDraftValues((prev) => ({ ...prev, [name]: { ...prev[name], [envId]: value } }));
  }, []);

  const addNewRow = useCallback(() => {
    setNewRows((prev) => [...prev, { id: crypto.randomUUID(), name: "", values: {} }]);
  }, []);

  const setNewRowName = useCallback((id: string, name: string) => {
    setNewRows((prev) => prev.map((r) => (r.id === id ? { ...r, name } : r)));
  }, []);

  const setNewRowValue = useCallback((id: string, envId: string, value: string) => {
    setNewRows((prev) => prev.map((r) => (r.id === id ? { ...r, values: { ...r.values, [envId]: value } } : r)));
  }, []);

  const removeNewRow = useCallback((id: string) => {
    setNewRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  // Delete an existing secret key from every environment (server enforces per-env ability).
  const handleDelete = useCallback(async (name: string) => {
    if (!window.confirm(`Delete "${name}" from all environments?`)) return;
    try {
      await deleteSecretAction({ name, environmentIds: environments.map((e) => e.id) });
    } catch (e: any) {
      alert(e?.message || "Failed to delete secret");
    }
  }, [environments]);

  // Base value stored server-side for a cell (undefined = secret absent in env).
  const baseValue = useCallback(
    (name: string, envId: string): string | undefined => secretsByEnv[envId]?.[name],
    [secretsByEnv],
  );

  // Fill every environment with this key's first known value (draft or stored).
  const fillRow = useCallback((name: string) => {
    let val: string | undefined;
    for (const env of selectedEnvs) {
      const v = draftValues[name]?.[env.id] ?? secretsByEnv[env.id]?.[name];
      if (v !== undefined) { val = v; break; }
    }
    if (val === undefined) return;
    setDraftValues((prev) => {
      const row = { ...prev[name] };
      for (const env of selectedEnvs) row[env.id] = val!;
      return { ...prev, [name]: row };
    });
  }, [draftValues, secretsByEnv, selectedEnvs]);

  // Download one environment's current values as a .env file.
  const downloadEnv = useCallback((env: Environment) => {
    const text = secretNames
      .map((name) => [name, draftValues[name]?.[env.id] ?? secretsByEnv[env.id]?.[name]] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join("\n") + "\n";
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `.env.${env.slug}`;
    link.click();
    URL.revokeObjectURL(url);
  }, [secretNames, draftValues, secretsByEnv]);

  // Import a .env file's keys/values into a single environment.
  const importEnvFile = useCallback(async (file: File, envId: string) => {
    const parsed = parseEnv(await file.text());
    const edits = Object.entries(parsed).map(([name, value]) => ({ name, value }));
    if (edits.length === 0) return;
    setSaving(true);
    try {
      await saveSecretsAction({ edits, environmentIds: [envId] });
    } catch (e: any) {
      alert(e?.message || "Failed to import .env");
    } finally {
      setSaving(false);
    }
  }, []);

  // Flatten drafts that differ from the stored value, grouped by env for save.
  const dirtyByEnv = useMemo(() => {
    const byEnv: Record<string, { name: string; value: string }[]> = {};
    for (const [name, envValues] of Object.entries(draftValues)) {
      for (const [envId, value] of Object.entries(envValues)) {
        if (value === (baseValue(name, envId) ?? "")) continue;
        (byEnv[envId] ??= []).push({ name, value });
      }
    }
    return byEnv;
  }, [draftValues, baseValue]);

  // Combine edited-cell drafts with new-key rows into a single per-env edit list.
  // Each named new row contributes one edit per env where a value was typed.
  const editsByEnv = useMemo(() => {
    const byEnv: Record<string, { name: string; value: string }[]> = {};
    for (const [envId, edits] of Object.entries(dirtyByEnv)) byEnv[envId] = [...edits];
    for (const row of newRows) {
      const name = row.name.trim();
      if (!name) continue;
      for (const env of selectedEnvs) {
        const value = row.values[env.id];
        if (!value) continue; // skip envs with no value typed
        (byEnv[env.id] ??= []).push({ name, value });
      }
    }
    return byEnv;
  }, [dirtyByEnv, newRows, selectedEnvs]);

  const dirtyCount = useMemo(
    () => Object.values(editsByEnv).reduce((sum, edits) => sum + edits.length, 0),
    [editsByEnv],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // One save call per environment; the server enforces write ability per env.
      for (const [envId, edits] of Object.entries(editsByEnv)) {
        if (edits.length > 0) await saveSecretsAction({ edits, environmentIds: [envId] });
      }
      setDraftValues({});
      setNewRows([]);
    } catch (e: any) {
      alert(e?.message || "Failed to save secrets");
    } finally {
      setSaving(false);
    }
  }, [editsByEnv]);

  if (secretNames.length === 0 && newRows.length === 0) {
    return (
      <Frame className="w-full">
        <div className="py-12 text-center text-muted-foreground">
          <KeyIcon className="mx-auto size-10 text-muted-foreground/30" />
          <p className="mt-2 text-sm">No secrets across any environment yet.</p>
          {canWriteSecret && (
            <Button
              size="xs"
              className="mt-4"
              onClick={addNewRow}
              title="Add a new secret key"
              aria-label="Add a new secret key"
            >
              <PlusIcon className="size-3.5" />
              Add secret
            </Button>
          )}
        </div>
      </Frame>
    );
  }

  return (
    <>
      <Frame className="w-full gap-3">
        {canWriteSecret && (
          <div className="flex items-center px-1">
            <Button
              size="xs"
              onClick={addNewRow}
              title="Add a new secret key"
              aria-label="Add a new secret key"
            >
              <PlusIcon className="size-3.5" />
              Add secret
            </Button>
          </div>
        )}
        <div className="overflow-x-auto">
          <Table className="min-w-[600px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="min-w-48">Secret</TableHead>
                {selectedEnvs.map((env) => (
                  <TableHead key={env.id} className="min-w-40">
                    <div className="flex items-center justify-between gap-1">
                      <span>{env.name}</span>
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => downloadEnv(env)}
                          className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                          title={`Download ${env.name} as a .env file`}
                          aria-label={`Download ${env.name} as a .env file`}
                        >
                          <DownloadIcon className="size-3.5" />
                        </button>
                        {canWriteSecret && (
                          <button
                            type="button"
                            onClick={() => { setImportEnvId(env.id); fileInputRef.current?.click(); }}
                            className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                            title={`Import a .env file into ${env.name}`}
                            aria-label={`Import a .env file into ${env.name}`}
                          >
                            <UploadIcon className="size-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </TableHead>
                ))}
                {canWriteSecret && selectedEnvs.length > 1 && (
                  <TableHead className="w-10 text-center" />
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {newRows.map((row) => (
                <TableRow key={row.id} className="bg-primary/5 dark:bg-primary/10">
                  <TableCell className="min-w-0">
                    <div className="flex items-center gap-2">
                      <KeyIcon className="size-4 shrink-0 text-muted-foreground" />
                      <Input
                        type="text"
                        inputSize="sm"
                        autoFocus
                        autoComplete="off"
                        data-1p-ignore
                        data-lpignore="true"
                        value={row.name}
                        placeholder="SECRET_KEY"
                        onChange={(e) => setNewRowName(row.id, e.target.value)}
                        className="w-full min-w-0 mono-sm font-medium"
                      />
                      <button
                        type="button"
                        onClick={() => removeNewRow(row.id)}
                        className="ml-auto shrink-0 cursor-pointer text-muted-foreground hover:text-destructive"
                        title="Remove"
                        aria-label="Remove draft secret"
                      >
                        <TrashIcon className="size-3.5" />
                      </button>
                    </div>
                  </TableCell>
                  {selectedEnvs.map((env) => (
                    <TableCell key={env.id} className="px-2 py-1">
                      <Input
                        type="text"
                        inputSize="sm"
                        autoComplete="off"
                        data-1p-ignore
                        data-lpignore="true"
                        value={row.values[env.id] ?? ""}
                        placeholder="value"
                        onChange={(e) => setNewRowValue(row.id, env.id, e.target.value)}
                        className="w-full min-w-0 mono-sm"
                      />
                    </TableCell>
                  ))}
                  {canWriteSecret && selectedEnvs.length > 1 && <TableCell className="p-0" />}
                </TableRow>
              ))}
              {secretNames.map((name) => {
                const visible = rowVisible[name] ?? false;
                // Effective value per shown env (missing = undefined, its own distinct state).
                const effectiveValues = selectedEnvs.map(
                  (env) => draftValues[name]?.[env.id] ?? secretsByEnv[env.id]?.[name],
                );
                const differs = selectedEnvs.length > 1 && new Set(effectiveValues).size > 1;
                return (
                  <TableRow key={name}>
                    <TableCell className="min-w-0">
                      <div className="flex items-center gap-2">
                        <KeyIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate mono-sm font-medium">{name}</span>
                        {differs && (
                          <Badge
                            size="sm"
                            variant="outline"
                            className="shrink-0 border-amber-400/40 text-amber-700 dark:text-amber-400"
                          >
                            differs
                          </Badge>
                        )}
                        <button
                          onClick={() => setRowVisible((prev) => ({ ...prev, [name]: !visible }))}
                          className="ml-auto shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                          title={visible ? "Hide values" : "Reveal values"}
                        >
                          {visible ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                        </button>
                        {canWriteSecret && (
                          <button
                            type="button"
                            onClick={() => void handleDelete(name)}
                            className="shrink-0 cursor-pointer text-muted-foreground hover:text-destructive"
                            title={`Delete ${name} from all environments`}
                            aria-label={`Delete ${name} from all environments`}
                          >
                            <TrashIcon className="size-3.5" />
                          </button>
                        )}
                      </div>
                    </TableCell>
                    {selectedEnvs.map((env) => {
                      const base = baseValue(name, env.id);
                      const draft = draftValues[name]?.[env.id];
                      const display = draft ?? base ?? "";
                      const isMissing = base === undefined && draft === undefined;
                      const isDirty = draft !== undefined && draft !== (base ?? "");
                      return (
                        <TableCell
                          key={env.id}
                          className={cn(
                            "px-2 py-1",
                            differs && (isMissing
                              ? "bg-destructive/5 dark:bg-destructive/10"
                              : "bg-amber-50/40 dark:bg-amber-950/15"),
                          )}
                        >
                          <Input
                            type="text"
                            inputSize="sm"
                            autoComplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                            readOnly={!canWriteSecret}
                            value={visible ? display : (isMissing ? "" : "••••••••••••")}
                            placeholder={isMissing ? "— not set —" : undefined}
                            onChange={(e) => { if (visible && canWriteSecret) setDraft(name, env.id, e.target.value); }}
                            onFocus={(e) => { if (!visible && !isMissing) { e.target.blur(); setRowVisible((prev) => ({ ...prev, [name]: true })); } }}
                            className={cn(
                              "w-full min-w-0 mono-sm",
                              !visible && !isMissing && "text-security-disc cursor-pointer select-none border-transparent bg-muted/50",
                              isMissing && "border-destructive/30 placeholder:text-destructive/60",
                              isDirty && "border-amber-400/50 bg-amber-50/50 focus:ring-amber-500 dark:bg-amber-950/20",
                            )}
                          />
                        </TableCell>
                      );
                    })}
                    {canWriteSecret && selectedEnvs.length > 1 && (
                      <TableCell className="p-0 text-center">
                        <button
                          type="button"
                          onClick={() => fillRow(name)}
                          className="cursor-pointer text-muted-foreground hover:text-foreground"
                          title="Fill every environment with this secret's value"
                          aria-label="Fill every environment with this secret's value"
                        >
                          <ArrowRightIcon className="size-3.5" />
                        </button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file && importEnvId) void importEnvFile(file, importEnvId);
            e.target.value = "";
          }}
        />
      </Frame>

      {dirtyCount > 0 && (
        <div className="mt-3 flex justify-end">
          <Button loading={saving} onClick={handleSave}>
            Save {dirtyCount} change{dirtyCount > 1 ? "s" : ""}
          </Button>
        </div>
      )}
    </>
  );
}
