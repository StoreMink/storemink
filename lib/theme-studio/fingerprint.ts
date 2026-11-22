import type { ThemeDefinition } from "@/lib/themes/types";
import { stylesheetFacts } from "@/lib/themes/stylesheet";
import {
  STUDIO_DESIGN_DIRECTION_IDS,
  type StudioDesignDirection,
  type PaletteFamily,
} from "./design-directions";

export interface ThemeFingerprint {
  composition: string;
  card: string;
  hero: string;
  sections: string[];
  sectionStyles: string[];
  pageColour: string;
  accentHue: string;
  bodyFont: string;
  displayFont: string;
  buttons: string;
  width: string;
  grid: string;
  shape: string;
  heading: string;
  motion: string;
  category: string;
  newsletter: string;
  /**
   * What the theme's own style rules say (lib/themes/stylesheet.ts
   * `stylesheetFacts`), from prompt v34. ★ OPTIONAL, and only ever set by a
   * caller that asks for it: a theme with no stylesheet, every fingerprint
   * stored before 22 Nov 2026, and the storefront redesign's use of this
   * type all read exactly as they did.
   */
  styling?: string[];
}
/** The most style facts one fingerprint keeps. */
export const STYLING_FACTS_MAX = 160;
/**
 * The weight of styling when BOTH themes carry rules: about a quarter of the
 * whole. Two themes alike in every layout pick and different in every rule
 * then score 0.28, a real difference that still falls short of "distinct",
 * because a catalogue of themes that differ only in styling would be one
 * theme in several hands (Shopify calls those styles of a theme).
 */
export const STYLING_WEIGHT = 40;
/** Styling counts as a changed major axis at this share of differing facts. */
const STYLING_CHANGE = 0.5;

function stylingDistance(a: readonly string[], b: readonly string[]): number {
  const [x, y] = [new Set(a), new Set(b)];
  if (!x.size && !y.size) return 0;
  let shared = 0;
  for (const fact of x) if (y.has(fact)) shared += 1;
  return 1 - shared / (x.size + y.size - shared);
}
export interface ExistingThemeFingerprint {
  themeId: string;
  direction: StudioDesignDirection | null;
  fingerprint: ThemeFingerprint;
}
/** Expand compound fingerprint fields for transparent catalogue frequency
 * hints and the evaluation's individual-setting convergence checks. */
export function fingerprintChoiceValues(
  fingerprint: ThemeFingerprint,
): Record<string, string> {
  const [mobile, desktop, filters, sticky, hover, banner, gap] =
    fingerprint.grid.split("/");
  const [buttonShape, primary, secondary] = fingerprint.buttons.split("/");
  const [categoryDisplay, categoryLayout] = fingerprint.category
    .split("|")[0]
    .split("/");
  return {
    card: fingerprint.card,
    gridColumnsMobile: mobile,
    gridColumnsDesktop: desktop,
    shopFilters: filters,
    stickyAddToCart: sticky,
    cardHoverImage: hover,
    collectionBanner: banner,
    gridGap: gap,
    categoryDisplay,
    categoryLayout: categoryLayout ?? "none",
    primaryButton: primary,
    secondaryButton: secondary,
    buttonShape,
    pageWidth: fingerprint.width,
    pageColour: fingerprint.pageColour,
    motion: fingerprint.motion,
    bodyFont: fingerprint.bodyFont,
    displayFont: fingerprint.displayFont,
    hero: fingerprint.hero,
    newsletter: fingerprint.newsletter,
  };
}
export const DISTINCTNESS_THRESHOLD = 0.35;
/** Major axes counted by `changedAxes`: composition, card, hero, page colour,
 * buttons, typography and homepage structure, and (when both themes carry
 * style rules) styling. */
export const MAJOR_AXES = 8;
/** Section-sequence edit distance at which homepage structure counts as a
 * changed major axis. */
const STRUCTURE_CHANGE = 0.5;
const WEIGHTS: Record<Exclude<keyof ThemeFingerprint, "styling">, number> = {
  composition: 10,
  card: 10,
  hero: 10,
  sections: 12,
  sectionStyles: 6,
  pageColour: 12,
  accentHue: 4,
  bodyFont: 5,
  displayFont: 8,
  buttons: 5,
  width: 4,
  grid: 4,
  shape: 3,
  heading: 4,
  motion: 1,
  category: 3,
  newsletter: 3,
};
export function colourBand(hex: string): string {
  if (/^#[0-9a-f]{3}$/i.test(hex))
    hex = `#${hex
      .slice(1)
      .split("")
      .map((c) => c + c)
      .join("")}`;
  const values = /^#[0-9a-f]{6}$/i.test(hex)
    ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    : [1, 1, 1];
  const [r, g, b] = values;
  const max = Math.max(...values),
    min = Math.min(...values),
    delta = max - min;
  const luma = values
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  if (delta < 0.12 && luma > 0.8) return "near-white";
  if (delta < 0.08)
    return luma < 0.08
      ? "near-black"
      : luma < 0.4
        ? "neutral-mid"
        : "neutral-light";
  const hue =
    delta === 0
      ? 0
      : max === r
        ? ((g - b) / delta + 6) % 6
        : max === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4;
  return `${luma < 0.12 ? "dark" : luma > 0.65 ? "tinted" : "colour"}:${Math.floor(hue)}`;
}
export function paletteFamilyIssues(
  family: PaletteFamily | undefined,
  page: string,
): string[] {
  const pageBand = colourBand(page);
  if (family === "dark" && !/^(near-black|dark:)/.test(pageBand))
    return [
      "The dark palette family needs a dark page background (cream), not only dark accents.",
    ];
  if (family === "colour-field" && !/^(colour:|tinted:|dark:)/.test(pageBand))
    return [
      "The colour-field palette family needs a visibly coloured page background (cream), not only a coloured accent on a neutral page.",
    ];
  if (family === "tinted-neutral" && pageBand === "near-white")
    return [
      "The tinted-neutral palette family needs a visible sage, clay, mineral or neutral page background (cream); a barely tinted white belongs to the light family.",
    ];
  return [];
}
export function themeFingerprint(
  theme: ThemeDefinition,
  /** Theme Studio asks for the styling axis; nothing else does. */
  options: { styling?: boolean } = {},
): ThemeFingerprint {
  const styling = options.styling
    ? stylesheetFacts(theme.preset.stylesheet).slice(0, STYLING_FACTS_MAX)
    : [];
  const design = theme.preset.design;
  const layout = design.layout ?? {};
  const grocery = layout.storefront === "grocery";
  const home = (theme.preset.pages.find((p) => !p.slug)?.sections ?? []).slice(
    0,
    30,
  );
  const configs = (type: string) =>
    home
      .filter((s) => s.type === type)
      .map((s) => s.config as unknown as Record<string, unknown>);
  const radius = parseFloat(design.shape.card);
  const radiusBucket = radius < 2 ? "square" : radius < 12 ? "soft" : "round";
  const hero = home.find(
    (s) => s.type === "hero" || s.type === "hero_carousel",
  );
  const heroConfig = hero?.config as unknown as
    | Record<string, unknown>
    | undefined;
  return {
    composition: `${layout.header ?? "classic"}/${layout.productDetail ?? (grocery ? "grocery" : "classic")}/${layout.cart ?? (grocery ? "grocery" : "classic")}/${layout.footer ?? "rich"}/${grocery ? "grocery" : "classic"}`,
    card: grocery ? "grocery" : (layout.card ?? "classic"),
    hero: `${hero?.type ?? "none"}:${heroConfig?.variant ?? (hero?.type === "hero" ? "banner" : "")}:${heroConfig?.height ?? "auto"}`,
    sections: home.map((s) => s.type),
    sectionStyles: home.map(
      (s) =>
        `${s.type}:${s.style?.scheme ?? "page"}:${s.style?.padding_y ?? "md"}:${s.style?.width ?? "contained"}`,
    ),
    pageColour: colourBand(design.palette.cream),
    accentHue: colourBand(design.palette.accent ?? design.palette.ink),
    bodyFont: design.fonts.body,
    displayFont: design.fonts.display,
    buttons: `${design.buttons?.shape ?? "rounded"}/${design.buttons?.primary ?? "solid"}/${design.buttons?.secondary ?? "outline"}`,
    width: design.page?.width ?? "standard",
    grid: `${layout.gridColumnsMobile ?? 1}/${layout.gridColumnsDesktop ?? 4}/${!!layout.shopFilters}/${!!layout.stickyAddToCart}/${!!layout.cardHoverImage}/${!!layout.collectionBanner}/${design.page?.gridGap ?? "standard"}`,
    shape: radiusBucket,
    heading: `${design.typography?.headingFont ?? "body"}/${design.typography?.headingScale ?? "medium"}/${design.typography?.headingCase ?? "none"}/${design.typography?.headingTracking ?? "normal"}`,
    motion: design.motion?.reveal ?? "none",
    category:
      configs("shop_by_category")
        .map((c) => `${c.display ?? "circles"}/${c.layout ?? "scroll"}`)
        .join("|")
        .slice(0, 160) || "none",
    newsletter:
      configs("newsletter")
        .map((c) => `${c.theme ?? "dark"}/${c.alignment ?? "center"}`)
        .join("|")
        .slice(0, 160) || "none",
    ...(styling.length ? { styling } : {}),
  };
}
function sequenceDistance(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(
        Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)),
      );
    row = next;
  }
  return row[b.length] / Math.max(a.length, b.length);
}
export function fingerprintDistance(
  a: ThemeFingerprint,
  b: ThemeFingerprint,
): number {
  // ★ Styling is compared only when BOTH carry it, and then it joins the
  //   total: a theme with rules against one without is judged on the layout
  //   axes alone, so a new theme is not "different" from every older one
  //   merely for having a stylesheet.
  const styled = !!a.styling?.length && !!b.styling?.length;
  const total =
    Object.values(WEIGHTS).reduce((s, w) => s + w, 0) +
    (styled ? STYLING_WEIGHT : 0);
  return (
    ((Object.entries(WEIGHTS) as [keyof typeof WEIGHTS, number][]).reduce(
      (sum, [k, w]) =>
        sum +
        w *
          (Array.isArray(a[k])
            ? sequenceDistance(a[k] as string[], b[k] as string[])
            : a[k] === b[k]
              ? 0
              : 1),
      0,
    ) +
      (styled ? STYLING_WEIGHT * stylingDistance(a.styling!, b.styling!) : 0)) /
    total
  );
}
export interface DistinctnessReport {
  version: 1;
  score: number | null;
  threshold: number;
  nearestThemeId: string | null;
  sharedAttributes: (keyof ThemeFingerprint)[];
  changedAxes: number;
  status: "distinct" | "similar" | "reference-led" | "not-compared";
  repairAttempted: boolean;
  beforeScore?: number | null;
  /** v24+: style settings that repeat the catalogue's dominant answer. */
  overusedChoices?: string[];
}
export function measureDistinctness(
  theme: ThemeDefinition,
  existing: readonly ExistingThemeFingerprint[],
  referenceLed = false,
  /** v34+: count the theme's own style rules (prompt-features.ts). */
  styling = false,
): DistinctnessReport {
  const current = themeFingerprint(theme, { styling });
  const nearest = existing
    .map((t) => ({ ...t, score: fingerprintDistance(current, t.fingerprint) }))
    .sort((a, b) => a.score - b.score || a.themeId.localeCompare(b.themeId))[0];
  const changedAxes = nearest
    ? ["composition", "card", "hero", "pageColour", "buttons"].filter(
        (k) =>
          current[k as keyof ThemeFingerprint] !==
          nearest.fingerprint[k as keyof ThemeFingerprint],
      ).length +
      (current.bodyFont !== nearest.fingerprint.bodyFont ||
      current.displayFont !== nearest.fingerprint.displayFont
        ? 1
        : 0) +
      // Homepage structure is the heaviest-weighted axis; a substantially
      // different section sequence is a major change, not a minor one.
      (sequenceDistance(current.sections, nearest.fingerprint.sections) >=
      STRUCTURE_CHANGE
        ? 1
        : 0) +
      (current.styling?.length &&
      nearest.fingerprint.styling?.length &&
      stylingDistance(current.styling, nearest.fingerprint.styling) >=
        STYLING_CHANGE
        ? 1
        : 0)
    : 0;
  return {
    version: 1,
    score: nearest ? Math.round(nearest.score * 1000) / 1000 : null,
    threshold: DISTINCTNESS_THRESHOLD,
    nearestThemeId: nearest?.themeId ?? null,
    sharedAttributes: nearest
      ? (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).filter(
          (k) =>
            JSON.stringify(current[k]) ===
            JSON.stringify(nearest.fingerprint[k]),
        )
      : [],
    changedAxes,
    status: referenceLed
      ? "reference-led"
      : !nearest
        ? "not-compared"
        : nearest.score < DISTINCTNESS_THRESHOLD || changedAxes < 3
          ? "similar"
          : "distinct",
    repairAttempted: false,
  };
}

/** Individual style settings a variety correction can change. Measured
 * separately from the weighted distance because the 2026-10-04 live batch
 * passed that bar while all eight drafts chose the same page width and the
 * same hover-image setting: small weights, one shared answer everywhere. */
export const CONVERGENCE_CHOICES = [
  "pageWidth",
  "cardHoverImage",
  "gridColumnsDesktop",
  "gridColumnsMobile",
  "gridGap",
  "buttonShape",
  "primaryButton",
  "categoryDisplay",
  "card",
  // Not the hero: since 2026-10-09 every Studio theme opens with a photograph
  // filling the band (opening.ts), so a shared opening is the rule, not a
  // repeated default. The weighted distance still counts the hero axis.
  "motion",
] as const;
/** A value this share of the catalogue already uses is "the default answer". */
export const CONVERGENCE_SHARE = 0.6;
/** Below this many comparable themes a majority says nothing. */
export const CONVERGENCE_MIN_THEMES = 5;
/** How many repeated defaults trigger one bounded correction. */
export const CONVERGENCE_TRIGGER = 2;

/**
 * The draft's style settings that repeat the catalogue's dominant answer,
 * most-used first, e.g. `pageWidth=wide (7/8)`.
 */
export function overusedChoices(
  theme: ThemeDefinition,
  existing: readonly ExistingThemeFingerprint[],
): string[] {
  if (existing.length < CONVERGENCE_MIN_THEMES) return [];
  const current = fingerprintChoiceValues(themeFingerprint(theme));
  const out: { label: string; share: number }[] = [];
  for (const key of CONVERGENCE_CHOICES) {
    const value = current[key];
    if (value === undefined) continue;
    const same = existing.filter(
      (t) => fingerprintChoiceValues(t.fingerprint)[key] === value,
    ).length;
    const share = same / existing.length;
    if (share >= CONVERGENCE_SHARE)
      out.push({
        label: `${key}=${value} (${same}/${existing.length})`,
        share,
      });
  }
  return out
    .sort((a, b) => b.share - a.share || a.label.localeCompare(b.label))
    .map((o) => o.label);
}

export function readDistinctnessReport(
  value: unknown,
): DistinctnessReport | null {
  const r = value as DistinctnessReport | null;
  return r &&
    r.version === 1 &&
    (r.score === null ||
      (typeof r.score === "number" && r.score >= 0 && r.score <= 1)) &&
    typeof r.threshold === "number" &&
    r.threshold > 0 &&
    r.threshold <= 1 &&
    (r.nearestThemeId === null ||
      (typeof r.nearestThemeId === "string" &&
        r.nearestThemeId.length <= 80)) &&
    Number.isInteger(r.changedAxes) &&
    r.changedAxes >= 0 &&
    r.changedAxes <= MAJOR_AXES &&
    ["distinct", "similar", "reference-led", "not-compared"].includes(
      r.status,
    ) &&
    typeof r.repairAttempted === "boolean" &&
    Array.isArray(r.sharedAttributes) &&
    r.sharedAttributes.length <= Object.keys(WEIGHTS).length &&
    r.sharedAttributes.every((k) => Object.hasOwn(WEIGHTS, k)) &&
    (r.beforeScore === undefined ||
      r.beforeScore === null ||
      (typeof r.beforeScore === "number" &&
        r.beforeScore >= 0 &&
        r.beforeScore <= 1))
    ? {
        version: 1,
        score: r.score,
        threshold: r.threshold,
        nearestThemeId: r.nearestThemeId,
        changedAxes: r.changedAxes,
        status: r.status,
        repairAttempted: r.repairAttempted,
        sharedAttributes: [...r.sharedAttributes],
        ...(r.beforeScore !== undefined ? { beforeScore: r.beforeScore } : {}),
        ...(Array.isArray(r.overusedChoices) &&
        r.overusedChoices.length <= CONVERGENCE_CHOICES.length &&
        r.overusedChoices.every((c) => typeof c === "string" && c.length <= 120)
          ? { overusedChoices: [...r.overusedChoices] }
          : {}),
      }
    : null;
}

export function readVarietyContext(
  value: unknown,
): ExistingThemeFingerprint[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const keys = Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[];
  const text = (v: unknown) => typeof v === "string" && v.length <= 160;
  // The optional styling axis: a bounded list of "hook:property=value".
  const styling = (v: unknown) =>
    v === undefined ||
    (Array.isArray(v) &&
      v.length <= STYLING_FACTS_MAX &&
      v.every(
        (fact) =>
          typeof fact === "string" &&
          /^[a-z][a-z.-]*(:[a-z-]+)?:[A-Za-z]+=[A-Za-z0-9.-]+$/.test(fact) &&
          fact.length <= 120,
      ));
  if (
    !value.every(
      (t) =>
        t &&
        typeof t === "object" &&
        typeof t.themeId === "string" &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t.themeId) &&
        t.themeId.length <= 80 &&
        (t.direction === null ||
          STUDIO_DESIGN_DIRECTION_IDS.includes(t.direction)) &&
        t.fingerprint &&
        keys.every((k) =>
          k === "sections" || k === "sectionStyles"
            ? Array.isArray(t.fingerprint[k]) &&
              t.fingerprint[k].length <= 30 &&
              t.fingerprint[k].every(text)
            : text(t.fingerprint[k]),
        ) &&
        styling(t.fingerprint.styling),
    )
  )
    return null;
  // Whitelist every field: database metadata can never carry copy or prompts.
  return value.map((t) => ({
    themeId: t.themeId,
    direction: t.direction,
    fingerprint: {
      ...Object.fromEntries(keys.map((k) => [k, t.fingerprint[k]])),
      ...(t.fingerprint.styling?.length
        ? { styling: [...t.fingerprint.styling] }
        : {}),
    } as unknown as ThemeFingerprint,
  }));
}

/** A catalogue entry without its (long) styling axis, for the places that
 *  print fingerprints into a request and need only the layout axes. */
export function withoutStyling(
  theme: ExistingThemeFingerprint,
): ExistingThemeFingerprint {
  if (!theme.fingerprint.styling) return theme;
  return {
    ...theme,
    fingerprint: Object.fromEntries(
      Object.entries(theme.fingerprint).filter(([key]) => key !== "styling"),
    ) as unknown as ThemeFingerprint,
  };
}

/** How many catalogue themes must carry style rules before "most themes do
 *  this" means anything. */
export const STYLING_CONVERGENCE_MIN_THEMES = 4;
/** The most overused style facts a prompt is shown. */
const STYLING_OVERUSED_SHOWN = 16;

/**
 * Style facts most styled catalogue themes share ("product-card.title:
 * textTransform=uppercase"), most common first, for the stylesheet prompt:
 * the same convergence signal `overusedChoices` gives the layout settings.
 * Empty until enough themes carry rules.
 */
export function overusedStyling(
  existing: readonly ExistingThemeFingerprint[],
): string[] {
  const styled = existing.filter((t) => t.fingerprint.styling?.length);
  if (styled.length < STYLING_CONVERGENCE_MIN_THEMES) return [];
  const counts = new Map<string, number>();
  for (const theme of styled)
    for (const fact of new Set(theme.fingerprint.styling))
      counts.set(fact, (counts.get(fact) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count / styled.length >= CONVERGENCE_SHARE)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, STYLING_OVERUSED_SHOWN)
    .map(([fact]) => fact);
}

// ───────────────────────────────────────────────────────────────────────────
// Publishing: a theme too close to one already in the catalogue is refused
// (owner, 22 Nov 2026: "all the themes should not look same"; plan Phase 4
// item 3). Until then similarity only steered the prompt and showed as a
// note, so two near-identical themes could both be published.
// ───────────────────────────────────────────────────────────────────────────

/**
 * How different a theme must be from every theme already in the public
 * catalogue to be published beside them. Measured on 22 Nov 2026: each of the
 * seven hand-made exemplars is 0.58 to 0.89 from its nearest neighbour, and
 * the 4 Oct live batch's median pair was 0.65, so a theme designed on its own
 * terms clears this easily, and one that repeats a neighbour does not.
 */
export const PUBLICATION_DISTINCTNESS_THRESHOLD = 0.5;

/** A theme in the public catalogue, as a new one is compared with it. */
export interface PublishedThemeFingerprint {
  themeId: string;
  name: string;
  fingerprint: ThemeFingerprint;
}

/** What two themes share, in an operator's words, most visible first. */
function sharedInWords(a: ThemeFingerprint, b: ThemeFingerprint): string[] {
  const shared: string[] = [];
  if (a.composition === b.composition)
    shared.push("the header, product page, cart and footer layouts");
  if (a.card === b.card) shared.push("the product card");
  if (a.hero === b.hero) shared.push("the homepage opening");
  if (sequenceDistance(a.sections, b.sections) < STRUCTURE_CHANGE)
    shared.push("most of the homepage's sections, in the same order");
  if (a.pageColour === b.pageColour) shared.push("the page colour");
  if (a.bodyFont === b.bodyFont && a.displayFont === b.displayFont)
    shared.push("both fonts");
  if (a.buttons === b.buttons) shared.push("the button style");
  if (
    a.styling?.length &&
    b.styling?.length &&
    stylingDistance(a.styling, b.styling) < STYLING_CHANGE
  )
    shared.push("most of its style rules");
  return shared;
}

/**
 * Why this theme cannot be published beside the catalogue as it stands, in
 * the operator's words, or null when it is different enough from every theme
 * in it. The theme's own earlier release is never one of `published`.
 */
export function publicationSimilarityBlocker(
  theme: ThemeDefinition,
  published: readonly PublishedThemeFingerprint[],
): string | null {
  const current = themeFingerprint(theme, { styling: true });
  const nearest = published
    .map((other) => ({
      other,
      score: fingerprintDistance(current, other.fingerprint),
    }))
    .sort(
      (a, b) =>
        a.score - b.score || a.other.themeId.localeCompare(b.other.themeId),
    )[0];
  if (!nearest || nearest.score >= PUBLICATION_DISTINCTNESS_THRESHOLD)
    return null;
  const shared = sharedInWords(current, nearest.other.fingerprint);
  const alike = Math.round((1 - nearest.score) * 100);
  return (
    `This theme looks too much like "${nearest.other.name}", which is already in the catalogue: ` +
    `they are ${alike}% alike, and a theme must differ from every published theme by at least ${Math.round(PUBLICATION_DISTINCTNESS_THRESHOLD * 100)}%.` +
    (shared.length ? ` They share ${shared.join(", ")}.` : "") +
    " Ask for a change that sets it apart, then publish."
  );
}
