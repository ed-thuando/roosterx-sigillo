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
const PROJECT_ROLE: Record<'admin' | 'member' | 'viewer', Role> = {
  admin: 'project-admin',
  member: 'project-member',
  viewer: 'project-viewer',
}

// Translate a user's org role + project_member rows into Grants.
// Org admins get full access (org-admin) and their project rows are ignored.
// A user with no org-admin role and no project rows gets no grants (no access).
export function grantsFromMembership(
  orgRole: 'admin' | 'member' | null,
  projectRows: { role: 'admin' | 'member' | 'viewer'; projectId: string; environmentId: string | null }[],
): Grant[] {
  if (orgRole === 'admin') return [{ role: 'org-admin' }]
  return projectRows.map((r) => ({
    role: PROJECT_ROLE[r.role],
    projectId: r.projectId,
    environmentId: r.environmentId ?? undefined,
  }))
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
