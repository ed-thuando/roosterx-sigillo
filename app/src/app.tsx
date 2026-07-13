// Spiceflow entry for the self-hosted secret sharing app.
// Pages for secrets management UI. REST API routes live in api.ts.
// Also serves as the Cloudflare Worker entry via the default export.
//
// Two nested layouts:
// 1. /* — HTML shell (head, body, fonts, ProgressBar)
// 2. /dash/* — Authenticated app shell with sidebar
//
// Standalone pages (no sidebar): /, /login, /device, /invite/:id

import './globals.css'
import { Spiceflow } from 'spiceflow'
import { Head, ProgressBar } from 'spiceflow/react'
import {
  getDb, getSession,
  requirePageSession,
  requirePageOrgMember,
  requirePageCan,
  getOrgIdForProject,
  getUserAbility,
  deriveEnvironmentSecretsAndNames,
  safeDecrypt,
} from './db.ts'
import { createSessionFromIdToken, signOutRequest, createDeviceCode, pollDeviceToken, approveDeviceCode } from './auth.ts'
import { subject, canReadProject, filterReadableEnvironments } from './ability.ts'
import { apiApp } from './api.ts'
import { cn } from 'sigillo-app/src/lib/utils'
import { CreateOrgForm } from 'sigillo-app/src/components/create-org-form'
import { SigilloLogo } from 'sigillo-app/src/components/logo'
import { TabBar } from 'sigillo-app/src/components/tab-bar'
import { app as holocronApp } from '@holocron.so/vite/app'


const cliBannerCookieName = 'sigillo-cli-banner-dismissed'

function isTruthy<T>(value: T | null | undefined): value is T {
  return value != null
}

// Only allow local app paths for redirects — prevents open redirects and
// avoids sending logged-in users to API routes or obvious 404s.
function safeRedirectPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/dash'
  if (value === '/' || value.startsWith('/device')) return value
  if (value === '/dash' || value.startsWith('/dash/') || value.startsWith('/invite/')) return value
  return '/'
}

function hasCookie(args: { cookieHeader: string; name: string }) {
  return args.cookieHeader
    .split(';')
    .some((part) => part.trim().startsWith(`${args.name}=`))
}

// Resolve where a redirect should land: the first project the caller may read
// (in the given order) and the first environment within it that they may read.
// Falls back to slug '_' when the project is readable but has no readable env.
// Returns null when no project is readable.
type ProjectWithEnvs = { id: string; environments?: { id: string; slug: string; createdAt: number }[] }
function firstReadableProjectEnv(
  ability: import('./ability.ts').AppAbility,
  projects: ProjectWithEnvs[],
): { projectId: string; envSlug: string } | null {
  for (const p of projects) {
    if (!canReadProject(ability, p.id)) continue
    const envs = filterReadableEnvironments(ability, p.id, [...(p.environments || [])])
      .sort((a, b) => a.createdAt - b.createdAt)
    return { projectId: p.id, envSlug: envs[0]?.slug ?? '_' }
  }
  return null
}

export const app = new Spiceflow()

  // ── Native auth (Firebase Google sign-in → own D1 session) ──────
  // Frontend does Firebase signInWithPopup, then POSTs the ID token here.
  .route({
    method: 'POST',
    path: '/auth/session',
    detail: { hide: true },
    async handler({ request }) {
      const body = (await request.json().catch(() => null)) as { idToken?: string } | null
      if (!body?.idToken) {
        return new Response(JSON.stringify({ error: 'missing idToken' }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return createSessionFromIdToken(request, body.idToken)
    },
  })
  .route({
    method: 'POST',
    path: '/auth/signout',
    detail: { hide: true },
    handler({ request }) {
      return signOutRequest(request)
    },
  })

  // ── Device authorization (RFC 8628) for the CLI `sigillo login` ──
  .route({
    method: 'POST',
    path: '/api/auth/device/code',
    detail: { hide: true },
    async handler({ request }) {
      const body = (await request.json().catch(() => null)) as { client_id?: string } | null
      const res = await createDeviceCode(new URL(request.url).origin, body?.client_id ?? null)
      return new Response(JSON.stringify(res), { headers: { 'content-type': 'application/json' } })
    },
  })
  .route({
    method: 'POST',
    path: '/api/auth/device/token',
    detail: { hide: true },
    async handler({ request }) {
      const body = (await request.json().catch(() => null)) as { device_code?: string } | null
      if (!body?.device_code) {
        return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      const r = await pollDeviceToken(body.device_code)
      if ('error' in r) {
        return new Response(JSON.stringify({ error: r.error }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ access_token: r.accessToken, token_type: 'Bearer' }), { headers: { 'content-type': 'application/json' } })
    },
  })
  .route({
    method: 'POST',
    path: '/api/auth/device/approve',
    detail: { hide: true },
    async handler({ request }) {
      const session = await getSession(request)
      if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
      const body = (await request.json().catch(() => null)) as { user_code?: string } | null
      if (!body?.user_code) return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400, headers: { 'content-type': 'application/json' } })
      const ok = await approveDeviceCode(body.user_code, session.userId)
      return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 400, headers: { 'content-type': 'application/json' } })
    },
  })

  // ── Layout: Dashboard routes (HTML shell + sidebar chrome) ──────
  // No global layout('/*') because holocron provides its own HTML shell
  // for docs pages (/). Each route group registers AppShell separately.
  .layout('/dash/*', async ({ children, request }) => {
    const { MobileMenuButton } = await import('sigillo-app/src/components/sidebar')
    return (
      <AppShell request={request} mobileMenuSlot={<MobileMenuButton />}>
        {children}
      </AppShell>
    )
  })

  // ── Layout: Standalone pages (login, invite, new-org) ──
  .layout('/login', async ({ children, request }) => <AppShell request={request}>{children}</AppShell>)
  .layout('/device', async ({ children, request }) => <AppShell request={request}>{children}</AppShell>)
  .layout('/invite/*', async ({ children, request }) => <AppShell request={request}>{children}</AppShell>)

  .loader('/dash/*', async ({ request }) => {
    const db = getDb()
    const pathname = new URL(request.url).pathname
    const projectId = new URLPattern({ pathname: '/dash/projects/:projectId/*' })
      .exec(request.url)?.pathname.groups.projectId ?? null
    const session = await requirePageSession(request)
    const members = await db.query.orgMember.findMany({
      where: { userId: session.userId },
      with: { org: true },
    })

    const orgs = members.filter((m) => m.org != null).map((m) => ({
      id: m.org!.id!, name: m.org!.name!, role: m.role,
      createdAt: m.org!.createdAt!, updatedAt: m.org!.updatedAt!,
    }))

    // Tokens tab is admin-only (its loader requires Read ApiToken); resolve the
    // caller's ability for the current project so the tab bar can hide it
    // instead of letting members click a tab that just 403s.
    let canReadTokens = false
    if (projectId) {
      const orgId = await getOrgIdForProject(projectId)
      if (orgId) {
        const ability = await getUserAbility(session.userId, orgId)
        canReadTokens = ability.can('Read', subject('ApiToken', { projectId }))
      }
    }

    return {
      orgs,
      projectId,
      pathname,
      currentProjectFirstEnvSlug: null,
      canReadTokens,
      user: { name: session.user.name || 'User', email: session.user.email || '' },
    }
  })

  .loader('/dash/orgs/:orgId', async ({ params, request }) => {
    const db = getDb()
    const session = await requirePageSession(request)
    await requirePageOrgMember(session.userId, params.orgId)
    const ability = await getUserAbility(session.userId, params.orgId)

    const allProjects = await db.query.project.findMany({
      where: { orgId: params.orgId },
      with: { environments: true },
      orderBy: { createdAt: 'desc' },
    })

    const projects = allProjects
      .filter((p) => canReadProject(ability, p.id))
      .map((p) => {
        const readableEnvs = filterReadableEnvironments(ability, p.id, [...(p.environments || [])])
          .sort((a, b) => a.createdAt - b.createdAt)
        return { id: p.id, name: p.name, firstEnvSlug: readableEnvs[0]?.slug ?? null }
      })

    return {
      orgId: params.orgId,
      projectId: null,
      projects,
      environments: [],
      currentProjectFirstEnvSlug: null,
    }
  })

  .loader('/dash/projects/:projectId/*', async ({ params, request }) => {
    const db = getDb()
    const url = new URL(request.url)
    const { projectId } = params
    const session = await requirePageSession(request)
    const orgId = await getOrgIdForProject(projectId)
    if (!orgId) throw Response.redirect(new URL('/', request.url).toString(), 302)
    await requirePageOrgMember(session.userId, orgId)
    // Must be able to read this project; org-admins and any grant on it pass.
    const ability = await requirePageCan(session.userId, orgId, (a) => canReadProject(a, projectId))

    const allProjects = await db.query.project.findMany({
      where: { orgId },
      with: { environments: true },
      orderBy: { createdAt: 'desc' },
    })

    // Sidebar/nav: only projects the caller may read.
    const projects = allProjects
      .filter((p) => canReadProject(ability, p.id))
      .map((p) => {
        const readableEnvs = filterReadableEnvironments(ability, p.id, [...(p.environments || [])])
          .sort((a, b) => a.createdAt - b.createdAt)
        return { id: p.id, name: p.name, firstEnvSlug: readableEnvs[0]?.slug ?? null }
      })
    const currentProject = allProjects.find((project) => project.id === projectId)
    // Env dropdown/tab bar: only environments in the caller's grant scope.
    const environments = filterReadableEnvironments(ability, projectId, [...(currentProject?.environments || [])])
      .sort((a, b) => a.createdAt - b.createdAt)

    return {
      orgId,
      projectId,
      projectName: currentProject?.name ?? 'Project',
      pathname: url.pathname,
      projects,
      environments,
      currentProjectFirstEnvSlug: projects.find((project) => project.id === projectId)?.firstEnvSlug ?? null,
    }
  })

  // ── Layout 2: Authenticated app shell with sidebar ─────────────
  .layout('/dash/*', async ({ children, loaderData }) => {
    const { Sidebar, MobileDrawer } = await import('sigillo-app/src/components/sidebar')
    const projectId = loaderData.projectId
    return (
      <div className="isolate grow relative flex w-full min-h-0 bg-background md:h-svh">
        <Sidebar />
        <MobileDrawer />
        <div className="flex min-w-0 flex-1 flex-col p-2 md:pl-0">
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            {projectId && (
              <div className="sticky top-0 z-30 shrink-0 border-b border-border bg-card/80 px-4 backdrop-blur">
                <TabBar
                  projectId={projectId}
                  pathname={loaderData.pathname}
                  firstEnvSlug={loaderData.currentProjectFirstEnvSlug}
                  canReadTokens={loaderData.canReadTokens ?? false}
                />
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-5">
              {children}
            </div>
          </main>
        </div>
      </div>
    )
  })

  // ── /dash redirect → resolve user's default project+env in one hop ──
  // The holocron navbar links to /dash. This resolves the full path
  // (org → project → env) in a single worker invocation instead of
  // chaining through /dash/orgs/:orgId → /dash/projects/:id → /envs/:slug.
  .get('/dash', async ({ request }) => {
    const session = await getSession(request)
    if (!session) return Response.redirect(new URL('/login?redirect=/dash', request.url).toString(), 302)
    const db = getDb()
    const members = await db.query.orgMember.findMany({
      where: { userId: session.userId },
      with: { org: true },
    })
    const lastOrg = members
      .filter((m) => m.org != null)
      .sort((a, b) => b.org!.createdAt! - a.org!.createdAt!)
      [0]
    if (!lastOrg) {
      return Response.redirect(new URL('/dash/new-org', request.url).toString(), 302)
    }
    const orgId = lastOrg.org!.id
    const ability = await getUserAbility(session.userId, orgId)
    const projects = await db.query.project.findMany({
      where: { orgId },
      columns: { id: true },
      with: { environments: { columns: { id: true, slug: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    })
    const target = firstReadableProjectEnv(ability, projects)
    if (target) {
      const href = `/dash/projects/${encodeURIComponent(target.projectId)}/envs/${encodeURIComponent(target.envSlug)}`
      return Response.redirect(new URL(href, request.url).toString(), 302)
    }
    return Response.redirect(new URL(`/dash/orgs/${encodeURIComponent(orgId)}`, request.url).toString(), 302)
  })

  // ── Org root redirect → resolve first project+env in one hop ──
  .get('/dash/orgs/:orgId', async ({ params, request }) => {
    const session = await requirePageSession(request)
    await requirePageOrgMember(session.userId, params.orgId)
    const db = getDb()
    const ability = await getUserAbility(session.userId, params.orgId)
    const projects = await db.query.project.findMany({
      where: { orgId: params.orgId },
      columns: { id: true },
      with: { environments: { columns: { id: true, slug: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    })
    const target = firstReadableProjectEnv(ability, projects)
    if (target) {
      const href = `/dash/projects/${encodeURIComponent(target.projectId)}/envs/${encodeURIComponent(target.envSlug)}`
      return Response.redirect(new URL(href, request.url).toString(), 302)
    }
    return null
  })

  // ── Org page (redirects to first project, or shows empty state) ─
  .page('/dash/orgs/:orgId', async ({ params, request }) => {
    const session = await requirePageSession(request)
    await requirePageOrgMember(session.userId, params.orgId)
    const db = getDb()
    const ability = await getUserAbility(session.userId, params.orgId)

    const projects = await db.query.project.findMany({
        where: { orgId: params.orgId },
        columns: { id: true, name: true },
        orderBy: { createdAt: 'desc' },
      })
    const firstReadable = projects.find((p) => canReadProject(ability, p.id))

    if (firstReadable) {
      return Response.redirect(new URL(`/dash/projects/${encodeURIComponent(firstReadable.id)}`, request.url).toString(), 302)
    }

    const { NewProjectButton } = await import('sigillo-app/src/components/sidebar')

    return (
      <div className="max-w-3xl">
        <h1 className="text-lg font-semibold tracking-tight mb-2">No projects yet</h1>
        <p className="text-muted-foreground mb-6">Create your first project to start managing secrets.</p>
        <NewProjectButton orgId={params.orgId} />
      </div>
    )
  })

  // ── New Organization page (standalone, no sidebar) ─────────────
  .page('/dash/new-org', async ({ request }) => {
    const session = await requirePageSession(request)
    const db = getDb()
    // Orgs the caller admins — offered as "import members from" sources so a
    // new org can reuse an existing team without inviting everyone again.
    const adminMemberships = await db.query.orgMember.findMany({
      where: { userId: session.userId, role: 'admin' },
      with: { org: { columns: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    })
    const adminOrgs = adminMemberships
      .filter((m) => m.org != null)
      .map((m) => ({ id: m.org!.id, name: m.org!.name }))
    return (
      <div className="mx-auto w-full max-w-md py-12">
        <div className="space-y-6 rounded-3xl border border-border bg-card p-8 shadow-sm">
          <div>
            <h1 className="text-lg font-semibold tracking-tight mb-1">New Organization</h1>
            <p className="text-sm text-muted-foreground">
              Organizations group your projects and team members.
            </p>
          </div>
          <CreateOrgForm adminOrgs={adminOrgs} />
        </div>
      </div>
    )
  })

  // ── Project root redirect → first env ─────────────────────────
  .page('/dash/projects/:projectId', async ({ params, request, redirect }) => {
    const db = getDb()
    const session = await requirePageSession(request)
    const orgId = await getOrgIdForProject(params.projectId)
    if (!orgId) throw Response.redirect(new URL('/', request.url).toString(), 302)
    await requirePageOrgMember(session.userId, orgId)
    const ability = await requirePageCan(session.userId, orgId, (a) => canReadProject(a, params.projectId))
    const environments = filterReadableEnvironments(
      ability,
      params.projectId,
      await db.query.environment.findMany({ where: { projectId: params.projectId }, orderBy: { createdAt: 'asc' } }),
    )
    const firstEnvSlug = environments[0]?.slug || '_'
    return redirect(`/dash/projects/${encodeURIComponent(params.projectId)}/envs/${encodeURIComponent(firstEnvSlug)}`)
  })

  .loader('/dash/projects/:projectId/envs/:envSlug', async ({ request, params, redirect }) => {
    const db = getDb()
    const { projectId, envSlug } = params
    const session = await requirePageSession(request)
    const orgId = await getOrgIdForProject(projectId)
    if (!orgId) throw redirect('/')
    await requirePageOrgMember(session.userId, orgId)
    const ability = await requirePageCan(session.userId, orgId, (a) => canReadProject(a, projectId))

    // Only environments the caller may read; the selected env is chosen from
    // this filtered set so an out-of-scope slug can never be decrypted.
    const environments = filterReadableEnvironments(
      ability,
      projectId,
      await db.query.environment.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
    )

    const matchedEnv = environments.find((e) => e.slug === envSlug)
    const selectedEnvId = matchedEnv?.id ?? environments[0]?.id ?? null

    if (selectedEnvId && !matchedEnv && environments[0]) {
      throw redirect(`/dash/projects/${encodeURIComponent(projectId)}/envs/${encodeURIComponent(environments[0].slug)}`)
    }
    const canWriteSecret = selectedEnvId
      ? ability.can('Edit', subject('Secret', { projectId, environmentId: selectedEnvId }))
      : false

    let secrets: { id: string; name: string; value: string; createdAt: number; updatedAt: number; createdBy: { id: string; name: string } | null }[] = []
    // One D1 batch derives the selected env's secrets AND the union of names
    // across all envs, instead of a separate names round-trip + per-env query.
    const { secrets: derived, allNames: allSecretNames, byEnv } = await deriveEnvironmentSecretsAndNames({
      environmentIds: environments.map((e) => e.id),
      selectedEnvId,
    })

    // Decrypt every readable env's secrets into a name→value map so the matrix
    // view can show values across all environments. `environments` is already
    // filtered to the caller's read scope. Undecryptable rows are skipped.
    const secretsByEnv: Record<string, Record<string, string>> = {}
    for (const env of environments) {
      const map: Record<string, string> = {}
      for (const d of byEnv[env.id] ?? []) {
        const res = await safeDecrypt(d.valueEncrypted, d.iv)
        if (res.ok) map[d.name] = res.value
      }
      secretsByEnv[env.id] = map
    }
    if (selectedEnvId) {
      // Resolve all secret authors in ONE query instead of findFirst per user.
      const userIds = [...new Set(derived.map((d) => d.userId).filter(isTruthy))]
      const userMap = new Map<string, { id: string; name: string }>()
      if (userIds.length > 0) {
        const users = await db.query.user.findMany({
          where: { id: { in: userIds } },
          columns: { id: true, name: true },
        })
        for (const u of users) userMap.set(u.id, u)
      }
      // Use safeDecrypt so a single undecryptable secret (e.g. written under a
      // different key) can't crash the whole secrets page — skip the bad rows.
      const decrypted = await Promise.all(derived.map(async (d) => {
        const res = await safeDecrypt(d.valueEncrypted, d.iv)
        if (!res.ok) return null
        return {
          id: d.id, name: d.name,
          value: res.value,
          createdAt: d.createdAt, updatedAt: d.updatedAt,
          createdBy: d.userId ? (userMap.get(d.userId) ?? null) : null,
        }
      }))
      secrets = decrypted.filter(isTruthy)
    }

    const cookieHeader = request.headers.get('cookie') ?? ''

    return {
      selectedEnvId,
      secrets,
      secretsByEnv,
      allSecretNames,
      canWriteSecret,
      showBanner: !hasCookie({ cookieHeader, name: cliBannerCookieName }),
    }
  })

  // ── Project detail with env ───────────────────────────────────
  .page('/dash/projects/:projectId/envs/:envSlug', async ({ loaderData }) => {
    const { ProjectPage } = await import('sigillo-app/src/components/project-page')
    return <ProjectPage key={loaderData.selectedEnvId ?? 'none'} />
  })

    .loader('/dash/projects/:projectId/environments', async ({ params, redirect }) => {
    throw redirect(`/dash/projects/${params.projectId}/access`)
  })

  .page('/dash/projects/:projectId/environments', async () => {
    return <></>
  })

.loader('/dash/projects/:projectId/access', async ({ params, request, redirect }) => {
    const db = getDb()
    const { projectId } = params
    const session = await requirePageSession(request)
    const orgId = await getOrgIdForProject(projectId)
    if (!orgId) throw redirect('/')
    const { role } = await requirePageOrgMember(session.userId, orgId)
    const ability = await requirePageCan(session.userId, orgId, (a) => canReadProject(a, projectId))

    const members = await db.query.orgMember.findMany({
      where: { orgId },
      with: { user: { columns: { id: true, name: true, email: true, image: true } } },
      orderBy: { createdAt: 'asc' },
    })

    // Project-level access grants + data needed by the add-grant form.
    const projectMembers = await db.query.projectMember.findMany({
      where: { projectId },
      with: {
        user: { columns: { id: true, name: true, email: true, image: true } },
        environment: { columns: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
    const environments = await db.query.environment.findMany({
      where: { projectId },
      columns: { id: true, name: true, slug: true, locked: true, visibility: true },
      orderBy: { createdAt: 'asc' },
    })
    const canManageProjectMembers = ability.can('Create', subject('ProjectMember', { projectId }))
    const canWriteEnv = ability.can('Create', subject('Environment', { projectId }))

    return {
      orgId,
      projectId,
      role,
      currentUserId: session.userId,
      members,
      projectMembers,
      environments,
      canManageProjectMembers,
      canWriteEnv,
    }
  })

  .page('/dash/projects/:projectId/access', async () => {
    const { AccessPage } = await import('sigillo-app/src/components/access-table')

    return <AccessPage />
  })

  // ── Event Log page ─────────────────────────────────────────────
  
  
  .loader('/dash/projects/:projectId/tokens', async ({ params, request, redirect }) => {
    const db = getDb()
    const { projectId } = params
    const session = await requirePageSession(request)
    const orgId = await getOrgIdForProject(projectId)
    if (!orgId) throw redirect('/')
    await requirePageOrgMember(session.userId, orgId)
    // API tokens carry secret read/write power — only project-admins may list/manage
    // them, so gating the whole page on Read is sufficient (Read⇔Create⇔Delete here).
    await requirePageCan(session.userId, orgId, (a) => a.can('Read', subject('ApiToken', { projectId })))

    const tokens = await db.query.apiToken.findMany({
      where: { projectId },
      with: {
        creator: { columns: { id: true, name: true } },
        environment: { columns: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    return {
      projectId,
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        environmentId: t.environmentId,
        environmentName: t.environment?.name ?? null,
        createdBy: t.creator?.name ?? '—',
        createdAt: t.createdAt,
      })),
    }
  })

  .page('/dash/projects/:projectId/tokens', async () => {
    const { TokensPage } = await import('sigillo-app/src/components/tokens-page')

    return (
      <div className="flex flex-col gap-4 w-full">
        <TokensPage />
      </div>
    )
  })

  // ── Settings page ────────────────────────────────────────────────
  .loader('/dash/projects/:projectId/settings', async ({ params, request, redirect }) => {
    const db = getDb()
    const session = await requirePageSession(request)
    const orgId = await getOrgIdForProject(params.projectId)
    if (!orgId) throw redirect('/')
    await requirePageOrgMember(session.userId, orgId)
    // Any project reader may open Settings. Destructive actions enforce their
    // own finer-grained checks (org-admins for org deletion, project-admins for
    // project deletion), so we no longer bounce non-org-admins to /dash.
    const ability = await requirePageCan(session.userId, orgId, (a) => canReadProject(a, params.projectId))
    const isOrgAdmin = ability.can('manage', 'all')

    const [orgRow, projects] = await Promise.all([
      db.query.org.findFirst({ where: { id: orgId }, columns: { name: true } }),
      db.query.project.findMany({ where: { orgId }, columns: { id: true, name: true }, orderBy: { createdAt: 'asc' } }),
    ])

    return {
      orgId,
      orgName: orgRow?.name ?? 'Organization',
      isOrgAdmin,
      // Deleting a project needs project-admin (or org-admin); hide the button
      // for everyone else so they don't click a dead destructive action.
      canDeleteProject: ability.can('Delete', subject('Project', { id: params.projectId })),
      projectId: params.projectId,
      projectName: projects.find((p) => p.id === params.projectId)?.name ?? 'Project',
      projectNames: projects.map((p) => p.name),
    }
  })

  .page('/dash/projects/:projectId/settings', async () => {
    const { SettingsPage } = await import('sigillo-app/src/components/settings-page')

    return (
      <div className="flex flex-col gap-4 w-full">
        <SettingsPage />
      </div>
    )
  })


  // ── Login page (standalone, no sidebar) ─────────────────────────
  .page('/login', async ({ request, redirect }) => {
    const session = await getSession(request)
    const url = new URL(request.url)
    const redirectTo = safeRedirectPath(url.searchParams.get('redirect'))
    if (session) return redirect(redirectTo)
    const { LoginButton } = await import('sigillo-app/src/components/login-button')
    const firebaseConfig = {
      apiKey: process.env.FIREBASE_API_KEY ?? '',
      authDomain: process.env.FIREBASE_AUTH_DOMAIN ?? '',
      projectId: process.env.FIREBASE_PROJECT_ID ?? '',
    }
    return (
      <ContentFrame className="flex justify-center items-center min-h-[60vh] px-4">
        <div className="w-full max-w-sm space-y-6 rounded-3xl border border-border bg-card p-8 shadow-sm text-center">
          <SigilloLogo className="h-[40px] w-auto mx-auto" />
          <p className="text-muted-foreground">Sign in to manage your secrets</p>
          <LoginButton callbackURL={redirectTo} firebaseConfig={firebaseConfig} />
        </div>
      </ContentFrame>
    )
  })

  // ── Device approval page (CLI `sigillo login`) — Firebase-gated ──
  .page('/device', async ({ request }) => {
    const session = await getSession(request)
    if (!session) {
      const url = new URL(request.url)
      const back = encodeURIComponent('/device' + url.search)
      return Response.redirect(new URL(`/login?redirect=${back}`, request.url).toString(), 302)
    }
    const userCode = new URL(request.url).searchParams.get('user_code') ?? ''
    const { DeviceFlow } = await import('sigillo-app/src/components/device-flow')
    return (
      <ContentFrame className="flex justify-center items-center min-h-[60vh] px-4">
        <div className="w-full max-w-sm rounded-3xl border border-border bg-card p-8 shadow-sm">
          <DeviceFlow initialCode={userCode} />
        </div>
      </ContentFrame>
    )
  })

  // ── Invite accept page (standalone, no sidebar) ────────────────
  .page('/invite/:id', async ({ params, request, redirect }) => {
    const db = getDb()
    const invite = await db.query.orgInvitation.findFirst({
      where: { id: params.id },
      with: { org: { columns: { id: true, name: true } }, creator: { columns: { name: true } } },
    })
    if (!invite || invite.expiresAt < Date.now()) {
      return (
        <ContentFrame className="flex justify-center items-center min-h-[60vh] px-4">
          <div className="w-full max-w-sm space-y-2 rounded-3xl border border-border bg-card p-8 shadow-sm text-center">
            <h1 className="text-lg font-semibold tracking-tight">Invalid Invitation</h1>
            <p className="text-muted-foreground">This invitation link is invalid or has expired.</p>
          </div>
        </ContentFrame>
      )
    }
    const session = await getSession(request)
    if (!session) {
      const redirectPath = `/invite/${encodeURIComponent(params.id)}`
      return Response.redirect(new URL(`/login?redirect=${encodeURIComponent(redirectPath)}`, request.url).toString(), 302)
    }
    // Already a member? Skip straight to the org
    const existing = await db.query.orgMember.findFirst({
      where: { orgId: invite.orgId, userId: session.userId },
    })
    if (existing) return redirect(`/dash/orgs/${encodeURIComponent(invite.orgId)}`)
    const { AcceptInviteButton } = await import('sigillo-app/src/components/accept-invite-button')
    return (
      <ContentFrame className="flex justify-center items-center min-h-[60vh] px-4">
        <div className="w-full max-w-sm space-y-4 rounded-3xl border border-border bg-card p-8 shadow-sm text-center">
          <h1 className="text-2xl font-bold tracking-tight">Join {invite.org!.name}</h1>
          <p className="text-muted-foreground text-sm">
            <span className="font-medium text-foreground">{invite.creator!.name}</span> invited you to join this organization.
          </p>
          <p className="text-muted-foreground text-xs">
            This will give you access to <strong>all projects</strong> in this organization.
          </p>
          <AcceptInviteButton invitationId={params.id} />
        </div>
      </ContentFrame>
    )
  })

  // ── REST API (separate sub-app) ─────────────────────────────────
  .use(apiApp)

  // ── Holocron docs/landing page ────────────────────────────────
  // Mounted last so all explicit routes above take priority.
  // Holocron handles "/" (index.mdx) with its own HTML shell, navbar, and footer.
  .use(holocronApp)

/** Shared HTML shell for all non-holocron pages (dash, login, device, invite).
 *  Holocron provides its own shell for docs routes (/).
 *  This replaces the old global layout('/*'). */
const appThemeScript = `(function(){var d=document.documentElement;var m=document.cookie.match(/(?:^|;\\s*)color-theme=(light|dark)(?:;|$)/);var t=m?m[1]:null;if(!t)t=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';if(t==='dark')d.classList.add('dark');else d.classList.remove('dark')})()`

// Recover open tabs from stale hashed chunks after a redeploy: when a lazy
// import fails (chunk 404), reload once to pull the current HTML + asset hashes.
const chunkReloadScript = `window.addEventListener('vite:preloadError',function(){if(!window.__spReloaded){window.__spReloaded=true;location.reload()}})`

function getInitialThemeClass(request: Request) {
  const cookie = request.headers.get('cookie') ?? ''
  return /(?:^|;\s*)color-theme=dark(?:;|$)/.test(cookie) ? 'dark' : undefined
}

function AppShell({ children, mobileMenuSlot, request }: { children: React.ReactNode; mobileMenuSlot?: React.ReactNode; request: Request }) {
  return (
    <html lang="en" className={getInitialThemeClass(request)} data-default-theme="system" suppressHydrationWarning>
      <Head>
        <Head.Meta charSet="UTF-8" />
        <Head.Meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <Head.Title>Sigillo — Secret Manager</Head.Title>
        <Head.Link rel="icon" type="image/png" href="/favicon.png" />
      </Head>
      <body className="relative flex flex-col min-h-screen bg-background font-sans antialiased">
        <script dangerouslySetInnerHTML={{ __html: appThemeScript }} />
        <script dangerouslySetInnerHTML={{ __html: chunkReloadScript }} />
        <ProgressBar color="var(--accent)" />
        <Navbar mobileMenuSlot={mobileMenuSlot} />
        {children ?? (
          <div className="max-w-(--content-max-width) mx-auto w-full flex items-center justify-center text-muted-foreground py-12">
            Page not found
          </div>
        )}
      </body>
    </html>
  )
}


function ContentFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("max-w-(--content-max-width) mx-auto w-full", className)}>
      {children}
    </div>
  )
}

function Navbar({ mobileMenuSlot }: { mobileMenuSlot?: React.ReactNode }) {
  return (
    <nav className="md:hidden sticky top-0 z-50 w-full bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="max-w-(--content-max-width) mx-auto">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2">
            {mobileMenuSlot}
            {/* Root ('/') is served by holocron, not a typed spiceflow route,
                so use a plain anchor for this cross-app navigation. */}
            <a href="/" className="text-primary hover:opacity-80 transition-opacity">
              <SigilloLogo className="h-[36px] w-auto shrink-0" />
            </a>
          </div>
        </div>
      </div>
    </nav>
  )
}

export type App = typeof app

export default {
  fetch: (request: Request) => app.handle(request),
} satisfies ExportedHandler<Env>

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
