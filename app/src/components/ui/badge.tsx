"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";
import { cn } from "sigillo-app/src/lib/utils";

export const badgeVariants = cva(
  "chip justify-center whitespace-nowrap gap-1 overflow-hidden px-2 py-0.5 [&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "chip--sm",
        lg: "chip--md",
        sm: "chip--sm text-[.625rem] leading-4",
      },
      variant: {
        default: "chip--primary chip--accent",
        destructive: "chip--primary chip--danger",
        outline:
          "chip--default border border-border bg-transparent text-foreground [button&,a&]:hover:bg-accent [button&,a&]:hover:text-accent-foreground",
        secondary: "chip--soft chip--default",
      },
    },
  },
);

export interface BadgeProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof badgeVariants>["variant"];
  size?: VariantProps<typeof badgeVariants>["size"];
}

export function Badge({
  className,
  variant,
  size,
  render,
  ...props
}: BadgeProps): React.ReactElement {
  const defaultProps = {
    className: cn(badgeVariants({ className, size, variant })),
    "data-slot": "badge",
  };

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}
