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

  const token = randomToken(32)
  await db.insert(schema.session).values({
    userId,
    token,
    expiresAt: Date.now() + SESSION_TTL_MS,
    ipAddress: request.headers.get('cf-connecting-ip'),
    userAgent: request.headers.get('user-agent'),
  })

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': sessionCookie(token, SESSION_TTL_MS / 1000, isSecure(request)),
    },
  })
}

// ── session resolution (used by db.ts guards) ───────────────────────
export async function getSessionFromRequest(request: Request): Promise<Session | null> {
  const token = parseCookies(request)[SESSION_COOKIE]
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
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie('', 0, isSecure(request)) },
  })
}
