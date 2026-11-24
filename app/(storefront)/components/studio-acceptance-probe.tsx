"use client";

import { useEffect } from "react";
import type { ElementContext, Result as AxeResult } from "axe-core";
import { isPlatformHost } from "@/lib/store/host";
import { REVEAL_ALL_EVENT } from "@/lib/themes/motion";
import { measureChromeStates } from "./studio-acceptance-states";

// ---------------------------------------------------------------------------
// The Theme Studio acceptance probe.
//
// Rendered ONLY on a Theme Studio preview store (the storefront layout checks
// the store's preview marker; the store itself resolves only for a request
// carrying a preview grant). When the Studio's acceptance runner frames a
// preview page and asks, this measures the page as a browser actually lays it
// out — which a server fetch cannot — and posts back RAW measurements:
//
//   • horizontal overflow in pixels, and the elements causing it;
//   • axe-core WCAG 2.1 A/AA violations with their impact;
//   • images that failed to load (after scrolling, so lazy images load);
//   • LCP and cumulative layout shift from the Performance timeline;
//   • on the home page, the menu drawer, search sheet, cart drawer, account
//     menu and sign-in dialog, each opened, audited and closed
//     (studio-acceptance-states.ts) — they are hidden on load, so nothing
//     else ever measured them;
//   • the text axe could not judge (over a photograph, gradient or
//     overlapping layer), as evidence for the vision reviewer.
//
// ★ IT DECIDES NOTHING. Thresholds are applied on the server
// (lib/theme-studio/acceptance-gates.ts); there is no "passed" field here.
//
// ★ IT ANSWERS ONLY ITS PARENT, AND ONLY A PLATFORM-HOST PARENT. The message
// must come from `window.parent` and from an origin whose host is the
// StoreMink platform, and the reply is addressed to that exact origin. axe is
// imported on demand, so a preview page that is never measured never loads it.
// ---------------------------------------------------------------------------

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

declare global {
  interface Window {
    /** Present only in a private Theme Studio preview. The headless Track 5
     * worker calls the exact same measurement code as the operator runner. */
    __smThemeStudioMeasure?: () => Promise<Record<string, unknown>>;
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function violationExamples(violation: AxeResult) {
  const seen = new Set<string>();
  const examples: { target: string; summary: string }[] = [];
  for (const node of violation.nodes) {
    const target = String(node.target[0] ?? "");
    const summary = (node.failureSummary ?? "").replace(/\s+/g, " ").trim();
    // Twenty cards failing the same check must not crowd out the footer or
    // a discount label. Keep distinct selector patterns and colour pairs.
    const key = `${target.replace(/:nth-(?:child|of-type)\(\d+\)/g, "")}|${summary}`;
    if (!target || seen.has(key)) continue;
    seen.add(key);
    examples.push({
      target: target.slice(-180),
      summary: summary.slice(0, 300),
    });
    if (examples.length === 3) break;
  }
  return examples;
}

function contrastMeasurements(violation: AxeResult) {
  if (violation.id !== "color-contrast") return [];
  return violation.nodes.slice(0, 40).flatMap((node) =>
    (node.any ?? []).flatMap((check) => {
      if (check.id !== "color-contrast") return [];
      const data = check.data as {
        contrastRatio?: unknown;
        expectedContrastRatio?: unknown;
      } | null;
      const ratio = Number(data?.contrastRatio);
      const required = Number(
        String(data?.expectedContrastRatio ?? "").replace(/:1$/, ""),
      );
      const target = String(node.target[0] ?? "").slice(-180);
      return target &&
        Number.isFinite(ratio) &&
        ratio >= 1 &&
        ratio <= 21 &&
        Number.isFinite(required) &&
        required >= 1 &&
        required <= 21
        ? [{ target, ratio, required }]
        : [];
    }),
  );
}

/** The colour-contrast nodes axe could not judge, with its reason
 * (`bgImage`, `bgGradient`, `bgOverlap`, `imgNode`, …), deduplicated by
 * selector pattern so twenty cards over one photograph count once. */
function unresolvedContrast(incomplete: AxeResult[]) {
  const seen = new Set<string>();
  const out: { target: string; reason: string }[] = [];
  for (const result of incomplete) {
    if (result.id !== "color-contrast") continue;
    for (const node of result.nodes) {
      const target = String(node.target[0] ?? "");
      const check = (node.any ?? []).find((c) => c.id === "color-contrast");
      const data = check?.data as { messageKey?: unknown } | null | undefined;
      const reason = String(data?.messageKey ?? "unknown").slice(0, 40);
      const key = `${target.replace(/:nth-(?:child|of-type)\(\d+\)/g, "")}|${reason}`;
      if (!target || seen.has(key)) continue;
      seen.add(key);
      out.push({ target: target.slice(-180), reason });
      if (out.length === 40) return out;
    }
  }
  return out;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<void> {
  await Promise.race([promise.then(() => undefined), sleep(ms)]);
}

function describe(element: Element): string {
  const id = element.id ? `#${element.id}` : "";
  const classes =
    typeof element.className === "string" && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}`
      : "";
  return `${element.tagName.toLowerCase()}${id}${classes}`.slice(0, 120);
}

/**
 * Whether content at this element is hidden from the page by something other
 * than the viewport edge: a fixed-position ancestor (an off-canvas drawer is
 * off-screen on purpose), or a scroll/clip container that itself fits (a
 * carousel is MEANT to hold more than it shows). Cached per element, since a
 * page has thousands and they share ancestors.
 */
function exemptFromOverflow(
  element: Element,
  edge: number,
  cache: Map<Element, boolean>,
): boolean {
  const cached = cache.get(element);
  if (cached !== undefined) return cached;
  const style = getComputedStyle(element);
  let exempt = style.position === "fixed";
  if (!exempt) {
    // ★ The nearest box that can clip this one: its parent for an in-flow
    // box, but for an absolutely positioned box its CONTAINING BLOCK (the
    // nearest positioned ancestor). A scroll container between the two does
    // not clip it: a product carousel's screen-reader-only labels resolved
    // against the carousel wrapper outside the track, scrolled off-screen
    // with their cards, and widened the page by the whole hidden track
    // while this scan, walking parents, exempted them as "inside a fitting
    // scroll container" and named nothing (2026-10-09).
    const container =
      style.position === "absolute"
        ? ((element as HTMLElement).offsetParent ?? document.body)
        : element.parentElement;
    if (container && container !== document.body) {
      const containerStyle = getComputedStyle(container);
      if (containerStyle.position === "fixed") {
        exempt = true;
      } else if (
        containerStyle.overflowX !== "visible" &&
        container.getBoundingClientRect().right <= edge
      ) {
        exempt = true;
      } else {
        exempt = exemptFromOverflow(container, edge, cache);
      }
    }
  }
  cache.set(element, exempt);
  return exempt;
}

/**
 * How far laid-out content reaches past the right edge, measured from the
 * boxes themselves.
 *
 * ★★ `scrollWidth` ALONE IS BLIND ON THIS STOREFRONT. `<html>` and `<body>`
 * carry `overflow-x: clip`, so content wider than the phone is cut off rather
 * than scrollable and `scrollWidth` reports it as fitting. That is how the
 * grocery product page shipped 734px wide on a 390px screen — its right half
 * simply missing — with this gate green. Measuring rectangles is what sees it.
 * ★ The reverse also happens: `body.scrollWidth` DOES count layout overflow
 * that escapes a scroll container (an absolutely positioned descendant whose
 * containing block lies outside the track), which the rectangles only name
 * with the containing-block rule in `exemptFromOverflow`. Both measures are
 * kept; neither alone is enough.
 */
function clippedOverflow(limit: number): { px: number; offenders: string[] } {
  const width = document.documentElement.clientWidth;
  const edge = width + 1;
  const cache = new Map<Element, boolean>();
  const offenders: string[] = [];
  let px = 0;
  const all = document.body ? document.body.querySelectorAll("*") : [];
  for (let i = 0; i < all.length && i < 6000; i += 1) {
    const element = all[i];
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.right <= edge) continue;
    if (exemptFromOverflow(element, edge, cache)) continue;
    px = Math.max(px, Math.round(rect.right - width));
    const parent = element.parentElement;
    const parentSticksOut =
      parent !== null &&
      parent !== document.body &&
      parent.getBoundingClientRect().right > edge &&
      !exemptFromOverflow(parent, edge, cache);
    if (!parentSticksOut && offenders.length < limit) {
      offenders.push(describe(element));
    }
  }
  return { px, offenders };
}

type ClippedTextItem = { target: string; clippedX: number; clippedY: number };

/**
 * Text clipped by its own box, the largest clip first. Every element in the
 * scan is measured before the list is cut to `limit`, so the cut can never
 * drop a heading cut in half behind a grid of card titles clipped by a pixel
 * or two: the server makes a clip of a pixel or two a warning and a larger
 * one serious (lib/theme-studio/finding-severity.ts). `clippedTextFound` is
 * how many there were before the cut; the server reads its presence as "this
 * list holds the largest clips".
 */
function clippedText(
  limit: number,
  root: ParentNode | null = document.body,
): { clippedText: ClippedTextItem[]; clippedTextFound: number } {
  const findings: ClippedTextItem[] = [];
  const elements = root?.querySelectorAll("*") ?? [];
  for (let i = 0; i < elements.length && i < 6000; i += 1) {
    const element = elements[i];
    // querySelectorAll's type parameter does not filter SVG/MathML nodes.
    // Every storefront has SVG icons; they have no innerText and previously
    // crashed the entire automatic capture after all pictures were taken.
    if (!(element instanceof HTMLElement) || !element.innerText?.trim())
      continue;
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      continue;
    }
    const clipsX = style.overflowX === "hidden" || style.overflowX === "clip";
    const clipsY = style.overflowY === "hidden" || style.overflowY === "clip";
    // Visually hidden accessible labels and deliberate truncation retain the
    // full text in the accessibility tree. They are not accidental clipping.
    const visuallyHidden =
      element.clientWidth <= 1 &&
      element.clientHeight <= 1 &&
      ((style.clip && style.clip !== "auto") ||
        (style.clipPath && style.clipPath !== "none"));
    if (visuallyHidden) continue;
    const ellipsis = style.textOverflow === "ellipsis";
    const lineClamp = Number.parseInt(style.webkitLineClamp, 10) > 0;
    // The ticker intentionally moves its complete text through this viewport.
    // In reduced-motion mode its track wraps, so real clipping is still caught.
    const ticker =
      element.matches(".home-ticker") &&
      [...element.children].some(
        (child) =>
          child.matches(".home-ticker-track") &&
          getComputedStyle(child).animationName === "home-ticker-scroll",
      );
    if (ticker) continue;
    const clippedX =
      clipsX && !ellipsis
        ? Math.max(0, element.scrollWidth - element.clientWidth)
        : 0;
    const clippedY =
      clipsY && !lineClamp
        ? Math.max(0, element.scrollHeight - element.clientHeight)
        : 0;
    if (clippedX <= 1 && clippedY <= 1) continue;
    // Report the innermost clipping box; a parent wrapping the same clipped
    // child adds noise without identifying a second defect.
    if (
      [...element.children].some(
        (child) =>
          child instanceof HTMLElement &&
          (child.scrollWidth > child.clientWidth + 1 ||
            child.scrollHeight > child.clientHeight + 1),
      )
    ) {
      continue;
    }
    findings.push({
      target: describe(element),
      clippedX: Math.round(clippedX),
      clippedY: Math.round(clippedY),
    });
  }
  const size = (item: ClippedTextItem) =>
    Math.max(item.clippedX, item.clippedY);
  // A stable sort: equal clips keep their page order.
  findings.sort((a, b) => size(b) - size(a));
  return {
    clippedText: findings.slice(0, limit),
    clippedTextFound: findings.length,
  };
}

function smallTapTargets(limit: number, root: ParentNode = document) {
  if (window.innerWidth > 768) return [];
  const findings: { target: string; width: number; height: number }[] = [];
  const selector =
    'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"]';
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    if (findings.length >= limit) break;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0 ||
      rect.width === 0 ||
      rect.height === 0 ||
      element.matches(":disabled") ||
      // WCAG's target-size exception permits links inside a sentence.
      style.display === "inline"
    ) {
      continue;
    }
    if (rect.width < 24 || rect.height < 24) {
      // A checkbox's associated label is also a clickable target. Measure the
      // actual label, not the browser's default 13px checkbox glyph alone.
      if (
        element instanceof HTMLInputElement &&
        (element.type === "checkbox" || element.type === "radio") &&
        [...(element.labels ?? [])].some((label) => {
          const box = label.getBoundingClientRect();
          const css = getComputedStyle(label);
          return (
            box.width >= 24 &&
            box.height >= 24 &&
            css.visibility !== "hidden" &&
            css.display !== "none"
          );
        })
      )
        continue;
      findings.push({
        target: describe(element),
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      });
    }
  }
  return findings;
}

function imageCropIssues(limit: number) {
  const findings: { target: string; retainedFraction: number }[] = [];
  for (const image of document.images) {
    if (findings.length >= limit) break;
    const rect = image.getBoundingClientRect();
    if (
      image.naturalWidth === 0 ||
      image.naturalHeight === 0 ||
      rect.width < 80 ||
      rect.height < 80 ||
      getComputedStyle(image).objectFit !== "cover"
    ) {
      continue;
    }
    const sourceAspect = image.naturalWidth / image.naturalHeight;
    const renderedAspect = rect.width / rect.height;
    const retainedFraction = Math.min(
      sourceAspect / renderedAspect,
      renderedAspect / sourceAspect,
    );
    if (retainedFraction < 0.35) {
      findings.push({
        target: describe(image),
        retainedFraction: Math.round(retainedFraction * 1000) / 1000,
      });
    }
  }
  return findings;
}

async function settleImages(ms: number): Promise<void> {
  const pending = Array.from(document.images).filter(
    (img) => !img.complete && (img.currentSrc || img.src),
  );
  await withTimeout(
    Promise.all(
      pending.map(
        (img) =>
          new Promise<void>((resolve) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          }),
      ),
    ),
    ms,
  );
}

/**
 * Images that failed to load, confirmed by asking for each one again. A frame
 * can catch an image mid-flight (the image optimizer's first request in
 * development takes seconds), and a transient miss is not a broken asset; a
 * URL that fails twice is.
 */
async function confirmBrokenImages(): Promise<number> {
  const suspects = [
    ...new Set(
      Array.from(document.images)
        .filter(
          (img) =>
            img.complete &&
            img.naturalWidth === 0 &&
            (img.currentSrc || img.src),
        )
        .map((img) => img.currentSrc || img.src),
    ),
  ];
  const results = await Promise.all(
    suspects.map(
      (src) =>
        new Promise<boolean>((resolve) => {
          const probe = new Image();
          const timer = setTimeout(() => resolve(true), 8_000);
          probe.onload = () => {
            clearTimeout(timer);
            resolve(probe.naturalWidth === 0);
          };
          probe.onerror = () => {
            clearTimeout(timer);
            resolve(true);
          };
          probe.src = src;
        }),
    ),
  );
  return results.filter(Boolean).length;
}

async function measure(perf: { lcp: number | null; cls: number }) {
  if (document.readyState !== "complete") {
    await withTimeout(
      new Promise<void>((resolve) =>
        window.addEventListener("load", () => resolve(), { once: true }),
      ),
      15_000,
    );
  }
  if (document.fonts?.ready) await withTimeout(document.fonts.ready, 5_000);
  // ★★ TIMING IS FROZEN HERE, before anything below moves the page. LCP keeps
  // accepting larger candidates until a USER scrolls, and the scroll-through
  // below is programmatic — so a hero far down the page was reported as the
  // largest paint at 25 s (benchmark 2026-10-04), and lazy images loading as
  // the page was scrolled counted as layout shifts (CLS up to 1.4 on the
  // same run). What is frozen is what a shopper's first screen cost, which
  // is what the thresholds were written for.
  const timing = {
    lcpMs: perf.lcp === null ? null : Math.round(perf.lcp),
    cls: Math.round(perf.cls * 10_000) / 10_000,
  };
  // A theme that reveals sections on scroll holds some at opacity 0 until
  // they arrive; show them all first, so axe and the overflow check measure
  // every section rather than skipping the ones not yet revealed.
  window.dispatchEvent(new Event(REVEAL_ALL_EVENT));

  // Scroll through the page so lazy images load and below-the-fold layout is
  // exercised, then return to the top before measuring.
  const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
  for (
    let y = 0;
    y < document.documentElement.scrollHeight && y < 40_000;
    y += step
  ) {
    window.scrollTo(0, y);
    await sleep(60);
  }
  window.scrollTo(0, 0);
  await settleImages(6_000);
  await sleep(800);

  const root = document.documentElement;
  const scrollWidth = Math.max(
    root.scrollWidth,
    document.body?.scrollWidth ?? 0,
  );
  const clipped = clippedOverflow(5);
  const overflowPx = Math.max(scrollWidth - root.clientWidth, clipped.px);
  const brokenImages = await confirmBrokenImages();

  const page = await axeAudit({ exclude: [["nextjs-portal"]] });
  const pageFindings = {
    ...clippedText(40),
    smallTapTargets: smallTapTargets(60),
    imageCropIssues: imageCropIssues(40),
  };
  // The chrome states open last (a drawer's scroll lock drops the scrollbar,
  // which would register as a shift — but `timing` was frozen long before).
  // The header chrome is the same on every surface, so its states are
  // opened once, on the home page; the gates expect them there.
  const states = location.pathname === "/" ? await chromeStates() : [];
  // Whether a shopper on this screen sees the header's menu, or finds it
  // behind the menu button (owner, 23 Nov 2026: Muse's menu was hidden on a
  // 1440px screen and nothing said so). Read after the header fit ran.
  const menu = location.pathname === "/" ? headerMenu() : null;

  return {
    path: `${location.pathname}${location.search}`.slice(0, 512),
    width: window.innerWidth,
    height: window.innerHeight,
    overflowPx,
    overflowOffenders: overflowPx > 1 ? clipped.offenders : [],
    ...pageFindings,
    brokenImages,
    violations: page.violations,
    contrastUnresolved: page.contrastUnresolved,
    states,
    ...(menu ? { headerMenu: menu } : {}),
    ...timing,
  };
}

/** The header's menu as this screen shows it: its layout (the root's
 *  sm-header-* class), how many top-level items it has, whether it is on
 *  screen or behind the menu button, and whether it had to move to a row of
 *  its own under a centred logo (use-header-fit.ts "stack"). */
function headerMenu(): {
  layout: string;
  links: number;
  shown: boolean;
  stacked: boolean;
} | null {
  const nav = document.querySelector<HTMLElement>(
    'header [data-sm="header-menu"]',
  );
  if (!nav) return null;
  const box = nav.getBoundingClientRect();
  const root = nav.closest(".storefront-root")?.className ?? "";
  return {
    layout: /(?:^|\s)sm-header-([a-z]+)/.exec(root)?.[1] ?? "classic",
    links: nav.children.length,
    shown:
      box.width > 0 &&
      box.height > 0 &&
      getComputedStyle(nav).visibility !== "hidden",
    stacked: (nav.closest("header")?.getAttribute("data-header-compact") ?? "")
      .split(/\s+/)
      .includes("stack"),
  };
}

type AxeAudit = Awaited<ReturnType<typeof axeAudit>>;

/** WCAG 2.1 A/AA over `context`: the violations with their measured
 * contrast, plus the colour-contrast nodes axe left `incomplete`. */
async function axeAudit(context: ElementContext) {
  const axe = (await import("axe-core")).default;
  const results = await axe.run(context, {
    runOnly: {
      type: "tag",
      values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
    },
    // `incomplete` is what axe could not judge — text over a photograph, a
    // gradient or an overlapping layer. Asking for violations alone (the
    // previous setting) left a hero caption on a pale photograph unmeasured
    // AND unreported; the vision reviewer can see the pixels, so it gets
    // the list.
    resultTypes: ["violations", "incomplete"],
  });
  return {
    violations: results.violations.slice(0, 100).map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? null,
      nodes: violation.nodes.length,
      help: violation.help.slice(0, 200),
      // The first offending element, so a reviewer can find it.
      target: String(violation.nodes[0]?.target?.[0] ?? "").slice(0, 120),
      // Include axe's measured colours and ratio, not just the generic rule
      // name. Both automatic and operator repair use this same evidence.
      examples: violationExamples(violation),
      contrast: contrastMeasurements(violation),
    })),
    contrastUnresolved: unresolvedContrast(results.incomplete ?? []),
  };
}

const EMPTY_STATE_AUDIT = {
  violations: [] as AxeAudit["violations"],
  contrastUnresolved: [] as AxeAudit["contrastUnresolved"],
  clippedText: [] as ClippedTextItem[],
  clippedTextFound: 0,
  smallTapTargets: [] as ReturnType<typeof smallTapTargets>,
};

/** Open each chrome state and audit what appeared, scoped to its panel. A
 * state that was not measured carries empty findings and its reason, so the
 * wire shape is uniform and the server can tell "clean" from "never opened". */
async function chromeStates() {
  const measured = await measureChromeStates(async (panel) => ({
    ...(await axeAudit(panel)),
    ...clippedText(20, panel),
    smallTapTargets: smallTapTargets(30, panel),
  }));
  return measured.map(({ audit, ...rest }) => ({
    ...rest,
    ...(audit ?? EMPTY_STATE_AUDIT),
  }));
}

export function StudioAcceptanceProbe() {
  useEffect(() => {
    const perf = { lcp: null as number | null, cls: 0 };
    const observers: PerformanceObserver[] = [];
    try {
      const lcp = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) perf.lcp = entry.startTime;
      });
      lcp.observe({ type: "largest-contentful-paint", buffered: true });
      observers.push(lcp);
    } catch {
      /* not supported: reported as null */
    }
    try {
      const shifts = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as LayoutShiftEntry[]) {
          if (!entry.hadRecentInput) perf.cls += entry.value;
        }
      });
      shifts.observe({ type: "layout-shift", buffered: true });
      observers.push(shifts);
    } catch {
      /* not supported */
    }

    let started = false;
    window.__smThemeStudioMeasure = () => measure(perf);
    const onMessage = async (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      let host: string;
      try {
        host = new URL(event.origin).host;
      } catch {
        return;
      }
      if (!isPlatformHost(host)) return;
      const data = event.data as {
        type?: unknown;
        nonce?: unknown;
        sample?: unknown;
      } | null;
      if (!data || data.type !== "sm-acceptance-run") return;
      if (typeof data.nonce !== "string" || data.nonce.length > 200) return;
      if (typeof data.sample !== "number" || !Number.isInteger(data.sample)) {
        return;
      }
      // ★ A page that has already measured stays SILENT. When the runner moves
      // the frame to the next page, this document is still alive for a moment
      // and receives the next page's request; acknowledging it would tell the
      // runner the request had landed, and the new page would never be asked.
      if (started) return;
      started = true;
      const { nonce, sample } = data;
      window.parent.postMessage(
        { type: "sm-acceptance-ack", nonce, sample },
        event.origin,
      );
      try {
        const result = await measure(perf);
        window.parent.postMessage(
          { type: "sm-acceptance-result", nonce, sample, result },
          event.origin,
        );
      } catch (error) {
        window.parent.postMessage(
          {
            type: "sm-acceptance-error",
            nonce,
            sample,
            message: String(
              error instanceof Error ? error.message : error,
            ).slice(0, 200),
          },
          event.origin,
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      delete window.__smThemeStudioMeasure;
      for (const observer of observers) observer.disconnect();
    };
  }, []);
  return null;
}
