# Sigillo Handoff Document

## Project Overview
Self-hostable secret manager (Doppler/Infisical alternative) running on Cloudflare Workers + D1.

## Architecture
- **Provider** (`provider/`): Centralized OAuth/OIDC provider at `auth.sigillo.dev`. Wraps Google login via BetterAuth. Self-hosted instances register automatically via RFC 7591 dynamic client registration as public PKCE clients.
- **App** (`app/`): Secret manager users self-host. Authenticates via provider using `genericOAuth` + PKCE. Encrypts secrets with AES-256-GCM (Web Crypto). Supports RFC 8628 device flow for CLI/agent login.
- **DB** (`db/`): Shared Drizzle schemas and migrations for app's D1 database.

## Stack
- **Spiceflow** — API routes + React Server Components
- **BetterAuth** — Auth on both sides
- **Drizzle ORM** — D1 driver, migrations via drizzle-kit + `wrangler d1 migrations apply`
- **Cloudflare Workers + D1** — Compute + storage
- **pnpm** workspaces

## Secrets Encryption
- AES-256-GCM in Web Crypto
- If `ENCRYPTION_KEY` set (32 random bytes, base64), uses it directly
- Otherwise derives stable 32-byte AES key from `BETTER_AUTH_SECRET` via SHA-256
- Each secret gets random 12-byte IV
- Generate key: `openssl rand -base64 32`

## Local Dev & First-Time Setup
```bash
pnpm install
```
Local `pnpm dev` needs local D1 schema first. `vite dev` does **not** create tables.

```bash
# App
pnpm --dir app dev -- --port 5188 # runs wrangler d1 migrations apply DB --local first

# Provider
pnpm --dir provider dev
```

### First-time setup
1. `pnpm install`
2. Create `app/.dev.vars` with `BETTER_AUTH_SECRET` (and optionally `ENCRYPTION_KEY`)
3. Create `provider/.dev.vars` with `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
4. `pnpm --dir provider dev` → creates local provider D1
5. `pnpm --dir app dev -- --port 5188` → creates local app D1

Useful manual commands:
```bash
pnpm --dir provider db:migrate:local
pnpm --dir app db:migrate:local
```

## D1 Migrations (Remote)
After generating a new migration with `pnpm --dir db run generate`, **flatten** the output. Drizzle-kit generates `<timestamp>_<name>/migration.sql` subdirectories, but wrangler D1 only recognizes flat `.sql` files.

```bash
# Flatten app migrations
pnpm --dir db run flatten

# Flatten provider migrations
pnpm --dir db run flatten -- ../provider/drizzle
```

Then apply to remote D1:
```bash
# App — production
pnpm --dir app exec wrangler d1 migrations apply DB --remote

# App — preview
pnpm --dir app exec wrangler d1 migrations apply DB --remote --env preview

# Provider — production
pnpm --dir provider exec wrangler d1 migrations apply DB --remote

# Provider — preview
pnpm --dir provider exec wrangler d1 migrations apply DB --remote --env preview
```

## Deployments
**ALWAYS deploy preview first, then production.** Never go straight to production.

Deployment sequence:
```bash
# 1. Deploy preview (runs migration + build + deploy)
pnpm --dir app deployment
pnpm --dir provider deployment

# 2. Verify preview works (load the page, hit /api/health, check logs)

# 3. Deploy production (runs migration + build + deploy)
pnpm --dir app deployment:prod
pnpm --dir provider deployment:prod
```

If preview migration/deploy fails, **stop**. Fix the migration, retry preview first.

Scripts in `package.json`:
```json
"deployment": "pnpm db:migrate:preview && CLOUDFLARE_ENV=preview pnpm build && wrangler deploy --env preview",
"deployment:prod": "pnpm db:migrate:prod && pnpm build && wrangler deploy"
```

The `deployment` and `deployment:prod` scripts run the D1 migration **before** building, so if migration fails the deploy never happens.

## Key Files
- `app/src/app.tsx` — Spiceflow entry, layouts, routes
- `app/src/components/access-table.tsx` — Access matrix (full-width responsive, delete member, env management)
- `app/src/components/invite-dialog.tsx` — Org invite UX (role selector, pending invites, revoke)
- `app/src/components/settings-page.tsx` — Settings (delete project, delete org)
- `app/src/components/secrets-table.tsx` — Secrets grid
- `app/src/db.ts` — DB client, auth, encryption, authorization guards
- `app/src/ability.ts` — CASL abilities, secret derivation
- `app/src/api.ts` — External REST API (CLI, SDKs)
- `app/src/actions.ts` — Server actions (create/delete env, invite, project, org, secrets)
- `provider/src/` — OAuth provider
- `db/src/app-schema.ts` — Drizzle schema

## CSS & Theming
`app/src/globals.css` is the single source of truth for all CSS custom properties (colors, radius, fonts). Provider imports it via `@import 'sigillo-app/src/globals.css'` — **never duplicate color definitions** across workers.

- Use `var(--primary)`, `var(--ring)` etc.
- If `--ring` should match `--primary`, write `--ring: var(--primary)`, not the same `color-mix(...)` twice.
- Provider-specific styles go in `provider/src/globals.css` **after** the app import.

## Auth Flow
1. Self-hosted app calls `POST /api/setup` on first deploy → registers with provider via dynamic client registration
2. User clicks login → redirected to provider → signs in with Google → consent → redirected back with auth code
3. App exchanges code for tokens via PKCE (no client_secret)
4. CLI/agents use device flow: `POST /api/auth/device/code` → user enters code at `/device` → agent polls for token

## Verification Checklist (Post-Deploy)
1. Load preview URL → verify page loads
2. Hit `/api/health` → should return `{"ok":true,"service":"sigillo-app"}`
3. Check logs for errors
4. Test login flow
5. Test org invite → pending invites list → revoke
6. Test access matrix: add env, set per-env roles, delete member
7. Test project deletion (cascades via FK)
8. Test org deletion (cascades via FK)

## Recent Major Changes
- **Access matrix**: Full-width responsive, smaller font/padding, 6+ env columns, "Add env" in header, "Actions" column with delete member
- **Org invite UX**: Role selector, pending invites list with revoke, org-level only
- **Delete member from project**: Trash icon in Actions column, removes all grants
- **Event Log removed**: Leaked decrypted values, caused AES-GCM decrypt errors on old events
- **Settings gate**: Project readers can open Settings; delete-org only for org-admins
- **Project deletion**: Cascades via FK (envs, secrets, tokens, grants, events)
- **Org invite API**: `GET/DELETE /api/v0/orgs/:orgId/invitations` + `/invites` alias
- **Safe decrypt**: `safeDecrypt` wraps failures for bulk download
- **Safe download**: Skips undecryptable secrets instead of crashing

## Recent Major Changes
- **Access matrix**: Full-width responsive, smaller font/padding, 6+ env columns, "Add env" in header, "Actions" column with delete member
- **Org invite UX**: Role selector, pending invites list with revoke, org-level only
- **Delete member from project**: Trash icon in Actions column, removes all grants
- **Event Log removed**: Leaked decrypted values, caused AES-GCM decrypt errors on old events
- **Settings gate**: Project readers can open Settings; delete-org only for org-admins
- **Project deletion**: Cascades via FK (envs, secrets, tokens, grants, events)
- **Org invite API**: `GET/DELETE /api/v0/orgs/:orgId/invitations` + `/invites` alias
- **Safe decrypt**: `safeDecrypt` wraps failures for bulk download
- **Safe download**: Skips undecryptable secrets instead of crashing

## Deployments

### Cloudflare API Token
The token is NOT in the repo. Read `environments.ai-office-dev.cloudflare.apiToken` (+ `.accountId`) from:
```
/Volumes/DATA/TOOLS/BACKEND/AI_FaceSwap_Cloudflare_Backend/_deploy-cli-cloudflare-gcp/deployments-secrets.json
```
Account ID: `d6bbe756fe7a10cc4982a882cd98c9c8`

### Deploy Sequence (always preview first, then prod)
```bash
export CLOUDFLARE_API_TOKEN=$(cat /tmp/cf_token.txt)
export CLOUDFLARE_ACCOUNT_ID=d6bbe756fe7a10cc4982a882cd98c9c8

# Preview (runs migration + build + deploy)
pnpm --dir app deployment
pnpm --dir provider deployment

# Verify preview works (hit /health, /dash, check logs)

# Production
pnpm --dir app deployment:prod
pnpm --dir provider deployment:prod
```

### Deploy Scripts (in app/package.json)
```json
"deployment": "pnpm db:migrate:preview && CLOUDFLARE_ENV=preview pnpm build && wrangler deploy --env preview",
"deployment:prod": "pnpm db:migrate:prod && pnpm build && wrangler deploy"
```

### Preview Environment
- Worker: `sigillo-app-preview.thanhlx273.workers.dev`
- D1: `sigillo-app-preview-db` (id: `5c4b54b1-663d-49b7-b68f-61cca140e406`)

### Production Environment
- Worker: `demo-roosterx-sigillo.thanhlx273.workers.dev`
- D1: `sigillo-app-db` (id: `c16e4de3-e4d1-4b32-ac4c-b07d3b6cd55b`)

### Provider
- Prod: `auth.sigillo.dev`
- Preview: `auth.preview.sigillo.dev`
- D1: `sigillo-provider-db` / `sigillo-provider-preview-db`

### Important Notes
- Always deploy preview first, verify, then prod
- Preview D1 database ID differs from prod — check `wrangler.jsonc` `env.preview.d1_databases`
- `wrangler` is NOT logged in globally — must pass `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` each run
- Provider worker name: `sigillo-provider` (prod) / `sigillo-provider-preview` (preview)

## CLI
- `cli/zig/src/main.zig` — Command wiring
- `cli/zig/src/client.zig` — HTTP client
- `cli/zig/src/config.zig` — Global config in `~/.sigillo/config.json`