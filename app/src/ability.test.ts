import { describe, it, expect } from 'vitest'
import { buildAbility, grantsFromMembership, tokenGrant, subject, isSecretWriteAction, type EnvMeta, type Grant } from './ability.ts'

// Fixed ids for readability across cases.
const PROJ_A = 'proj_a'
const PROJ_B = 'proj_b'
const ENV_PROD = 'env_prod'
const ENV_DEV = 'env_dev'
const ENV_SECRET = 'env_secret'

function secret(projectId: string, environmentId: string) {
  return subject('Secret', { projectId, environmentId })
}

describe('project-viewer', () => {
  const ability = buildAbility([{ role: 'project-viewer', projectId: PROJ_A }])

  it('can describe and read secret values in its project', () => {
    expect(ability.can('DescribeSecret', secret(PROJ_A, ENV_PROD))).toBe(true)
    expect(ability.can('ReadValue', secret(PROJ_A, ENV_PROD))).toBe(true)
  })

  it('cannot create, edit, or delete secrets', () => {
    expect(ability.can('Create', secret(PROJ_A, ENV_PROD))).toBe(false)
    expect(ability.can('Edit', secret(PROJ_A, ENV_PROD))).toBe(false)
    expect(ability.can('Delete', secret(PROJ_A, ENV_PROD))).toBe(false)
  })

  it('cannot read secrets in a different project', () => {
    expect(ability.can('ReadValue', secret(PROJ_B, ENV_PROD))).toBe(false)
  })
})

describe('project-member', () => {
  const ability = buildAbility([{ role: 'project-member', projectId: PROJ_A }])

  it('can read and write secrets in its project', () => {
    expect(ability.can('ReadValue', secret(PROJ_A, ENV_PROD))).toBe(true)
    expect(ability.can('Create', secret(PROJ_A, ENV_PROD))).toBe(true)
    expect(ability.can('Edit', secret(PROJ_A, ENV_PROD))).toBe(true)
    expect(ability.can('Delete', secret(PROJ_A, ENV_PROD))).toBe(true)
  })

  it('cannot manage environments or project members', () => {
    expect(ability.can('Create', subject('Environment', { projectId: PROJ_A }))).toBe(false)
    expect(ability.can('Create', subject('ProjectMember', { projectId: PROJ_A }))).toBe(false)
  })
})

describe('project-admin', () => {
  const ability = buildAbility([{ role: 'project-admin', projectId: PROJ_A }])

  it('can manage environments, project members, and delete the project', () => {
    expect(ability.can('Create', subject('Environment', { projectId: PROJ_A }))).toBe(true)
    expect(ability.can('Create', subject('ProjectMember', { projectId: PROJ_A }))).toBe(true)
    expect(ability.can('Delete', subject('Project', { id: PROJ_A }))).toBe(true)
  })

  it('can still read and write secrets', () => {
    expect(ability.can('ReadValue', secret(PROJ_A, ENV_PROD))).toBe(true)
    expect(ability.can('Create', secret(PROJ_A, ENV_PROD))).toBe(true)
  })

  it('has no access to a different project', () => {
    expect(ability.can('Delete', subject('Project', { id: PROJ_B }))).toBe(false)
    expect(ability.can('ReadValue', secret(PROJ_B, ENV_PROD))).toBe(false)
  })
})

describe('environment-scoped grant', () => {
  const ability = buildAbility([{ role: 'project-viewer', projectId: PROJ_A, environmentId: ENV_PROD }])

  it('can read secrets in the granted environment', () => {
    expect(ability.can('ReadValue', secret(PROJ_A, ENV_PROD))).toBe(true)
  })

  it('cannot read secrets in a different environment of the same project', () => {
    expect(ability.can('ReadValue', secret(PROJ_A, ENV_DEV))).toBe(false)
  })
})

describe('org-admin', () => {
  const ability = buildAbility([{ role: 'org-admin' }])

  it('can do anything in any project', () => {
    expect(ability.can('Delete', secret(PROJ_A, ENV_PROD))).toBe(true)
    expect(ability.can('ReadValue', secret(PROJ_B, ENV_DEV))).toBe(true)
    expect(ability.can('Edit', subject('Org', { id: 'org_1' }))).toBe(true)
    expect(ability.can('Create', subject('Invitation', { orgId: 'org_1' }))).toBe(true)
  })
})

describe('no-access', () => {
  const ability = buildAbility([{ role: 'no-access', projectId: PROJ_A }])

  it('cannot do anything', () => {
    expect(ability.can('DescribeSecret', secret(PROJ_A, ENV_PROD))).toBe(false)
    expect(ability.can('ReadValue', secret(PROJ_A, ENV_PROD))).toBe(false)
  })
})

describe('grantsFromMembership', () => {
  it('gives org admins full access, ignoring project rows', () => {
    const grants = grantsFromMembership('admin', [{ role: 'read', projectId: PROJ_A, environmentId: null }])
    expect(grants).toEqual([{ role: 'org-admin' }])
    expect(buildAbility(grants).can('Delete', secret(PROJ_B, ENV_DEV))).toBe(true)
  })

  it('maps project rows to scoped grants for non-admins', () => {
    const grants = grantsFromMembership('member', [
      { role: 'read', projectId: PROJ_A, environmentId: null },
      { role: 'write', projectId: PROJ_B, environmentId: ENV_PROD },
    ])
    expect(grants).toEqual([
      { role: 'project-viewer', projectId: PROJ_A, environmentId: undefined },
      { role: 'project-member', projectId: PROJ_B, environmentId: ENV_PROD },
    ])
  })

  it('grants nothing to a non-admin with no project rows', () => {
    const ability = buildAbility(grantsFromMembership('member', []))
    expect(ability.can('ReadValue', secret(PROJ_A, ENV_PROD))).toBe(false)
  })
})

describe('tokenGrant', () => {
  it('read-only maps to viewer (read, no write)', () => {
    const ability = buildAbility([tokenGrant('read-only', PROJ_A)])
    expect(ability.can('ReadValue', secret(PROJ_A, ENV_PROD))).toBe(true)
    expect(ability.can('Create', secret(PROJ_A, ENV_PROD))).toBe(false)
  })

  it('read-write maps to member (read + write) and honors env scope', () => {
    const ability = buildAbility([tokenGrant('read-write', PROJ_A, ENV_PROD)])
    expect(ability.can('Create', secret(PROJ_A, ENV_PROD))).toBe(true)
    expect(ability.can('Create', secret(PROJ_A, ENV_DEV))).toBe(false)
  })
})

describe('merged grants', () => {
  it('unions capabilities across multiple grants', () => {
    const grants: Grant[] = [
      { role: 'project-viewer', projectId: PROJ_A },
      { role: 'project-member', projectId: PROJ_B },
    ]
    const ability = buildAbility(grants)
    // viewer on A: read yes, write no
    expect(ability.can('ReadValue', secret(PROJ_A, ENV_PROD))).toBe(true)
    expect(ability.can('Create', secret(PROJ_A, ENV_PROD))).toBe(false)
    // member on B: write yes
    expect(ability.can('Create', secret(PROJ_B, ENV_PROD))).toBe(true)
  })
})

describe('isSecretWriteAction', () => {
  it('classifies mutating actions as writes', () => {
    expect(isSecretWriteAction('Create')).toBe(true)
    expect(isSecretWriteAction('Edit')).toBe(true)
    expect(isSecretWriteAction('Delete')).toBe(true)
    expect(isSecretWriteAction('ReadValue')).toBe(false)
    expect(isSecretWriteAction('DescribeSecret')).toBe(false)
  })
})

// ── Env-level access controls (private / read-only environments) ──────
// These shape a NON-admin's grants via env metadata passed to
// grantsFromMembership. Admins bypass both controls.
describe('private environments', () => {
  const envs = new Map<string, EnvMeta[]>([[PROJ_A, [
    { id: ENV_PROD, visibility: 'public', locked: false },
    { id: ENV_SECRET, visibility: 'private', locked: false },
  ]]])

  it('hides a private env from a whole-project grant', () => {
    const ability = buildAbility(
      grantsFromMembership('member', [{ role: 'write', projectId: PROJ_A, environmentId: null }], envs),
    )
    // public env: full access
    expect(ability.can('ReadValue', secret(PROJ_A, ENV_PROD))).toBe(true)
    expect(ability.can('Create', secret(PROJ_A, ENV_PROD))).toBe(true)
    expect(ability.can('Read', subject('Environment', { projectId: PROJ_A, id: ENV_PROD }))).toBe(true)
    // private env: invisible — not even readable
    expect(ability.can('ReadValue', secret(PROJ_A, ENV_SECRET))).toBe(false)
    expect(ability.can('Read', subject('Environment', { projectId: PROJ_A, id: ENV_SECRET }))).toBe(false)
  })

  it('reveals a private env to an explicit env-scoped grant', () => {
    const ability = buildAbility(
      grantsFromMembership('member', [{ role: 'read', projectId: PROJ_A, environmentId: ENV_SECRET }], envs),
    )
    expect(ability.can('ReadValue', secret(PROJ_A, ENV_SECRET))).toBe(true)
    expect(ability.can('Read', subject('Environment', { projectId: PROJ_A, id: ENV_SECRET }))).toBe(true)
  })

  it('lets an admin see private envs (bypasses visibility)', () => {
    const ability = buildAbility(
      grantsFromMembership('member', [{ role: 'admin', projectId: PROJ_A, environmentId: null }], envs),
    )
    expect(ability.can('ReadValue', secret(PROJ_A, ENV_SECRET))).toBe(true)
    expect(ability.can('Create', secret(PROJ_A, ENV_SECRET))).toBe(true)
  })
})

describe('read-only (locked) environments', () => {
  const envs = new Map<string, EnvMeta[]>([[PROJ_A, [
    { id: ENV_PROD, visibility: 'public', locked: true },
  ]]])

  it('caps a whole-project write grant to read on a locked env', () => {
    const ability = buildAbility(
      grantsFromMembership('member', [{ role: 'write', projectId: PROJ_A, environmentId: null }], envs),
    )
    expect(ability.can('ReadValue', secret(PROJ_A, ENV_PROD))).toBe(true)
    expect(ability.can('Create', secret(PROJ_A, ENV_PROD))).toBe(false)
    expect(ability.can('Edit', secret(PROJ_A, ENV_PROD))).toBe(false)
    expect(ability.can('Delete', secret(PROJ_A, ENV_PROD))).toBe(false)
  })

  it('caps an explicit env-scoped write grant to read on a locked env', () => {
    const ability = buildAbility(
      grantsFromMembership('member', [{ role: 'write', projectId: PROJ_A, environmentId: ENV_PROD }], envs),
    )
    expect(ability.can('ReadValue', secret(PROJ_A, ENV_PROD))).toBe(true)
    expect(ability.can('Create', secret(PROJ_A, ENV_PROD))).toBe(false)
  })

  it('lets an admin write to a locked env (bypasses lock)', () => {
    const ability = buildAbility(
      grantsFromMembership('member', [{ role: 'admin', projectId: PROJ_A, environmentId: null }], envs),
    )
    expect(ability.can('Create', secret(PROJ_A, ENV_PROD))).toBe(true)
  })

  it('leaves grants unchanged when a project has no private/locked envs', () => {
    const plain = new Map<string, EnvMeta[]>([[PROJ_A, [
      { id: ENV_PROD, visibility: 'public', locked: false },
      { id: ENV_DEV, visibility: 'public', locked: false },
    ]]])
    const grants = grantsFromMembership('member', [{ role: 'write', projectId: PROJ_A, environmentId: null }], plain)
    expect(grants).toEqual([{ role: 'project-member', projectId: PROJ_A, environmentId: undefined }])
  })
})
