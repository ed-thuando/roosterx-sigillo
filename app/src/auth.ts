// Cloudflare-native Google login (no BetterAuth, no auth.sigillo.dev provider).
//
// Authorization-code flow with PKCE, done entirely in the worker. Sessions are
// opaque 256-bit tokens stored server-side in the existing D1 `session` table;
// the browser only holds an HttpOnly cookie. See AUTH_REWRITE.md for the plan.
//
// NOTE: not yet wired into app.tsx/db.ts. Activation is gated on registering the
// callback redirect URI in the Google Cloud OAuth client (see AUTH_REWRITE.md).

import { eq } from 'drizzle-orm'
import { getDb, schema } from 'db'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

const SESSION_COOKIE = 'sig_session'
const STATE_COOKIE = 'sig_oauth_state'
const VERIFIER_COOKIE = 'sig_oauth_verifier'
const NEXT_COOKIE = 'sig_oauth_next'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const OAUTH_TX_TTL_S = 600 // 10 minutes for the login round-trip

export type Session = { userId: string; user: { id: string; name: string; email: string } }

function googleClientId(): string {
  const id = process.env.GOOGLE_CLIENT_ID
  if (!id) throw new Error('GOOGLE_CLIENT_ID is not set')
  return id
}

function googleClientSecret(): string {
  const secret = process.env.GOOGLE_CLIENT_SECRET
  if (!secret) throw new Error('GOOGLE_CLIENT_SECRET is not set')
  return secret
}

// ── crypto / encoding helpers ───────────────────────────────────────
function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function sha256Base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return base64url(new Uint8Array(digest))
}

// Decode a JWT payload WITHOUT signature verification. Safe here only because the
// id_token is read from the token-endpoint response (fetched by us over TLS with
// the client secret), never from the browser.
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1]
  if (!part) throw new Error('Malformed id_token')
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
  const json = decodeURIComponent(
    atob(b64)
      .split('')
      .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join(''),
  )
  return JSON.parse(json) as Record<string, unknown>
}

// ── cookies ─────────────────────────────────────────────────────────
function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('cookie') ?? ''
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

function serializeCookie(name: string, value: string, opts: { maxAge: number; secure: boolean }): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${opts.maxAge}`,
  ]
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === 'https:'
}

// Same-origin-only redirect target for post-login `next`.
function safeNext(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/dash'
  return value
}

// ── login: step 1 (redirect to Google) ──────────────────────────────
export async function startGoogleLogin(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const next = safeNext(url.searchParams.get('next'))
  const state = randomToken(16)
  const verifier = randomToken(32)
  const challenge = await sha256Base64url(verifier)
  const redirectUri = `${url.origin}/auth/google/callback`

  const authorize = new URL(GOOGLE_AUTH_URL)
  authorize.searchParams.set('client_id', googleClientId())
  authorize.searchParams.set('redirect_uri', redirectUri)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('scope', 'openid email profile')
  authorize.searchParams.set('state', state)
  authorize.searchParams.set('code_challenge', challenge)
  authorize.searchParams.set('code_challenge_method', 'S256')
  authorize.searchParams.set('access_type', 'online')
  authorize.searchParams.set('prompt', 'select_account')

  const secure = isSecure(request)
  const headers = new Headers({ Location: authorize.toString() })
  headers.append('Set-Cookie', serializeCookie(STATE_COOKIE, state, { maxAge: OAUTH_TX_TTL_S, secure }))
  headers.append('Set-Cookie', serializeCookie(VERIFIER_COOKIE, verifier, { maxAge: OAUTH_TX_TTL_S, secure }))
  headers.append('Set-Cookie', serializeCookie(NEXT_COOKIE, next, { maxAge: OAUTH_TX_TTL_S, secure }))
  return new Response(null, { status: 302, headers })
}

// ── login: step 2 (Google callback → session) ───────────────────────
export async function handleGoogleCallback(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const cookies = parseCookies(request)
  const secure = isSecure(request)

  if (!code || !state || state !== cookies[STATE_COOKIE] || !cookies[VERIFIER_COOKIE]) {
    return new Response('Invalid login state', { status: 400 })
  }
  const redirectUri = `${url.origin}/auth/google/callback`

  // Exchange the authorization code for tokens (server-to-server, TLS).
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      redirect_uri: redirectUri,
      code_verifier: cookies[VERIFIER_COOKIE]!,
    }),
  })
  if (!tokenRes.ok) {
    return new Response('Token exchange failed', { status: 502 })
  }
  const tokens = (await tokenRes.json()) as { id_token?: string }
  if (!tokens.id_token) return new Response('No id_token from Google', { status: 502 })

  const claims = decodeJwtPayload(tokens.id_token)
  const email = typeof claims.email === 'string' ? claims.email : null
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true'
  const aud = claims.aud
  const iss = claims.iss
  const exp = typeof claims.exp === 'number' ? claims.exp : 0

  if (aud !== googleClientId()) return new Response('Wrong token audience', { status: 401 })
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') {
    return new Response('Wrong token issuer', { status: 401 })
  }
  if (exp * 1000 < Date.now()) return new Response('Expired id_token', { status: 401 })
  if (!email || !emailVerified) return new Response('Email not verified', { status: 403 })

  const name = typeof claims.name === 'string' ? claims.name : email
  const image = typeof claims.picture === 'string' ? claims.picture : null

  const db = getDb()
  const existing = await db.query.user.findFirst({ where: { email } })
  let userId: string
  if (existing) {
    userId = existing.id
    await db.update(schema.user).set({ name, image, updatedAt: Date.now() }).where(eq(schema.user.id, existing.id))
  } else {
    const [row] = await db
      .insert(schema.user)
      .values({ name, email, image, emailVerified: true })
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

  const next = safeNext(cookies[NEXT_COOKIE] ?? null)
  const headers = new Headers({ Location: next })
  headers.append('Set-Cookie', serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_MS / 1000, secure }))
  // Clear the transient oauth cookies.
  for (const c of [STATE_COOKIE, VERIFIER_COOKIE, NEXT_COOKIE]) {
    headers.append('Set-Cookie', serializeCookie(c, '', { maxAge: 0, secure }))
  }
  return new Response(null, { status: 302, headers })
}

// ── session resolution ──────────────────────────────────────────────
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
    const db = getDb()
    await db.delete(schema.session).where(eq(schema.session.token, token))
  }
  const headers = new Headers({ Location: '/login' })
  headers.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: isSecure(request) }))
  return new Response(null, { status: 302, headers })
}
