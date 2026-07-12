// Dropdown menu built on @base-ui/react/menu.
// Follows the same wrapping pattern as select.tsx and dialog.tsx.
// Portal-based positioning avoids layout shifts.

"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type React from "react";
import { cn } from "sigillo-app/src/lib/utils";

export const DropdownMenu: typeof MenuPrimitive.Root = MenuPrimitive.Root;

export function DropdownMenuTrigger({
  className,
  ...props
}: MenuPrimitive.Trigger.Props): React.ReactElement {
  return (
    <MenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      className={cn("cursor-pointer outline-none", className)}
      suppressHydrationWarning
      {...props}
    />
  );
}

export function DropdownMenuPopup({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  anchor,
  ...props
}: MenuPrimitive.Popup.Props & {
  side?: MenuPrimitive.Positioner.Props["side"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  align?: MenuPrimitive.Positioner.Props["align"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  anchor?: MenuPrimitive.Positioner.Props["anchor"];
}): React.ReactElement {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="z-50"
        data-slot="dropdown-menu-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            "min-w-(--anchor-width) origin-(--transform-origin) rounded-2xl border border-border bg-overlay p-1 text-overlay-foreground shadow-overlay outline-none transition-[transform,scale,opacity] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            className,
          )}
          data-slot="dropdown-menu-popup"
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: MenuPrimitive.Item.Props): React.ReactElement {
  return (
    <MenuPrimitive.Item
      className={cn(
        "flex min-h-8 w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-highlighted:bg-default-soft data-highlighted:text-default-soft-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="dropdown-menu-item"
      {...props}
    />
  );
}

export function DropdownMenuLinkItem({
  className,
  ...props
}: MenuPrimitive.LinkItem.Props): React.ReactElement {
  return (
    <MenuPrimitive.LinkItem
      closeOnClick
      className={cn(
        "flex min-h-8 w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-highlighted:bg-default-soft data-highlighted:text-default-soft-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="dropdown-menu-link-item"
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <div
      role="separator"
      className={cn("my-1 h-px bg-border", className)}
      data-slot="dropdown-menu-separator"
    />
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "px-2 py-1.5 text-xs font-medium text-muted-foreground",
        className,
      )}
      data-slot="dropdown-menu-label"
      {...props}
    />
  );
}

export { MenuPrimitive as DropdownMenuPrimitive };
