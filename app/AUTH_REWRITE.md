# Auth rewrite: BetterAuth → Cloudflare-native Google login

Goal: remove the `better-auth` dependency and the `auth.sigillo.dev` provider; sign
in directly with Google using our own code on Cloudflare Workers + D1.

## Why
- `better-auth` is a third-party library. The app also depends on the separate
  `sigillo-provider` worker (`auth.sigillo.dev`) which wraps Google via OIDC.
- We want: our own Google (Gmail) login, no third-party auth lib, Cloudflare-only.
  (Google remains the identity provider — unavoidable for "Gmail login" — but we
  own all the OAuth/session code; nothing runs through `auth.sigillo.dev`.)

## Approach (chosen): hand-rolled Google OAuth 2.0 + D1 sessions
Authorization-code flow with PKCE, done in the worker. Reuses the existing D1
tables `user` and `session` (no schema change needed):
- `user(id, name, email UNIQUE, image, email_verified, …)`
- `session(id, user_id, token UNIQUE, expires_at, ip_address, user_agent, …)`

(Cloudflare Access was the alternative — least code — but it forces Zero-Trust
setup and its own login UX. Hand-rolled keeps the current UX and full control.)

### Endpoints (new, in `app.tsx`, replacing the `/api/auth/*` BetterAuth handler)
- `GET /auth/google/start?next=/dash`
  - generate `state` (CSRF) + PKCE `code_verifier`; store both + `next` in
    short-lived HttpOnly cookies (10 min).
  - 302 → Google authorize URL (`accounts.google.com/o/oauth2/v2/auth`) with
    `client_id`, `redirect_uri=<origin>/auth/google/callback`, `scope=openid email
    profile`, `state`, `code_challenge` (S256), `access_type=online`.
- `GET /auth/google/callback?code&state`
  - verify `state` == cookie; exchange `code` at `oauth2.googleapis.com/token`
    (with `client_secret` + `code_verifier`) over TLS → response is authentic.
  - decode `id_token` payload from the token response (trusted: came straight
    from Google's token endpoint, not the browser); read `sub, email,
    email_verified, name, picture`. Reject if `email_verified !== true`.
  - upsert `user` by email; create `session` (random 32-byte token, 30-day TTL);
    set `sig_session` cookie (HttpOnly, Secure, SameSite=Lax, Path=/).
  - 302 → safe `next` (same-origin only) or `/dash`.
- `POST /auth/signout` → delete session row by token, clear cookie, 302 → `/login`.

### Session model (`auth.ts`)
- Cookie `sig_session=<token>`; `getSessionFromRequest` looks up `session` by
  token where `expires_at > now`, joins `user`, returns
  `{ userId, user: { id, name, email } }` — same shape the app already consumes.
- `db.ts` `getSession/requireSession/requirePageSession/requireApiSession` swap to
  call `auth.ts` instead of BetterAuth. Per-request WeakMap dedupe kept.

### Security checklist
- [x] PKCE (S256) + `state` CSRF check.
- [x] `client_secret` never leaves the worker.
- [x] `email_verified` required.
- [x] Session token = 256-bit random, stored server-side (D1); cookie is opaque.
- [x] Cookie flags HttpOnly + Secure + SameSite=Lax; Path=/.
- [x] Same-origin-only redirect for `next` (reuse `safeRedirectPath`).
- [ ] Session rotation on privilege change / periodic; sliding expiry (optional v2).

## What this removes
- deps: `better-auth`, `better-auth-drizzle-adapter` from `app/package.json`.
- `db.ts`: `getAuth`, `genericOAuth`, `deviceAuthorization`, `bearer`,
  `drizzleAdapter`, `ensureOAuthClient`, OAuth-host memoization, `PROVIDER_URL`.
- `app.tsx`: the `/api/auth/*` catch handler; provider discovery.
- `auth-client.ts`, `login-button.tsx`: replace `authClient.signIn.social` with a
  plain link to `/auth/google/start`.
- `sidebar.tsx`: logout → `POST /auth/signout`.

## NOT in v1 (follow-ups)
- **Device flow (CLI login)** — currently BetterAuth `deviceAuthorization` (RFC
  8628). The `device_code` table exists; reimplement natively later. CLI login
  breaks until then.
- Retire `sigillo-provider` / `auth.sigillo.dev` ONLY after web login verified.

## HARD PREREQUISITE (only you can do — blocks activation)
The `GOOGLE_CLIENT_ID` on `sigillo-app` was created for the provider's callback.
Direct login needs our callback registered on that Google OAuth client (Google
Cloud Console → APIs & Services → Credentials → the OAuth 2.0 Client):
- Add **Authorized redirect URIs**:
  - `https://env.shotpix.app/auth/google/callback`
  - `https://sigillo-app.thanhlx273.workers.dev/auth/google/callback` (for testing)
- Ensure the OAuth consent screen allows the intended users.
Without this, Google returns `redirect_uri_mismatch`.

## Cutover plan (safe, no lockout)
1. Land `auth.ts` + endpoints behind the new routes (this branch).
2. Register redirect URIs (prereq above).
3. Deploy to `sigillo-app` and test login on the `*.workers.dev` URL FIRST.
4. Verify: login → session cookie → `/dash` loads → logout.
5. Only then switch `login-button` to the new start URL for all users on
   `env.shotpix.app`; keep BetterAuth code until verified, then delete.
6. Rollback = redeploy previous version (BetterAuth) — keep it until step 5 passes.

## Status
- `auth.ts` core module: implemented on this branch (`auth-cloudflare-native`).
- Wiring into `app.tsx`/`db.ts`, dep removal, device-flow: pending, gated on the
  Google Console prerequisite + workers.dev verification above.
