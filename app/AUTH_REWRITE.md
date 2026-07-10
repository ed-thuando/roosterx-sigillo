# Auth rewrite: BetterAuth → Firebase Google sign-in (Path A)

Remove the `better-auth` dependency and the `auth.sigillo.dev` provider. Sign in
with Google via **Firebase Auth** (the FaceSwap project's standard), verified
server-side in our Cloudflare Worker, with our own opaque D1 session.

Chosen after inspecting `AI_FaceSwap_Cloudflare_Backend` — its whole stack uses
Firebase Auth (`worker/auth.ts` verifies Firebase ID tokens). We reuse that.

## Flow
1. Browser loads the Firebase Web SDK, calls `signInWithPopup(GoogleAuthProvider)`,
   gets a **Firebase ID token**.
2. Browser `POST /auth/session { idToken }`.
3. Worker `verifyFirebaseIdToken(idToken, FIREBASE_PROJECT_ID)` — RS256 against
   Google's securetoken JWKS + full claim checks (iss/aud/exp/iat/auth_time,
   `email_verified`). On success: upsert `user` by email, create `session` (random
   256-bit token, 30d), set `sig_session` HttpOnly+Secure+SameSite cookie.
4. `GET` requests: `getSessionFromRequest` reads the cookie → D1 `session`→`user`.
5. `POST /auth/signout`: delete session row + clear cookie.

Implemented in `app/src/auth.ts` (verifier adapted from FaceSwap's proven code).
Reuses existing D1 `user`/`session` tables — no schema change.

## Firebase project (from FaceSwap config)
- **prod**: `gopix-1c752` (authDomain `gopix-1c752.firebaseapp.com`)
- **dev**: `uppix-dev`
- gcloud is authenticated as `tucm@roosterxtech.com` (+ SA on `ai-photo-office`).

## Wiring still TODO (this branch)
- `app.tsx`: add `POST /auth/session`, `POST /auth/signout`; delete the
  `/api/auth/*` BetterAuth handler; drop provider discovery + `PROVIDER_URL`.
- `db.ts`: `getSession/requireSession/requirePageSession/requireApiSession` call
  `auth.ts` instead of BetterAuth; delete `getAuth`, `genericOAuth`,
  `deviceAuthorization`, `bearer`, `drizzleAdapter`, `ensureOAuthClient`.
- Frontend: add `firebase` dep; `login-button.tsx` → Firebase `signInWithPopup`
  then `POST /auth/session`; `sidebar.tsx` logout → `POST /auth/signout`.
- Remove `better-auth`, `better-auth-drizzle-adapter` from `app/package.json`.
- `auth-client.ts`, `device-flow.tsx`: remove/replace (CLI device flow = v2).

## Prerequisites to ACTIVATE (config, mostly doable via your gcloud)
1. On the `sigillo-app` worker, set:
   - var `FIREBASE_PROJECT_ID=gopix-1c752`
   - Firebase **web** config for the frontend (public): `FIREBASE_API_KEY`,
     `FIREBASE_AUTH_DOMAIN=gopix-1c752.firebaseapp.com` (apiKey from the
     gopix-1c752 Firebase web app).
2. Add **`env.shotpix.app`** (and `sigillo-app.thanhlx273.workers.dev` for testing)
   to Firebase Auth **Authorized domains** for `gopix-1c752`
   (Firebase Console → Authentication → Settings → Authorized domains).
   Without this, `signInWithPopup` is rejected with `auth/unauthorized-domain`.
3. Google provider already enabled in `gopix-1c752` (FaceSwap uses it).

## Consequence
Reusing `gopix-1c752` means sigillo users share that Firebase identity pool with
FaceSwap. Acceptable per the "reuse this project" decision; if isolation is
wanted later, create a dedicated Firebase project and swap `FIREBASE_PROJECT_ID`.

## Cutover (safe, no lockout)
1. Land verifier + endpoints + frontend (this branch).
2. Set the vars + authorized domain (prereqs).
3. Deploy to `sigillo-app`; test login on `*.workers.dev` FIRST.
4. Verify: Google popup → `/auth/session` 200 → cookie → `/dash` loads → signout.
5. Only then remove BetterAuth + `PROVIDER_URL`; keep it until verified (rollback
   = redeploy previous version). Then retire `sigillo-provider`.

## Not in v1
- CLI **device flow** (RFC 8628) — reimplement natively later; CLI login breaks
  until then.

## Status
- `app/src/auth.ts` (Firebase verifier + D1 session core): done, compiles.
- Everything under "Wiring TODO" + prerequisites: pending.
