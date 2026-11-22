// ---------------------------------------------------------------------------
// The design plan (owner, 22 Nov 2026): "whenever a new theme is requested,
// the planning is done beforehand ... what will be the styling, theme
// colours, screenshots or any reference image or prompt should be analysed
// deeply. It should also plan the alikeness in this step. Then a plan should
// be created and on the basis of that, the theme should be created."
//
// WHY. Until now the first stage wrote prose ("a warm palette, a refined
// serif") and the second stage decided every concrete thing. How alike the
// result was to the catalogue was measured only after it was built, held to
// a lower bar (0.35) than publishing uses (0.50), and not corrected at all
// for a theme built from screenshots. So a theme could have every photograph
// drawn and then be refused at Publish.
//
// So, from prompt v34, the first stage decides the design itself and writes
// it down: the page, surface, text and accent colours, the font pairing, the
// buttons, how the theme sets its type (in words) and, when screenshots were
// supplied, the layout they show. StoreMink completes it (a theme with no
// screenshots is assigned the layout its catalogue uses least,
// commitments.ts) and CHECKS IT AGAINST EVERY PUBLISHED THEME before the
// second stage writes anything. The second stage is then held to the plan.
//
// ★ THE PLAN'S CHECK IS OVER WHAT THE PLAN DECIDES. A plan does not know the
//   homepage's sections or the style rules yet, so it is not a fingerprint:
//   `planDistance` is the weighted share of the PLANNED axes that differ,
//   with the fingerprint's own weights. The exact measure, over the whole
//   built theme, is taken after the build and before any photograph is drawn
//   (pipeline.ts, "the publish floor").
// ★ A PLAN IS HELD LIKE A COMMITMENT, NOT A CAGE: a first draft that leaves
//   it is sent back once with the list; what comes back is accepted, and the
//   exact measure has the last word.
// ★ A SHADE MAY MOVE, A FAMILY MAY NOT. The build may adjust a planned
//   colour so text reads on it; what is checked is its colour band, the unit
//   the fingerprint itself compares.
// Pure: no database, no provider, no image decoding.
// ---------------------------------------------------------------------------

import {
  BUTTON_PRIMARY_STYLES,
  BUTTON_SHAPES,
  type ButtonPrimaryStyle,
  type ButtonShape,
} from "@/lib/themes/buttons";
import {
  FONT_PAIRINGS,
  FONT_PAIRING_KEYS,
  pairingFonts,
  type FontPairingKey,
} from "@/lib/themes/fonts";
import { PAGE_WIDTHS } from "@/lib/themes/page";
import type { ThemePackageV2 } from "./contracts";
import {
  DIRECTION_SIGNATURES,
  commitmentIssues,
  type LayoutCommitments,
} from "./commitments";
import {
  colourBand,
  paletteFamilyIssues,
  type ExistingThemeFingerprint,
  type ThemeFingerprint,
} from "./fingerprint";
import type { PaletteFamily } from "./design-directions";

export const DESIGN_PLAN_VERSION = 1;
/** The share of what a plan decides that must differ from every published
 *  theme. The same number publishing uses over the whole theme. */
export const PLAN_DISTINCTNESS_FLOOR = 0.5;
export const PLAN_STYLING_LINES = 6;
export const PLAN_SETS_APART_LINES = 4;
const LINE_MAX = 200;
/** Body text on its page and on its cards (WCAG AA). */
const PLAN_TEXT_CONTRAST = 4.5;

export interface DesignPlan {
  version: typeof DESIGN_PLAN_VERSION;
  /** #rrggbb. `page` is the page background (palette key `cream`). */
  colours: { page: string; surface: string; ink: string; accent: string };
  fontPairing: FontPairingKey;
  buttons: { shape: ButtonShape; primary: ButtonPrimaryStyle };
  /** Null when nothing decided it: a direction with no signature. */
  layout: LayoutCommitments | null;
  /** `catalogue`: assigned, the layout the catalogue uses least.
   *  `reference`: read from the operator's screenshots. */
  layoutSource: "catalogue" | "reference" | "none";
  /** How the theme sets its names, prices, buttons and headings, in words. */
  styling: string[];
  /** How it differs from the catalogue themes nearest to it, in words. */
  setsApart: string[];
}

const SIGNATURES = Object.values(DIRECTION_SIGNATURES);
const union = <T>(
  pick: (signature: (typeof SIGNATURES)[number]) => readonly T[],
) =>
  [...new Set(SIGNATURES.flatMap((signature) => [...pick(signature)]))] as T[];
/** Every layout value some direction's signature allows. */
export const PLAN_LAYOUT_VALUES = {
  header: union((s) => s.headers),
  card: union((s) => s.cards),
  productDetail: union((s) => s.productDetails),
  footer: union((s) => s.footers),
  pageWidth: [...PAGE_WIDTHS],
  gridColumnsDesktop: union((s) => s.columns),
} as const;

const HEX = /^#[0-9a-f]{6}$/i;
const isRec = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function luminance(hex: string): number {
  return [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
/** WCAG contrast of two #rrggbb colours. */
export function planContrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function lines(
  value: unknown,
  path: string,
  max: number,
  min: number,
  issues: string[],
): string[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of short lines.`);
    return [];
  }
  const out = value
    .filter((line): line is string => typeof line === "string")
    .map((line) => line.replace(/\s+/g, " ").trim().slice(0, LINE_MAX))
    .filter(Boolean)
    .slice(0, max);
  if (out.length < min)
    issues.push(`${path} needs at least ${min} line${min === 1 ? "" : "s"}.`);
  return out;
}

function layoutOf(
  value: unknown,
  path: string,
  issues: string[],
): LayoutCommitments | null {
  if (value === null || value === undefined) return null;
  if (!isRec(value)) {
    issues.push(`${path} must be null or an object.`);
    return null;
  }
  const pick = <T>(key: string, allowed: readonly T[]): T | undefined => {
    if (allowed.includes(value[key] as T)) return value[key] as T;
    issues.push(
      `${path}.${key} must be one of: ${allowed.map(String).join(", ")}.`,
    );
    return undefined;
  };
  const header = pick("header", PLAN_LAYOUT_VALUES.header);
  const card = pick("card", PLAN_LAYOUT_VALUES.card);
  const productDetail = pick("productDetail", PLAN_LAYOUT_VALUES.productDetail);
  const footer = pick("footer", PLAN_LAYOUT_VALUES.footer);
  const pageWidth = pick("pageWidth", PLAN_LAYOUT_VALUES.pageWidth);
  const gridColumnsDesktop = pick(
    "gridColumnsDesktop",
    PLAN_LAYOUT_VALUES.gridColumnsDesktop,
  );
  if (typeof value.cardHoverImage !== "boolean")
    issues.push(`${path}.cardHoverImage must be true or false.`);
  if (
    header === undefined ||
    card === undefined ||
    productDetail === undefined ||
    footer === undefined ||
    pageWidth === undefined ||
    gridColumnsDesktop === undefined ||
    typeof value.cardHoverImage !== "boolean"
  )
    return null;
  return {
    header,
    card,
    productDetail,
    footer,
    pageWidth,
    gridColumnsDesktop,
    cardHoverImage: value.cardHoverImage,
  };
}

/**
 * Read a plan from anything (a model's JSON, a stored intent). Every field is
 * whitelisted and bounded; `issues` gets what is wrong, in words a model can
 * repair from. Null when it cannot be used.
 */
export function parseDesignPlan(
  value: unknown,
  path: string,
  issues: string[],
): DesignPlan | null {
  if (!isRec(value)) {
    issues.push(`${path} must be an object.`);
    return null;
  }
  const before = issues.length;
  const colours = isRec(value.colours) ? value.colours : {};
  if (!isRec(value.colours)) issues.push(`${path}.colours must be an object.`);
  const colour = (key: string): string => {
    const hex = colours[key];
    if (typeof hex === "string" && HEX.test(hex)) return hex.toLowerCase();
    issues.push(`${path}.colours.${key} must be a #rrggbb colour.`);
    return "#000000";
  };
  const page = colour("page");
  const surface = colour("surface");
  const ink = colour("ink");
  const accent = colour("accent");
  const fontPairing = FONT_PAIRING_KEYS.includes(
    value.fontPairing as FontPairingKey,
  )
    ? (value.fontPairing as FontPairingKey)
    : null;
  if (!fontPairing)
    issues.push(
      `${path}.fontPairing must be one of: ${FONT_PAIRING_KEYS.join(", ")}.`,
    );
  const buttons = isRec(value.buttons) ? value.buttons : {};
  const shape = BUTTON_SHAPES.includes(buttons.shape as ButtonShape)
    ? (buttons.shape as ButtonShape)
    : null;
  if (!shape)
    issues.push(
      `${path}.buttons.shape must be one of: ${BUTTON_SHAPES.join(", ")}.`,
    );
  const primary = BUTTON_PRIMARY_STYLES.includes(
    buttons.primary as ButtonPrimaryStyle,
  )
    ? (buttons.primary as ButtonPrimaryStyle)
    : null;
  if (!primary)
    issues.push(
      `${path}.buttons.primary must be one of: ${BUTTON_PRIMARY_STYLES.join(", ")}.`,
    );
  const layout = layoutOf(value.layout, `${path}.layout`, issues);
  const styling = lines(
    value.styling,
    `${path}.styling`,
    PLAN_STYLING_LINES,
    2,
    issues,
  );
  const setsApart = lines(
    value.setsApart,
    `${path}.setsApart`,
    PLAN_SETS_APART_LINES,
    1,
    issues,
  );
  const layoutSource =
    value.layoutSource === "catalogue" || value.layoutSource === "reference"
      ? value.layoutSource
      : "none";
  if (issues.length > before || !fontPairing || !shape || !primary) return null;
  for (const [name, on] of [
    ["the page", page],
    ["cards", surface],
  ] as const) {
    const ratio = planContrast(ink, on);
    if (ratio < PLAN_TEXT_CONTRAST)
      issues.push(
        `${path}.colours.ink reads ${ratio.toFixed(2)}:1 on ${name} (${on}); body text needs ${PLAN_TEXT_CONTRAST}:1. Choose a text colour that reads on both.`,
      );
  }
  if (issues.length > before) return null;
  return {
    version: DESIGN_PLAN_VERSION,
    colours: { page, surface, ink, accent },
    fontPairing,
    buttons: { shape, primary },
    layout,
    layoutSource: layout ? layoutSource : "none",
    styling,
    setsApart,
  };
}

/** The plan a model wrote as one JSON string (Stage A `designPlanJson`). */
export function parseDesignPlanJson(
  text: unknown,
  issues: string[],
): DesignPlan | null {
  if (typeof text !== "string" || !text.trim()) {
    issues.push(
      "designPlanJson must be a JSON string holding this theme's design plan.",
    );
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    issues.push("designPlanJson is not valid JSON.");
    return null;
  }
  return parseDesignPlan(value, "designPlan", issues);
}

/** The plan kept with a version's stored intent, or null (none, or unreadable). */
export function readStoredDesignPlan(intent: unknown): DesignPlan | null {
  if (!isRec(intent) || !isRec(intent.designPlan)) return null;
  return parseDesignPlan(intent.designPlan, "designPlan", []);
}

/**
 * The plan as StoreMink completes it. A theme with no screenshots is given
 * the layout its catalogue uses least, whatever the model wrote: that layout
 * is a property of the catalogue, which the model cannot count. A theme built
 * from screenshots keeps the layout read from them.
 */
export function completeDesignPlan(
  plan: DesignPlan,
  commitments: LayoutCommitments | null,
  referenceLed: boolean,
): DesignPlan {
  if (referenceLed)
    return { ...plan, layoutSource: plan.layout ? "reference" : "none" };
  return {
    ...plan,
    layout: commitments,
    layoutSource: commitments ? "catalogue" : "none",
  };
}

// --------------------------------------------------------------- alikeness

/** The fingerprint axes a plan decides, with the fingerprint's own weights. */
const PLAN_WEIGHTS = {
  layout: 10, // composition: header, product page and footer
  card: 10,
  pageColour: 12,
  accent: 4,
  bodyFont: 5,
  displayFont: 8,
  buttons: 5,
  width: 4,
} as const;
type PlanAxis = keyof typeof PLAN_WEIGHTS;
const AXIS_WORDS: Record<PlanAxis, string> = {
  layout: "the header, product page and footer layouts",
  card: "the product card",
  pageColour: "the page colour",
  accent: "the accent colour",
  bodyFont: "the body font",
  displayFont: "the heading font",
  buttons: "the button style",
  width: "the page width",
};

/** Which planned axes a plan shares with a built theme's fingerprint. */
export function planSharedAxes(
  plan: DesignPlan,
  other: ThemeFingerprint,
): { planned: PlanAxis[]; shared: PlanAxis[] } {
  const fonts = pairingFonts(plan.fontPairing);
  const [header, productDetail, , footer] = other.composition.split("/");
  const [shape, primary] = other.buttons.split("/");
  const same: Record<PlanAxis, boolean | null> = {
    layout: plan.layout
      ? plan.layout.header === header &&
        plan.layout.productDetail === productDetail &&
        plan.layout.footer === footer
      : null,
    card: plan.layout ? plan.layout.card === other.card : null,
    pageColour: colourBand(plan.colours.page) === other.pageColour,
    accent: colourBand(plan.colours.accent) === other.accentHue,
    bodyFont: fonts.body === other.bodyFont,
    displayFont: fonts.display === other.displayFont,
    buttons: plan.buttons.shape === shape && plan.buttons.primary === primary,
    width: plan.layout ? plan.layout.pageWidth === other.width : null,
  };
  const planned = (Object.keys(same) as PlanAxis[]).filter(
    (axis) => same[axis] !== null,
  );
  return { planned, shared: planned.filter((axis) => same[axis]) };
}

/** 0 (everything the plan decides is shared) to 1 (nothing is). */
export function planDistance(
  plan: DesignPlan,
  other: ThemeFingerprint,
): number {
  const { planned, shared } = planSharedAxes(plan, other);
  const total = planned.reduce((sum, axis) => sum + PLAN_WEIGHTS[axis], 0);
  const same = shared.reduce((sum, axis) => sum + PLAN_WEIGHTS[axis], 0);
  return total ? Math.round((1 - same / total) * 1000) / 1000 : 1;
}

export interface PlanAlikeness {
  themeId: string;
  /** The published theme's name, or its id when the catalogue has none. */
  name: string;
  /** How far the plan is from it, 0 to 1. */
  score: number;
  /** What the two share, in an operator's words. */
  shared: string[];
}

/** The published theme a plan is closest to, or null with none published. */
export function planAlikeness(
  plan: DesignPlan,
  existing: readonly ExistingThemeFingerprint[],
): PlanAlikeness | null {
  const nearest = existing
    .filter((theme) => theme.published)
    .map((theme) => ({ theme, score: planDistance(plan, theme.fingerprint) }))
    .sort(
      (a, b) =>
        a.score - b.score || a.theme.themeId.localeCompare(b.theme.themeId),
    )[0];
  if (!nearest) return null;
  return {
    themeId: nearest.theme.themeId,
    name: nearest.theme.name ?? nearest.theme.themeId,
    score: nearest.score,
    shared: planSharedAxes(plan, nearest.theme.fingerprint).shared.map(
      (axis) => AXIS_WORDS[axis],
    ),
  };
}

/**
 * Why a plan cannot be built as it stands, as repair issues for the stage
 * that wrote it: a page colour its palette family does not allow, or a design
 * too close to a published theme.
 */
export function designPlanIssues(
  plan: DesignPlan,
  paletteFamily: PaletteFamily | undefined,
  existing: readonly ExistingThemeFingerprint[],
  referenceLed: boolean,
): string[] {
  const issues = paletteFamilyIssues(paletteFamily, plan.colours.page).map(
    (issue) => `Design plan colours.page: ${issue}`,
  );
  const nearest = planAlikeness(plan, existing);
  if (nearest && nearest.score < PLAN_DISTINCTNESS_FLOOR)
    issues.push(
      `Design plan: as planned, this theme would sit too close to "${nearest.name}", which is already published. They share ${nearest.shared.join(", ")}, and a plan must differ from every published theme on at least half of what it decides, before anything is built. Change the plan so it does: another page colour family (with a paletteFamily that allows it), another font pairing, another button style or accent${
        referenceLed
          ? ", or a layout value the screenshots leave open. Keep what the reference screenshots show most clearly and change what they leave open."
          : ", or another design direction (the layout follows the direction)."
      }`,
    );
  return issues;
}

// ------------------------------------------------------------------ prompts

const list = (values: readonly (string | number)[]) => values.join(", ");

/** Appended to the Stage A system prompt (v34+). */
export function designPlanPlanningPrompt(): string {
  const pairings = FONT_PAIRING_KEYS.map(
    (key) => `${key} (${FONT_PAIRINGS[key].label})`,
  ).join("; ");
  return `

Design plan: decide this theme's design now, before anything is built, and write it as designPlanJson: ONE JSON string holding an object with exactly these keys.
- colours: {"page","surface","ink","accent"}, each #rrggbb. page is the page background and must suit paletteFamily. surface is the colour of cards and panels. ink is the body text and must read at ${PLAN_TEXT_CONTRAST}:1 or better on both page and surface. accent is the one colour buttons and links use.
- fontPairing: one of ${pairings}.
- buttons: {"shape": ${list(BUTTON_SHAPES)}, "primary": ${list(BUTTON_PRIMARY_STYLES)}}.
- layout: null when no reference screenshot was supplied; StoreMink then assigns the layout the catalogue uses least for your designDirection. With reference screenshots, read it from them and choose the supported value closest to what they show: {"header": ${list(PLAN_LAYOUT_VALUES.header)}; "card": ${list(PLAN_LAYOUT_VALUES.card)}; "productDetail": ${list(PLAN_LAYOUT_VALUES.productDetail)}; "footer": ${list(PLAN_LAYOUT_VALUES.footer)}; "pageWidth": ${list(PLAN_LAYOUT_VALUES.pageWidth)}; "gridColumnsDesktop": ${list(PLAN_LAYOUT_VALUES.gridColumnsDesktop)}; "cardHoverImage": true or false}.
- styling: two to ${PLAN_STYLING_LINES} short lines, in plain words, on how this theme sets its product names, prices, buttons, badges and headings. The build writes the theme's style rules from them.
- setsApart: one to ${PLAN_SETS_APART_LINES} short lines on how this design differs from the catalogue themes listed as nearest.
With reference screenshots the plan follows them. Take page, surface, ink and accent from the colours measured from each screenshot's pixels (given with the brief), moving a shade only where text would not read. Take fontPairing from the pairing closest to the lettering shown, and the layout from the structure shown. Read every screenshot for its header, product card, page width, columns, buttons and how type is set, and record what you read in referenceAnalysis. Never plan to reproduce a reference's logo, brand name, wording or photographs.
The plan is checked before anything is built: it must differ from every published theme on at least half of what it decides (layout, product card, page colour, accent, fonts, buttons and page width). A plan that is too close comes back naming the theme it resembles.`;
}

const LAYOUT_PATHS: Record<keyof LayoutCommitments, string> = {
  header: "design.layout.header",
  card: "design.layout.card",
  productDetail: "design.layout.productDetail",
  footer: "design.layout.footer",
  pageWidth: "design.page.width",
  gridColumnsDesktop: "design.layout.gridColumnsDesktop",
  cardHoverImage: "design.layout.cardHoverImage",
};

/** Appended to the Stage B system prompt (v34+): the plan it builds from. */
export function designPlanBuildPrompt(plan: DesignPlan): string {
  const layout = plan.layout
    ? ` Layout (${
        plan.layoutSource === "reference"
          ? "read from the reference screenshots"
          : "the layout the catalogue uses least for this direction"
      }): ${(Object.keys(LAYOUT_PATHS) as (keyof LayoutCommitments)[])
        .map(
          (key) =>
            `${LAYOUT_PATHS[key]} = ${JSON.stringify(plan.layout![key])}`,
        )
        .join("; ")}.`
    : "";
  return `

Design plan: this theme's design was decided and checked against the published catalogue before you write it. Build exactly this plan.
Colours: design.palette.cream = ${plan.colours.page} (the page background), design.palette.surface = ${plan.colours.surface}, design.palette.ink = ${plan.colours.ink}, design.palette.accent = ${plan.colours.accent}. You may move a shade so text reads, never to another colour family; derive the remaining palette keys and the four section schemes from these.
Fonts: fontPairing = ${JSON.stringify(plan.fontPairing)}.
Buttons: design.buttons.shape = ${JSON.stringify(plan.buttons.shape)}, design.buttons.primary = ${JSON.stringify(plan.buttons.primary)}.${layout}
Styling, to carry out in the stylesheet and the section styles: ${plan.styling.join(" | ")}
Design the homepage, the page templates and the stylesheet around this plan (a transparent header needs the full-band opening it floats over; a market header needs headerBackground and headerForeground). Depart from one value only where the brief plainly requires it, such as a grocery store that needs the grocery storefront; a preference of your own is not a reason.`;
}

/**
 * Where a built draft leaves its plan, as repair issues. Colours are held by
 * band (a shade may move so text reads); everything else by value.
 */
export function designPlanDepartures(
  pkg: ThemePackageV2,
  plan: DesignPlan,
): string[] {
  const design = pkg.definition.preset.design;
  const issues = plan.layout
    ? commitmentIssues(pkg, plan.layout).map((issue) =>
        issue.replace(/^Layout commitment: /, "Design plan: "),
      )
    : [];
  const band = (
    path: string,
    actual: string | undefined,
    planned: string,
  ): void => {
    if (actual && colourBand(actual) !== colourBand(planned))
      issues.push(
        `Design plan: ${path} is ${actual}, in another colour family than the planned ${planned}. Use the planned colour; move its shade only so text reads.`,
      );
  };
  band("design.palette.cream", design.palette.cream, plan.colours.page);
  band("design.palette.accent", design.palette.accent, plan.colours.accent);
  const fonts = pairingFonts(plan.fontPairing);
  if (
    design.fonts.body !== fonts.body ||
    design.fonts.display !== fonts.display
  )
    issues.push(
      `Design plan: the fonts are not the planned pairing. Set fontPairing to ${JSON.stringify(plan.fontPairing)}.`,
    );
  const shape = design.buttons?.shape ?? "rounded";
  const primary = design.buttons?.primary ?? "solid";
  if (shape !== plan.buttons.shape)
    issues.push(
      `Design plan: design.buttons.shape is ${JSON.stringify(shape)}, but the plan is ${JSON.stringify(plan.buttons.shape)}.`,
    );
  if (primary !== plan.buttons.primary)
    issues.push(
      `Design plan: design.buttons.primary is ${JSON.stringify(primary)}, but the plan is ${JSON.stringify(plan.buttons.primary)}.`,
    );
  return issues;
}
