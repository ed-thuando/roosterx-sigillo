// Environments table for a project (standalone tab).
// Shows name, slug, timestamps. Supports inline rename, delete, and add.
// All environments are user-managed — no hardcoded "default" protection.

"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { EyeIcon, EyeOffIcon, LockIcon, LockOpenIcon, PencilIcon, TrashIcon, UserPlusIcon } from "lucide-react";
import { useState, useRef } from "react";
import { z } from "zod";
import { parseFormData } from "spiceflow";
import { ErrorBoundary, useLoaderData } from "spiceflow/react";
import { Badge } from "sigillo-app/src/components/ui/badge";
import { cn } from "sigillo-app/src/lib/utils";
import { Button } from "sigillo-app/src/components/ui/button";
import { Frame } from "sigillo-app/src/components/ui/frame";
import { Input } from "sigillo-app/src/components/ui/input";
import { formatTime } from "sigillo-app/src/lib/utils";
import {
  addProjectMemberAction,
  createEnvAction,
  deleteEnvAction,
  removeProjectMemberAction,
  renameEnvAction,
  setEnvAccessAction,
  updateProjectMemberRoleAction,
} from "../actions.ts";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "sigillo-app/src/components/ui/dialog";
import { NativeSelect } from "sigillo-app/src/components/ui/native-select";
import { Spinner } from "sigillo-app/src/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "sigillo-app/src/components/ui/table";

type Environment = {
  id: string;
  name: string;
  slug: string;
  locked: boolean;
  visibility: "public" | "private";
  createdAt: number;
  updatedAt: number;
};

const knownEnvColors: Record<string, string> = {
  development: "bg-primary",
  dev: "bg-primary",
  preview: "bg-amber-500",
  staging: "bg-amber-500",
  production: "bg-emerald-500",
  prod: "bg-emerald-500",
};

// Deterministic color palette for custom env names not in the known list.
const envColorPalette = [
  "bg-violet-500",
  "bg-pink-500",
  "bg-cyan-500",
  "bg-orange-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-indigo-500",
  "bg-lime-500",
];

function getEnvColor(name: string, slug: string): string {
  const key = slug.toLowerCase();
  const nameKey = name.toLowerCase();
  if (knownEnvColors[key]) return knownEnvColors[key]!;
  if (knownEnvColors[nameKey]) return knownEnvColors[nameKey]!;
  // Deterministic hash of slug for consistent color across renders.
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return envColorPalette[hash % envColorPalette.length]!;
}

// Inline editable name+slug cell for a single environment row.
function EditableEnvCell({ env, field, canWrite }: { env: Environment; field: "name" | "slug"; canWrite: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(env[field]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Read-only viewers see the value without edit affordances.
  if (!canWrite) {
    return field === "name" ? (
      <span className="flex items-center gap-2">
        <span className={cn("size-2 rounded-full", getEnvColor(env.name, env.slug))} />
        {env.name}
      </span>
    ) : (
      <Badge variant="outline" size="default">
        <span className="mono-sm">{env.slug}</span>
      </Badge>
    );
  }

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === env[field]) {
      setValue(env[field]);
      setEditing(false);
      return;
    }
    try {
      await renameEnvAction({ id: env.id, [field]: trimmed });
      setEditing(false);
    } catch (e: any) {
      alert(e?.message || `Failed to rename ${field}`);
      setValue(env[field]);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <form
        className="flex items-center gap-1"
        onSubmit={async (e) => {
          e.preventDefault();
          await save();
        }}
      >
        <Input
          ref={inputRef}
          inputSize="sm"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          autoFocus
          className={cn("h-7 w-full", field === "slug" && "mono-sm")}
        />
      </form>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="group flex items-center gap-1.5 cursor-pointer text-left"
      title={`Click to edit ${field}`}
    >
      {field === "name" ? (
        <span className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", getEnvColor(env.name, env.slug))} />
          {env.name}
        </span>
      ) : (
        <Badge variant="outline" size="default">
          <span className="mono-sm">{env.slug}</span>
        </Badge>
      )}
      <PencilIcon className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
}

// Lock (read-only) + visibility (private) controls for one environment.
// Admins get toggle buttons; everyone else sees read-only badges.
function EnvAccessCell({ env, canManage }: { env: Environment; canManage: boolean }) {
  const [busy, setBusy] = useState(false);
  const locked = env.locked;
  const isPrivate = env.visibility === "private";

  const update = async (patch: { locked?: boolean; visibility?: "public" | "private" }) => {
    setBusy(true);
    try {
      await setEnvAccessAction({ id: env.id, ...patch });
    } catch (e: any) {
      alert(e?.message || "Failed to update access");
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) {
    if (!locked && !isPrivate) return <span className="text-muted-foreground text-xs">—</span>;
    return (
      <span className="flex items-center gap-1.5">
        {locked && (
          <Badge variant="outline" size="default">
            <LockIcon className="size-3 mr-1" />
            Read-only
          </Badge>
        )}
        {isPrivate && (
          <Badge variant="outline" size="default">
            <EyeOffIcon className="size-3 mr-1" />
            Private
          </Badge>
        )}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1">
      <button
        disabled={busy}
        onClick={() => update({ locked: !locked })}
        title={locked ? "Read-only. Click to allow writes." : "Writable. Click to make read-only."}
        className={cn(
          "cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors",
          locked ? "text-destructive" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {locked ? <LockIcon className="size-3.5" /> : <LockOpenIcon className="size-3.5" />}
      </button>
      <button
        disabled={busy}
        onClick={() => update({ visibility: isPrivate ? "public" : "private" })}
        title={isPrivate ? "Private. Click to make visible to all project members." : "Visible to project. Click to make private."}
        className={cn(
          "cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors",
          isPrivate ? "text-amber-500" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {isPrivate ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
      </button>
    </span>
  );
}

type UserLite = { id: string; name: string | null; email: string | null; image: string | null };
type OrgMemberOption = { id: string; role: "admin" | "member"; user: UserLite | null };
type ProjectGrant = {
  id: string;
  role: "admin" | "write" | "read";
  environmentId: string | null;
  user: UserLite | null;
};

// Per-environment sharing: pick an org member and give them read/edit access to
// THIS environment (an env-scoped grant). For a private env this is the only way
// anyone but an admin can see it. Reuses the same grant actions as the Access tab.
function ShareEnvControl({ env, members, grants, projectId }: {
  env: Environment;
  members: OrgMemberOption[];
  grants: ProjectGrant[];
  projectId: string;
}) {
  const [open, setOpen] = useState(false);
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<"read" | "write">("read");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const envGrants = grants.filter((g) => g.environmentId === env.id);
  const grantedIds = new Set(envGrants.map((g) => g.user?.id));
  const available = members.filter((m) => m.user && !grantedIds.has(m.user.id));

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setError(null);
    setBusyId(id);
    try {
      await fn();
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Share this environment with people"
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
      >
        <UserPlusIcon className="size-3.5" />
        {envGrants.length > 0 ? <span className="text-xs tabular-nums">{envGrants.length}</span> : null}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Share {env.name}</DialogTitle>
            <DialogDescription>
              Give specific org members access to this environment.
              {env.visibility === "private"
                ? " It's private — only people added here (and admins) can see it."
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 pb-2 flex flex-col gap-4">
            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1 flex-1 min-w-40">
                <label className="text-xs font-medium text-muted-foreground">Person</label>
                <NativeSelect value={addUserId} onChange={(e) => setAddUserId(e.currentTarget.value)}>
                  <option value="">Select a member…</option>
                  {available.map((m) => (
                    <option key={m.user!.id} value={m.user!.id}>
                      {m.user!.name || m.user!.email || m.user!.id}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">Access</label>
                <NativeSelect value={addRole} onChange={(e) => setAddRole(e.currentTarget.value as "read" | "write")}>
                  <option value="read">Read</option>
                  <option value="write">Edit</option>
                </NativeSelect>
              </div>
              <Button
                size="sm"
                loading={busyId === "add"}
                disabled={!addUserId}
                onClick={() =>
                  run("add", async () => {
                    await addProjectMemberAction({ projectId, userId: addUserId, environmentId: env.id, role: addRole });
                    setAddUserId("");
                    setAddRole("read");
                  })
                }
              >
                Share
              </Button>
            </div>

            <div className="flex flex-col gap-1.5">
              {envGrants.length === 0 ? (
                <p className="text-xs text-muted-foreground">No one shared yet.</p>
              ) : (
                envGrants.map((g) => {
                  const label = g.user?.name || g.user?.email || "Unknown member";
                  return (
                    <div key={g.id} className="flex items-center gap-2">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <div className="size-6 shrink-0 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
                          {label.charAt(0).toUpperCase()}
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="text-sm truncate">{label}</span>
                          {g.user?.name && g.user?.email ? (
                            <span className="text-xs text-muted-foreground truncate">{g.user.email}</span>
                          ) : null}
                        </div>
                      </div>
                      <div className="w-36 shrink-0">
                        <NativeSelect
                          disabled={busyId === g.id || g.role === "admin"}
                          value={g.role}
                          onChange={(e) =>
                            run(g.id, () =>
                              updateProjectMemberRoleAction({ memberId: g.id, role: e.currentTarget.value as "read" | "write" }),
                            )
                          }
                        >
                          <option value="read">Read</option>
                          <option value="write">Edit</option>
                          {g.role === "admin" ? <option value="admin">Admin</option> : null}
                        </NativeSelect>
                      </div>
                      <button
                        disabled={busyId === g.id}
                        onClick={() => run(g.id, () => removeProjectMemberAction({ memberId: g.id }))}
                        className="shrink-0 text-muted-foreground hover:text-destructive cursor-pointer disabled:opacity-40"
                        title="Remove access"
                      >
                        {busyId === g.id ? <Spinner className="size-4" /> : <TrashIcon className="size-3.5" />}
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            <DialogFooter variant="bare" className="mt-2">
              <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
            </DialogFooter>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}

const envSchema = z.object({ name: z.string().min(1, "Name is required"), slug: z.string().min(1, "Slug is required") });
const envFields = envSchema.keyof().enum;

export function EnvironmentsPage() {
  const { projectName } = useLoaderData('/dash/projects/:projectId/environments');

  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{projectName}</h1>
      </div>
      <EnvironmentsTable />
    </div>
  );
}

export function EnvironmentsTable() {
  const { environments, projectId, canWriteEnv, canManageProjectMembers, members, projectMembers } =
    useLoaderData('/dash/projects/:projectId/environments');
  const [showNewRow, setShowNewRow] = useState(false);

  const columns: ColumnDef<Environment>[] = [
    {
      accessorKey: "name",
      header: "Environment",
      size: 200,
      cell: ({ row }) => <EditableEnvCell env={row.original} field="name" canWrite={canWriteEnv} />,
    },
    {
      accessorKey: "slug",
      header: "Slug",
      size: 160,
      cell: ({ row }) => <EditableEnvCell env={row.original} field="slug" canWrite={canWriteEnv} />,
    },
    {
      accessorKey: "updatedAt",
      header: "Last Updated",
      size: 130,
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatTime(row.original.updatedAt)}
        </span>
      ),
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      size: 130,
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatTime(row.original.createdAt)}
        </span>
      ),
    },
    {
      id: "access",
      header: "Access",
      size: 150,
      cell: ({ row }) => (
        <div className="flex items-center gap-2.5">
          <EnvAccessCell env={row.original} canManage={canWriteEnv} />
          {canManageProjectMembers ? (
            <ShareEnvControl
              env={row.original}
              members={members}
              grants={projectMembers}
              projectId={projectId}
            />
          ) : null}
        </div>
      ),
    },
    {
      id: "actions",
      size: 50,
      cell: ({ row }) => (
        <button
          disabled={!canWriteEnv}
          onClick={async (e) => {
            e.stopPropagation();
            if (confirm(`Delete environment "${row.original.name}"? All secrets in this environment will be lost.`)) {
              try {
                await deleteEnvAction({ id: row.original.id });
              } catch (e: any) {
                alert(e?.message || "Failed to delete environment");
              }
            }
          }}
          className="text-muted-foreground hover:text-destructive cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground"
          title={canWriteEnv ? "Delete environment" : "You don't have permission to delete environments"}
        >
          <TrashIcon className="size-3.5" />
        </button>
      ),
    },
  ];

  const table = useReactTable({
    columns,
    data: environments,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <Frame className="w-full">
      <Table className="table-fixed">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow className="hover:bg-transparent" key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const columnSize = header.column.getSize();
                return (
                  <TableHead
                    key={header.id}
                    style={columnSize ? { width: `${columnSize}px` } : undefined}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center text-muted-foreground py-8">
                No environments yet. Add one below.
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <div className="p-2 border-t border-border">
        {showNewRow ? (
          <ErrorBoundary
            fallback={
              <div className="flex items-center gap-2 px-2 py-1">
                <ErrorBoundary.ErrorMessage className="text-xs text-destructive" />
                <ErrorBoundary.ResetButton className="text-xs text-destructive underline cursor-pointer">
                  Try again
                </ErrorBoundary.ResetButton>
              </div>
            }
          >
            <form
              className="flex items-center gap-2"
              action={async (formData: FormData) => {
                const { name, slug } = parseFormData(envSchema, formData);
                await createEnvAction({ name, slug, projectId });
                setShowNewRow(false);
              }}
            >
              <Input
                name={envFields.name}
                inputSize="sm"
                placeholder="Environment name"
                required
                className="flex-1"
              />
              <Input
                name={envFields.slug}
                inputSize="sm"
                placeholder="slug"
                required
                className="flex-1 mono-sm"
              />
              <Button size="xs" type="submit">
                Add
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setShowNewRow(false)}>
                Cancel
              </Button>
            </form>
          </ErrorBoundary>
        ) : (
          <button
            disabled={!canWriteEnv}
            onClick={() => setShowNewRow(true)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground"
            title={canWriteEnv ? undefined : "You don't have permission to add environments"}
          >
            + Add Environment
          </button>
        )}
      </div>
    </Frame>
  );
}
