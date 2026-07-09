// CASL-based access control for Sigillo.
//
// The model is action–subject–conditions. A user's (or token's) effective
// permissions are expressed as a list of Grants, each a built-in role scoped to
// a project (and optionally a single environment). buildAbility() turns grants
// into a MongoAbility that call sites query with
// `ability.can(action, subject(Type, { ... }))`.
//
// Scope is expressed with equality conditions on the subject object:
//   - whole-project grant  → condition { projectId }           (matches any env)
//   - env-scoped grant      → condition { projectId, environmentId }
// org-admin is unscoped (`manage`/`all`) — full access within the org whose
// context the ability was built for.
//
// v1 is deliberately a subset of Infisical: built-in roles only (no custom
// roles / packed rules), equality conditions only (no glob paths, environment
// is the leaf), no deny rules / temporary access / permission boundary.

import {
  AbilityBuilder,
  createMongoAbility,
  subject,
  type ForcedSubject,
  type MongoAbility,
} from '@casl/ability'

export { subject }

export type Actions =
  | 'DescribeSecret'
  | 'ReadValue'
  | 'Create'
  | 'Edit'
  | 'Delete'
  | 'Read'
  | 'manage'

// Field shapes carried by each subject; conditions are matched against these.
interface SubjectShapes {
  Secret: { projectId: string; environmentId: string }
  Environment: { projectId: string; id?: string }
  Project: { id: string; orgId?: string }
  ProjectMember: { projectId: string }
  ApiToken: { projectId: string }
  OrgMember: { orgId: string }
  Org: { id: string }
  Invitation: { orgId: string }
}

export type SubjectName = keyof SubjectShapes

// CASL subject union: either the bare type name (for rule building) or a tagged
// object (produced by `subject(name, obj)`) used at check sites.
export type Subjects =
  | 'all'
  | SubjectName
  | {
      [K in SubjectName]: SubjectShapes[K] & ForcedSubject<K>
    }[SubjectName]

export type AppAbility = MongoAbility<[Actions, Subjects]>

// Actions that apply to the Secret subject (used by secret-route enforcement).
export type SecretAction = 'DescribeSecret' | 'ReadValue' | 'Create' | 'Edit' | 'Delete'

export type Role =
  | 'org-admin'
  | 'project-admin'
  | 'project-member'
  | 'project-viewer'
  | 'no-access'

// A single permission grant. `projectId`/`environmentId` scope the role.
// org-admin ignores scope (full access). no-access grants nothing.
export interface Grant {
  role: Role
  projectId?: string
  environmentId?: string
}

type Can = AbilityBuilder<AppAbility>['can']

function applyGrant(can: Can, grant: Grant): void {
  const { role, projectId, environmentId } = grant

  if (role === 'org-admin') {
    can('manage', 'all')
    return
  }
  if (role === 'no-access' || !projectId) return

  // Secret conditions: env-scoped grants pin environmentId; whole-project grants
  // omit it so they match secrets in any environment of the project.
  const secretCond = environmentId ? { projectId, environmentId } : { projectId }
  const envCond = environmentId ? { projectId, id: environmentId } : { projectId }

  // viewer (and everything above) — read
  can(['DescribeSecret', 'ReadValue'], 'Secret', secretCond)
  can('Read', 'Environment', envCond)
  can('Read', 'Project', { id: projectId })
  if (role === 'project-viewer') return

  // member — read + write secrets
  can(['Create', 'Edit', 'Delete'], 'Secret', secretCond)
  if (role === 'project-member') return

  // admin — manage the project itself
  can(['Create', 'Edit', 'Delete'], 'Environment', { projectId })
  can(['Edit', 'Delete'], 'Project', { id: projectId })
  can(['Read', 'Create', 'Edit', 'Delete'], 'ProjectMember', { projectId })
  can(['Read', 'Create', 'Delete'], 'ApiToken', { projectId })
}

export function buildAbility(grants: Grant[]): AppAbility {
  const builder = new AbilityBuilder<AppAbility>(createMongoAbility)
  for (const grant of grants) applyGrant(builder.can, grant)
  return builder.build()
}

// Maps a project_member.role value to the corresponding built-in Role.
const PROJECT_ROLE: Record<'admin' | 'write' | 'read', Role> = {
  admin: 'project-admin',
  write: 'project-member',
  read: 'project-viewer',
}

// A project_member row as stored in the DB.
export interface ProjectMemberRow {
  role: 'admin' | 'write' | 'read'
  projectId: string
  environmentId: string | null
}

// Env-level access metadata used to shape grants (see grantsFromMembership).
export interface EnvMeta {
  id: string
  visibility: 'public' | 'private'
  locked: boolean
}

// The Secret actions that mutate state (as opposed to read). Used to decide
// whether a read-only (locked) environment should block an action.
const SECRET_WRITE_ACTIONS: ReadonlySet<Actions> = new Set(['Create', 'Edit', 'Delete'])
export function isSecretWriteAction(action: Actions): boolean {
  return SECRET_WRITE_ACTIONS.has(action)
}

// A locked (read-only) environment demotes a non-admin write grant to read.
// Admin roles are never passed here, so admins keep write on locked envs.
function capRoleForLock(role: Role, locked: boolean | undefined): Role {
  return locked && role === 'project-member' ? 'project-viewer' : role
}

// Translate a user's org role + project_member rows into Grants.
// Org admins get full access (org-admin) and their project rows are ignored.
// A user with no org-admin role and no project rows gets no grants (no access).
//
// `envsByProject` (env metadata per project) layers the env-level controls on
// top of the row's role, and is applied ONLY to non-admin (write/read) grants —
// admins bypass both controls:
//   - visibility: a whole-project grant is expanded to the PUBLIC envs only, so
//     private envs stay hidden unless the user holds an explicit env-scoped row.
//   - locked: any env-scoped grant landing on a locked env is capped to read.
// When metadata is absent, or a project has no private/locked envs, the
// whole-project grant is emitted unchanged (identical to the previous behavior).
export function grantsFromMembership(
  orgRole: 'admin' | 'member' | null,
  projectRows: ProjectMemberRow[],
  envsByProject?: Map<string, EnvMeta[]>,
): Grant[] {
  if (orgRole === 'admin') return [{ role: 'org-admin' }]

  const grants: Grant[] = []
  for (const row of projectRows) {
    // Unknown/stale role values fall back to no-access rather than through the
    // waterfall in applyGrant (which would otherwise grant admin).
    const role = PROJECT_ROLE[row.role] ?? 'no-access'
    const { projectId } = row
    const environmentId = row.environmentId ?? undefined

    // no-access grants nothing; project-admin bypasses env visibility + locks.
    if (role === 'no-access' || role === 'project-admin') {
      grants.push({ role, projectId, environmentId })
      continue
    }

    const envs = envsByProject?.get(projectId)

    // Explicit env-scoped grant: this is how a user is let into a private env,
    // so visibility does not apply — but a locked env still caps write to read.
    if (environmentId) {
      const meta = envs?.find((e) => e.id === environmentId)
      grants.push({ role: capRoleForLock(role, meta?.locked), projectId, environmentId })
      continue
    }

    // Whole-project grant with no private/locked envs (or no metadata): keep the
    // single project-wide grant — unchanged behavior.
    if (!envs || !envs.some((e) => e.visibility === 'private' || e.locked)) {
      grants.push({ role, projectId, environmentId: undefined })
      continue
    }

    // Expand to the public envs only (private ones stay hidden from a
    // whole-project grant), capping locked envs to read.
    for (const e of envs) {
      if (e.visibility === 'private') continue
      grants.push({ role: capRoleForLock(role, e.locked), projectId, environmentId: e.id })
    }
  }
  return grants
}

// ── Read helpers ────────────────────────────────────────────────────
// Small wrappers used by loaders/routes to filter lists down to what the
// caller may read, keeping call sites free of repeated subject() plumbing.

export function canReadProject(ability: AppAbility, projectId: string): boolean {
  return ability.can('Read', subject('Project', { id: projectId }))
}

export function filterReadableEnvironments<T extends { id: string }>(
  ability: AppAbility,
  projectId: string,
  envs: T[],
): T[] {
  return envs.filter((e) => ability.can('Read', subject('Environment', { projectId, id: e.id })))
}

// Build the ability for an API token from its capability + scope.
export function tokenGrant(
  capability: 'read-only' | 'read-write',
  projectId: string,
  environmentId?: string | null,
): Grant {
  return {
    role: capability === 'read-only' ? 'project-viewer' : 'project-member',
    projectId,
    environmentId: environmentId ?? undefined,
  }
}
