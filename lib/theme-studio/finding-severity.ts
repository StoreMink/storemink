import type { GateId } from "./acceptance-gates";
import { CHROME_STATE_LABELS } from "./chrome-states";

// ---------------------------------------------------------------------------
// Theme Studio finding severity: what stops Publish, and what is a warning.
//
// "Fix it, then allow Publish" (owner, 23 and 24 Oct 2026). Theme Studio
// repairs what it can in its automatic rounds; a SERIOUS finding left after
// them stops Publish, a MINOR one is a warning the operator may publish past.
// Plan: revamp-handoff/tasks/theme-studio-plan.md, section 3.
//
// ★ SEVERITY IS JUDGED BY WHAT A SHOPPER MEETS, NEVER BY WHO OWNS THE CODE.
// A fault in StoreMink's shared storefront code is as serious as the same
// fault in a theme. isPlatformFinding changes only the words and the buttons
// ("Needs a StoreMink fix"), never the severity.
//
// ★ WHAT NOBODY CLASSIFIED IS SERIOUS. The rules below name the codes that
// are minor; every other code, and every gate this file does not know, is
// serious. "We could not check it" (a skipped check, an unmeasured value, a
// page that timed out) is serious until it is checked.
//
// ★ SEVERITY IS SET WHEN A FINDING IS MEASURED (acceptance-gates.ts gate())
// and stored with it, beside SEVERITY_RULES_VERSION, so a later rule never
// re-judges old evidence and a stricter rule can find every run that passed
// under this one. A stored finding with no severity was measured before these
// rules existed, when every finding of a required gate failed it: it counts
// as serious (isSeriousFinding).
//
// Dependency-free apart from chrome-states.ts (types aside), so the screens
// can import it as well as the server.
// ---------------------------------------------------------------------------

/** Stamped on every gate result measured under these rules. */
export const SEVERITY_RULES_VERSION = "severity-v1";

export type FindingSeverity = "serious" | "minor";

/** What severity reads from a finding: GateFinding is assignable to it. */
export interface SeverityFinding {
  code: string;
  where?: string;
  /** Per measured piece of text: the ratio and the line it needed. */
  contrast?: readonly { target: string; ratio: number; required: number }[];
  /** The axe impact of a browser.accessibility finding; null when axe gave
   * none this code recognises. */
  impact?: string | null;
  /** How many elements an axe finding covers. */
  nodes?: number;
  /** Pixels of text a browser.clipped_text finding hides. */
  clipped?: { x: number; y: number };
  /** The selectors the browser named for this finding. */
  targets?: readonly string[];
  severity?: FindingSeverity;
}

/**
 * Decision 1 (owner, 24 Oct 2026): text below the WCAG AA line is serious
 * whatever caused it: 4.5 to 1 for normal text, 3 to 1 for large text. The
 * browser check (axe colour contrast) records, per piece of text, the ratio
 * it measured and the line that text needed. Another answer to decision 1
 * changes this constant and nothing else.
 */
export const CONTRAST_AA_LINE = { normalText: 4.5, largeText: 3 } as const;

/**
 * A clip of a pixel or two is a warning; from 3 px a clip hides part of a
 * glyph and is serious. The probe never reports a clip of 1 px or less
 * (studio-acceptance-probe.tsx clippedText), and the 4 Oct benchmark recorded
 * no clipped text at all (evals/theme-studio/full-live-2026-10-04.json), so
 * the line is the plan's "a pixel or two".
 */
export const CLIPPED_TEXT_WARNING_PX = 2;

/** "We could not check it", in any gate. */
const UNCHECKED_CODES: ReadonlySet<string> = new Set(["skipped", "unmeasured"]);

/**
 * The codes each gate reports as warnings (section 3's table). Every code
 * missing here is serious; so is every gate missing here. Two gates have a
 * rule instead of a list: browser.clipped_text (by the size of the clip) and
 * browser.accessibility (colour contrast at the AA line, other rules by
 * impact).
 */
const MINOR_CODES: Partial<Record<GateId, readonly string[]>> = {
  // A picture over its byte budget, narrower than its slot's target but not
  // below the storefront minimum, or declared and never rendered.
  "assets.integrity": [
    "over_budget",
    "preview_over_budget",
    "below_target",
    "unused",
  ],
  // StoreMink's own preview markup. Shoppers never reach a preview without a
  // grant, and axe still judges every rendered image in the browser.
  "routes.render": ["indexable"],
  "routes.markup": ["lang", "img_alt"],
  "browser.tap_targets": ["small_target"],
  "browser.image_crops": ["extreme_crop"],
  // Speed is a warning. A gate made required by THEME_STUDIO_PERFORMANCE_
  // REQUIRED measures its findings as serious (acceptance-gates.ts).
  "browser.performance": ["lcp", "cls"],
};

/** The axe rule for text contrast, and the name older evidence used. */
const CONTRAST_CODES: ReadonlySet<string> = new Set([
  "color-contrast",
  "contrast",
]);
/** axe impacts that warn. Serious and critical block, as they did before
 * severity-v1. */
const MINOR_IMPACTS: ReadonlySet<string> = new Set(["minor", "moderate"]);

/** The AA line for one measured piece of text: the line the browser applied
 * to it, never looser than large text's nor stricter than normal text's. */
function aaLineFor(required: number): number {
  return Math.min(
    Math.max(required, CONTRAST_AA_LINE.largeText),
    CONTRAST_AA_LINE.normalText,
  );
}

/** axe's own test: text clears its line only when its ratio is above it. A
 * ratio that cannot be read never clears. */
function clearsAaLine(measured: { ratio: number; required: number }): boolean {
  return (
    typeof measured.ratio === "number" &&
    typeof measured.required === "number" &&
    Number.isFinite(measured.ratio) &&
    Number.isFinite(measured.required) &&
    measured.ratio > aaLineFor(measured.required)
  );
}

function accessibilitySeverity(finding: SeverityFinding): FindingSeverity {
  if (CONTRAST_CODES.has(finding.code)) {
    // Whatever its impact or cause. Minor only when every element was
    // measured and every measurement clears the AA line, which an AA
    // violation never does; a finding without a readable ratio is serious.
    const measured = finding.contrast ?? [];
    const everyElement =
      measured.length > 0 &&
      (typeof finding.nodes !== "number" || measured.length >= finding.nodes);
    return everyElement && measured.every(clearsAaLine) ? "minor" : "serious";
  }
  // Every other rule keeps today's line: serious and critical block,
  // moderate and minor warn. An impact axe did not give is serious.
  return typeof finding.impact === "string" && MINOR_IMPACTS.has(finding.impact)
    ? "minor"
    : "serious";
}

function clippedSeverity(finding: SeverityFinding): FindingSeverity {
  const clip = finding.clipped;
  if (
    !clip ||
    typeof clip.x !== "number" ||
    typeof clip.y !== "number" ||
    !Number.isFinite(clip.x) ||
    !Number.isFinite(clip.y)
  )
    return "serious";
  return Math.max(clip.x, clip.y) <= CLIPPED_TEXT_WARNING_PX
    ? "minor"
    : "serious";
}

/**
 * The severity of one finding of one check, as measured. Pure: the same
 * gate and finding always give the same answer under one rules version.
 */
export function findingSeverity(
  gateId: string,
  finding: SeverityFinding,
): FindingSeverity {
  if (UNCHECKED_CODES.has(finding.code)) return "serious";
  if (gateId === "browser.accessibility") return accessibilitySeverity(finding);
  if (gateId === "browser.clipped_text") {
    return finding.code === "clipped_text"
      ? clippedSeverity(finding)
      : "serious";
  }
  return MINOR_CODES[gateId as GateId]?.includes(finding.code)
    ? "minor"
    : "serious";
}

/** Whether a stored finding stops Publish. Its severity as measured; a
 * finding with no recognised severity (measured before severity-v1) is
 * serious. */
export function isSeriousFinding(finding: { severity?: unknown }): boolean {
  return finding.severity !== "minor";
}

/** The more serious of two severities. A measuring step may raise a
 * finding's severity above its rule, never lower it. */
export function stricterSeverity(
  a: FindingSeverity | undefined,
  b: FindingSeverity,
): FindingSeverity {
  return a === "serious" || b === "serious" ? "serious" : "minor";
}

// ------------------------------------------------------------ platform label

/** Codes that are always StoreMink's own markup: the preview's noindex and
 * the page's language and image alt attribute, and a control's hit area,
 * which no theme setting can change (qa-diagnosis.ts files it as renderer
 * work). */
const PLATFORM_CODES: Partial<Record<GateId, readonly string[]>> = {
  "routes.render": ["indexable"],
  "routes.markup": ["lang", "img_alt"],
  "browser.tap_targets": ["small_target"],
};

/** Gates whose findings name the elements they measured, so the element
 * decides the label. */
const SELECTOR_GATES: ReadonlySet<string> = new Set([
  "browser.accessibility",
  "browser.clipped_text",
  "browser.overflow",
]);

/**
 * Global storefront classes whose colour or size StoreMink's own CSS picks,
 * whatever the theme's settings: the shared-renderer defects measured on 4
 * and 10 Oct 2026 (the card discount label and struck prices, the product
 * page's struck price, eyebrow and variant price, the gallery counter, the
 * hero and carousel badges) and the screen-reader label behind the 9 Oct
 * overflow. All are fixed in the working tree; one that fails again is a
 * StoreMink regression.
 */
const SHARED_STOREFRONT_CLASSES = [
  "shop-card-off",
  "shop-card-base",
  "shop-card-badge",
  "pdp-price-base",
  "pdp-variant-was",
  "pdp-category",
  "sm-gallery-count",
  "home-hero-badge",
  "sr-only",
] as const;

/** The account menu's stable ids (Header.jsx). */
const SHARED_STOREFRONT_IDS = ["header-profile-btn", "profile-dropdown"];

/** A CSS-module class (`delivery-location-module__HXOnpW__trigger` in a
 * built storefront). Only StoreMink's shared chrome uses CSS modules: the
 * header and its drawer, the footer, delivery, the cart drawer, sign-in and
 * the account pages. A theme never authors one. */
const CSS_MODULE_CLASS_RE = /[\w-]-module__[\w-]+__[\w-]/;

const SHARED_SELECTOR_RE = new RegExp(
  `(?:\\.(?:${SHARED_STOREFRONT_CLASSES.join("|")})|#(?:${SHARED_STOREFRONT_IDS.join("|")}))(?![\\w-])`,
);

/** Whether a selector names an element of StoreMink's shared storefront
 * code. */
export function isSharedSelector(selector: string): boolean {
  return (
    CSS_MODULE_CLASS_RE.test(selector) || SHARED_SELECTOR_RE.test(selector)
  );
}

const CHROME_LABELS: ReadonlySet<string> = new Set(
  Object.values(CHROME_STATE_LABELS),
);

/** Whether a finding was measured inside an opened chrome state (the menu
 * drawer, search sheet, cart drawer, account menu or sign-in dialog): the
 * same shared chrome on every theme. `where` is "phone360 · home · menu
 * drawer" for those (acceptance-gates.ts stateFindings). */
function inChromeState(where: string | undefined): boolean {
  return (where ?? "").split(" · ").some((part) => CHROME_LABELS.has(part));
}

function findingSelectors(finding: SeverityFinding): string[] {
  return [
    ...(finding.contrast ?? []).map((measured) => measured.target),
    ...(finding.targets ?? []),
  ].filter((selector) => typeof selector === "string" && selector.length > 0);
}

/**
 * Whether a finding is a problem in StoreMink's own storefront code rather
 * than in the theme: from a closed list of codes and shared selectors, and
 * anything else counts as the theme's. Changes the words and the buttons
 * only ("Needs a StoreMink fix", no paid revision), never the severity. A
 * check that could not run is not one: "Couldn't finish the checks" offers
 * Check again.
 */
export function isPlatformFinding(
  gateId: string,
  finding: SeverityFinding,
): boolean {
  if (UNCHECKED_CODES.has(finding.code)) return false;
  if (PLATFORM_CODES[gateId as GateId]?.includes(finding.code)) return true;
  // Every axe rule but colour contrast judges markup, which only StoreMink's
  // renderer writes; qa-diagnosis.ts files these as renderer work.
  if (gateId === "browser.accessibility" && !CONTRAST_CODES.has(finding.code)) {
    return true;
  }
  if (!SELECTOR_GATES.has(gateId)) return false;
  if (inChromeState(finding.where)) return true;
  const selectors = findingSelectors(finding);
  return selectors.length > 0 && selectors.every(isSharedSelector);
}
