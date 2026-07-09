# Environment-level access controls (read-only + private envs)

We added two per-environment controls — `locked` (read-only) and `visibility` (public/private) — on top of the existing per-user grants, because "protect prod" and "hide an env from most of the team" could not be expressed by grants alone. Both are enforced by shaping a user's grants inside `grantsFromMembership` (the one function that turns `project_member` rows into a CASL ability), so all three surfaces — web app, REST API, and CLI — inherit the rules with no call-site changes. Tokens, which don't flow through that function, get a single explicit lock check in `requireSecretsApiAuth`.

## Considered options

- **Allowlist (private env) vs. denylist (per-user "hidden" rows).** Chose allowlist: a private env is invisible unless a user holds an explicit environment-scoped grant. Denylists were rejected — the CASL model deliberately has no deny rules, and a forgotten deny row is a silent leak.
- **Encode the rules in CASL subject conditions (add `visibility` to every check site) vs. shape the grants once.** Chose to shape grants: a whole-project grant expands to per-*public*-env grants, and a grant landing on a locked env is capped to read. This keeps the ~25 existing `can(...)` call sites untouched and means projects with no private/locked envs behave exactly as before.

## Consequences

- Admins (org-admin, project-admin) bypass both controls by design — a locked prod is still writable by an admin, and private envs are always visible to admins so they can manage sharing.
- A project-scoped, read-write **API token** can still *read* a private env's secrets (privacy hides from users, not from admin-created machine credentials); scope the token to an environment to narrow it. Tokens can never *write* to a locked env.
- Authorization is eventually consistent: env metadata and grants are memoized (~5 min), so toggling a lock or visibility can take up to that long to take effect — consistent with how grant changes already propagate.
