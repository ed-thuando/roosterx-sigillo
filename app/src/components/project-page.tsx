// Project detail page client component.
// Always renders the secrets matrix (all environments as columns).

"use client";

import { useState } from "react";
import { XIcon } from "lucide-react";
import { SecretsMatrix } from "sigillo-app/src/components/secrets-matrix";
import { FramePanel } from "sigillo-app/src/components/ui/frame";
import { useLoaderData } from "spiceflow/react";

const cliBannerCookieName = "sigillo-cli-banner-dismissed";
const cliBannerCodeLines = [
  [
    { text: "npm", kind: "command" },
    { text: " install -g ", kind: "plain" },
    { text: "sigillo", kind: "value" },
  ],
  [
    { text: "sigillo", kind: "value" },
    { text: " login", kind: "plain" },
  ],
  [
    { text: "sigillo", kind: "value" },
    { text: " run", kind: "plain" },
    { text: " -- ", kind: "operator" },
    { text: "next", kind: "command" },
    { text: " dev", kind: "plain" },
  ],
  [
    { text: "sigillo", kind: "value" },
    { text: " run --project ", kind: "plain" },
    { text: "website", kind: "value" },
    { text: " --env ", kind: "plain" },
    { text: "dev", kind: "value" },
    { text: " -- ", kind: "operator" },
    { text: "next", kind: "command" },
    { text: " dev", kind: "plain" },
  ],
] as const;

function CliBanner() {
  const [open, setOpen] = useState(true);
  if (!open) return null;

  return (
    <FramePanel className="relative overflow-hidden border-border/70 bg-muted/45 p-4 sm:p-8">
      <button
        type="button"
        onClick={() => {
          document.cookie = `${cliBannerCookieName}=1; Path=/; Max-Age=31536000; SameSite=Lax`;
          setOpen(false);
        }}
        className="absolute right-0.5 top-0.5 z-10 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Dismiss CLI banner"
        title="Dismiss"
      >
        <XIcon className="size-4" />
      </button>

      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <div className="flex flex-1 flex-col gap-1.5">
          <h2 className="text-base font-semibold tracking-tight">
            Use the Sigillo CLI
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Install with npm, then use <code className="mono-sm text-foreground">sigillo run</code> to pass secrets to your process. Output is redacted by default.
          </p>
        </div>

        <pre className="cli-banner-code overflow-x-auto rounded-xl border border-border/70 bg-background/95 p-4 text-[12px]">
          <code className="block mono-sm">
            {cliBannerCodeLines.map((line, i) => (
              <span key={i} className="flex gap-x-4 leading-6">
                <span className="w-5 shrink-0 select-none text-right text-muted-foreground/80">
                  {i + 1}
                </span>
                <span className="whitespace-pre">
                  {line.map((token, j) => (
                    <span key={j} className={`cli-token-${token.kind}`}>
                      {token.text}
                    </span>
                  ))}
                </span>
              </span>
            ))}
          </code>
        </pre>
      </div>
    </FramePanel>
  );
}

export function ProjectPage() {
  const { projectName, showBanner } =
    useLoaderData('/dash/projects/:projectId/envs/:envSlug');

  return (
    <div className="flex flex-col gap-4 w-full">
      <h1 className="text-2xl font-bold tracking-tight">{projectName}</h1>

      {showBanner && <CliBanner />}

      <SecretsMatrix />
    </div>
  );
}
