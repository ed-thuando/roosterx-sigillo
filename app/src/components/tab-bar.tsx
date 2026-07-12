// Dashboard tab bar (Secrets/Tokens/Access/Settings).
//
// spiceflow's router fetches <path>.rsc with cache: 'no-store' and exposes
// no prefetch API, so we can't prefetch tab content. Instead we highlight the
// clicked tab optimistically on click and clear that state once navigation
// commits (via router.subscribe), so the UI feels instant.

"use client";

import { useState, useEffect } from "react";
import { router, Link } from "spiceflow/react";
import { cn } from "sigillo-app/src/lib/utils";

export function TabBar({
  projectId,
  pathname,
  firstEnvSlug,
}: {
  projectId: string;
  pathname: string;
  firstEnvSlug: string | null;
}) {
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [current, setCurrent] = useState(pathname);
  useEffect(() => {
    setCurrent(router.pathname);
    const unsub = router.subscribe(() => {
      setCurrent(router.pathname);
      setPendingHref(null);
    });
    return unsub;
  }, []);

  const base = `/dash/projects/${projectId}`;
  const safePath = pathname ?? "";
  const envMatch = safePath.match(new RegExp(`^${base}/envs/([^/]+)`));
  const envSlug = envMatch?.[1] ?? firstEnvSlug;
  const secretsHref = envSlug
    ? router.href("/dash/projects/:projectId/envs/:envSlug", { projectId, envSlug })
    : router.href("/dash/projects/:projectId", { projectId });
  const activePath = current ?? "";
  const tabs = [
    { label: "Secrets", href: secretsHref, active: activePath === base || activePath.startsWith(`${base}/envs`) },
    { label: "Tokens", href: router.href("/dash/projects/:projectId/tokens", { projectId }), active: activePath === `${base}/tokens` },
    { label: "Access", href: router.href("/dash/projects/:projectId/access", { projectId }), active: activePath === `${base}/access` },
    { label: "Settings", href: router.href("/dash/projects/:projectId/settings", { projectId }), active: activePath === `${base}/settings` },
  ] as const;

  return (
    <div className="max-w-(--content-max-width) mx-auto w-full">
      <div className="flex h-12 items-stretch gap-1 overflow-x-auto scrollbar-hide">
        {tabs.map((tab) => {
          const isActive = pendingHref ? pendingHref === tab.href : tab.active;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              onClick={() => setPendingHref(tab.href)}
              className={cn(
                "relative flex items-center shrink-0 whitespace-nowrap px-3 text-sm no-underline transition-colors duration-150",
                isActive
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              {isActive && (
                <div className="absolute bottom-0 inset-x-3 h-0.5 rounded-full bg-primary" />
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
