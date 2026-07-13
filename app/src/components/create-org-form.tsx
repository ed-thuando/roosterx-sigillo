// Client component form for creating a new organization.
// Uses server action, navigates on success.

"use client";

import { z } from "zod";
import { parseFormData } from "spiceflow";
import { ErrorBoundary } from "spiceflow/react";
import { Button } from "sigillo-app/src/components/ui/button";
import { Input } from "sigillo-app/src/components/ui/input";
import { NativeSelect } from "sigillo-app/src/components/ui/native-select";
import { createOrgAction } from "../actions.ts";

const orgSchema = z.object({
  name: z.string().min(1, "Name is required"),
  importFromOrgId: z.string().optional(),
});
const fields = orgSchema.keyof().enum;

export function CreateOrgForm({
  adminOrgs = [],
}: {
  adminOrgs?: { id: string; name: string }[];
}) {
  return (
    <ErrorBoundary
      fallback={
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 flex flex-col gap-2">
          <ErrorBoundary.ErrorMessage className="text-sm text-destructive" />
          <ErrorBoundary.ResetButton className="text-sm text-destructive underline cursor-pointer self-start">
            Try again
          </ErrorBoundary.ResetButton>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        action={async (formData: FormData) => {
          const { name, importFromOrgId } = parseFormData(orgSchema, formData);
          await createOrgAction({
            name,
            importFromOrgId: importFromOrgId ? importFromOrgId : undefined,
          });
        }}
      >
        <div>
          <label htmlFor="org-name" className="text-sm font-medium mb-1.5 block">Name</label>
          <Input
            id="org-name"
            name={fields.name}
            placeholder="My Organization"
            required
            autoFocus
            className="w-full"
          />
        </div>

        {adminOrgs.length > 0 && (
          <div>
            <label htmlFor="import-org" className="text-sm font-medium mb-1.5 block">
              Import members from
            </label>
            <NativeSelect
              id="import-org"
              name={fields.importFromOrgId}
              defaultValue=""
              className="w-full"
            >
              <option value="">Don't import — start empty</option>
              {adminOrgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </NativeSelect>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Copies every member (and their role) from the chosen organization.
              You stay an admin.
            </p>
          </div>
        )}

        <Button type="submit">Create Organization</Button>
      </form>
    </ErrorBoundary>
  );
}
