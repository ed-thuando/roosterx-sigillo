// Secrets Matrix: grid of secrets (rows) × environments (columns).
// Shows every secret name across all readable environments in one view, with
// each env's value inline. Values are masked by default (allVisible reveals).
// Editing a cell drafts a change; Save writes drafts grouped per environment
// via saveSecretsAction. A per-row "propagate" and a toolbar "copy column"
// handle bulk copy of values across environments.

"use client";

import { useState, useCallback, useMemo } from "react";
import { KeyIcon, CopyIcon, EyeIcon, EyeOffIcon, ArrowRightIcon } from "lucide-react";
import { Badge } from "sigillo-app/src/components/ui/badge";
import { Button } from "sigillo-app/src/components/ui/button";
import { Frame } from "sigillo-app/src/components/ui/frame";
import { Input } from "sigillo-app/src/components/ui/input";
import { NativeSelect } from "sigillo-app/src/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "sigillo-app/src/components/ui/table";
import { cn } from "sigillo-app/src/lib/utils";
import { useLoaderData } from "spiceflow/react";
import { saveSecretsAction } from "../actions.ts";

type Environment = { id: string; name: string; slug: string };

// draftValues[secretName][envId] = pending value for that cell
type DraftValues = Record<string, Record<string, string>>;

export function SecretsMatrix({ allVisible }: { allVisible: boolean }) {
  const { environments, allSecretNames, secretsByEnv, canWriteSecret, selectedEnvId } =
    useLoaderData("/dash/projects/:projectId/envs/:envSlug");

  const secretNames = useMemo(() => [...allSecretNames].sort(), [allSecretNames]);

  // Which env columns are visible. Default: all readable envs.
  const [selectedEnvIds, setSelectedEnvIds] = useState<string[]>(() => environments.map((e) => e.id));
  const selectedEnvs = useMemo(
    () => environments.filter((e) => selectedEnvIds.includes(e.id)),
    [environments, selectedEnvIds],
  );

  const [draftValues, setDraftValues] = useState<DraftValues>({});
  const [rowVisible, setRowVisible] = useState<Record<string, boolean>>({});
  const [copySourceId, setCopySourceId] = useState<string>(selectedEnvId ?? environments[0]?.id ?? "");
  const [saving, setSaving] = useState(false);

  const toggleEnv = useCallback((envId: string) => {
    setSelectedEnvIds((prev) =>
      prev.includes(envId) ? prev.filter((id) => id !== envId) : [...prev, envId],
    );
  }, []);

  const setDraft = useCallback((name: string, envId: string, value: string) => {
    setDraftValues((prev) => ({ ...prev, [name]: { ...prev[name], [envId]: value } }));
  }, []);

  // Base value stored server-side for a cell (undefined = secret absent in env).
  const baseValue = useCallback(
    (name: string, envId: string): string | undefined => secretsByEnv[envId]?.[name],
    [secretsByEnv],
  );

  // Copy one env's values for every secret into all other selected envs (draft).
  const copyColumn = useCallback((sourceEnvId: string) => {
    setDraftValues((prev) => {
      const next: DraftValues = { ...prev };
      for (const name of secretNames) {
        const val = secretsByEnv[sourceEnvId]?.[name];
        if (val === undefined) continue;
        for (const env of selectedEnvs) {
          if (env.id === sourceEnvId) continue;
          next[name] = { ...next[name], [env.id]: val };
        }
      }
      return next;
    });
  }, [secretNames, secretsByEnv, selectedEnvs]);

  // Propagate a single secret's source-env value across the other selected envs.
  const propagateRow = useCallback((name: string, sourceEnvId: string) => {
    const val = draftValues[name]?.[sourceEnvId] ?? secretsByEnv[sourceEnvId]?.[name];
    if (val === undefined) return;
    setDraftValues((prev) => {
      const row = { ...prev[name] };
      for (const env of selectedEnvs) {
        if (env.id === sourceEnvId) continue;
        row[env.id] = val;
      }
      return { ...prev, [name]: row };
    });
  }, [draftValues, secretsByEnv, selectedEnvs]);

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

  const dirtyCount = useMemo(
    () => Object.values(dirtyByEnv).reduce((sum, edits) => sum + edits.length, 0),
    [dirtyByEnv],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // One save call per environment; the server enforces write ability per env.
      for (const [envId, edits] of Object.entries(dirtyByEnv)) {
        if (edits.length > 0) await saveSecretsAction({ edits, environmentIds: [envId] });
      }
      setDraftValues({});
    } catch (e: any) {
      alert(e?.message || "Failed to save secrets");
    } finally {
      setSaving(false);
    }
  }, [dirtyByEnv]);

  if (secretNames.length === 0) {
    return (
      <Frame className="w-full">
        <div className="py-12 text-center text-muted-foreground">
          <KeyIcon className="mx-auto size-10 text-muted-foreground/30" />
          <p className="mt-2 text-sm">No secrets across any environment yet.</p>
        </div>
      </Frame>
    );
  }

  return (
    <>
      <Frame className="w-full gap-3">
        {/* Env selection + bulk copy toolbar */}
        <div className="flex flex-wrap items-center gap-2 px-1">
          <span className="text-xs font-medium text-muted-foreground">Environments:</span>
          {environments.map((env) => {
            const active = selectedEnvIds.includes(env.id);
            return (
              <button
                key={env.id}
                onClick={() => toggleEnv(env.id)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs transition-colors cursor-pointer",
                  active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-input text-muted-foreground hover:bg-muted/50",
                )}
              >
                {env.name}
              </button>
            );
          })}
          {canWriteSecret && selectedEnvs.length > 1 && (
            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Copy from</span>
              <NativeSelect
                value={copySourceId}
                onChange={(e) => setCopySourceId(e.target.value)}
                className="h-7 w-32 text-xs"
              >
                {selectedEnvs.map((env) => (
                  <option key={env.id} value={env.id}>{env.name}</option>
                ))}
              </NativeSelect>
              <Button size="xs" variant="outline" onClick={() => copyColumn(copySourceId)}>
                <CopyIcon className="size-3" />
                to all
              </Button>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <Table className="min-w-[600px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="min-w-48">Secret</TableHead>
                {selectedEnvs.map((env) => (
                  <TableHead key={env.id} className="min-w-40">{env.name}</TableHead>
                ))}
                {canWriteSecret && selectedEnvs.length > 1 && (
                  <TableHead className="w-10 text-center" />
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {secretNames.map((name) => {
                const visible = allVisible || (rowVisible[name] ?? false);
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
                          onClick={() => propagateRow(name, copySourceId)}
                          className="cursor-pointer text-muted-foreground hover:text-foreground"
                          title={`Copy ${copySourceId ? environments.find((e) => e.id === copySourceId)?.name : "source"}'s value across selected envs`}
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
