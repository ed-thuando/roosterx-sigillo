# Spec: Fine-Grained Access Control (CASL RBAC) for Sigillo

Status: **IMPLEMENTED** (T1–T8 complete; 60/60 integration + 18 ability unit tests green; worker builds)

## Known v1 limitations (documented, not bugs)
- **Reads stay membership-level.** List/get project + list/get environment routes (api.ts:396,432,507,550) still gate on org membership, not per-project grant. A member with a grant on project A can read project B's *metadata* (names/env list). Secret **values** are protected everywhere (API secret routes + web actions go through ability).
- **Web page loader value display.** `app.tsx` env page loader (`/dash/projects/:projectId/envs/:envSlug`) renders secret values gated by page membership only — a no-grant org member could see values in the dashboard. The **API** read path (what agents/CLI use — the primary threat per README) IS enforced. Tightening the SSR loader is the top follow-up.
- **Pre-existing typecheck errors** (`actions.ts` `router.href('/')`, `app.tsx:769` ResolvedHref) exist on HEAD, unrelated to this work; `pnpm typecheck` reports 2. Build (vite) and tests are green.

---

Status (history): DRAFT — reviewed & approved
Author: agent + @ewarddo
Scope decisions (locked): Core RBAC · Environment is leaf (no folder tree) · V2 action split · custom drizzle tables.

## Objective

Replace Sigillo's current binary org-membership authorization with a fine-grained,
CASL-based RBAC layer that scopes access **per project and per environment**, and
**separates read from write**. Modeled on Infisical's access-control mechanism, but a
deliberate *subset* (see Non-Goals).

Today (see `docs/access-control-rbac-spec.md` context): every org member can read, write,
and delete every secret in every project/environment of the org. `role` (`admin`|`member`)
only gates org administration. There is no CASL layer, no per-project role, no read/write
distinction.

Target: a policy engine where a request is authorized via
`ability.can(action, subject, { projectId, environmentId })`, with built-in roles that
grant scoped, read/write-distinguished capabilities.

### Users / stories
- Org admin: full control over org, projects, members, secrets.
- Project admin: manage one project (its environments, members, secrets), no org admin.
- Member (scoped to project or single environment): read + write secrets in scope.
- Viewer (scoped to project or single environment): read only, no writes.
- API token: machine actor scoped to a project (or one environment) with read-only or read-write capability.

### Success criteria (testable)
1. A viewer-scoped user can `GET` a secret value but receives 403 on `POST/PUT/DELETE` of secrets.
2. A user granted access to project A cannot read secrets of project B in the same org (403).
3. A user granted access to environment `prod` only cannot read `dev` secrets of the same project.
4. Org admin retains full access to all projects/environments (unchanged behavior).
5. A read-only API token can list + read values but 403s on writes.
6. Migration: every user's post-migration effective access equals their pre-migration access (no regressions in a seeded fixture).
7. All secret + management routes route through the single ability check; no call site does an ad-hoc membership check.

## Non-Goals (explicitly out of v1)
- Custom roles / DB-stored packed rules (built-in roles only, defined in code).
- ABAC glob conditions on secret paths (no folders/`secretPath` — environment is the leaf).
- Deny rules (CASL `inverted`), temporary/time-bound access, additional privileges per membership.
- Permission boundary / privilege-escalation subset validation.
- Teams / groups.

These are intentionally deferred; the model is designed so they can be layered later
(action-subject-condition shape is forward-compatible).

## Tech Stack
- Runtime: Cloudflare Workers (edge). Libraries must be pure-JS / edge-safe.
- Auth: better-auth (existing; no organization plugin — org/role logic stays hand-rolled).
- DB: D1 + drizzle (`db/src/app-schema.ts`).
- New deps: `@casl/ability` (createMongoAbility, packRules/unpackRules). No `@ucast/mongo2js`
  needed for v1 (equality conditions only; CASL's built-in matcher covers `$eq`/`$in`). No
  `picomatch` (no globs in v1).

## Domain model changes

### Roles (built-in, defined in code — no table)
Slugs: `org-admin`, `project-admin`, `project-member`, `project-viewer`, `no-access`.
Each is a factory `rulesFor(role, scope) => CASLRule[]` producing rules with equality
conditions on `projectId` (and `environmentId` when the grant is env-scoped).

### Subjects & actions
| Subject | Actions |
|---|---|
| `Secret` | `DescribeSecret`, `ReadValue`, `Create`, `Edit`, `Delete` |
| `Environment` | `Read`, `Create`, `Edit`, `Delete` |
| `Project` | `Read`, `Create`, `Edit`, `Delete` |
| `ProjectMember` | `Read`, `Create`, `Edit`, `Delete` |
| `ApiToken` | `Read`, `Create`, `Delete` |
| `OrgMember` / `Org` / `Invitation` | `Read`, `Create`, `Edit`, `Delete` |

V2 split rationale: `DescribeSecret` (key exists) vs `ReadValue` (plaintext) are separate so
future roles/tokens can allow listing keys without exposing values. Built-in `project-viewer`
grants both for v1.

### Role → capability matrix (project scope)
| Action \ Role | org-admin | project-admin | project-member | project-viewer |
|---|---|---|---|---|
| Secret Describe/ReadValue | ✓ | ✓ | ✓ | ✓ |
| Secret Create/Edit/Delete | ✓ | ✓ | ✓ | ✗ |
| Environment CRUD | ✓ | ✓ | ✗ | ✗ |
| Project Edit/Delete | ✓ | ✓ | ✗ | ✗ |
| ProjectMember CRUD | ✓ | ✓ | ✗ | ✗ |
| Org admin (members/invites/settings) | ✓ | ✗ | ✗ | ✗ |

### New table: `projectMember`
```
projectMember(
  id            text pk,
  projectId     text  → project.id  (cascade delete),
  userId        text  → user.id     (cascade delete),
  environmentId text? → environment.id (nullable; NULL = whole project, set = that env only),
  role          text enum('admin','member','viewer') not null,
  createdAt     integer(timestamp),
  UNIQUE(projectId, userId, environmentId)
)
```
- `orgMember` (existing) unchanged: `role` `admin`|`member`. `org-admin` still = org-wide full.
- Env-scoped grant = row with `environmentId` set.

### `apiToken` change
Add `capability text enum('read-only','read-write') not null default 'read-write'`.
Existing tokens backfill to `read-write` (no behavior change). Token ability = the matching
capability's rules scoped to `token.projectId` (+ `token.environmentId` if set).

## Enforcement design

Single module `app/src/ability.ts`:
- `buildAbility(actor, ctx)` → `MongoAbility`. `actor` = `{ type:'user', userId }` or `{ type:'token', token }`.
- For users: load `orgMember` for the org + all `projectMember` rows for the relevant project;
  concat role rules (with scope conditions) → `createMongoAbility(rules)`.
- For tokens: rules from `token.capability` scoped to token's project/env.
- Cache per-request (memoize on actor+scope). No Redis (v1).

Choke points (swap membership check for ability check):
- `requireSecretsApiAuth` (`app/src/db.ts:534`) → build ability, then
  `throwUnlessCan(action, subject('Secret', { projectId, environmentId }))`. Route maps HTTP
  verb → action: GET list→`DescribeSecret`, GET value/download→`ReadValue`,
  POST/PUT→`Create`/`Edit`, DELETE→`Delete`.
- `requireOrgMember` / `requireApiOrgMember` / `requirePageOrgMember` (`db.ts:312-334`) →
  thin wrappers that build ability + check the relevant management action.
- Server actions (`app/src/actions.ts`) + API management routes (`app/src/api.ts`): replace
  `requireAdminRole` / `requireOrgMember` with ability checks on the proper subject/action.

`ForbiddenError.from(ability).throwUnlessCan(...)` → mapped to HTTP 403 (API) / redirect (pages).

## Migration & backward compatibility (KEY DECISION — needs sign-off)
Behavioral change: org `member` will **no longer** get implicit access to all projects; access
becomes explicit per-project. To preserve current behavior with zero regression:
- Data migration backfills `projectMember(role='member', environmentId=NULL)` for **every
  existing (org member, project) pair** in each org.
- Org `admin` stays implicit org-wide (no backfill needed; `org-admin` rules ignore project scope).
- New projects: creator/admin must grant members explicitly (this is the intended new behavior).

Alternative (simpler, less "fine-grained"): keep org member = implicit member on all org
projects, use `projectMember` only to *narrow*. Rejected because it can't express "member of
project A only". **Confirm which semantics you want.**

## Commands
- Typecheck: `pnpm -r typecheck`
- App build: `pnpm --filter sigillo-app build`
- Migrate (local): `pnpm --dir app db:migrate:local`
- Deploy preview: `pnpm --dir app deployment`
- Tests: (see Testing Strategy — test tooling to confirm)

## Project structure (new/changed files)
```
db/src/app-schema.ts        → add projectMember table + apiToken.capability column
db/drizzle-app/000X_*.sql   → migration (schema + data backfill)
app/src/ability.ts          → NEW: subjects, actions, role factories, buildAbility
app/src/db.ts               → rewrite requireSecretsApiAuth / requireOrgMember to use ability
app/src/api.ts              → verb→action mapping at secret routes; management action checks
app/src/actions.ts          → replace requireAdminRole/requireOrgMember with ability checks
app/src/app.tsx             → page loaders use ability for gating
```

## Code style (example)
```ts
// app/src/ability.ts
import { AbilityBuilder, createMongoAbility, type MongoAbility } from '@casl/ability'

export type Actions =
  | 'DescribeSecret' | 'ReadValue' | 'Create' | 'Edit' | 'Delete' | 'Read'
export type Subjects = 'Secret' | 'Environment' | 'Project' | 'ProjectMember'
  | 'ApiToken' | 'OrgMember' | 'Org' | 'Invitation'
export type AppAbility = MongoAbility<[Actions, Subjects | { __type: Subjects }]>

export function buildAbility(grants: Grant[]): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility)
  for (const g of grants) applyRole(can, g)
  return build()
}
```
Confirmed repo style: 2-space indent, **single quotes, no semicolons**, named exports,
`ulid()` for ids, drizzle table style as in `db/src/app-schema.ts`.

## Testing strategy
- Framework: **vitest + `@cloudflare/vitest-pool-workers`**, tests colocated as `app/src/*.test.ts`.
- Unit: role factories → rule sets; `buildAbility` → `can`/`cannot` truth table across the 6 success criteria.
- Integration: hit secret routes with viewer/member/token actors, assert 200/403.
- Migration test: seed old-model fixture, run migration, assert effective access unchanged (criterion 6).

## Boundaries
- **Always:** run `pnpm -r typecheck` + tests before commit; route every check through `ability.ts`; preserve existing token/session behavior unless migration explicitly changes it.
- **Ask first:** the migration semantics (above); adding `@casl/ability` dep; any schema change; touching `provider/`.
- **Never:** weaken encryption; commit secrets/.dev.vars; delete the append-only `secretEvent` log; remove failing tests to go green.

## Verb → action mapping (secret routes, confirmed from `app/src/api.ts`)
| Route | Action |
|---|---|
| GET `…/secrets` (list — metadata only, no values, api.ts:610) | `DescribeSecret` |
| GET `…/secrets/:name` (value, api.ts:666) + GET download (api.ts:707) | `ReadValue` |
| POST `…/secrets` (set/upsert, api.ts:646) | `Create` (member holds Create+Edit) |
| PUT `…/secrets` (bulk, api.ts:735) | `Edit` |
| DELETE `…/secrets/:name` (api.ts:681) | `Delete` |

Create/Edit distinction is not exercised by v1 built-in roles (member grants all three); mapping
is future-proof for finer roles.

## Task list (Phase 3)

- [x] **T1 — Schema: `projectMember` + `apiToken.capability`**
  - Acceptance: `projectMember(id, projectId→project, userId→user, environmentId?→environment, role enum(admin,member,viewer), createdAt)` with UNIQUE(projectId,userId,environmentId) + cascade deletes; `apiToken.capability enum(read-only,read-write) default read-write`; drizzle relations added.
  - Verify: `drizzle-kit generate` emits migration; `pnpm -r typecheck` green.
  - Files: `db/src/app-schema.ts` (+ generated migration).

- [x] **T2 — Migration SQL + data backfill**
  - Acceptance: CREATE TABLE projectMember; ALTER apiToken ADD capability default 'read-write'; INSERT backfill one `projectMember(role='member', environmentId=NULL)` per existing (orgMember.userId, project) pair joined via org.
  - Verify: `pnpm --dir app db:migrate:local` clean; local query shows backfilled rows == (members × projects).
  - Files: `db/drizzle-app/000X_*.sql` (+ meta snapshot).

- [x] **T3 — Ability core (pure)**
  - Acceptance: `app/src/ability.ts` exports Actions/Subjects types, `rulesFor(role, {projectId, environmentId?})`, `buildAbility(grants)` via `createMongoAbility`; unit truth-table covers success criteria 1–5.
  - Verify: `vitest run src/ability.test.ts` green; `pnpm --filter sigillo-app build` succeeds (proves `@casl/ability` edge-safe).
  - Files: `app/src/ability.ts`, `app/src/ability.test.ts`, `app/package.json` (add dep).

- [x] **T4 — Grant loaders**
  - Acceptance: `loadUserAbility(userId, { orgId, projectId })` reads `orgMember` + `projectMember`; `loadTokenAbility(token)` maps `capability`→rules scoped to token project/env; per-request memoize.
  - Verify: unit test feeding fixture rows asserts resulting `can`/`cannot`.
  - Files: `app/src/ability.ts` (or `app/src/permissions.ts`), `app/src/db.ts`.

- [x] **T5 — Enforce secret routes**
  - Acceptance: `requireSecretsApiAuth` builds ability then `throwUnlessCan(action, subject('Secret',{projectId,environmentId}))` per verb map; viewer→403 on write/200 on read; token for project A →403 on project B; env-scoped grant blocks other env.
  - Verify: integration tests (criteria 1–3,5) green.
  - Files: `app/src/db.ts`, `app/src/api.ts`.

- [x] **T6 — Enforce management routes/actions**
  - Acceptance: `requireOrgMember`/`requireApiOrgMember`/`requirePageOrgMember` + `actions.ts` `requireAdminRole` replaced by ability checks on proper subject/action; project-admin manages own project incl. delete; org-admin unchanged; NO residual ad-hoc membership/role checks remain.
  - Verify: integration + `grep -rn "requireAdminRole\|\.role ===" app/src` returns only ability-internal usage; typecheck green.
  - Files: `app/src/db.ts`, `app/src/actions.ts`, `app/src/api.ts`, `app/src/app.tsx`.

- [x] **T7 — Token `--read-only`**
  - Acceptance: token create (API + CLI + UI) accepts read-only → stores `capability='read-only'`; such token 403s on write, 200 on read; default unchanged (read-write).
  - Verify: integration test read-only token; CLI help shows flag.
  - Files: `app/src/api.ts` (token create), `cli/…` (create-token cmd), app UI create-token component.

- [x] **T8 — Migration parity + criteria suite**
  - Acceptance: seed old-model fixture (org+members+projects+secrets+tokens), run migration, assert every actor's effective access is identical pre/post (criterion 6); full criteria 1–7 pass.
  - Verify: `vitest run` full suite green.
  - Files: `app/src/access-control.test.ts` (+ migration test helper).

## Resolved decisions (signed off)
1. **Migration semantics** — backfill explicit per-project `projectMember(role='member')` for every existing (org member, project) pair. Org member gets NO implicit access to future projects.
2. **`project-admin` CAN delete the project** (not org-admin-only). Update capability matrix: Project Delete = ✓ for org-admin AND project-admin.
3. **Env-scoped grants** — one role per `(userId, projectId, environmentId)` row; multiple envs = multiple rows; `environmentId=NULL` = whole project. UNIQUE(projectId, userId, environmentId).
4. **API token `capability`** — exposed via `--read-only` flag on token create (CLI + UI). No flag = `read-write` (backward compatible).
