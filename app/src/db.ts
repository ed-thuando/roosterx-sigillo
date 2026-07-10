// Worker-level database client, auth, encryption, and authorization guards.
//
// getDb() creates a drizzle-orm/d1 client bound to env.DB. The schema uses
// epochMs custom columns that accept both Date and number inputs, so
// BetterAuth's Date params are converted to epoch ms before reaching D1.
// getAuth(request) creates a BetterAuth instance backed by the same drizzle
// client for the current request host. encrypt()/decrypt() use ENCRYPTION_KEY
// when set, otherwise derive a stable AES-256 key from BETTER_AUTH_SECRET.

import { env } from 'cloudflare:workers'
import { getDb, schema } from 'db'
import { betterAuth } from 'better-auth/minimal'
import { bearer } from 'better-auth/plugins'
import { drizzleAdapter } from 'better-auth-drizzle-adapter'
import { redirect } from 'spiceflow'
import { memoize } from './lib/memoize.ts'
import { getSessionFromRequest } from './auth.ts'
import { buildAbility, grantsFromMembership, tokenGrant, subject, isSecretWriteAction, type AppAbility, type SecretAction, type EnvMeta } from './ability.ts'

// ── Drizzle client via D1 ───────────────────────────────────────────
export { getDb }

// ── OAuth client registration ───────────────────────────────────────
// Registers this instance with the provider via RFC 7591 dynamic client
// registration on first request for a hostname, then caches the client_id by
// hostname.

function getRequestOrigin(request: Request): string {
  const publicOrigin = getPublicOriginOverride(request)
  if (publicOrigin) {
    return publicOrigin
  }

  return new URL(request.url).origin
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

function originFromHost(host: string, protocol = 'https'): string {
  const hostname = host.split(':')[0] ?? host
  const safeProtocol = protocol === 'http' || protocol === 'https' ? protocol : 'https'
  const scheme = isLocalHost(hostname) ? 'http' : safeProtocol
  return `${scheme}://${host}`
}

// IMPORTANT: This function MUST only run when request.url is localhost.
// The isLocalHost guard below is critical for security. In production,
// Cloudflare Workers set request.url to the real hostname (e.g. sigillo.dev),
// so this function returns null immediately and never reads forwarded headers.
//
// If this guard were removed, an attacker could inject X-Forwarded-Host: evil.com
// to make BetterAuth set baseURL and trustedOrigins to evil.com, redirecting
// the OAuth callback there and stealing the user's auth code/credentials.
//
// This override only exists for local dev behind a tunnel (e.g. traforo),
// where request.url is localhost but the real public URL is the tunnel domain.
function getPublicOriginOverride(request: Request): string | null {
  const requestUrl = new URL(request.url)
  if (!isLocalHost(requestUrl.hostname)) {
    return null
  }

  const forwardedHost = request.headers.get('x-forwarded-host')
  if (forwardedHost) {
    const host = forwardedHost.split(',')[0]!.trim().toLowerCase()
    const protocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
    return originFromHost(host, protocol)
  }

  const origin = request.headers.get('origin')
  if (origin) {
    const originUrl = new URL(origin)
    if (!isLocalHost(originUrl.hostname)) {
      return originUrl.origin
    }
  }

  const referer = request.headers.get('referer')
  if (referer) {
    const refererUrl = new URL(referer)
    if (!isLocalHost(refererUrl.hostname)) {
      return refererUrl.origin
    }
  }

  const traforoUrl = process.env.TRAFORO_URL
  if (!traforoUrl) {
    return null
  }

  return traforoUrl
}

// ── BetterAuth (session validation only) ────────────────────────────
// App login is Firebase (see auth.ts). BetterAuth is retained ONLY to (a) let
// the vitest harness create users + bearer tokens via emailAndPassword, and
// (b) validate not-yet-expired legacy sessions during the transition. No OAuth
// provider, no dynamic client registration.
export async function getAuth(request: Request) {
  const db = getDb()
  const origin = getRequestOrigin(request)
  return betterAuth({
    baseURL: origin,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    trustedOrigins: [origin],
    // Enabled only under vitest so tests can create users + bearer tokens.
    // No-op in production.
    emailAndPassword: { enabled: !!process.env.VITEST },
    session: {
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    plugins: [bearer()],
  })
}

// ── Data center location ────────────────────────────────────────────

export function getDataCenter(request: Request & { cf?: { colo?: string } }): string {
  return request.cf?.colo ?? 'unknown'
}

// ── Session helpers ─────────────────────────────────────────────────

type Session = { userId: string; user: { id: string; name: string; email: string } }

// Spiceflow passes the SAME request instance to every matched loader/layout in
// a single navigation (verified against the framework source). Several loaders
// call getSession concurrently for one navigation, so without deduping each
// would rebuild a BetterAuth instance and re-validate the session — and on a
// cold cookie cache, each would hit D1 for the same session. Memoizing the
// resolution per request collapses those into one. The WeakMap lets entries be
// GC'd once the request is gone, so it never leaks across requests.
const sessionByRequest = new WeakMap<Request, Promise<Session | null>>()

export function getSession(request: Request): Promise<Session | null> {
  const cached = sessionByRequest.get(request)
  if (cached) return cached
  const promise = resolveSession(request)
  sessionByRequest.set(request, promise)
  return promise
}

async function resolveSession(request: Request): Promise<Session | null> {
  // Native Firebase-backed session (sig_session cookie) takes precedence.
  const native = await getSessionFromRequest(request)
  if (native) return native

  // Legacy BetterAuth fallback — ONLY when a BetterAuth credential is actually
  // present (Authorization bearer or a better-auth cookie). This avoids calling
  // getAuth() for ordinary requests (e.g. theme/banner cookies), so retiring the
  // provider can't add latency or errors to normal page loads. Wrapped in
  // try/catch so a removed provider degrades to "logged out", never a 500.
  const cookieHeader = request.headers.get('cookie') ?? ''
  const hasLegacyCredential =
    request.headers.has('authorization') || /better-auth|session_token/i.test(cookieHeader)
  if (!hasLegacyCredential) return null

  try {
    const auth = await getAuth(request)
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session) return null
    return { userId: session.user.id, user: { id: session.user.id, name: session.user.name, email: session.user.email } }
  } catch {
    return null
  }
}

export async function requireApiSession(request: Request): Promise<Session> {
  const session = await getSession(request)
  if (!session) throw new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
  return session
}

export async function requirePageSession(request: Request): Promise<Session> {
  const session = await getSession(request)
  if (!session) throw redirect('/login')
  return session
}

// ── Org authorization ───────────────────────────────────────────────

// Read fresh (NOT memoized): authorization must reflect the current DB. A stale
// org role would keep granting/denying access for minutes after an admin edits
// it. Authz correctness beats saving a small indexed lookup.
async function lookupOrgMember(userId: string, orgId: string): Promise<{ role: string } | null> {
  const db = getDb()
  const member = await db.query.orgMember.findFirst({ where: { userId, orgId } })
  if (!member) return null
  return { role: member.role }
}

export async function requireOrgMember(userId: string, orgId: string) {
  const member = await lookupOrgMember(userId, orgId)
  if (!member) throw new Error('FORBIDDEN')
  return member
}

export async function requireApiOrgMember(userId: string, orgId: string) {
  try {
    return await requireOrgMember(userId, orgId)
  } catch {
    throw new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } })
  }
}

export async function requirePageOrgMember(userId: string, orgId: string) {
  try {
    return await requireOrgMember(userId, orgId)
  } catch {
    throw redirect('/')
  }
}

// ── Org ownership chain lookups ─────────────────────────────────────

export const getOrgIdForProject = memoize({
  namespace: 'project-org',
  fn: async (projectId: string): Promise<string | null> => {
    const db = getDb()
    const row = await db.query.project.findFirst({ where: { id: projectId }, columns: { orgId: true } })
    return row?.orgId ?? null
  },
})

// Resolve an environment identifier (ULID or slug) to { id, projectId, slug, orgId }.
// Tries ID first, falls back to slug within the project scope.
type ResolvedEnvironment = {
  id: string
  projectId: string
  name: string
  slug: string
  locked: boolean
  visibility: 'public' | 'private'
  createdAt: number
  updatedAt: number
  orgId: string | null
}

export const resolveEnvironment = memoize({
  namespace: 'resolve-env',
  fn: async (identifier: string, projectId?: string | null): Promise<ResolvedEnvironment | null> => {
    const db = getDb()
    const byId = await db.query.environment.findFirst({
      where: { id: identifier },
      with: { project: { columns: { orgId: true } } },
    })
    if (byId) return { ...byId, orgId: byId.project?.orgId ?? null }
    if (projectId) {
      const bySlug = await db.query.environment.findFirst({
        where: { projectId, slug: identifier },
        with: { project: { columns: { orgId: true } } },
      })
      if (bySlug) return { ...bySlug, orgId: bySlug.project?.orgId ?? null }
    }
    return null
  },
})

export async function getOrgIdForEnvironment(environmentId: string, projectId?: string | null) {
  const env = await resolveEnvironment(environmentId, projectId)
  return env?.orgId ?? null
}

export async function getProjectIdForEnvironment(environmentId: string, projectId?: string | null) {
  const env = await resolveEnvironment(environmentId, projectId)
  return env?.projectId ?? null
}

// ── CASL ability loaders ────────────────────────────────────────────
// Compile a user's or token's effective permissions into a CASL ability that
// call sites query with ability.can(action, subject(Type, { ... })).

// Project-member rows for a user, filtered to the given org's projects.
// Read fresh (NOT memoized) so a newly added/removed/edited grant takes effect
// on the next request — sharing must not lag behind a cache.
async function lookupProjectGrants(
  userId: string,
  orgId: string,
): Promise<{ role: 'admin' | 'write' | 'read'; projectId: string; environmentId: string | null }[]> {
  const db = getDb()
  const rows = await db.query.projectMember.findMany({
    where: { userId },
    columns: { role: true, projectId: true, environmentId: true },
    with: { project: { columns: { orgId: true } } },
  })
  return rows
    .filter((r) => r.project?.orgId === orgId)
    .map((r) => ({ role: r.role, projectId: r.projectId, environmentId: r.environmentId }))
}

// Env-level access metadata (visibility + lock) for every environment in an
// org's projects, grouped by projectId. Feeds grantsFromMembership so a user's
// grants respect private/read-only environments. Fetched only for non-admins
// (org-admins bypass these controls).
// Read fresh (NOT memoized): toggling an env private/locked must take effect on
// the very next request, not after a cache window — that staleness is exactly
// what made hiding look broken.
async function lookupEnvMetaByProject(orgId: string): Promise<Map<string, EnvMeta[]>> {
  const db = getDb()
  const rows = await db.query.environment.findMany({
    columns: { id: true, projectId: true, visibility: true, locked: true },
    with: { project: { columns: { orgId: true } } },
  })
  const byProject = new Map<string, EnvMeta[]>()
  for (const r of rows) {
    if (r.project?.orgId !== orgId) continue
    const list = byProject.get(r.projectId) ?? []
    list.push({ id: r.id, visibility: r.visibility, locked: r.locked })
    byProject.set(r.projectId, list)
  }
  return byProject
}

// Build the ability for a user within one org. Org admins get full access;
// everyone else gets exactly what their project_member rows grant, shaped by
// each environment's visibility/lock. A non-member (or member with no project
// rows) gets an empty ability (no access).
export async function getUserAbility(userId: string, orgId: string): Promise<AppAbility> {
  const member = await lookupOrgMember(userId, orgId)
  if (!member) return buildAbility([])
  const orgRole = member.role === 'admin' ? 'admin' : 'member'
  if (orgRole === 'admin') return buildAbility(grantsFromMembership('admin', []))
  const [projectRows, envsByProject] = await Promise.all([
    lookupProjectGrants(userId, orgId),
    lookupEnvMetaByProject(orgId),
  ])
  return buildAbility(grantsFromMembership(orgRole, projectRows, envsByProject))
}

// Ability-based authorization checks. `check` receives the user's compiled
// ability and returns whether the action is allowed. The Api* variant throws a
// 403 Response (REST routes); the plain variant throws Error('FORBIDDEN')
// (server actions), matching the existing requireOrgMember behavior.
export async function requireApiCan(
  userId: string,
  orgId: string,
  check: (ability: AppAbility) => boolean,
): Promise<void> {
  const ability = await getUserAbility(userId, orgId)
  if (!check(ability)) throw forbiddenResponse()
}

export async function requireCan(
  userId: string,
  orgId: string,
  check: (ability: AppAbility) => boolean,
): Promise<void> {
  const ability = await getUserAbility(userId, orgId)
  if (!check(ability)) throw new Error('FORBIDDEN')
}

// Page-loader variant: redirects to the dashboard root instead of throwing,
// and returns the compiled ability so the loader can reuse it for filtering
// without a second getUserAbility call.
export async function requirePageCan(
  userId: string,
  orgId: string,
  check: (ability: AppAbility) => boolean,
): Promise<AppAbility> {
  const ability = await getUserAbility(userId, orgId)
  if (!check(ability)) throw redirect('/dash')
  return ability
}

// Org-admin only — for administration not tied to an existing project scope
// (creating projects, org settings). org-admin ⇒ `manage all`.
export async function requireApiOrgAdmin(userId: string, orgId: string): Promise<void> {
  await requireApiCan(userId, orgId, (a) => a.can('manage', 'all'))
}

// Build the ability for an API token from its capability + scope.
export function getTokenAbility(token: {
  capability: 'read-only' | 'read-write'
  projectId: string
  environmentId: string | null
}): AppAbility {
  return buildAbility([tokenGrant(token.capability, token.projectId, token.environmentId)])
}

// ── Derive current secrets from event log ───────────────────────────
// Replays the append-only secretEvent log for an environment and returns
// the current state: last "set" event per name wins, "delete" removes it.

export type DerivedSecret = {
  id: string
  name: string
  valueEncrypted: string
  iv: string
  createdAt: number
  updatedAt: number
  userId: string | null
}

// Minimal shape of a secret event row needed to replay current state.
type SecretEventRow = {
  id: string
  name: string
  operation: string
  valueEncrypted: string | null
  iv: string | null
  userId: string | null
  createdAt: number
}

// Replay an append-only event log (ordered by createdAt asc) into the current
// set of secrets. Last "set" per name wins; "delete" removes it. Rows missing
// a value/iv are dropped. Pure — no DB access, so it can run on rows fetched
// from any query or batch.
function replaySecretEvents(events: SecretEventRow[]): DerivedSecret[] {
  const state = new Map<string, {
    id: string
    name: string
    valueEncrypted: string | null
    iv: string | null
    userId: string | null
    createdAt: number
    firstCreatedAt: number
  }>()

  for (const evt of events) {
    const existing = state.get(evt.name)
    if (evt.operation === 'delete') {
      state.delete(evt.name)
    } else {
      state.set(evt.name, {
        id: evt.id,
        name: evt.name,
        valueEncrypted: evt.valueEncrypted,
        iv: evt.iv,
        userId: evt.userId,
        createdAt: evt.createdAt,
        firstCreatedAt: existing?.firstCreatedAt ?? evt.createdAt,
      })
    }
  }

  return Array.from(state.values())
    .filter((s) => s.valueEncrypted && s.iv)
    .map((s) => ({
      id: s.id,
      name: s.name,
      valueEncrypted: s.valueEncrypted!,
      iv: s.iv!,
      createdAt: s.firstCreatedAt,
      updatedAt: s.createdAt,
      userId: s.userId,
    }))
}

export async function deriveSecrets(environmentId: string): Promise<DerivedSecret[]> {
  const db = getDb()
  const events = await db.query.secretEvent.findMany({
    where: { environmentId },
    orderBy: { createdAt: 'asc' },
  })
  return replaySecretEvents(events)
}

// ── Derive secrets for one env + all names across envs in ONE batch ─
// The project secrets page needs two things: the decryptable secrets for the
// selected environment, and the union of secret names across every environment
// (to render the "missing in this env" hints). Previously this was two separate
// round-trips (deriveSecrets + deriveAllSecretNames). This folds every
// secret_event read into a single db.batch so the whole page costs one D1
// round-trip for secret data instead of N+1.
export async function deriveEnvironmentSecretsAndNames(
  { environmentIds, selectedEnvId }: { environmentIds: string[]; selectedEnvId: string | null },
): Promise<{ secrets: DerivedSecret[]; allNames: string[]; byEnv: Record<string, DerivedSecret[]> }> {
  if (environmentIds.length === 0) return { secrets: [], allNames: [], byEnv: {} }
  const db = getDb()

  const [firstEnvId, ...restEnvIds] = environmentIds
  const results = await db.batch([
    db.query.secretEvent.findMany({
      where: { environmentId: firstEnvId },
      orderBy: { createdAt: 'asc' },
    }),
    ...restEnvIds.map((envId) =>
      db.query.secretEvent.findMany({
        where: { environmentId: envId },
        orderBy: { createdAt: 'asc' },
      }),
    ),
  ])

  const allNames = new Set<string>()
  const byEnv: Record<string, DerivedSecret[]> = {}
  let selected: DerivedSecret[] = []
  for (let i = 0; i < environmentIds.length; i++) {
    const envId = environmentIds[i]!
    const derived = replaySecretEvents(results[i]!)
    byEnv[envId] = derived
    if (envId === selectedEnvId) selected = derived
    for (const secret of derived) allNames.add(secret.name)
  }

  return {
    secrets: selectedEnvId ? selected : [],
    allNames: [...allNames].sort(),
    byEnv,
  }
}

// ── Secrets API auth (session OR bearer token) ─────────────────────
// Unified auth for secrets API routes. Accepts either:
// 1. Session cookie → verifies org membership, returns { userId }
// 2. Authorization: Bearer sig_... → verifies token scope, returns { apiTokenId }
//
// Exactly one of userId/apiTokenId is set in the return value. This maps
// directly to secretEvent columns — the event log shows either the user
// name or the API token name depending on which performed the action.

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401, headers: { 'content-type': 'application/json' },
  })
}

function forbiddenResponse(msg = 'forbidden'): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status: 403, headers: { 'content-type': 'application/json' },
  })
}

export type SecretsAuth = { userId: string; apiTokenId: null } | { userId: null; apiTokenId: string }

// The environmentRef can be either a ULID or a slug. For token auth the
// token's project scope is used to resolve slugs. For session auth we
// need the caller to pass projectId when using a slug.
// Returns { auth, environmentId } where environmentId is the resolved ULID.
export async function requireSecretsApiAuth(
  {
    request,
    environmentRef,
    projectId,
    action,
  }: {
    request: Request
    environmentRef: string
    projectId?: string | null
    // The Secret action this route requires (verb → action mapping lives at the
    // call site). Access is granted only if the actor's ability permits it on
    // the resolved (projectId, environmentId).
    action: SecretAction
  },
): Promise<SecretsAuth & { environmentId: string }> {
  const authHeader = request.headers.get('authorization')
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

  // API tokens use the "sig_" prefix — check those first.
  // Non-prefixed bearer tokens fall through to session auth (BetterAuth bearer plugin).
  if (bearer?.startsWith('sig_')) {
    const hashedKey = await hashTokenKey(bearer)
    const db = getDb()
    const token = await db.query.apiToken.findFirst({
      where: { hashedKey },
      columns: { id: true, projectId: true, environmentId: true, capability: true },
    })
    if (!token) throw unauthorizedResponse()

    // Resolve the environment ref (ID or slug) using the token's project scope
    const env = await resolveEnvironment(environmentRef, token.projectId)
    if (!env || env.projectId !== token.projectId) throw forbiddenResponse('token does not have access to this environment')

    // If token is scoped to a specific environment, enforce it
    if (token.environmentId && token.environmentId !== env.id) {
      throw forbiddenResponse('token is scoped to a different environment')
    }

    // Locked (read-only) environments reject ALL token writes — tokens are
    // never admins, so no automated process can mutate a locked env's secrets.
    // Read the flag FRESH (resolveEnvironment is memoized ~5min); a security
    // lock must take effect immediately, not after the cache expires.
    if (isSecretWriteAction(action)) {
      const meta = await db.query.environment.findFirst({
        where: { id: env.id },
        columns: { locked: true },
      })
      if (meta?.locked) throw forbiddenResponse('environment is read-only')
    }

    const ability = getTokenAbility(token)
    if (!ability.can(action, subject('Secret', { projectId: token.projectId, environmentId: env.id }))) {
      throw forbiddenResponse('token capability does not allow this action')
    }

    return { userId: null, apiTokenId: token.id, environmentId: env.id }
  }

  // Session auth path — works with both cookies and BetterAuth bearer tokens
  const session = await getSession(request)
  if (!session) throw unauthorizedResponse()

  const env = await resolveEnvironment(environmentRef, projectId)
  if (!env?.orgId) throw new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })

  const ability = await getUserAbility(session.userId, env.orgId)
  if (!ability.can(action, subject('Secret', { projectId: env.projectId, environmentId: env.id }))) {
    throw forbiddenResponse()
  }

  return { userId: session.userId, apiTokenId: null, environmentId: env.id }
}

// ── API token helpers ───────────────────────────────────────────────
// Tokens use SHA-256 hashing — the full key is never stored, only shown
// once at creation. generateApiToken() creates the raw key + hash + prefix.
// verifyApiToken() looks up a key by its hash for API authentication.

export async function hashTokenKey(key: string): Promise<string> {
  const encoded = new TextEncoder().encode(key)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function generateApiToken(): Promise<{ key: string; hashedKey: string; prefix: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const raw = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  const key = `sig_${raw}`
  const hashedKey = await hashTokenKey(key)
  const prefix = raw.slice(0, 12)
  return { key, hashedKey, prefix }
}

export async function verifyApiToken(key: string): Promise<{
  tokenId: string
  projectId: string
  environmentId: string | null
} | null> {
  const hashedKey = await hashTokenKey(key)
  const db = getDb()
  const token = await db.query.apiToken.findFirst({
    where: { hashedKey },
    columns: { id: true, projectId: true, environmentId: true },
  })
  if (!token) return null
  return { tokenId: token.id, projectId: token.projectId, environmentId: token.environmentId }
}

// ── Encryption (AES-256-GCM) ────────────────────────────────────────

async function getEncryptionKey(): Promise<CryptoKey> {
  const configuredKey = process.env.ENCRYPTION_KEY?.trim()
  if (configuredKey) {
    const raw = Uint8Array.from(atob(configuredKey), (c) => c.charCodeAt(0))
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  }

  // AES-256 needs exactly 32 bytes. Hashing the Better Auth secret gives a
  // stable 32-byte fallback key. Plain base64-encoding the secret text would
  // produce variable-length bytes and break encryption.
  const derived = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.BETTER_AUTH_SECRET))
  return crypto.subtle.importKey('raw', derived, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encrypt(plaintext: string): Promise<{ encrypted: string; iv: string }> {
  const key = await getEncryptionKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  return {
    encrypted: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    iv: btoa(String.fromCharCode(...iv)),
  }
}

export async function decrypt(encrypted: string, iv: string): Promise<string> {
  const key = await getEncryptionKey()
  const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0))
  const ciphertext = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0))
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, ciphertext)
  return new TextDecoder().decode(plaintext)
}

export async function safeDecrypt(encrypted: string, iv: string): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  try {
    const value = await decrypt(encrypted, iv)
    return { ok: true, value }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Decryption failed' }
  }
}
