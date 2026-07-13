// Shared server actions for the Sigillo app UI.
// Client components import these directly instead of receiving action props.
//
// Every action authenticates via getActionRequest() → getSession() and
// verifies org membership before mutating data. No action accepts a raw
// userId — it always comes from the session cookie.
//
// Actions throw on error (caught by ErrorBoundary in the UI) and return
// objects on success. Never return strings or scalar values.

'use server'

import { ulid } from 'ulid'
import * as orm from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { schema } from 'db'
import { getActionRequest, redirect } from 'spiceflow'
import { router } from 'spiceflow/react'
import {
  getDb, getSession,
  requireOrgMember,
  requireCan,
  getUserAbility,
  getOrgIdForProject, getOrgIdForEnvironment, getProjectIdForEnvironment,
  encrypt,
  generateApiToken,
  deriveSecrets,
} from './db.ts'
import { subject } from './ability.ts'

async function requireSession() {
  const request = getActionRequest()
  const session = await getSession(request)
  if (!session) throw new Error('Unauthorized')
  return session
}

async function requireAdminRole(userId: string, orgId: string) {
  const { role } = await requireOrgMember(userId, orgId)
  if (role !== 'admin') throw new Error('Only admins can manage access')
}

async function ensureAnotherAdminExists(orgId: string, userId: string) {
  const db = getDb()
  const admins = await db.query.orgMember.findMany({
    where: { orgId, role: 'admin' },
    columns: { userId: true },
  })
  if (admins.length === 1 && admins[0]?.userId === userId) {
    throw new Error('This organization needs at least one admin')
  }
}

export async function createProjectAction({ name, orgId }: { name: string; orgId: string }) {
  if (!name) throw new Error('Name is required')
  if (!orgId) throw new Error('No org selected')
  const session = await requireSession()
  // Any org member may create a project. Non-admin creators are granted
  // project-admin on the new project so they can manage what they created;
  // org-admins already have full access and need no grant row.
  const { role: userRole } = await requireOrgMember(session.userId, orgId)
  const db = getDb()
  const projectId = ulid()
  const grantRow = userRole === 'admin'
    ? []
    : [db.insert(schema.projectMember).values({ projectId, userId: session.userId, role: 'admin' })]
  const [[proj]] = await db.batch([
    db.insert(schema.project).values({ id: projectId, name, orgId })
      .returning({ id: schema.project.id, name: schema.project.name }),
    ...schema.DEFAULT_ENVIRONMENTS.map((e) =>
      db.insert(schema.environment).values({ projectId, name: e.name, slug: e.slug }),
    ),
    ...grantRow,
  ] as const)
  throw redirect(router.href('/dash/projects/:projectId', { projectId: proj!.id }))
}

// All secret mutations append to the secretEvent log. Never update or delete events.

export async function deleteSecretAction({ name, environmentIds }: {
  name: string
  environmentIds: string[]
}) {
  const unique = Array.from(new Set(environmentIds))
  if (!unique.length) throw new Error('No environments selected')
  const session = await requireSession()
  const orgIds = await Promise.all(unique.map((id) => getOrgIdForEnvironment(id)))
  const orgId = orgIds[0]
  if (!orgId || orgIds.some((id) => !id)) throw new Error('Environment not found')
  if (orgIds.some((id) => id !== orgId)) throw new Error('All environments must belong to the same organization')
  const ability = await getUserAbility(session.userId, orgId)
  for (const envId of unique) {
    const projectId = await getProjectIdForEnvironment(envId)
    if (!projectId || !ability.can('Delete', subject('Secret', { projectId, environmentId: envId }))) {
      throw new Error('FORBIDDEN')
    }
  }
  const db = getDb()
  const queries: BatchItem<'sqlite'>[] = unique.map((envId) =>
    db.insert(schema.secretEvent).values({
      environmentId: envId, name, operation: 'delete', userId: session.userId,
    }),
  )
  const [first, ...rest] = queries
  if (first) await db.batch([first, ...rest])
}

// Save edited secrets to the current environment and optionally apply
// the same changes to additional environments. Each edit appends a "set"
// event to the log. Renames are handled as delete old name + set new name.
export async function saveSecretsAction({ edits, environmentIds }: {
  edits: { name: string; originalName?: string; value: string }[]
  environmentIds: string[]
}) {
  if (edits.length === 0 || environmentIds.length === 0) return
  const session = await requireSession()
  const currentEnvId = environmentIds[0]!
  const orgId = await getOrgIdForEnvironment(currentEnvId)
  if (!orgId) throw new Error('Environment not found')
  const ability = await getUserAbility(session.userId, orgId)
  const currentProjectId = await getProjectIdForEnvironment(currentEnvId)
  if (!currentProjectId || !ability.can('Edit', subject('Secret', { projectId: currentProjectId, environmentId: currentEnvId }))) {
    throw new Error('FORBIDDEN')
  }

  const db = getDb()

  // Encrypt all values upfront so we can batch all inserts in one RPC
  const editsWithEncrypted = await Promise.all(
    edits.map(async (edit) => ({
      ...edit,
      enc: await encrypt(edit.value),
    })),
  )

  // Build all insert statements for the current environment
  const queries: BatchItem<'sqlite'>[] = []

  for (const edit of editsWithEncrypted) {
    const originalName = edit.originalName
    const isRename = !!originalName && edit.name !== originalName
    if (isRename) {
      queries.push(db.insert(schema.secretEvent).values({
        environmentId: currentEnvId, name: originalName,
        operation: 'delete', userId: session.userId,
      }))
    }
    queries.push(db.insert(schema.secretEvent).values({
      environmentId: currentEnvId, name: edit.name,
      operation: 'set', valueEncrypted: edit.enc!.encrypted, iv: edit.enc!.iv,
      userId: session.userId,
    }))
  }

  // Apply value changes to other environments
  const otherEnvIds = environmentIds.slice(1)
  for (const envId of otherEnvIds) {
    const targetOrgId = await getOrgIdForEnvironment(envId)
    if (targetOrgId !== orgId) continue
    const targetProjectId = await getProjectIdForEnvironment(envId)
    if (!targetProjectId || !ability.can('Edit', subject('Secret', { projectId: targetProjectId, environmentId: envId }))) continue
    for (const edit of editsWithEncrypted) {
      queries.push(db.insert(schema.secretEvent).values({
        environmentId: envId, name: edit.name,
        operation: 'set', valueEncrypted: edit.enc!.encrypted, iv: edit.enc!.iv,
        userId: session.userId,
      }))
    }
  }

  const [firstQuery, ...restQueries] = queries
  if (firstQuery) {
    await db.batch([firstQuery, ...restQueries])
  }
}

export async function deleteEnvAction({ id }: { id: string }) {
  const session = await requireSession()
  const orgId = await getOrgIdForEnvironment(id)
  if (!orgId) throw new Error('Environment not found')
  const projectId = await getProjectIdForEnvironment(id)
  await requireCan(session.userId, orgId, (a) => a.can('Delete', subject('Environment', { projectId: projectId! })))
  const db = getDb()
  await db.delete(schema.environment).where(orm.eq(schema.environment.id, id))
}

export async function createEnvAction({ name, slug, projectId }: {
  name: string
  slug: string
  projectId: string
}) {
  if (!name || !slug) throw new Error('Name and slug are required')
  const session = await requireSession()
  const orgId = await getOrgIdForProject(projectId)
  if (!orgId) throw new Error('Project not found')
  await requireCan(session.userId, orgId, (a) => a.can('Create', subject('Environment', { projectId })))
  const db = getDb()
  await db.insert(schema.environment).values({ projectId, name, slug })
  return { name }
}

export async function renameEnvAction({ id, name, slug }: {
  id: string
  name?: string
  slug?: string
}) {
  if (!name && !slug) throw new Error('At least one of name or slug is required')
  const session = await requireSession()
  const orgId = await getOrgIdForEnvironment(id)
  if (!orgId) throw new Error('Environment not found')
  const projectId = await getProjectIdForEnvironment(id)
  await requireCan(session.userId, orgId, (a) => a.can('Edit', subject('Environment', { projectId: projectId! })))
  const db = getDb()
  const updates: Partial<{ name: string; slug: string; updatedAt: number }> = { updatedAt: Date.now() }
  if (name) updates.name = name
  if (slug) updates.slug = slug
  await db.update(schema.environment).set(updates).where(orm.eq(schema.environment.id, id))
  return { id }
}

// Toggle an environment's access controls (see app-schema.ts):
//   locked     — read-only environment (only admins may write secrets)
//   visibility — 'private' hides the env from whole-project grants
// Only project-admins (or org-admins) may change these, matching env management.
export async function setEnvAccessAction({ id, locked, visibility }: {
  id: string
  locked?: boolean
  visibility?: 'public' | 'private'
}) {
  if (locked === undefined && visibility === undefined) throw new Error('Nothing to update')
  const session = await requireSession()
  const orgId = await getOrgIdForEnvironment(id)
  if (!orgId) throw new Error('Environment not found')
  const projectId = await getProjectIdForEnvironment(id)
  await requireCan(session.userId, orgId, (a) => a.can('Edit', subject('Environment', { projectId: projectId! })))
  const db = getDb()
  const updates: Partial<{ locked: boolean; visibility: 'public' | 'private'; updatedAt: number }> = { updatedAt: Date.now() }
  if (locked !== undefined) updates.locked = locked
  if (visibility !== undefined) updates.visibility = visibility
  await db.update(schema.environment).set(updates).where(orm.eq(schema.environment.id, id))
  return { id }
}

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export async function createInviteAction({ orgId, role = 'member' }: { orgId: string; role?: 'admin' | 'member' }) {
  if (!orgId) throw new Error('No org selected')
  const session = await requireSession()
  const { role: userRole } = await requireOrgMember(session.userId, orgId)
  if (userRole !== 'admin') throw new Error('Only admins can create invites')
  const db = getDb()
  const [invite] = await db.insert(schema.orgInvitation).values({
    orgId,
    createdBy: session.userId,
    role,
    expiresAt: Date.now() + INVITE_EXPIRY_MS,
  }).returning({ id: schema.orgInvitation.id })
  return { id: invite!.id }
}

export async function acceptInviteAction({ invitationId }: { invitationId: string }) {
  if (!invitationId) throw new Error('Invitation ID is required')
  const session = await requireSession()
  const db = getDb()
  // Look up the invite without deleting — it stays valid until it expires.
  // This avoids a race where the page re-renders after accept and shows
  // "Invalid Invitation" because the row was already deleted.
  const invite = await db.query.orgInvitation.findFirst({
    where: { id: invitationId },
  })
  if (!invite || invite.expiresAt < Date.now()) throw new Error('Invitation not found or expired')
  // Insert membership, onConflictDoNothing handles the already-member case
  // (unique index on org_id + user_id prevents duplicates).
  const inserted = await db.insert(schema.orgMember)
    .values({ orgId: invite.orgId, userId: session.userId, role: invite.role })
    .onConflictDoNothing({ target: [schema.orgMember.orgId, schema.orgMember.userId] })
    .returning({ id: schema.orgMember.id })
  throw redirect(router.href('/dash/orgs/:orgId', { orgId: invite.orgId }))
}

export async function revokeInviteAction({ id }: { id: string }) {
  if (!id) throw new Error('Invitation ID is required')
  const session = await requireSession()
  const db = getDb()
  const invite = await db.query.orgInvitation.findFirst({
    where: { id },
    columns: { orgId: true },
  })
  if (!invite) throw new Error('Invitation not found')
  const { role } = await requireOrgMember(session.userId, invite.orgId)
  if (role !== 'admin') throw new Error('Only admins can revoke invites')
  await db.delete(schema.orgInvitation).where(orm.eq(schema.orgInvitation.id, id))
  return { id }
}

export async function updateOrgMemberRoleAction({ memberId, role }: {
  memberId: string
  role: 'admin' | 'member'
}) {
  const session = await requireSession()
  const db = getDb()
  const member = await db.query.orgMember.findFirst({
    where: { id: memberId },
    columns: { id: true, orgId: true, userId: true, role: true },
  })
  if (!member) throw new Error('Member not found')

  await requireAdminRole(session.userId, member.orgId)

  if (member.role === role) {
    return { id: member.id, role: member.role }
  }

  if (member.role === 'admin' && role !== 'admin') {
    await ensureAnotherAdminExists(member.orgId, member.userId)
  }

  await db.update(schema.orgMember)
    .set({ role })
    .where(orm.eq(schema.orgMember.id, member.id))

  return { id: member.id, role }
}

export async function removeOrgMemberAction({ memberId }: { memberId: string }) {
  const session = await requireSession()
  const db = getDb()
  const member = await db.query.orgMember.findFirst({
    where: { id: memberId },
    columns: { id: true, orgId: true, userId: true, role: true },
  })
  if (!member) throw new Error('Member not found')

  await requireAdminRole(session.userId, member.orgId)

  if (member.role === 'admin') {
    await ensureAnotherAdminExists(member.orgId, member.userId)
  }

  await db.delete(schema.orgMember).where(orm.eq(schema.orgMember.id, member.id))
  return { id: member.id }
}

// ── Project member (access grant) actions ───────────────────────────
// Manage per-project / per-environment role grants. Authorized via the
// ProjectMember subject (org-admin or project-admin). environmentId=null grants
// the role across the whole project; set = scoped to that one environment.

export async function addProjectMemberAction({ projectId, userId, environmentId, role }: {
  projectId: string
  userId: string
  environmentId?: string | null
  role: 'admin' | 'write' | 'read'
}) {
  if (!projectId || !userId) throw new Error('Project and user are required')
  const session = await requireSession()
  const orgId = await getOrgIdForProject(projectId)
  if (!orgId) throw new Error('Project not found')
  await requireCan(session.userId, orgId, (a) => a.can('Create', subject('ProjectMember', { projectId })))
  const db = getDb()

  // The target user must belong to the org.
  const orgMembership = await db.query.orgMember.findFirst({
    where: { orgId, userId }, columns: { id: true },
  })
  if (!orgMembership) throw new Error('User is not a member of this organization')

  // If env-scoped, the environment must belong to this project.
  if (environmentId) {
    const env = await db.query.environment.findFirst({
      where: { id: environmentId, projectId }, columns: { id: true },
    })
    if (!env) throw new Error('Environment not found in this project')
  }

  // Upsert by (projectId, userId, environmentId) — one grant per scope.
  const existingRows = await db.query.projectMember.findMany({
    where: { projectId, userId },
    columns: { id: true, environmentId: true },
  })
  const existing = existingRows.find((r) => r.environmentId === (environmentId ?? null))
  if (existing) {
    await db.update(schema.projectMember).set({ role }).where(orm.eq(schema.projectMember.id, existing.id))
    return { id: existing.id }
  }
  const [row] = await db.insert(schema.projectMember)
    .values({ projectId, userId, environmentId: environmentId || null, role })
    .returning({ id: schema.projectMember.id })
  return { id: row!.id }
}

export async function updateProjectMemberRoleAction({ memberId, role }: {
  memberId: string
  role: 'admin' | 'write' | 'read'
}) {
  const session = await requireSession()
  const db = getDb()
  const member = await db.query.projectMember.findFirst({
    where: { id: memberId }, columns: { id: true, projectId: true },
  })
  if (!member) throw new Error('Grant not found')
  const orgId = await getOrgIdForProject(member.projectId)
  if (!orgId) throw new Error('Project not found')
  await requireCan(session.userId, orgId, (a) => a.can('Edit', subject('ProjectMember', { projectId: member.projectId })))
  await db.update(schema.projectMember).set({ role }).where(orm.eq(schema.projectMember.id, member.id))
  return { id: member.id, role }
}

export async function removeProjectMemberAction({ memberId }: { memberId: string }) {
  const session = await requireSession()
  const db = getDb()
  const member = await db.query.projectMember.findFirst({
    where: { id: memberId }, columns: { id: true, projectId: true },
  })
  if (!member) throw new Error('Grant not found')
  const orgId = await getOrgIdForProject(member.projectId)
  if (!orgId) throw new Error('Project not found')
  await requireCan(session.userId, orgId, (a) => a.can('Delete', subject('ProjectMember', { projectId: member.projectId })))
  await db.delete(schema.projectMember).where(orm.eq(schema.projectMember.id, member.id))
  return { id: member.id }
}

// ── API Token actions ───────────────────────────────────────────────

export async function createTokenAction({ name, projectId, environmentId, readOnly }: {
  name: string
  projectId: string
  environmentId?: string | null
  readOnly?: boolean
}) {
  if (!name) throw new Error('Name is required')
  if (!projectId) throw new Error('Project is required')
  const session = await requireSession()
  const orgId = await getOrgIdForProject(projectId)
  if (!orgId) throw new Error('Project not found')
  await requireCan(session.userId, orgId, (a) => a.can('Create', subject('ApiToken', { projectId })))

  // If environmentId is provided, verify it belongs to this project
  if (environmentId) {
    const db = getDb()
    const env = await db.query.environment.findFirst({
      where: { id: environmentId, projectId },
      columns: { id: true },
    })
    if (!env) throw new Error('Environment not found in this project')
  }

  const { key, hashedKey, prefix } = await generateApiToken()
  const db = getDb()
  const [token] = await db.insert(schema.apiToken).values({
    name,
    projectId,
    environmentId: environmentId || null,
    capability: readOnly ? 'read-only' : 'read-write',
    prefix,
    hashedKey,
    createdBy: session.userId,
  }).returning({ id: schema.apiToken.id })

  // Return the full key — this is the only time it's ever available
  return { id: token!.id, key }
}

export async function deleteTokenAction({ tokenId }: { tokenId: string }) {
  if (!tokenId) throw new Error('Token ID is required')
  const session = await requireSession()
  const db = getDb()
  const token = await db.query.apiToken.findFirst({
    where: { id: tokenId },
    columns: { projectId: true },
  })
  if (!token) throw new Error('Token not found')
  const orgId = await getOrgIdForProject(token.projectId)
  if (!orgId) throw new Error('Project not found')
  await requireCan(session.userId, orgId, (a) => a.can('Delete', subject('ApiToken', { projectId: token.projectId })))
  await db.delete(schema.apiToken).where(orm.eq(schema.apiToken.id, tokenId))
}

export async function syncMissingSecretsAction({
  sourceEnvironmentId,
  targetEnvironmentId,
  names,
}: {
  sourceEnvironmentId: string
  targetEnvironmentId: string
  names: string[]
}) {
  if (!sourceEnvironmentId || !targetEnvironmentId) throw new Error('Both environment IDs are required')
  if (sourceEnvironmentId === targetEnvironmentId) throw new Error('Source and target environments must be different')
  if (!names.length) throw new Error('No secret names provided')
  const session = await requireSession()

  const sourceOrgId = await getOrgIdForEnvironment(sourceEnvironmentId)
  const targetOrgId = await getOrgIdForEnvironment(targetEnvironmentId)
  if (!sourceOrgId || !targetOrgId) throw new Error('Environment not found')
  if (sourceOrgId !== targetOrgId) throw new Error('Environments must belong to the same organization')
  const ability = await getUserAbility(session.userId, targetOrgId)
  const sourceProjectId = await getProjectIdForEnvironment(sourceEnvironmentId)
  const targetProjectId = await getProjectIdForEnvironment(targetEnvironmentId)
  if (!sourceProjectId || !ability.can('ReadValue', subject('Secret', { projectId: sourceProjectId, environmentId: sourceEnvironmentId }))) {
    throw new Error('FORBIDDEN')
  }
  if (!targetProjectId || !ability.can('Edit', subject('Secret', { projectId: targetProjectId, environmentId: targetEnvironmentId }))) {
    throw new Error('FORBIDDEN')
  }

  // Re-derive both sides server-side so we never overwrite a key that was
  // added to the target after the client loaded (stale tab race condition).
  const [sourceSecrets, targetSecrets] = await Promise.all([
    deriveSecrets(sourceEnvironmentId),
    deriveSecrets(targetEnvironmentId),
  ])
  const targetNames = new Set(targetSecrets.map((s) => s.name))
  const stillMissing = new Set(names.filter((name) => !targetNames.has(name)))
  const toSync = sourceSecrets.filter((s) => stillMissing.has(s.name))

  if (toSync.length === 0) return { count: 0 }

  const db = getDb()
  const queries: BatchItem<'sqlite'>[] = toSync.map((s) =>
    db.insert(schema.secretEvent).values({
      environmentId: targetEnvironmentId,
      name: s.name,
      operation: 'set',
      valueEncrypted: s.valueEncrypted,
      iv: s.iv,
      userId: session.userId,
    }),
  )

  const [firstQuery, ...restQueries] = queries
  if (!firstQuery) return { count: 0 }
  await db.batch([firstQuery, ...restQueries])
  return { count: toSync.length }
}

export async function createOrgAction({ name, importFromOrgId }: { name: string; importFromOrgId?: string }) {
  if (!name) throw new Error('Name is required')
  const session = await requireSession()
  const db = getDb()

  // Optional: copy the member list from an existing org (the caller must be an
  // admin there) so a new org can reuse a team without re-inviting everyone.
  // Roles are preserved; the creator is always admin and is skipped.
  let importedMembers: { userId: string; role: 'admin' | 'member' }[] = []
  if (importFromOrgId) {
    await requireAdminRole(session.userId, importFromOrgId)
    const sourceMembers = await db.query.orgMember.findMany({
      where: { orgId: importFromOrgId },
      columns: { userId: true, role: true },
    })
    importedMembers = sourceMembers.filter((member) => member.userId !== session.userId)
  }

  const orgId = ulid()
  const [[org]] = await db.batch([
    db.insert(schema.org).values({ id: orgId, name }).returning({ id: schema.org.id, name: schema.org.name }),
    db.insert(schema.orgMember).values({ orgId, userId: session.userId, role: 'admin' }),
    ...importedMembers.map((member) =>
      db.insert(schema.orgMember)
        .values({ orgId, userId: member.userId, role: member.role })
        .onConflictDoNothing({ target: [schema.orgMember.orgId, schema.orgMember.userId] }),
    ),
  ] as const)
  throw redirect(router.href('/dash/orgs/:orgId', { orgId: org!.id }))
}

export async function deleteOrgAction({ orgId }: { orgId: string }) {
  if (!orgId) throw new Error('Org ID is required')
  const session = await requireSession()
  await requireAdminRole(session.userId, orgId)
  const db = getDb()
  // Cascade deletes handle orgMembers, invitations, projects, environments,
  // secretEvents, and apiTokens automatically via foreign key constraints.
  await db.delete(schema.org).where(orm.eq(schema.org.id, orgId))
  // Root ('/') is served by holocron, not a typed spiceflow route, so pass the
  // raw path to redirect() instead of router.href().
  throw redirect('/')
}

// Delete a project and all of its environments, secrets, tokens, and access
// grants. FK cascades (onDelete: 'cascade') remove the children automatically.
// Only org-admins or project-admins may delete a project.
export async function deleteProjectAction({ projectId }: { projectId: string }) {
  if (!projectId) throw new Error('Project ID is required')
  const session = await requireSession()
  const orgId = await getOrgIdForProject(projectId)
  if (!orgId) throw new Error('Project not found')
  const ability = await requireCan(session.userId, orgId, (a) => a.can('Delete', subject('Project', { id: projectId })))
  const db = getDb()
  await db.delete(schema.project).where(orm.eq(schema.project.id, projectId))
  throw redirect(router.href('/dash/orgs/:orgId', { orgId }))
}
