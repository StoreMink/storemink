"use client";

import { Monitor, Smartphone, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type {
  RevampReview,
  RevampReviewPage,
} from "@/lib/mink/revamp/contract";
import type { DraftDatasets } from "@/app/(storefront)/components/sections/draft-canvas";

/**
 * Before and after, side by side, for a storefront revamp.
 *
 * ★ BOTH SIDES ARE THE REAL STOREFRONT, never a second renderer. "Before" is
 *   the page's own builder preview (`?preview=1`, the current draft); "after"
 *   is the same address in a second frame that, once its canvas is ready, is
 *   handed the proposed sections through the `sm-draft` message the Website
 *   Builder already uses, and the proposed header and footer through
 *   `sm-chrome`. So what the merchant sees here is what the storefront's own
 *   components draw.
 *
 * ★ THE NEW PRODUCTS DO NOT EXIST YET, so the `sm-draft` message carries them
 *   as `datasets` (only the fields a product card needs), which the canvas
 *   merges over its own snapshot. Without it a featured-products section on
 *   the "after" side would show the theme's old samples.
 *
 * ★ A PAGE THE REVAMP CREATES HAS NO "BEFORE" and no address yet, so its
 *   "after" side borrows the homepage's preview canvas and replaces its
 *   sections with the new page's. The header and footer around it are the
 *   proposed ones either way.
 *
 * ★★ ONCE APPLIED, THE DRAFT IS THE REDESIGN, so "before" from the draft would
 *   compare the redesign with itself. The pair becomes "Live now" (the page
 *   shoppers get, no preview flag) and "Your draft" (the Builder draft, which
 *   is exactly what Publish puts live), and nothing proposed is pushed over
 *   the draft: the merchant may have edited it since, and the frame must show
 *   what Publish would really publish.
 */

export const PREVIEW_WIDTHS = { phone: 390, desktop: 1280 } as const;
type PreviewWidth = keyof typeof PREVIEW_WIDTHS;

/** The most products the preview hands the canvas (it bounds them too). */
const MAX_PREVIEW_PRODUCTS = 100;

/** A page's live address, what shoppers see: "" is the homepage. */
export function livePath(slug: string): string {
  const path = slug
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return path ? `/${path}` : "/";
}

/**
 * A page's draft preview address for the review: "" is the homepage. ★
 * `review=1` keeps the Builder preview's draft canvas, handshake and live
 * header and footer, and tells the page to leave out the Builder's own edit
 * layer ("+ Add section" pills, outlines, click-swallowing hit rects) and its
 * draft badge, which this dialog never answers and which sit over the design
 * being judged.
 */
export function previewPath(slug: string): string {
  return `${livePath(slug)}?preview=1&review=1`;
}

/** Where the "after" frame loads: a created page borrows the homepage. */
export function afterPath(page: Pick<RevampReviewPage, "slug" | "create">) {
  return page.create ? previewPath("") : previewPath(page.slug);
}

function keyToSlug(key: string, index: number): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `product-${index + 1}`;
}

/**
 * The review's products in the shape a featured-products section renders.
 * ★ Featured, untracked and with no variants: the canvas shows them in a
 *   "featured" section, never as sold out, at the price the merchant gave.
 */
export function revampPreviewDatasets(
  review: Pick<RevampReview, "products" | "canvas">,
): Required<DraftDatasets> {
  // ★ Categories and the samples Apply hides go live AT Apply, with no draft
  //   for the canvas to read, so they travel in the message like the new
  //   products: an "after" frame showing the old category band, or a theme
  //   sample Apply takes off the shop, is not the shop Apply leaves.
  const categories = review.canvas?.categories ?? [];
  return {
    categories: categories
      .filter((category) => !category.hidden)
      .map((category) => ({
        id: category.id,
        name: category.name,
        slug: category.slug,
        image_url: category.imageUrl,
        description: category.description,
      })),
    hiddenCategoryIds: categories
      .filter((category) => category.hidden)
      .map((category) => category.id),
    hiddenProductIds: review.canvas?.hiddenProductIds ?? [],
    products: review.products
      .slice(0, MAX_PREVIEW_PRODUCTS)
      .map((product, index) => {
        const slug = keyToSlug(product.key, index);
        return {
          id: `revamp-${slug}`,
          name: product.name,
          slug,
          image_url: product.imageUrl,
          base_price:
            product.mrp !== null && product.mrp > product.price
              ? product.mrp
              : product.price,
          selling_price: product.price,
          featured: true,
          category: null,
          category_id: null,
          track_inventory: false,
          stock: 0,
          low_stock_threshold: null,
          allow_backorder: false,
        };
      }),
  };
}

export function MinkRevampPreview({
  review,
  applied = false,
  published = false,
  inProgress = false,
  onClose,
}: {
  review: RevampReview;
  /** Compiled design only; application remains unavailable. */
  inProgress?: boolean;
  /** Apply has run: the draft already holds the redesign. */
  applied?: boolean;
  /** Something went live: the live pages are the redesign's. */
  published?: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  const pickerId = useId();
  const [pageIndex, setPageIndex] = useState(0);
  const [width, setWidth] = useState<PreviewWidth>("desktop");
  const [side, setSide] = useState<"before" | "after">("after");
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const afterRef = useRef<HTMLIFrameElement>(null);
  const releaseRef = useRef<() => void>(() => undefined);
  const page = review.pages[pageIndex] ?? review.pages[0] ?? null;
  const datasets = useMemo(() => revampPreviewDatasets(review), [review]);

  // Focus moves into the dialog and the page behind it stops scrolling.
  useEffect(() => {
    closeRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // ★★ EVERYTHING BEHIND THE DIALOG IS INERT WHILE IT IS OPEN. Key events
  //   inside a frame go to the frame's own document, so the Tab trap below
  //   never sees focus leave the last frame; without this it walks on into
  //   the dashboard behind the overlay. Only what this dialog made inert is
  //   given back, so an element that was inert already stays inert.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const made: Element[] = [];
    for (const element of Array.from(document.body.children)) {
      if (element === overlay || element.hasAttribute("inert")) continue;
      element.setAttribute("inert", "");
      made.push(element);
    }
    const release = () => {
      for (const element of made.splice(0)) element.removeAttribute("inert");
    };
    releaseRef.current = release;
    return release;
  }, []);

  // ★ The page is released BEFORE onClose, which hands focus back to the
  //   card's Preview button: an inert button cannot take it.
  const close = useCallback(() => {
    releaseRef.current();
    onClose();
  }, [onClose]);

  // ★ Escape pressed inside a frame reaches the frame's window, never this
  //   dialog. The frames are this host's own pages, so the dialog listens
  //   there too, with ONE stable listener (the latest close read through a
  //   ref), so neither a reload nor a re-render ever adds a second.
  const latestClose = useRef(close);
  useEffect(() => {
    latestClose.current = close;
  }, [close]);
  const onFrameKey = useCallback((event: Event) => {
    if ((event as { key?: unknown }).key !== "Escape") return;
    event.preventDefault();
    latestClose.current();
  }, []);

  const pushDraft = useCallback(() => {
    const target = afterRef.current?.contentWindow;
    // After Apply the frame is the real draft; see the header note.
    if (!target || !page || applied) return;
    target.postMessage(
      { type: "sm-draft", sections: page.sections, datasets },
      window.location.origin,
    );
  }, [page, datasets, applied]);

  const pushChrome = useCallback(() => {
    const target = afterRef.current?.contentWindow;
    if (!target || !review.chrome || applied) return;
    target.postMessage(
      { type: "sm-chrome", chrome: review.chrome },
      window.location.origin,
    );
  }, [review.chrome, applied]);

  // ★ The tagline and footer description go live at Apply and have no draft,
  //   so the "after" frame is told them on the Builder's own `sm-brand`
  //   channel. Only a half the plan rewrites is sent: a missing field means
  //   "leave it", where an empty one would read as clearing it. The frame's
  //   live listener (ChromeProvider) hands the words to its BrandProvider
  //   (previewBrandFrom), which lays them over the store's own lines, so the
  //   footer and the shop hero show them.
  const pushBrand = useCallback(() => {
    const target = afterRef.current?.contentWindow;
    const brand = review.canvas?.brand;
    if (!target || !brand || applied) return;
    const text: { tagline?: string; blurb?: string } = {};
    if (brand.tagline !== null) text.tagline = brand.tagline;
    if (brand.blurb !== null) text.blurb = brand.blurb;
    if (!text.tagline && !text.blurb) return;
    target.postMessage(
      { type: "sm-brand", brand: text },
      window.location.origin,
    );
  }, [review.canvas?.brand, applied]);

  // ★ The canvas announces itself once its listener exists (the builder's own
  //   handshake), so the draft is sent then rather than guessed at from the
  //   frame's load event, which can fire before hydration. Only the "after"
  //   frame is answered; the "before" frame keeps the current draft.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const frame = afterRef.current?.contentWindow;
      if (!frame || event.source !== frame) return;
      const type = (event.data as { type?: unknown } | null)?.type;
      if (type === "sm-preview-ready") pushDraft();
      if (type === "sm-chrome-ready") {
        pushChrome();
        pushBrand();
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pushDraft, pushChrome, pushBrand]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    // Keep keyboard focus inside the dialog while it is open.
    const focusable = dialogFocusables(dialogRef.current);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * ★ A guard at each end of the dialog catches focus the Tab trap cannot:
   *   tabbing out of a frame's last link lands on the end guard (the key was
   *   the frame's), which sends focus back to the start; arriving at the start
   *   guard from inside goes round to the end, from anywhere else to the start.
   */
  function onGuardFocus(edge: "start" | "end", from: EventTarget | null) {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = dialogFocusables(dialog);
    if (!focusable.length) return;
    const inside = from instanceof Node && dialog.contains(from);
    const target =
      edge === "start" && inside
        ? focusable[focusable.length - 1]
        : focusable[0];
    target.focus();
  }

  if (typeof document === "undefined") return null;

  const viewport = PREVIEW_WIDTHS[width];
  const beforeLabel = applied ? "Live now" : "Before";
  const afterLabel = applied ? "Your draft" : "After";
  const toggle =
    "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-[11px] font-semibold";
  const on = "bg-[#5d3fe3] text-white";
  const off = "text-[#403753] hover:bg-[#f1edff]";

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[110] flex bg-[#14111c]/70 sm:p-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        data-design-in-progress={inProgress || undefined}
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="mx-auto flex h-full w-full max-w-[1600px] flex-col overflow-hidden bg-white text-[#27242d] shadow-2xl sm:rounded-2xl"
      >
        <FocusGuard
          edge="start"
          onFocus={(from) => onGuardFocus("start", from)}
        />
        <div className="flex items-center justify-between gap-3 border-b border-[#ebe7f7] px-4 py-3">
          <h2 id={titleId} className="text-sm font-semibold">
            Preview your redesign
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            aria-label="Close preview"
            className="grid h-9 w-9 place-items-center rounded-lg text-[#403753] hover:bg-[#f1edff]"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>

        {inProgress ? (
          <p className="border-b border-[#ebe7f7] bg-[#fbfaff] px-4 py-2 text-xs text-[#5f5969]">
            Design in progress. Photographs appear once checked, and Apply
            unlocks when the redesign is ready.
          </p>
        ) : null}

        {page ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-[#ebe7f7] px-4 py-2">
              <label
                htmlFor={pickerId}
                className="text-[11px] font-semibold text-[#4a4260]"
              >
                Page
              </label>
              <select
                id={pickerId}
                value={pageIndex}
                onChange={(event) => setPageIndex(Number(event.target.value))}
                className="min-h-9 max-w-full rounded-lg border border-[#d9d2f5] bg-white px-2 text-[12px]"
              >
                {review.pages.map((option, index) => (
                  <option key={`${option.slug}-${index}`} value={index}>
                    {option.create
                      ? `${option.title} (new page)`
                      : option.title}
                  </option>
                ))}
              </select>
              <div
                role="group"
                aria-label="Screen width"
                className="flex rounded-lg border border-[#e2dcf3] p-0.5"
              >
                <button
                  type="button"
                  aria-pressed={width === "phone"}
                  onClick={() => setWidth("phone")}
                  className={`${toggle} ${width === "phone" ? on : off}`}
                >
                  <Smartphone aria-hidden className="h-3.5 w-3.5" />
                  Phone
                </button>
                <button
                  type="button"
                  aria-pressed={width === "desktop"}
                  onClick={() => setWidth("desktop")}
                  className={`${toggle} ${width === "desktop" ? on : off}`}
                >
                  <Monitor aria-hidden className="h-3.5 w-3.5" />
                  Desktop
                </button>
              </div>
              <div
                role="group"
                aria-label="Show"
                className="flex rounded-lg border border-[#e2dcf3] p-0.5 lg:hidden"
              >
                <button
                  type="button"
                  aria-pressed={side === "before"}
                  onClick={() => setSide("before")}
                  className={`${toggle} ${side === "before" ? on : off}`}
                >
                  {beforeLabel}
                </button>
                <button
                  type="button"
                  aria-pressed={side === "after"}
                  onClick={() => setSide("after")}
                  className={`${toggle} ${side === "after" ? on : off}`}
                >
                  {afterLabel}
                </button>
              </div>
            </div>

            <div className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-2">
              <figure
                className={`${side === "before" ? "flex" : "hidden"} min-h-0 flex-col gap-1.5 lg:flex`}
              >
                <figcaption className="text-[11px] font-semibold text-[#4a4260]">
                  {beforeLabel}
                </figcaption>
                {page.create && !published ? (
                  <div className="grid min-h-0 flex-1 place-items-center rounded-xl border border-dashed border-[#d9d2f5] bg-[#faf8ff] p-6 text-center text-[12px] text-[#5f5969]">
                    <p>
                      <span className="block font-semibold text-[#403753]">
                        New page
                      </span>
                      {applied
                        ? "It is in your Website Builder draft and goes on your store when you publish."
                        : "This page does not exist on your store yet."}
                    </p>
                  </div>
                ) : (
                  <ScaledFrame
                    key={`before-${page.slug}`}
                    src={applied ? livePath(page.slug) : previewPath(page.slug)}
                    title={`${page.title}, ${beforeLabel.toLowerCase()}`}
                    viewport={viewport}
                    onFrameKey={onFrameKey}
                  />
                )}
              </figure>
              <figure
                className={`${side === "after" ? "flex" : "hidden"} min-h-0 flex-col gap-1.5 lg:flex`}
              >
                <figcaption className="text-[11px] font-semibold text-[#4a4260]">
                  {afterLabel}
                </figcaption>
                <ScaledFrame
                  key={`after-${pageIndex}`}
                  frameRef={afterRef}
                  // ★ After Apply a created page exists as a draft at its own
                  //   address, so it no longer borrows the homepage canvas.
                  src={applied ? previewPath(page.slug) : afterPath(page)}
                  title={`${page.title}, ${afterLabel.toLowerCase()}`}
                  viewport={viewport}
                  onFrameKey={onFrameKey}
                  onLoad={() => {
                    pushDraft();
                    pushChrome();
                    pushBrand();
                  }}
                />
              </figure>
            </div>
            <p className="border-t border-[#ebe7f7] px-4 py-2 text-[11px] text-[#5f5969]">
              {published
                ? "Your redesign is live on your store."
                : applied
                  ? "Your new pages, header and footer are in your Website Builder draft. Publish to put them live."
                  : "Nothing on your store changes until you apply the redesign."}
            </p>
          </>
        ) : (
          <p className="p-6 text-[12px] text-[#5f5969]">
            There are no pages to preview.
          </p>
        )}
        <FocusGuard edge="end" onFocus={(from) => onGuardFocus("end", from)} />
      </div>
    </div>,
    document.body,
  );
}

const FOCUSABLE =
  'button:not([disabled]), select:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

/**
 * What Tab can reach inside the dialog, guards left out: a control hidden at
 * this width (the phone's Before and After switch, a frame on the side not
 * shown) has no box and is skipped.
 */
function dialogFocusables(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      !element.hasAttribute("data-focus-sentinel") &&
      (element.getClientRects().length > 0 ||
        element === document.activeElement),
  );
}

/**
 * An invisible stop at one end of the dialog's tab order (Base UI's focus
 * guard shape: hidden from screen readers, reachable only by Tab).
 */
function FocusGuard({
  edge,
  onFocus,
}: {
  edge: "start" | "end";
  onFocus: (from: EventTarget | null) => void;
}) {
  return (
    <span
      tabIndex={0}
      aria-hidden
      data-focus-sentinel={edge}
      className="sr-only"
      onFocus={(event) => onFocus(event.relatedTarget)}
    />
  );
}

/**
 * An iframe at a fixed CSS width, scaled down to fit its box. A phone is
 * 390 px wide and a desktop 1280 px, so a desktop page inside a narrow
 * column is shrunk rather than squeezed into a phone layout.
 */
function ScaledFrame({
  src,
  title,
  viewport,
  frameRef,
  onLoad,
  onFrameKey,
}: {
  src: string;
  title: string;
  viewport: number;
  frameRef?: RefObject<HTMLIFrameElement | null>;
  onLoad?: () => void;
  /** Hears keys pressed inside the frame, which the parent never gets. */
  onFrameKey?: (event: Event) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = boxRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    // The observer reports the first size as soon as it starts observing.
    const observer = new ResizeObserver(() =>
      setBox({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = box.width > 0 ? Math.min(1, box.width / viewport) : 1;
  const height = box.height > 0 ? box.height / scale : 800;
  const offset =
    box.width > viewport * scale ? (box.width - viewport * scale) / 2 : 0;

  return (
    <div
      ref={boxRef}
      className="relative min-h-[320px] flex-1 overflow-hidden rounded-xl border border-[#e7e3ef] bg-[#f4f2fa]"
    >
      <iframe
        ref={frameRef}
        src={src}
        title={title}
        onLoad={(event) => {
          // Each load is a new document, so the listener is added again; the
          // same function, so a window that survives a load keeps only one.
          // A frame that is not this host's page refuses access: no key then.
          if (onFrameKey) {
            try {
              event.currentTarget.contentWindow?.addEventListener(
                "keydown",
                onFrameKey,
              );
            } catch {
              // Cross-origin: the dialog's own Escape still works.
            }
          }
          onLoad?.();
        }}
        className="absolute top-0 border-0 bg-white"
        style={{
          left: offset,
          width: viewport,
          height,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      />
    </div>
  );
}
