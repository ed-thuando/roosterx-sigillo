// Access table for organization members.
// Admins can change roles inline and remove members from the org.

"use client"

import { useState } from "react"
import { TrashIcon } from "lucide-react"
import {
  removeOrgMemberAction, updateOrgMemberRoleAction,
  addProjectMemberAction, updateProjectMemberRoleAction, removeProjectMemberAction,
} from "sigillo-app/src/actions"
import { InviteButton } from "sigillo-app/src/components/invite-dialog"
import { Button } from "sigillo-app/src/components/ui/button"
import { Frame } from "sigillo-app/src/components/ui/frame"
import { NativeSelect } from "sigillo-app/src/components/ui/native-select"
import { Spinner } from "sigillo-app/src/components/ui/spinner"
import { useLoaderData } from "spiceflow/react"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "sigillo-app/src/components/ui/table"
import { formatTime } from "sigillo-app/src/lib/utils"

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

export function AccessPage() {
  const { projectName, orgId, role } = useLoaderData('/dash/projects/:projectId/access')

  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{projectName}</h1>
        {role === 'admin' ? <InviteButton orgId={orgId} /> : null}
      </div>
      <AccessTable />
      <div className="mt-8 flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Project access</h2>
          <p className="text-sm text-muted-foreground">
            Grant org members access to this project, scoped to all environments or a single one.
            Org admins always have full access.
          </p>
        </div>
        <ProjectAccessTable />
      </div>
    </div>
  )
}

type ProjectRole = "admin" | "member" | "viewer"

type ProjectGrant = {
  id: string
  createdAt: number
  role: ProjectRole
  environmentId: string | null
  user: { id: string; email: string | null; image: string | null; name: string | null } | null
  environment: { id: string; name: string; slug: string } | null
}

export function ProjectAccessTable() {
  const { projectId, members, projectMembers, environments, canManageProjectMembers } =
    useLoaderData('/dash/projects/:projectId/access')
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Add-grant form state
  const [addUserId, setAddUserId] = useState("")
  const [addEnvId, setAddEnvId] = useState("")
  const [addRole, setAddRole] = useState<ProjectRole>("viewer")
  const [adding, setAdding] = useState(false)

  const grants = projectMembers as ProjectGrant[]

  function saveRole(grant: ProjectGrant, nextRole: ProjectRole) {
    if (nextRole === grant.role) return
    setError(null)
    setPendingRoleId(grant.id)
    void (async () => {
      try {
        await updateProjectMemberRoleAction({ memberId: grant.id, role: nextRole })
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update role")
      } finally {
        setPendingRoleId((c) => (c === grant.id ? null : c))
      }
    })()
  }

  function removeGrant(grant: ProjectGrant) {
    const name = grant.user?.name || grant.user?.email || "this user"
    const scope = grant.environment ? grant.environment.name : "all environments"
    if (!confirm(`Remove ${name}'s access to ${scope}?`)) return
    setError(null)
    setPendingDeleteId(grant.id)
    void (async () => {
      try {
        await removeProjectMemberAction({ memberId: grant.id })
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to remove grant")
      } finally {
        setPendingDeleteId((c) => (c === grant.id ? null : c))
      }
    })()
  }

  function addGrant() {
    if (!addUserId) {
      setError("Select a user")
      return
    }
    setError(null)
    setAdding(true)
    void (async () => {
      try {
        await addProjectMemberAction({
          projectId,
          userId: addUserId,
          environmentId: addEnvId || null,
          role: addRole,
        })
        setAddUserId("")
        setAddEnvId("")
        setAddRole("viewer")
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to add grant")
      } finally {
        setAdding(false)
      }
    })()
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {canManageProjectMembers ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">User</label>
            <NativeSelect value={addUserId} onChange={(e) => setAddUserId(e.currentTarget.value)}>
              <option value="">Select a member…</option>
              {members.map((m) => (
                <option key={m.user?.id} value={m.user?.id ?? ""}>
                  {m.user?.name || m.user?.email || m.user?.id}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">Scope</label>
            <NativeSelect value={addEnvId} onChange={(e) => setAddEnvId(e.currentTarget.value)}>
              <option value="">All environments</option>
              {environments.map((env) => (
                <option key={env.id} value={env.id}>{env.name}</option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">Role</label>
            <NativeSelect value={addRole} onChange={(e) => setAddRole(e.currentTarget.value as ProjectRole)}>
              <option value="viewer">Viewer</option>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </NativeSelect>
          </div>
          <Button size="sm" loading={adding} onClick={addGrant}>Add access</Button>
        </div>
      ) : null}

      <Frame className="w-full">
        <Table className="table-fixed">
          <colgroup>
            <col className="w-1/4" />
            <col className="w-1/4" />
            <col className="w-32" />
            <col className="w-32" />
            <col className="w-28" />
            {canManageProjectMembers ? <col className="w-16" /> : null}
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Granted</TableHead>
              {canManageProjectMembers ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canManageProjectMembers ? 6 : 5}>
                  <span className="text-sm text-muted-foreground">No project-level grants yet.</span>
                </TableCell>
              </TableRow>
            ) : null}
            {grants.map((grant) => {
              const isSavingRole = pendingRoleId === grant.id
              const isDeleting = pendingDeleteId === grant.id
              const isBusy = isSavingRole || isDeleting
              return (
                <TableRow key={grant.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {grant.user?.image ? (
                        <img src={grant.user.image} alt="" className="size-6 rounded-full object-cover" />
                      ) : (
                        <div className="size-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
                          {(grant.user?.name || grant.user?.email || "?").charAt(0).toUpperCase()}
                        </div>
                      )}
                      <span className="text-sm font-medium">{grant.user?.name || "—"}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">{grant.user?.email || "—"}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">{grant.environment ? grant.environment.name : "All environments"}</span>
                  </TableCell>
                  <TableCell>
                    {canManageProjectMembers ? (
                      <div className="relative w-full">
                        <NativeSelect
                          disabled={isBusy}
                          value={grant.role}
                          onChange={(e) => saveRole(grant, e.currentTarget.value as ProjectRole)}
                        >
                          <option value="viewer">Viewer</option>
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </NativeSelect>
                        {isSavingRole ? (
                          <Spinner className="absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-xs font-medium capitalize">{grant.role}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground text-xs tabular-nums">{formatTime(grant.createdAt)}</span>
                  </TableCell>
                  {canManageProjectMembers ? (
                    <TableCell className="p-0">
                      <Button
                        aria-label="Remove access"
                        disabled={isBusy}
                        loading={isDeleting}
                        size="icon-xs"
                        title="Remove access"
                        variant="ghost"
                        onClick={() => removeGrant(grant)}
                      >
                        <TrashIcon className="size-3.5 text-muted-foreground" />
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Frame>
    </div>
  )
}

export function AccessTable() {
  const { role, currentUserId, members } = useLoaderData('/dash/projects/:projectId/access')
  const canManage = role === 'admin'
  const [roleOverrides, setRoleOverrides] = useState<Record<string, Member["role"]>>({})
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function getRole(member: Member) {
    return roleOverrides[member.id] ?? member.role
  }

  const adminCount = members.reduce((count, member) => {
    return count + (getRole(member) === "admin" ? 1 : 0)
  }, 0)

  function saveRole(member: Member, nextRole: Member["role"]) {
    const previousRole = getRole(member)
    setError(null)
    setRoleOverrides((current) => ({ ...current, [member.id]: nextRole }))
    setPendingRoleId(member.id)
    void (async () => {
      try {
        await updateOrgMemberRoleAction({ memberId: member.id, role: nextRole })
      } catch (error) {
        setRoleOverrides((current) => ({ ...current, [member.id]: previousRole }))
        setError(error instanceof Error ? error.message : "Failed to update role")
      } finally {
        setPendingRoleId((current) => (current === member.id ? null : current))
      }
    })
  }

  function removeMember(member: Member) {
    const name = member.user?.name || member.user?.email || "this user"
    if (!confirm(`Remove ${name} from this organization?`)) {
      return
    }

    setError(null)
    setPendingDeleteId(member.id)
    void (async () => {
      try {
        await removeOrgMemberAction({ memberId: member.id })
      } catch (error) {
        setError(error instanceof Error ? error.message : "Failed to remove user")
      } finally {
        setPendingDeleteId((current) => (current === member.id ? null : current))
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Frame className="w-full">
        <Table className="table-fixed">
          <colgroup>
            <col className="w-1/4" />
            <col className="w-1/3" />
            <col className="w-36" />
            <col className="w-32" />
            {canManage ? <col className="w-16" /> : null}
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              {canManage ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const currentRole = getRole(member)
              const isSavingRole = pendingRoleId === member.id
              const isDeleting = pendingDeleteId === member.id
              const isBusy = isSavingRole || isDeleting
              const isCurrentUser = member.user?.id === currentUserId
              const isLastAdmin = currentRole === "admin" && adminCount === 1

              return (
                <TableRow key={member.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {member.user?.image ? (
                        <img src={member.user.image} alt="" className="size-6 rounded-full object-cover" />
                      ) : (
                        <div className="size-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
                          {(member.user?.name || member.user?.email || "?").charAt(0).toUpperCase()}
                        </div>
                      )}
                      <span className="text-sm font-medium">{member.user?.name || "—"}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">{member.user?.email || "—"}</span>
                  </TableCell>
                  <TableCell>
                    {canManage ? (
                      <div className="relative w-full">
                        <NativeSelect
                          disabled={isBusy}
                          value={currentRole}
                          onChange={(event) => {
                            const nextRole = event.currentTarget.value as Member["role"]
                            if (nextRole === currentRole) {
                              return
                            }
                            saveRole(member, nextRole)
                          }}
                        >
                          <option value="admin">Admin</option>
                          <option disabled={isLastAdmin} value="member">Member</option>
                        </NativeSelect>
                        {isSavingRole ? (
                          <Spinner className="absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-xs font-medium capitalize">{member.role}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {formatTime(member.createdAt)}
                    </span>
                  </TableCell>
                  {canManage ? (
                    <TableCell className="p-0">
                      <Button
                        aria-label={isCurrentUser ? "Remove yourself" : "Remove user"}
                        disabled={isBusy || isLastAdmin}
                        loading={isDeleting}
                        size="icon-xs"
                        title={isLastAdmin
                          ? "This organization needs at least one admin"
                          : isCurrentUser
                            ? "Remove yourself"
                            : "Remove user"}
                        variant="ghost"
                        onClick={() => removeMember(member)}
                      >
                        <TrashIcon className="size-3.5 text-muted-foreground" />
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Frame>
    </div>
  )
}
