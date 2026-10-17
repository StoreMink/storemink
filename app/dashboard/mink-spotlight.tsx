"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  MINK_GUIDE_TARGETS,
  type MinkGuideTarget,
  type MinkHighlight,
} from "@/lib/mink/guide-targets";

/**
 * A ring and a note around one dashboard control, so "show me where I change
 * the delivery rate" ends with the control pointed at rather than described.
 *
 * ★ FOUND AT RUNTIME, NEVER BY A SELECTOR FROM THE MODEL: a `data-mink-target`
 * hook first, then the control's visible label against the registry's own
 * pattern. It waits up to a few seconds for the page to render, re-measures
 * on scroll and resize, and leaves on a click anywhere, Escape, a route
 * change or a timeout. The overlay never captures pointer events, so the
 * control under the ring still works.
 */
const WAIT_MS = 6_000;
const SHOW_MS = 20_000;
const POLL_MS = 200;

export function findMinkGuideElement(
  target: MinkHighlight["target"],
): HTMLElement | null {
  const hooked = document.querySelector<HTMLElement>(
    `[data-mink-target="${target}"]`,
  );
  if (hooked && isVisible(hooked)) return hooked;
  const entry: MinkGuideTarget = MINK_GUIDE_TARGETS[target];
  const pattern = new RegExp(entry.text, "i");
  const candidates =
    entry.role === "control"
      ? Array.from(
          document.querySelectorAll<HTMLElement>(
            "main input, main select, main textarea, main fieldset",
          ),
        )
      : Array.from(
          document.querySelectorAll<HTMLElement>(
            "main button, main a, main [role='button'], main summary",
          ),
        );
  return (
    candidates.find(
      (element) =>
        !element.closest(".mink-chat-surface") &&
        isVisible(element) &&
        pattern.test(accessibleName(element)),
    ) ?? null
  );
}

function accessibleName(element: HTMLElement): string {
  const aria = element.getAttribute("aria-label");
  if (aria) return aria.trim();
  const id = element.getAttribute("id");
  if (id) {
    const label = document.querySelector(`label[for="${escapeId(id)}"]`);
    if (label?.textContent)
      return label.textContent.replace(/\s+/g, " ").trim();
  }
  if (element instanceof HTMLFieldSetElement) {
    return (element.querySelector("legend")?.textContent ?? "").trim();
  }
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function isVisible(element: HTMLElement): boolean {
  if (element.closest("[hidden]")) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function escapeId(id: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(id)
    : id.replace(/["\\]/g, "\\$&");
}

export function MinkSpotlight({
  highlight,
  onDone,
}: {
  highlight: MinkHighlight;
  onDone: () => void;
}) {
  const pathname = usePathname();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let element: HTMLElement | null = null;
    let cancelled = false;
    const startedAt = Date.now();
    const measure = () => {
      if (cancelled || !element) return;
      setRect(element.getBoundingClientRect());
    };
    const timers: number[] = [];
    const find = () => {
      if (cancelled) return;
      element = findMinkGuideElement(highlight.target);
      if (element) {
        element.scrollIntoView?.({ block: "center", behavior: "smooth" });
        measure();
        window.addEventListener("scroll", measure, true);
        window.addEventListener("resize", measure);
        timers.push(window.setTimeout(onDone, SHOW_MS));
        return;
      }
      if (Date.now() - startedAt > WAIT_MS) {
        setMissing(true);
        timers.push(window.setTimeout(onDone, 4_000));
        return;
      }
      timers.push(window.setTimeout(find, POLL_MS));
    };
    const dismiss = () => onDone();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDone();
    };
    find();
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape);
    return () => {
      cancelled = true;
      for (const timer of timers) window.clearTimeout(timer);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape);
    };
  }, [highlight.target, onDone]);

  // A route change ends it: the control it pointed at is no longer on screen.
  const [startPath] = useState(pathname);
  useEffect(() => {
    if (pathname !== startPath) onDone();
  }, [pathname, startPath, onDone]);

  if (missing) {
    return (
      <div
        role="status"
        data-testid="mink-spotlight-missing"
        className="pointer-events-none fixed bottom-6 left-1/2 z-[95] -translate-x-1/2 rounded-full border border-[#ddd6f5] bg-white px-4 py-2 text-[12px] text-[#3e3262] shadow-lg"
      >
        {highlight.label} is not on this screen. {highlight.hint ?? ""}
      </div>
    );
  }
  if (!rect) return null;
  const pad = 6;
  const below = rect.bottom + 12;
  const noteTop = below + 72 < window.innerHeight ? below : rect.top - 12;
  return (
    <div
      aria-hidden="true"
      data-testid="mink-spotlight"
      className="pointer-events-none fixed inset-0 z-[95]"
    >
      <div
        className="mink-spotlight-ring absolute rounded-xl border-2 border-[#6d4dff] shadow-[0_0_0_4px_rgba(109,77,255,0.25)]"
        style={{
          top: rect.top - pad,
          left: rect.left - pad,
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
        }}
      />
      <div
        className="absolute max-w-[280px] rounded-xl border border-[#ddd6f5] bg-white px-3 py-2 text-[12px] text-[#2d2350] shadow-lg"
        style={{
          top: noteTop,
          left: Math.max(12, Math.min(rect.left, window.innerWidth - 292)),
          transform: noteTop < rect.top ? "translateY(-100%)" : undefined,
        }}
      >
        <p className="font-semibold">{highlight.label}</p>
        {highlight.hint ? (
          <p className="mt-0.5 text-[#6f6a8a]">{highlight.hint}</p>
        ) : null}
      </div>
    </div>
  );
}
