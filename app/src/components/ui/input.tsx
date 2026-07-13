// Reusable Input and Textarea components with consistent styling.
// Consolidates the repeated border/focus/ring patterns used across
// secrets-table, environments-table, sidebar, and create-org-form.

import type * as React from "react";
import { cn } from "sigillo-app/src/lib/utils";

export function Input({
  className,
  inputSize = "default",
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & { inputSize?: "default" | "sm"; size?: never }): React.ReactElement {
  return (
    <input
      className={cn(
        "input border border-border shadow-none text-sm",
        inputSize === "sm" ? "h-7 px-2 py-0.5" : "h-9 px-3",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">): React.ReactElement {
  return (
    <textarea
      className={cn(
        "input border border-border shadow-none w-full px-3 py-2 text-sm resize-y",
        className,
      )}
      {...props}
    />
  );
}
