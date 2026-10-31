"use client";

import type { ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { Info } from "lucide-react";

import { cn } from "@/lib/utils";

// The small "i" next to a field label. Guidance a merchant needs only now and
// then lives here instead of in a placeholder or a paragraph under the field.
//
// ★ A popover, not a tooltip: a tooltip never opens on a touch screen, and a
// phone is where a merchant is most likely to need the hint. It opens on hover
// with a mouse and on tap everywhere.
// ★ Put it BESIDE a <label>, never inside one: inside, its name becomes part
// of the field's accessible name ("Facts about your business More
// information").
// ★ The popup portals to <body>, so it is styled with plain Tailwind colours
// and works inside the dashboard, the console, POS and dialogs alike.
export function InfoTip({
  children,
  label = "More information",
  side = "top",
  align = "center",
  className,
}: {
  children: ReactNode;
  /** Read by screen readers, e.g. "About facts". */
  label?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        type="button"
        openOnHover
        delay={120}
        closeDelay={80}
        aria-label={label}
        data-slot="info-tip"
        className={cn(
          // A 16px icon with a 32px invisible hit area around it.
          "relative inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full align-middle text-neutral-400 transition-colors outline-none after:absolute after:-inset-2 after:content-[''] hover:text-neutral-700 focus-visible:text-neutral-700 focus-visible:ring-2 focus-visible:ring-indigo-500/40 data-[popup-open]:text-neutral-700",
          className,
        )}
      >
        <Info aria-hidden className="size-3.5" strokeWidth={2.25} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          className="isolate z-[60]"
        >
          <Popover.Popup
            data-slot="info-tip-content"
            className="max-w-[min(280px,calc(100vw-24px))] origin-(--transform-origin) rounded-lg bg-neutral-900 px-3 py-2 text-[12.5px] leading-relaxed font-normal text-white shadow-lg outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
