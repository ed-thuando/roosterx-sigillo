# Sigillo

Self-hosted secrets manager: an org owns projects, each project has environments, each environment holds secrets. Access is governed by fine-grained, per-user grants layered on top of org membership, enforced through a single CASL ability that covers the web app, the REST API, and the CLI alike.

## Language

### Structure

**Environment**:
A named bucket of secrets within a project (e.g. `dev`, `prod`). Arbitrary and user-managed — there is no fixed set.
_Avoid_: Stage, tier

**Secret**:
An encrypted key/value belonging to one environment, stored as an append-only event log rather than a mutable row.
_Avoid_: Variable, config value

### Access

**Access grant**:
A single row assigning one user a role within one project, optionally scoped to a single environment. The unit of fine-grained access.
_Avoid_: Permission, ACL entry, membership

**Whole-project grant**:
An access grant with no environment set — it applies to every *public* environment in the project.
_Avoid_: Global grant, project-wide role

**Environment-scoped grant**:
An access grant pinned to one environment — the only way to reach a private environment. Also the mechanism for "sharing" an environment with specific people.
_Avoid_: Env grant, scoped permission

**Read-only environment** (`locked`):
An environment whose secrets cannot be mutated by anyone except an admin — write members and every API token are reduced to read here. Its purpose is to protect an environment like production from accidental or automated writes.
_Avoid_: Frozen, protected, immutable environment

**Private environment** (`visibility = private`):
An environment hidden from anyone holding only a whole-project grant. It appears only to admins and to users given an explicit environment-scoped grant. Hiding is opt-in visibility, never a deny rule.
_Avoid_: Hidden, restricted, secret environment

**Public environment**:
The default — visible to any grant that covers its project.
_Avoid_: Open, shared environment

**Admin** (org-admin / project-admin):
A role that bypasses both read-only locks and private-environment visibility. The creator of a project is its project-admin. Org-admins have full access across the org.
_Avoid_: Owner, superuser
