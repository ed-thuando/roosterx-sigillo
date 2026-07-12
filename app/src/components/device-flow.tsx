// Device-authorization approval page for the CLI `sigillo login`.
// User is already logged in (page is Firebase-gated). They confirm the code
// shown by the CLI; we POST it to /api/auth/device/approve, which marks the
// device code approved so the CLI's poll returns a session token.

"use client";

import { useState } from "react";
import { CheckIcon } from "lucide-react";
import { Button } from "sigillo-app/src/components/ui/button";
import { Input } from "sigillo-app/src/components/ui/input";

export function DeviceFlow({ initialCode = "" }: { initialCode?: string }) {
  const [code, setCode] = useState(initialCode);
  const [status, setStatus] = useState<"idle" | "loading" | "approved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/auth/device/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_code: code.trim().toUpperCase() }),
      });
      if (!res.ok) throw new Error("That code is invalid or expired. Run `sigillo login` again.");
      setStatus("approved");
    } catch (e: any) {
      setError(e?.message || "Approval failed");
      setStatus("error");
    }
  }

  if (status === "approved") {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <CheckIcon className="size-6" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Device approved</h1>
        <p className="text-sm text-muted-foreground">Return to your terminal — the CLI is now logged in.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
      <div className="text-center">
        <h1 className="text-xl font-semibold tracking-tight">Approve CLI login</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Confirm the code shown in your terminal to grant the CLI access to your account.
        </p>
      </div>
      <Input
        value={code}
        onChange={(e) => setCode(e.currentTarget.value)}
        placeholder="XXXX-XXXX"
        autoFocus
        className="text-center mono-sm tracking-widest uppercase"
      />
      {error && <p className="text-sm text-destructive text-center">{error}</p>}
      <Button onClick={approve} loading={status === "loading"} disabled={!code.trim()} size="lg">
        Approve device
      </Button>
    </div>
  );
}
