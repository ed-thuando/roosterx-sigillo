"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { useFormStatus } from "react-dom";
import { cn } from "../../lib/utils.ts";
import { Spinner } from "./spinner.tsx";

export const buttonVariants = cva(
  "button shrink-0 disabled:pointer-events-none aria-invalid:border-destructive data-loading:select-none data-loading:text-transparent",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "button--md",
        icon: "button--md button--icon-only",
        "icon-lg": "button--lg button--icon-only",
        "icon-sm": "button--sm button--icon-only",
        "icon-xl": "button--lg button--icon-only",
        "icon-xs": "button--sm button--icon-only size-7 sm:size-6",
        lg: "button--lg",
        sm: "button--sm",
        xl: "button--lg",
        xs: "button--sm h-7 gap-1 px-2 text-xs sm:h-6",
      },
      variant: {
        default:
          "button--primary *:data-[slot=button-loading-indicator]:text-primary-foreground",
        destructive:
          "button--danger *:data-[slot=button-loading-indicator]:text-white",
        ghost:
          "button--ghost *:data-[slot=button-loading-indicator]:text-foreground",
        link: "text-primary underline-offset-4 hover:underline data-pressed:underline *:data-[slot=button-loading-indicator]:text-foreground",
        outline:
          "button--outline *:data-[slot=button-loading-indicator]:text-foreground",
        secondary:
          "button--secondary *:data-[slot=button-loading-indicator]:text-secondary-foreground",
      },
    },
  },
);

export interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  render,
  children,
  loading: loadingProp = false,
  disabled: disabledProp,
  ...props
}: ButtonProps): React.ReactElement {
  const { pending } = useFormStatus();
  // Auto-detect form submission: show loading when this button's form is pending
  // and this is a submit button (type="submit"). The explicit loading prop takes
  // precedence for non-form use cases.
  const isSubmit = props.type === "submit";
  const loading = loadingProp || (isSubmit && pending);
  const isDisabled: boolean = Boolean(loading || disabledProp);
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] =
    render ? undefined : "button";

  const defaultProps = {
    children: (
      <>
        {children}
        {loading && (
          <Spinner
            className="pointer-events-none absolute"
            data-slot="button-loading-indicator"
          />
        )}
      </>
    ),
    className: cn(buttonVariants({ className, size, variant })),
    "aria-disabled": loading || undefined,
    "data-loading": loading ? "" : undefined,
    "data-slot": "button",
    disabled: isDisabled,
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}
