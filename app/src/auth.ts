// Cloudflare-native auth via Firebase Google sign-in (no BetterAuth, no
// auth.sigillo.dev). The browser signs in with Firebase (Google) and gets a
// Firebase ID token; this Worker verifies that token server-side (RS256 against
// Google's securetoken JWKS), then issues our own opaque D1-backed session.
//
// Reuses the FaceSwap Firebase project (set FIREBASE_PROJECT_ID, e.g.
// "gopix-1c752"). Sessions reuse the existing D1 `user`/`session` tables — no
// schema change. See AUTH_REWRITE.md for wiring, prerequisites, and cutover.
//
// NOTE: verifier adapted from the proven implementation in
// AI_FaceSwap_Cloudflare_Backend/backend-cloudflare-workers/worker/auth.ts.

import { eq } from 'drizzle-orm'
import { getDb, schema } from 'db'

const SESSION_COOKIE = 'sig_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const GOOGLE_SECURETOKEN_JWKS =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'

export type Session = { userId: string; user: { id: string; name: string; email: string } }

type FirebaseUser = { uid: string; email: string; name: string; picture: string | null }

function firebaseProjectId(): string {
  const id = process.env.FIREBASE_PROJECT_ID?.trim()
  if (!id) throw new Error('FIREBASE_PROJECT_ID is not set')
  return id
}

// ── Firebase ID-token verification (RS256 via Google securetoken JWKS) ──
export async function verifyFirebaseIdToken(token: string, projectId: string): Promise<FirebaseUser | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const header = JSON.parse(atob(parts[0]!.replace(/-/g, '+').replace(/_/g, '/')))
    if (!header.kid || header.alg !== 'RS256') return null

    const payloadBytes = Uint8Array.from(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, any>

    const now = Math.floor(Date.now() / 1000)
    if (!payload.exp || payload.exp < now) return null
    if (!payload.iat || payload.iat > now + 300) return null
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null
    if (payload.aud !== projectId) return null
    if (!payload.sub || typeof payload.sub !== 'string') return null
    if (!payload.auth_time || payload.auth_time > now) return null

    const jwksRes = await fetch(GOOGLE_SECURETOKEN_JWKS, { cf: { cacheTtl: 3600, cacheEverything: true } as any })
    if (!jwksRes.ok) return null
    const jwks = (await jwksRes.json()) as { keys: Array<{ kid?: string; kty?: string; n?: string; e?: string }> }
    const key = jwks.keys.find((k) => k.kid === header.kid)
    if (!key || key.kty !== 'RSA') return null

    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      { kty: key.kty, n: key.n, e: key.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const signature = Uint8Array.from(atob(parts[2]!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      signature,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    )
    if (!valid) return null

    const email = typeof payload.email === 'string' ? payload.email : null
    // Firebase sets email_verified for Google sign-in; require it.
    if (!email || payload.email_verified !== true) return null

    return {
      uid: payload.sub,
      email,
      name: typeof payload.name === 'string' ? payload.name : email,
      picture: typeof payload.picture === 'string' ? payload.picture : null,
    }
  } catch {
    return null
  }
}

// ── cookies ─────────────────────────────────────────────────────────
function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('cookie') ?? ''
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    if (k) out[k] = decodeURIComponent(part.slice(idx + 1).trim())
  }
  return out
}

function sessionCookie(value: string, maxAgeSec: number, secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

// Expire an arbitrary cookie (used to clear legacy BetterAuth cookies on signout).
function expireCookie(name: string, secure: boolean): string {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === 'https:'
}

function randomToken(bytes = 32): string {
  let s = ''
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ── exchange a Firebase ID token for our session cookie ─────────────
// Called by POST /auth/session { idToken }. Verifies the token, upserts the
// user by email, creates a D1 session, and returns a 200 with Set-Cookie.
export async function createSessionFromIdToken(request: Request, idToken: string): Promise<Response> {
  const fbUser = await verifyFirebaseIdToken(idToken, firebaseProjectId())
  if (!fbUser) return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers: { 'content-type': 'application/json' } })

  const db = getDb()
  const existing = await db.query.user.findFirst({ where: { email: fbUser.email } })
  let userId: string
  if (existing) {
    userId = existing.id
    await db.update(schema.user).set({ name: fbUser.name, image: fbUser.picture, updatedAt: Date.now() }).where(eq(schema.user.id, existing.id))
  } else {
    const [row] = await db
      .insert(schema.user)
      .values({ name: fbUser.name, email: fbUser.email, image: fbUser.picture, emailVerified: true })
      .returning({ id: schema.user.id })
    userId = row!.id
  }

  const token = await createSession(userId, request)

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': sessionCookie(token, SESSION_TTL_MS / 1000, isSecure(request)),
    },
  })
}

// Create a D1-backed session for a user; returns the opaque session token.
export async function createSession(userId: string, request?: Request): Promise<string> {
  const token = randomToken(32)
  await getDb().insert(schema.session).values({
    userId,
    token,
    expiresAt: Date.now() + SESSION_TTL_MS,
    ipAddress: request?.headers.get('cf-connecting-ip') ?? null,
    userAgent: request?.headers.get('user-agent') ?? null,
  })
  return token
}

// ── session resolution (used by db.ts guards) ───────────────────────
// Accepts the session token from the `sig_session` cookie OR an
// `Authorization: Bearer <token>` header (used by API clients + tests).
export async function getSessionFromRequest(request: Request): Promise<Session | null> {
  const authz = request.headers.get('authorization')
  const bearer = authz && authz.startsWith('Bearer ') ? authz.slice(7).trim() : null
  const token = parseCookies(request)[SESSION_COOKIE] ?? bearer
  if (!token) return null
  const db = getDb()
  const row = await db.query.session.findFirst({ where: { token } })
  if (!row) return null
  if (row.expiresAt < Date.now()) {
    await db.delete(schema.session).where(eq(schema.session.token, token))
    return null
  }
  const user = await db.query.user.findFirst({ where: { id: row.userId } })
  if (!user) return null
  return { userId: user.id, user: { id: user.id, name: user.name, email: user.email } }
}

// ── sign out ────────────────────────────────────────────────────────
export async function signOutRequest(request: Request): Promise<Response> {
  const token = parseCookies(request)[SESSION_COOKIE]
  if (token) {
    await getDb().delete(schema.session).where(eq(schema.session.token, token))
  }
  const secure = isSecure(request)
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.append('set-cookie', sessionCookie('', 0, secure))
  // Also expire any session/BetterAuth cookie actually present on the request so
  // users with a pre-migration session can sign out regardless of cookie name.
  const present = Object.keys(parseCookies(request))
  const legacy = new Set([
    'better-auth.session_token',
    'better-auth.session_data',
    '__Secure-better-auth.session_token',
    '__Secure-better-auth.session_data',
  ])
  for (const name of present) {
    if (name === SESSION_COOKIE) continue
    if (legacy.has(name) || /session|better-auth/i.test(name)) {
      headers.append('set-cookie', expireCookie(name, secure))
      if (!name.startsWith('__Secure-') && secure) headers.append('set-cookie', expireCookie(name, false))
    }
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
}

// ── Device authorization flow (RFC 8628) for the CLI ────────────────
// `sigillo login`: CLI calls /api/auth/device/code, user approves at /device
// (gated by Firebase login → only your org can approve), CLI polls
// /api/auth/device/token for the resulting native session token.
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000
const DEVICE_POLL_INTERVAL = 5
// Unambiguous alphabet (no 0/O/1/I) for the human-entered user_code.
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789'

function genUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let s = ''
  for (let i = 0; i < 8; i++) {
    s += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length]
    if (i === 3) s += '-'
  }
  return s
}

export async function createDeviceCode(origin: string, clientId: string | null) {
  const deviceCode = randomToken(32)
  const userCode = genUserCode()
  await getDb().insert(schema.deviceCode).values({
    deviceCode,
    userCode,
    status: 'pending',
    expiresAt: Date.now() + DEVICE_CODE_TTL_MS,
    pollingInterval: DEVICE_POLL_INTERVAL,
    clientId,
  })
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${origin}/device`,
    verification_uri_complete: `${origin}/device?user_code=${encodeURIComponent(userCode)}`,
    expires_in: DEVICE_CODE_TTL_MS / 1000,
    interval: DEVICE_POLL_INTERVAL,
  }
}

// CLI polls this. On approval, mints a native session token + consumes the code.
export async function pollDeviceToken(deviceCode: string): Promise<{ ok: true; accessToken: string } | { error: string }> {
  const db = getDb()
  const row = await db.query.deviceCode.findFirst({ where: { deviceCode } })
  if (!row) return { error: 'expired_token' }
  if (row.expiresAt < Date.now()) {
    await db.delete(schema.deviceCode).where(eq(schema.deviceCode.deviceCode, deviceCode))
    return { error: 'expired_token' }
  }
  if (row.status === 'denied') return { error: 'access_denied' }
  if (row.status !== 'approved' || !row.userId) return { error: 'authorization_pending' }
  const accessToken = await createSession(row.userId)
  await db.delete(schema.deviceCode).where(eq(schema.deviceCode.deviceCode, deviceCode))
  return { ok: true, accessToken }
}

// Called from the /device page (requires a logged-in session).
export async function approveDeviceCode(userCode: string, userId: string): Promise<boolean> {
  const db = getDb()
  const normalized = userCode.trim().toUpperCase()
  const row = await db.query.deviceCode.findFirst({ where: { userCode: normalized } })
  if (!row || row.status !== 'pending' || row.expiresAt < Date.now()) return false
  await db.update(schema.deviceCode).set({ status: 'approved', userId }).where(eq(schema.deviceCode.id, row.id))
  return true
}
