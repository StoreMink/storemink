"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronLeft, ChevronRight, Images } from "lucide-react";
import type { ThemeStudioCheckScreenshotSample } from "@/lib/theme-studio/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// "Screenshots" in the Checks tab (owner-approved, 24 Oct 2026, 23:55 IST;
// wave TS-2, builder 2C): the pictures the newest final check stored, so the
// operator can see by eye that the theme is responsive, phone-friendly and
// accurate.
//
// ★ NOTHING LOADS UNTIL THE SECTION IS OPENED, AND NEVER ALL AT ONCE. A check
// stores up to 30 full-page pictures of several megabytes each. The section
// starts closed; once open it shows one width at a time, the pages of that
// width as thumbnails, each lazy-loaded from the bytes route (never a data:
// URL) with its own width and height so nothing jumps. The viewer loads one
// picture: the one it shows.
//
// ★ THE VIEWER is an in-app dialog: the arrow keys and a swipe move between
// the pages and on to the next width, Escape closes it, focus returns to the
// thumbnail that opened it, and the page and width are written under the
// picture. Plain words; no tooltip.
// ---------------------------------------------------------------------------

/** The check widths, narrowest first, with their names. */
export const SCREENSHOT_WIDTHS: readonly { key: string; label: string }[] = [
  { key: "phone360", label: "Phone 360" },
  { key: "phone390", label: "Phone 390" },
  { key: "tablet768", label: "Tablet 768" },
  { key: "laptop1024", label: "Laptop 1024" },
  { key: "desktop1440", label: "Desktop 1440" },
];

const PAGE_NAMES: Readonly<Record<string, string>> = {
  home: "Home",
  shop: "Shop",
  product: "Product",
  cart: "Cart",
  content: "Content page",
  not_found: "Not-found page",
};

/** A page's name ("Product"); an unknown page's own key, in words. */
export function screenshotPageName(page: string): string {
  return Object.hasOwn(PAGE_NAMES, page)
    ? PAGE_NAMES[page]
    : page.replace(/[_-]+/g, " ").trim() || "A page";
}

/** A width's name ("Phone 390"); an unknown width's own key. */
export function screenshotWidthName(viewport: string): string {
  return (
    SCREENSHOT_WIDTHS.find((width) => width.key === viewport)?.label ?? viewport
  );
}

/** The bytes route of one check screenshot. */
export function screenshotUrl(projectId: string, assetId: string): string {
  return `/api/platform/theme-studio/projects/${encodeURIComponent(projectId)}/check-screenshots/${encodeURIComponent(assetId)}`;
}

/** The widths the check stored, narrowest first (a width this screen does
 * not know comes last, in the order stored). */
export function screenshotWidths(
  samples: readonly ThemeStudioCheckScreenshotSample[],
): string[] {
  const known = SCREENSHOT_WIDTHS.map((w) => w.key).filter((key) =>
    samples.some((sample) => sample.viewport === key),
  );
  const other: string[] = [];
  for (const sample of samples)
    if (!known.includes(sample.viewport) && !other.includes(sample.viewport))
      other.push(sample.viewport);
  return [...known, ...other];
}

/** Every screenshot in viewing order: width by width, pages in the order
 * the check took them. */
export function screenshotSequence(
  samples: readonly ThemeStudioCheckScreenshotSample[],
): ThemeStudioCheckScreenshotSample[] {
  return screenshotWidths(samples).flatMap((width) =>
    samples.filter((sample) => sample.viewport === width),
  );
}

/** A swipe this far sideways (and more sideways than up or down) moves to
 * the next or the previous picture. */
const SWIPE_PX = 48;

export function CheckScreenshots({
  projectId,
  samples,
  takenAt,
}: {
  projectId: string;
  samples: readonly ThemeStudioCheckScreenshotSample[];
  /** When the check took them, in words ("25 Oct 2026, 10:05"). */
  takenAt: string | null;
}) {
  const widths = screenshotWidths(samples);
  const sequence = screenshotSequence(samples);
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState<string | null>(widths[0] ?? null);
  const [viewing, setViewing] = useState<number | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);

  if (!samples.length) {
    return (
      <p className="studio-muted text-sm">
        No screenshots yet. The final check stores them when it measures this
        design; a layout check takes none.
      </p>
    );
  }

  const shown = width
    ? samples.filter((sample) => sample.viewport === width)
    : [];
  const current = viewing === null ? null : (sequence[viewing] ?? null);
  const atStart = viewing === null || viewing <= 0;
  const atEnd = viewing === null || viewing >= sequence.length - 1;
  const caption = current
    ? `${screenshotPageName(current.page)}, ${screenshotWidthName(current.viewport)}`
    : "";

  function move(step: -1 | 1) {
    setViewing((at) =>
      at === null ? at : Math.min(sequence.length - 1, Math.max(0, at + step)),
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      move(-1);
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    swipe.current = { x: event.clientX, y: event.clientY };
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = swipe.current;
    swipe.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) <= Math.abs(dy)) return;
    move(dx < 0 ? 1 : -1);
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="dash-btn dash-btn-ghost"
          aria-expanded={open}
          aria-controls="studio-check-screenshots"
          onClick={() => setOpen((value) => !value)}
        >
          <Images aria-hidden="true" className="h-4 w-4" />
          {open
            ? "Hide the screenshots"
            : `Show the screenshots (${samples.length})`}
        </button>
        {takenAt ? (
          <span className="studio-muted text-sm">Taken {takenAt}</span>
        ) : null}
      </div>
      {open ? (
        <div id="studio-check-screenshots" className="grid gap-3">
          <div
            role="group"
            aria-label="Screen width"
            className="studio-segmented flex-wrap"
          >
            {widths.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={key === width}
                onClick={() => setWidth(key)}
              >
                {screenshotWidthName(key)}
              </button>
            ))}
          </div>
          <ul
            className="flex flex-wrap gap-3"
            aria-label={`Pages at ${width ? screenshotWidthName(width) : ""}`}
          >
            {shown.map((sample) => {
              const index = sequence.indexOf(sample);
              const name = screenshotPageName(sample.page);
              return (
                <li key={sample.assetId}>
                  <button
                    type="button"
                    className="grid w-32 gap-1 text-left"
                    aria-label={`Open ${name}, ${screenshotWidthName(sample.viewport)}, full size`}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      setViewing(index);
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={screenshotUrl(projectId, sample.assetId)}
                      alt=""
                      width={sample.width}
                      height={sample.height}
                      loading="lazy"
                      decoding="async"
                      className="h-48 w-32 rounded-[var(--dash-radius-sm)] border border-[var(--dash-border-strong)] bg-[var(--dash-surface)] object-cover object-top"
                    />
                    <span className="text-sm">{name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <Dialog
        open={current !== null}
        onOpenChange={(next) => {
          if (!next) setViewing(null);
        }}
      >
        <DialogContent
          className="studio-root sm:max-w-[min(1100px,calc(100%-2rem))]"
          finalFocus={opener}
          onKeyDown={onKeyDown}
        >
          <DialogTitle>Check screenshot</DialogTitle>
          <DialogDescription className="sr-only">
            Use the left and right arrow keys, or swipe, to move between the
            pages and the widths. Escape closes it.
          </DialogDescription>
          {current ? (
            <figure className="grid gap-2">
              <div
                className="max-h-[70dvh] overflow-auto rounded-[var(--dash-radius-sm)] border border-[var(--dash-border)]"
                // Up and down scroll the page's picture; sideways is a swipe.
                style={{ touchAction: "pan-y" }}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onPointerCancel={() => {
                  swipe.current = null;
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  key={current.assetId}
                  src={screenshotUrl(projectId, current.assetId)}
                  alt={`${caption}, the whole page`}
                  width={current.width}
                  height={current.height}
                  decoding="async"
                  draggable={false}
                  className="mx-auto block h-auto w-full"
                  style={{ maxWidth: `${current.width}px` }}
                />
              </div>
              <figcaption className="text-sm">
                {caption}{" "}
                <span className="studio-muted">
                  ({(viewing ?? 0) + 1} of {sequence.length})
                </span>
              </figcaption>
            </figure>
          ) : null}
          {/* At either end the button stays focusable (aria-disabled, not
              disabled): a button that becomes disabled while it has focus
              drops focus out of the dialog, and the arrow keys stop. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              className="dash-btn dash-btn-ghost aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
              aria-disabled={atStart}
              onClick={() => {
                if (!atStart) move(-1);
              }}
            >
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              Previous
            </button>
            <button
              type="button"
              className="dash-btn dash-btn-ghost aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
              aria-disabled={atEnd}
              onClick={() => {
                if (!atEnd) move(1);
              }}
            >
              Next
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
