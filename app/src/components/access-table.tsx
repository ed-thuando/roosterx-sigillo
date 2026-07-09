// Access matrix: org members down the side, the project's environments across
// the top, each cell a single None / Read / Write dropdown. Org-admins (and the
// whole-project owner) render as greyed "Full" — the admin bypass is shown, not
// a silent surprise. Environment management lives in the column headers.
"use client"

import { useState } from "react"
import { MoreVerticalIcon, PlusIcon, LockIcon, EyeOffIcon } from "lucide-react"
import {
  updateOrgMemberRoleAction,
  addProjectMemberAction,
  removeProjectMemberAction,
  setEnvAccessAction,
  createEnvAction,
  renameEnvAction,
  deleteEnvAction,
} from "../actions.ts"
import { InviteButton } from "sigillo-app/src/components/invite-dialog"
import { Button } from "sigillo-app/src/components/ui/button"
import { Frame } from "sigillo-app/src/components/ui/frame"
import { NativeSelect } from "sigillo-app/src/components/ui/native-select"
import { Spinner } from "sigillo-app/src/components/ui/spinner"
import { useLoaderData } from "spiceflow/react"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "sigillo-app/src/components/ui/table"
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuPopup,
  DropdownMenuItem, DropdownMenuSeparator,
} from "sigillo-app/src/components/ui/dropdown-menu"
import {
  Dialog, DialogPopup, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter, DialogClose,
} from "sigillo-app/src/components/ui/dialog"
import { Input } from "sigillo-app/src/components/ui/input"
import { cn } from "sigillo-app/src/lib/utils"

type Member = {
  id: string
  createdAt: number
  role: "admin" | "member"
  user: {
    id: string
    email: string | null
    image: string | null
    name: string | null
  } | null
}

type ProjectGrant = {
  id: string
  createdAt: number
  role: "admin" | "write" | "read"
  user: { id: string; email: string | null; image: string | null; name: string | null } | null
  environment: { id: string; name: string; slug: string } | null
}

type Environment = {
  id: string
  name: string
  slug: string
  locked: boolean
  visibility: string
}

type CellValue = "none" | "read" | "write"

export function AccessPage() {
  const {
    projectId, orgId, role, currentUserId, members, projectMembers,
    environments, canManageProjectMembers, canWriteEnv,
  } = useLoaderData('/dash/projects/:projectId/access')

  if (!canManageProjectMembers) {
    return (
      <Frame className="w-full">
        <h2 className="text-lg font-semibold tracking-tight">Project access</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Only project managers can change who has access. Contact an admin to
          grant or revoke access to this project.
        </p>
      </Frame>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Project access</h2>
          <p className="text-sm text-muted-foreground">
            Members down the side, environments across the top. Each cell is a
            single None / Read / Write grant. Org admins always have full access.
          </p>
        </div>
        <InviteButton orgId={orgId} />
      </div>
      <AccessMatrix
        projectId={projectId}
        currentUserId={currentUserId}
        isOrgAdmin={role === 'admin'}
        members={members}
        projectMembers={projectMembers}
        environments={environments}
        canWriteEnv={canWriteEnv}
      />
    </div>
  )
}

function initialsFor(name: string | null, email: string | null): string {
  const base = (name || email || "?").trim()
  return base.slice(0, 2).toUpperCase() || "?"
}

function AccessMatrix({
  projectId, currentUserId, isOrgAdmin, members, projectMembers, environments, canWriteEnv,
}: {
  projectId: string
  currentUserId: string
  isOrgAdmin: boolean
  members: Member[]
  projectMembers: ProjectGrant[]
  environments: Environment[]
  canWriteEnv: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [dialog, setDialog] = useState<
    { type: "rename" | "delete"; env: Environment } | { type: "add" } | null
  >(null)

  async function setCell(userId: string | undefined, envId: string, grantId: string | undefined, value: CellValue) {
    if (!userId) return
    const key = `${userId}:${envId}`
    setPending(key)
    setError(null)
    try {
      if (value === "none") {
        if (grantId) await removeProjectMemberAction({ memberId: grantId })
      } else {
        await addProjectMemberAction({ projectId, userId, environmentId: envId, role: value })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update access")
    } finally {
      setPending(null)
    }
  }

  async function setOrgRole(memberId: string, newRole: "admin" | "member") {
    setPending(`org:${memberId}`)
    setError(null)
    try {
      await updateOrgMemberRoleAction({ memberId, role: newRole })
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update role")
    } finally {
      setPending(null)
    }
  }

  return (
    <Frame className="w-full overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-48">
              <Button variant="outline" size="sm" onClick={() => setDialog({ type: "add" })}>
                <PlusIcon className="size-4" /> Env
              </Button>
            </TableHead>
            <TableHead className="min-w-48">Member</TableHead>
            <TableHead className="w-32">Org role</TableHead>
            {environments.map((env) => (
              <TableHead key={env.id} className="min-w-40">
                <EnvHeader
                  env={env}
                  canWriteEnv={canWriteEnv}
                  onRename={() => setDialog({ type: "rename", env })}
                  onDelete={() => setDialog({ type: "delete", env })}
                />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => {
            const userId = member.user?.id
            const isFull = member.role === "admin"
            return (
<TableRow key={member.id}>
                <TableCell />
                <TableCell>
                  <MemberCell member={member} currentUserId={currentUserId} />
                </TableCell>
                <TableCell>
                  {isOrgAdmin ? (
                    <NativeSelect
                      value={member.role}
                      disabled={pending === `org:${member.id}`}
                      onChange={(e) => setOrgRole(member.id, e.currentTarget.value as "admin" | "member")}
                    >
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                    </NativeSelect>
                  ) : (
                    <span className="text-sm capitalize text-muted-foreground">{member.role}</span>
                  )}
                </TableCell>
                {environments.map((env) => {
                  const grant = projectMembers.find(
                    (g) => g.user?.id === userId && g.environment?.id === env.id,
                  )
                  if (isFull) {
                    return (
                      <TableCell key={env.id} className="text-sm text-muted-foreground">
                        Full
                      </TableCell>
                    )
                  }
                  const value: CellValue = grant
                    ? grant.role === "admin" ? "write"
                    : (grant.role as CellValue)
                    : "none"
                  const key = `${userId}:${env.id}`
                  return (
                    <TableCell key={env.id}>
                      <div className="relative">
                        <NativeSelect
                          value={value}
                          disabled={pending === key}
                          onChange={(e) => setCell(userId, env.id, grant?.id, e.currentTarget.value as CellValue)}
                        >
                          <option value="none">None</option>
                          <option value="read">Read</option>
                          <option value="write" disabled={env.locked}>Write</option>
                        </NativeSelect>
                        {pending === key ? (
                          <Spinner className="absolute right-7 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        ) : null}
                      </div>
                    </TableCell>
                  )
                })}
                
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      {dialog?.type === "rename" && dialog.env ? (
        <RenameEnvDialog env={dialog.env} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.type === "delete" && dialog.env ? (
        <DeleteEnvDialog env={dialog.env} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.type === "add" ? (
        <AddEnvDialog projectId={projectId} onClose={() => setDialog(null)} />
      ) : null}
    </Frame>
  )
}

function MemberCell({ member, currentUserId }: { member: Member; currentUserId: string }) {
  const u = member.user
  const isYou = u?.id === currentUserId
  return (
    <div className="flex items-center gap-2">
      {u?.image ? (
        <img src={u.image} alt="" className="size-6 rounded-full object-cover" />
      ) : (
        <span className="flex size-6 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
          {initialsFor(u?.name ?? null, u?.email ?? null)}
        </span>
      )}
      <span className="text-sm font-medium">
        {u?.name || u?.email || "Unknown"}
        {isYou ? " (you)" : ""}
      </span>
    </div>
  )
}

function EnvHeader({
  env, canWriteEnv, onRename, onDelete,
}: {
  env: Environment
  canWriteEnv: boolean
  onRename: () => void
  onDelete: () => void
}) {
  async function toggleLock() {
    try {
      await setEnvAccessAction({ id: env.id, locked: !env.locked })
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to update environment")
    }
  }

  async function togglePrivate() {
    try {
      await setEnvAccessAction({
        id: env.id,
        visibility: env.visibility === "private" ? "public" : "private",
      })
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to update environment")
    }
  }

  return (
    <div className="flex items-start justify-between gap-1">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{env.name}</span>
          {env.locked ? <LockIcon className="size-3.5 text-muted-foreground" /> : null}
          {env.visibility === "private" ? <EyeOffIcon className="size-3.5 text-muted-foreground" /> : null}
        </div>
        <span className="mono-sm text-xs text-muted-foreground">{env.slug}</span>
      </div>
      {canWriteEnv ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex size-7 items-center justify-center rounded-md hover:bg-accent"
            aria-label={`Manage ${env.name}`}
          >
            <MoreVerticalIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuPopup side="bottom" align="end">
            <DropdownMenuItem onClick={onRename}>Rename</DropdownMenuItem>
            <DropdownMenuItem onClick={toggleLock}>
              {env.locked ? "Allow writes" : "Make read-only"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={togglePrivate}>
              {env.visibility === "private" ? "Make public" : "Make private"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete}>Delete</DropdownMenuItem>
          </DropdownMenuPopup>
        </DropdownMenu>
      ) : null}
    </div>
  )
}

function EnvDialogShell({
  title, description, onClose, children,
}: {
  title: string
  description: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogPopup>
    </Dialog>
  )
}

function RenameEnvDialog({ env, onClose }: { env: Environment; onClose: () => void }) {
  const [name, setName] = useState(env.name)
  const [slug, setSlug] = useState(env.slug)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save() {
    setBusy(true)
    setError(null)
    try {
      await renameEnvAction({ id: env.id, name, slug })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rename environment")
      setBusy(false)
    }
  }
  return (
    <EnvDialogShell title="Rename environment" description="Update the name and slug for this environment." onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Name
          <Input value={name} onChange={(e) => setName(e.currentTarget.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Slug
          <Input value={slug} onChange={(e) => setSlug(e.currentTarget.value)} className="mono-sm" />
        </label>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
      <DialogFooter variant="bare" className="mt-4">
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button loading={busy} onClick={save}>Save</Button>
      </DialogFooter>
    </EnvDialogShell>
  )
}

function AddEnvDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save() {
    setBusy(true)
    setError(null)
    try {
      await createEnvAction({ name, slug, projectId })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create environment")
      setBusy(false)
    }
  }
  return (
    <EnvDialogShell title="Add environment" description="Create a new environment for this project." onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Name
          <Input value={name} onChange={(e) => setName(e.currentTarget.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Slug
          <Input value={slug} onChange={(e) => setSlug(e.currentTarget.value)} className="mono-sm" />
        </label>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
      <DialogFooter variant="bare" className="mt-4">
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button loading={busy} onClick={save}>Add</Button>
      </DialogFooter>
    </EnvDialogShell>
  )
}

function DeleteEnvDialog({ env, onClose }: { env: Environment; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await deleteEnvAction({ id: env.id })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete environment")
      setBusy(false)
    }
  }
  return (
    <EnvDialogShell
      title="Delete environment"
      description={`This permanently removes "${env.name}" and all of its secrets. This cannot be undone.`}
      onClose={onClose}
    >
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <DialogFooter variant="bare" className="mt-4">
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button variant="destructive" loading={busy} onClick={remove}>Delete</Button>
      </DialogFooter>
    </EnvDialogShell>
  )
}
