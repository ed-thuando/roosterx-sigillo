<!-- wayfinder:map — local-markdown tracker (GitHub issues are disabled on this repo) -->

# Map: Fine-grained environment-level permissions

## Destination

Ship two env-level access controls on top of the existing per-user CASL grants — **read-only environments** (protect prod) and **private environments** (hide from most of the team) — enforced across web, REST API, and CLI, with UI to manage them and tests. Delivered in one session (design + implement).

## Notes

- Domain model: see [CONTEXT.md](../CONTEXT.md); key decision: [ADR-0001](../docs/adr/0001-env-level-access-controls.md).
- Enforcement chokepoint is `app/src/ability.ts` `grantsFromMembership` — the CLI shares the same `/api/v0/*` layer, so it inherits every rule.
- Skills for this effort: `/grilling`, `/domain-modeling`.

## Decisions so far

- **Destination = design + implement** — one map, plan → shipped code (not a spec handoff).
- **Read-only is env-level, not per-user** — new `environment.locked` flag; per-user read-only was already possible via a `read` grant.
- **Locked env: admins bypass** — org/project-admin still write; write/read members become read-only; **no API token can write** a locked env.
- **Hiding = allowlist (private env), not denylist** — `environment.visibility='private'`; visible only to admins + explicit env-scoped grants. Rejected denylist (repo has no deny rules; leak-prone). *(overrode an earlier denylist pick during grilling.)*
- **Both rules shaped in `grantsFromMembership`** — whole-project grant expands to public envs; locked envs cap write→read; zero change to existing check sites; tokens get one explicit lock check.
- **Sharing a private env** reuses the existing env-scoped `project_member` grant + access-table UI — no new sharing mechanism.

## Not yet specified

- Surfacing `locked`/`visibility` in REST/CLI environment responses (enforcement works without it; the CLI just can't *display* the flags yet).
- Audit-log entries when an env is locked/unlocked or made private/public.

## Out of scope

- Custom roles, glob paths, temporary access, and deny rules (explicitly excluded by the v1 CASL model — `ability.ts:15-17`).
