// ---------------------------------------------------------------------------
// The scoped theme stylesheet ("Track S", docs/theme-studio-shopify-grade-plan
// Phase 3; owner, 22 Nov 2026: "build step 3, the per-theme style rules").
//
// WHY. A theme used to be a set of picks from fixed lists (header, card, hero,
// fonts, colours). Two themes with the same picks were the same skeleton in
// different paint, which is why Theme Studio's themes looked alike. A theme
// may now carry its own STYLE RULES: how its product card names are set, how
// its buttons and badges are shaped, what its section headings and images
// look like, how things move on hover. Two themes with the same picks and
// different rules no longer look the same.
//
// ★★ RULES ARE STRUCTURED DATA, NEVER CSS TEXT. A rule names a HOOK from a
//    closed catalogue (never a selector the author invents), and its
//    declarations are PROPERTIES from an allowlist whose VALUES are names from
//    fixed scales (never lengths, colours or functions the author writes).
//    StoreMink's own compiler turns them into CSS. So there is nothing to
//    sanitise: a rule that is not in the vocabulary is refused, and what is in
//    the vocabulary cannot reach outside the storefront, load a URL, hide a
//    buy button, move a control or run anything.
// ★★ COLOUR IS ALWAYS A READABLE PAIR. A rule never sets a text colour and a
//    background separately in free combination: a label takes a TONE (its
//    background and the text colour that goes with it, from the theme's own
//    palette), a box takes a FILL that the page's ink is checked against, and
//    a text colour is checked against every surface that text can sit on,
//    section colour schemes included. Elements whose colour the storefront
//    owns (copy over a photograph, the header over the opening picture) take
//    no colour at all.
// ★ EVERYTHING IS A PALETTE TOKEN, so a merchant who changes their brand
//   colour or palette in the Website Builder re-colours the rules too, and a
//   section's colour scheme re-points them inside the section as it does the
//   rest of the page. Inline styles the builder writes still win.
// ★ PURE AND CLIENT-SAFE: no database, no React, no server import. The package
//   contract, the Studio compiler, the storefront layout, the builder preview
//   and the catalogue fingerprint all read this one module.
// ---------------------------------------------------------------------------

import { resolveScheme, SECTION_SCHEMES } from "./schemes";
import type { ThemeDesign } from "./types";

export type StyleState = "hover" | "focus-visible" | "active";
export type StyleViewport = "phone" | "tablet" | "desktop";
export type StyleValue = string | number;

export interface ThemeStyleRule {
  /** A name from the catalogue: "product-card.title",
   *  "product-card[variant=centered].title", "hero[variant=split].heading". */
  hook: string;
  state?: StyleState;
  viewport?: StyleViewport;
  declarations: Record<string, StyleValue>;
}

export const STYLESHEET_MAX_RULES = 200;
export const STYLESHEET_MAX_DECLARATIONS = 14;
/** The compiled CSS a theme may add to every page. */
export const STYLESHEET_MAX_BYTES = 32 * 1024;

export const STYLE_STATES: readonly StyleState[] = [
  "hover",
  "focus-visible",
  "active",
];
export const STYLE_VIEWPORTS: readonly StyleViewport[] = [
  "phone",
  "tablet",
  "desktop",
];

const VIEWPORT_MEDIA: Record<StyleViewport, string> = {
  phone: "(max-width: 640px)",
  tablet: "(min-width: 641px) and (max-width: 1024px)",
  desktop: "(min-width: 1025px)",
};

/**
 * The class the storefront root carries when a stylesheet is in force.
 * ★ Written twice in every compiled selector: the rules must beat the
 *   storefront's own variant rules (`.sm-card-centered .shop-card-name`)
 *   without `!important`, and a repeated class is the plain way to say so.
 */
export const STYLESHEET_ROOT_CLASS = "sm-styled";
const SCOPE = `.storefront-root.${STYLESHEET_ROOT_CLASS}.${STYLESHEET_ROOT_CLASS}`;

// ───────────────────────────────────────────────────────────────────────────
// Scales: every value a declaration may hold.
// ───────────────────────────────────────────────────────────────────────────

/** Font sizes, smallest first. Never under 12px; the large steps scale with
 *  the screen so a heading set for a desktop still fits a phone. */
export const STYLE_FONT_SIZES = {
  xs: "0.75rem",
  sm: "0.875rem",
  base: "1rem",
  lg: "1.125rem",
  xl: "clamp(1.15rem, 1rem + 0.6vw, 1.35rem)",
  "2xl": "clamp(1.35rem, 1.1rem + 1vw, 1.75rem)",
  "3xl": "clamp(1.6rem, 1.2rem + 1.8vw, 2.4rem)",
  "4xl": "clamp(1.9rem, 1.3rem + 3vw, 3.4rem)",
  "5xl": "clamp(2.2rem, 1.4rem + 4.5vw, 4.6rem)",
  "6xl": "clamp(2.5rem, 1.4rem + 6.5vw, 6.5rem)",
} as const;
export type StyleFontSize = keyof typeof STYLE_FONT_SIZES;
const FONT_SIZE_ORDER = Object.keys(STYLE_FONT_SIZES) as StyleFontSize[];

export const STYLE_SPACES = {
  "0": "0",
  "2xs": "2px",
  xs: "4px",
  sm: "8px",
  md: "12px",
  lg: "16px",
  xl: "24px",
  "2xl": "32px",
  "3xl": "48px",
} as const;
export type StyleSpace = keyof typeof STYLE_SPACES;
const SPACE_ORDER = Object.keys(STYLE_SPACES) as StyleSpace[];

export const STYLE_RADII = {
  none: "0",
  xs: "2px",
  sm: "6px",
  md: "12px",
  lg: "20px",
  xl: "32px",
  pill: "999px",
  // The theme's own shape tokens, which a merchant can change.
  card: "var(--sm-radius-card)",
  control: "var(--sm-radius-control)",
} as const;

export const STYLE_SHADOWS = {
  none: "none",
  hairline: "0 0 0 1px var(--sm-border)",
  soft: "0 2px 10px rgba(var(--sm-shadow-rgb), 0.08)",
  lifted: "0 10px 30px rgba(var(--sm-shadow-rgb), 0.12)",
  floating: "0 24px 60px rgba(var(--sm-shadow-rgb), 0.18)",
  hard: "4px 4px 0 var(--sm-ink)",
  "hard-accent": "4px 4px 0 var(--sm-accent, var(--brand-primary))",
  inset: "inset 0 0 0 1px var(--sm-border)",
} as const;

const ACCENT = "var(--sm-accent, var(--brand-primary))";

/** A label's background and the text colour that goes with it. */
export const STYLE_TONES = {
  ink: { background: "var(--sm-ink)", color: "var(--sm-on-ink)" },
  accent: { background: ACCENT, color: "var(--sm-on-accent)" },
  surface: { background: "var(--sm-surface)", color: "var(--sm-ink)" },
  page: { background: "var(--sm-cream)", color: "var(--sm-ink)" },
  soft: { background: "var(--sm-cream-deep)", color: "var(--sm-ink)" },
  sand: { background: "var(--sm-sand)", color: "var(--sm-ink)" },
  // No background of its own: the text sits on whatever is behind it, so
  // these two are refused on anything that can lie over a photograph.
  outline: { background: "transparent", color: "var(--sm-ink)" },
  ghost: { background: "transparent", color: "var(--sm-ink)" },
} as const;
export type StyleTone = keyof typeof STYLE_TONES;
const SEE_THROUGH_TONES: readonly string[] = ["outline", "ghost"];

/** A box's background. The page's ink is checked against each one used. */
export const STYLE_FILLS = {
  none: "transparent",
  surface: "var(--sm-surface)",
  page: "var(--sm-cream)",
  soft: "var(--sm-cream-deep)",
  sand: "var(--sm-sand)",
  tile: "var(--sm-tile)",
} as const;
export type StyleFill = keyof typeof STYLE_FILLS;

export const STYLE_TEXT_COLOURS = {
  ink: "var(--sm-ink)",
  inkSoft: "var(--sm-ink-soft)",
  accent: ACCENT,
} as const;
export type StyleTextColour = keyof typeof STYLE_TEXT_COLOURS;

export const STYLE_BORDER_COLOURS = {
  ink: "var(--sm-ink)",
  inkSoft: "var(--sm-ink-soft)",
  line: "var(--sm-border)",
  accent: ACCENT,
  sand: "var(--sm-sand)",
  transparent: "transparent",
} as const;

export const STYLE_TRANSFORMS = {
  none: "none",
  "lift-sm": "translateY(-2px)",
  lift: "translateY(-4px)",
  "lift-lg": "translateY(-8px)",
  grow: "scale(1.02)",
  zoom: "scale(1.05)",
  press: "scale(0.98)",
  nudge: "translateX(4px)",
} as const;

const TRANSITION_PROPERTIES =
  "transform, box-shadow, background-color, color, border-color, filter, opacity";
export const STYLE_TRANSITIONS = {
  none: "none",
  fast: "150ms",
  base: "250ms",
  slow: "450ms",
} as const;

export const STYLE_FILTERS = {
  none: "none",
  grayscale: "grayscale(1)",
  muted: "saturate(0.75)",
  vivid: "saturate(1.15) contrast(1.03)",
} as const;

export const STYLE_DECORATIONS = {
  none: "none",
  underline: "underline",
  "underline-offset": "underline",
  "underline-thick": "underline",
} as const;

const LETTER_SPACINGS = [
  "-0.03em",
  "-0.02em",
  "-0.01em",
  "0",
  "0.02em",
  "0.04em",
  "0.08em",
  "0.12em",
  "0.16em",
  "0.2em",
  "0.28em",
] as const;
const FONT_WEIGHTS = [300, 400, 500, 600, 700, 800, 900] as const;
const LINE_HEIGHTS = [0.95, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.75] as const;
const BORDER_WIDTHS = [0, 1, 2, 3, 4] as const;
const HOVER_OPACITIES = [0.8, 0.85, 0.9, 1] as const;

// ───────────────────────────────────────────────────────────────────────────
// Properties: what each kind of element may be told.
// ───────────────────────────────────────────────────────────────────────────

/**
 * - text:  a heading, a name, a caption. Type and (where allowed) colour.
 * - label: a button, a badge, a chip. Type, a tone, a border, a shape.
 * - box:   a card, a tile, an item. A fill, a border, a shape, spacing.
 * - media: a photograph or its frame. A shape, a border, a treatment.
 * - band:  a full-width strip. Only its top and bottom rules.
 * - grid:  a grid of cards. Only the gaps between them.
 */
export type StyleHookKind =
  | "text"
  | "label"
  | "box"
  | "media"
  | "band"
  | "grid";

type PropertyGroup =
  | "type"
  | "color"
  | "tone"
  | "fill"
  | "border"
  | "edge"
  | "shape"
  | "shadow"
  | "space"
  | "gap"
  | "below"
  | "align"
  | "media"
  | "motion";

interface PropertySpec {
  group: PropertyGroup;
  /** Only in a hover, focus or active rule. */
  stateOnly?: boolean;
  /** Never in a state rule. */
  baseOnly?: boolean;
  values: readonly StyleValue[];
  /** The CSS this value becomes. */
  css: (value: StyleValue) => string[];
}

const names = (record: Record<string, unknown>) => Object.keys(record);
const one = (property: string, map: Record<string, string>) => {
  return (value: StyleValue) => [`${property}: ${map[String(value)]}`];
};

export const STYLE_PROPERTIES: Readonly<Record<string, PropertySpec>> = {
  fontFamily: {
    group: "type",
    baseOnly: true,
    values: ["display", "body"],
    css: (v) => [
      `font-family: ${v === "display" ? "var(--font-stick-no-bills)" : "var(--font-outfit)"}`,
    ],
  },
  fontSize: {
    group: "type",
    baseOnly: true,
    values: FONT_SIZE_ORDER,
    css: one("font-size", STYLE_FONT_SIZES),
  },
  fontWeight: {
    group: "type",
    baseOnly: true,
    values: FONT_WEIGHTS,
    css: (v) => [`font-weight: ${v}`],
  },
  fontStyle: {
    group: "type",
    baseOnly: true,
    values: ["normal", "italic"],
    css: (v) => [`font-style: ${v}`],
  },
  letterSpacing: {
    group: "type",
    baseOnly: true,
    values: LETTER_SPACINGS,
    css: (v) => [`letter-spacing: ${v}`],
  },
  textTransform: {
    group: "type",
    baseOnly: true,
    values: ["none", "uppercase", "lowercase", "capitalize"],
    css: (v) => [`text-transform: ${v}`],
  },
  lineHeight: {
    group: "type",
    baseOnly: true,
    values: LINE_HEIGHTS,
    css: (v) => [`line-height: ${v}`],
  },
  textDecoration: {
    group: "type",
    values: names(STYLE_DECORATIONS),
    css: (v) =>
      v === "none"
        ? ["text-decoration: none"]
        : [
            "text-decoration: underline",
            `text-underline-offset: ${v === "underline" ? "0.12em" : "0.3em"}`,
            `text-decoration-thickness: ${v === "underline-thick" ? "0.14em" : "from-font"}`,
          ],
  },
  textAlign: {
    group: "align",
    baseOnly: true,
    values: ["start", "center", "end"],
    css: (v) => [`text-align: ${v}`],
  },
  color: {
    group: "color",
    values: names(STYLE_TEXT_COLOURS),
    css: one("color", STYLE_TEXT_COLOURS),
  },
  tone: {
    group: "tone",
    values: names(STYLE_TONES),
    css: (v) => {
      const tone = STYLE_TONES[v as StyleTone];
      return [
        `background-color: ${tone.background}`,
        `color: ${tone.color}`,
        // An outline is its line: a rule may still set the width and colour.
        ...(v === "outline" ? ["border: 1px solid currentColor"] : []),
      ];
    },
  },
  fill: {
    group: "fill",
    values: names(STYLE_FILLS),
    css: one("background-color", STYLE_FILLS),
  },
  borderWidth: {
    group: "border",
    values: BORDER_WIDTHS,
    css: (v) => [`border-width: ${v}px`, "border-style: solid"],
  },
  borderTopWidth: {
    group: "edge",
    values: BORDER_WIDTHS,
    css: (v) => [`border-top-width: ${v}px`, "border-top-style: solid"],
  },
  borderBottomWidth: {
    group: "edge",
    values: BORDER_WIDTHS,
    css: (v) => [`border-bottom-width: ${v}px`, "border-bottom-style: solid"],
  },
  borderStyle: {
    group: "edge",
    baseOnly: true,
    values: ["solid", "dashed", "dotted", "double"],
    // After the widths in every rule, so it restyles the lines they drew.
    css: (v) => [`border-style: ${v}`],
  },
  borderColor: {
    group: "edge",
    values: names(STYLE_BORDER_COLOURS),
    css: one("border-color", STYLE_BORDER_COLOURS),
  },
  borderRadius: {
    group: "shape",
    baseOnly: true,
    values: names(STYLE_RADII),
    css: one("border-radius", STYLE_RADII),
  },
  boxShadow: {
    group: "shadow",
    values: names(STYLE_SHADOWS),
    css: one("box-shadow", STYLE_SHADOWS),
  },
  padding: {
    group: "space",
    baseOnly: true,
    values: SPACE_ORDER,
    css: one("padding", STYLE_SPACES),
  },
  paddingBlock: {
    group: "space",
    baseOnly: true,
    values: SPACE_ORDER,
    css: one("padding-block", STYLE_SPACES),
  },
  paddingInline: {
    group: "space",
    baseOnly: true,
    values: SPACE_ORDER,
    css: one("padding-inline", STYLE_SPACES),
  },
  gap: {
    group: "gap",
    baseOnly: true,
    values: SPACE_ORDER,
    css: one("gap", STYLE_SPACES),
  },
  rowGap: {
    group: "gap",
    baseOnly: true,
    values: SPACE_ORDER,
    css: one("row-gap", STYLE_SPACES),
  },
  columnGap: {
    group: "gap",
    baseOnly: true,
    values: SPACE_ORDER,
    css: one("column-gap", STYLE_SPACES),
  },
  marginBlockEnd: {
    group: "below",
    baseOnly: true,
    values: SPACE_ORDER,
    css: one("margin-block-end", STYLE_SPACES),
  },
  objectPosition: {
    group: "media",
    baseOnly: true,
    values: ["center", "top", "bottom"],
    css: (v) => [`object-position: ${v}`],
  },
  filter: {
    group: "media",
    values: names(STYLE_FILTERS),
    css: one("filter", STYLE_FILTERS),
  },
  mixBlendMode: {
    group: "media",
    baseOnly: true,
    values: ["normal", "multiply"],
    css: (v) => [`mix-blend-mode: ${v}`],
  },
  opacity: {
    group: "motion",
    stateOnly: true,
    values: HOVER_OPACITIES,
    css: (v) => [`opacity: ${v}`],
  },
  transform: {
    group: "motion",
    stateOnly: true,
    values: names(STYLE_TRANSFORMS),
    css: one("transform", STYLE_TRANSFORMS),
  },
  transition: {
    group: "motion",
    baseOnly: true,
    values: names(STYLE_TRANSITIONS),
    css: (v) =>
      v === "none"
        ? ["transition: none"]
        : [
            `transition-property: ${TRANSITION_PROPERTIES}`,
            `transition-duration: ${STYLE_TRANSITIONS[v as keyof typeof STYLE_TRANSITIONS]}`,
            "transition-timing-function: ease",
          ],
  },
};

/** Compiled in this order whatever order a rule wrote them in, so the output
 *  is the same for the same rule and a style always follows its widths. */
const PROPERTY_ORDER = Object.keys(STYLE_PROPERTIES);
/** Declarations that only apply where motion is welcome. */
const MOTION_PROPERTIES: readonly string[] = ["transform", "transition"];

const KIND_GROUPS: Record<StyleHookKind, readonly PropertyGroup[]> = {
  text: ["type", "align", "color", "below"],
  label: [
    "type",
    "tone",
    "border",
    "edge",
    "shape",
    "shadow",
    "space",
    "motion",
  ],
  box: [
    "fill",
    "border",
    "edge",
    "shape",
    "shadow",
    "space",
    "gap",
    "align",
    "motion",
  ],
  media: ["border", "edge", "shape", "shadow", "media", "motion"],
  band: ["edge"],
  grid: ["gap"],
};

/** A label is small: its padding stays small. A box may breathe. */
const SPACE_CEILING: Partial<Record<StyleHookKind, StyleSpace>> = {
  label: "xl",
  box: "2xl",
};

// ───────────────────────────────────────────────────────────────────────────
// The hook catalogue: every element a rule may name.
// ───────────────────────────────────────────────────────────────────────────

/** A surface text can sit on, as a palette key. */
type Surface = "cream" | "surface" | "tile";

interface HookDef {
  /** The storefront's own class or data hook, under the scope. */
  selector: string;
  kind: StyleHookKind;
  /** What a merchant would call it (the builder's read-only list). */
  label: string;
  /** Font sizes it may take, inclusive. */
  sizes?: readonly [StyleFontSize, StyleFontSize];
  /** The surfaces its text can sit on (for a text colour's contrast). */
  on?: readonly Surface[];
  /** Headings: WCAG's 3:1 for large text applies. */
  large?: boolean;
  /** The storefront owns its colour (copy over a photograph, the header over
   *  the opening picture, a section with its own dark and light). */
  ownsColour?: boolean;
  /** It can lie over a photograph, so it must paint its own background. */
  overPhoto?: boolean;
  /** It renders inside page sections, which may wear a colour scheme. */
  inSection?: boolean;
  /** A hover rule applies when THIS ancestor is hovered or focused within. */
  owner?: string;
  /** The box whose fill this text sits on, as a hook name. */
  within?: string;
  /** For a zoom on hover: the frame that must clip it. */
  frame?: string;
  /**
   * A root class under which the storefront owns this element's colours, so
   * a rule's colour and fill never apply there. The overlay product card
   * draws its name and price over the photograph in its own light text on a
   * dark fade: an ink name there would be ink on ink.
   */
  coloursOwnedUnder?: string;
  states?: readonly StyleState[];
}

interface HookBase {
  /** `[variant=…]`: the values and how the storefront marks them. */
  variants?: {
    values: readonly string[];
    /** A class on the storefront root (`sm-card-centered`). */
    root?: string;
    /** The element marked with its variant (`.home-hero.variant-split`);
     *  a part lives inside it. */
    self?: string;
  };
  /** "" is the base itself; other keys are its parts. */
  parts: Readonly<Record<string, HookDef>>;
}

const INTERACTIVE: readonly StyleState[] = ["hover", "focus-visible", "active"];
const HOVERS: readonly StyleState[] = ["hover"];
const NOT_DISABLED = ':not(:disabled):not([aria-disabled="true"])';
const PAGE: readonly Surface[] = ["cream"];
const OVERLAY_CARD = "sm-card-overlay";
const CARD: readonly Surface[] = ["cream", "surface", "tile"];

export const STYLE_HOOKS: Readonly<Record<string, HookBase>> = {
  section: {
    parts: {
      "": { selector: ".home-section", kind: "band", label: "Page section" },
      head: {
        selector: ".home-section-head",
        kind: "box",
        label: "Section heading block",
        inSection: true,
      },
      title: {
        selector: ".home-section-title",
        kind: "text",
        label: "Section heading",
        sizes: ["xl", "4xl"],
        on: PAGE,
        large: true,
        inSection: true,
        within: "section.head",
      },
      eyebrow: {
        selector: ".home-section-eyebrow",
        kind: "text",
        label: "Section eyebrow",
        sizes: ["xs", "base"],
        on: PAGE,
        inSection: true,
        within: "section.head",
      },
      sub: {
        selector: ".home-section-sub",
        kind: "text",
        label: "Section sub-heading",
        sizes: ["sm", "lg"],
        on: PAGE,
        inSection: true,
        within: "section.head",
      },
    },
  },
  hero: {
    variants: {
      values: ["banner", "split", "minimal", "fullbleed", "stacked", "offset"],
      self: ".home-hero.variant-",
    },
    parts: {
      heading: {
        selector: ".home-hero-heading",
        kind: "text",
        label: "Hero heading",
        sizes: ["2xl", "6xl"],
        ownsColour: true,
      },
      sub: {
        selector: ".home-hero-sub",
        kind: "text",
        label: "Hero sub-heading",
        sizes: ["sm", "xl"],
        ownsColour: true,
      },
      badge: {
        selector: ".home-hero-badge",
        kind: "label",
        label: "Hero badge",
        sizes: ["xs", "base"],
        overPhoto: true,
      },
      media: {
        selector: ".home-hero-img",
        kind: "media",
        label: "Hero photograph",
      },
    },
  },
  carousel: {
    parts: {
      heading: {
        selector: ".home-carousel-heading",
        kind: "text",
        label: "Slideshow heading",
        sizes: ["2xl", "6xl"],
        ownsColour: true,
      },
      sub: {
        selector: ".home-carousel-sub",
        kind: "text",
        label: "Slideshow sub-heading",
        sizes: ["sm", "xl"],
        ownsColour: true,
      },
    },
  },
  button: {
    parts: {
      primary: {
        selector: `.sm-btn-primary${NOT_DISABLED}`,
        kind: "label",
        label: "Main button",
        sizes: ["xs", "lg"],
        overPhoto: true,
        states: INTERACTIVE,
      },
      secondary: {
        selector: `.sm-btn-secondary${NOT_DISABLED}`,
        kind: "label",
        label: "Second button",
        sizes: ["xs", "lg"],
        overPhoto: true,
        states: INTERACTIVE,
      },
    },
  },
  "product-card": {
    variants: {
      values: [
        "classic",
        "quick_add",
        "overlay",
        "framed",
        "grocery",
        "centered",
        "soft",
        "wide",
      ],
      root: "sm-card-",
    },
    parts: {
      "": {
        selector: ".shop-card",
        coloursOwnedUnder: OVERLAY_CARD,
        kind: "box",
        label: "Product card",
        states: HOVERS,
      },
      frame: {
        selector: ".shop-card-img",
        kind: "media",
        label: "Product card photo frame",
      },
      image: {
        selector: ".shop-card-img-el",
        kind: "media",
        label: "Product card photo",
        owner: ".shop-card",
        frame: ".shop-card-img",
        states: HOVERS,
      },
      body: {
        selector: ".shop-card-body",
        kind: "box",
        label: "Product card text block",
      },
      title: {
        selector: ".shop-card-name",
        coloursOwnedUnder: OVERLAY_CARD,
        kind: "text",
        label: "Product name on a card",
        sizes: ["xs", "xl"],
        on: CARD,
        within: "product-card",
      },
      price: {
        selector: ".shop-card-current",
        coloursOwnedUnder: OVERLAY_CARD,
        kind: "text",
        label: "Price on a card",
        sizes: ["xs", "xl"],
        on: CARD,
        within: "product-card",
      },
      category: {
        selector: ".shop-card-cat",
        coloursOwnedUnder: OVERLAY_CARD,
        kind: "text",
        label: "Category on a card",
        sizes: ["xs", "sm"],
        on: CARD,
        within: "product-card",
      },
      flag: {
        selector: ".shop-card-flag",
        kind: "label",
        label: "Card badge",
        sizes: ["xs", "sm"],
        overPhoto: true,
      },
    },
  },
  category: {
    parts: {
      "": {
        selector: ".home-cat-tile",
        kind: "box",
        label: "Category tile",
        inSection: true,
        states: HOVERS,
      },
      frame: {
        selector: ".home-cat-img",
        kind: "media",
        label: "Category photo frame",
      },
      image: {
        selector: ".home-cat-img-el",
        kind: "media",
        label: "Category photo",
        owner: ".home-cat-tile",
        frame: ".home-cat-img",
        states: HOVERS,
      },
      name: {
        selector: ".home-cat-name",
        kind: "text",
        label: "Category name",
        sizes: ["xs", "xl"],
        on: PAGE,
        inSection: true,
        within: "category",
      },
    },
  },
  tile: {
    parts: {
      "": {
        selector: ".home-tile",
        kind: "media",
        label: "Photo tile",
        states: HOVERS,
      },
      image: {
        selector: ".home-tile-img",
        kind: "media",
        label: "Photo tile picture",
        owner: ".home-tile",
        frame: ".home-tile",
        states: HOVERS,
      },
      title: {
        selector: ".home-tile-title",
        kind: "text",
        label: "Photo tile heading",
        sizes: ["lg", "3xl"],
        ownsColour: true,
      },
      sub: {
        selector: ".home-tile-sub",
        kind: "text",
        label: "Photo tile line",
        sizes: ["xs", "lg"],
        ownsColour: true,
      },
    },
  },
  banner: {
    parts: {
      heading: {
        selector: ".home-banner-heading",
        kind: "text",
        label: "Banner heading",
        sizes: ["xl", "5xl"],
        ownsColour: true,
      },
      sub: {
        selector: ".home-banner-subtext",
        kind: "text",
        label: "Banner line",
        sizes: ["sm", "xl"],
        ownsColour: true,
      },
    },
  },
  story: {
    parts: {
      heading: {
        selector: ".home-media-text-heading",
        kind: "text",
        label: "Story heading",
        sizes: ["lg", "4xl"],
        on: PAGE,
        large: true,
        inSection: true,
      },
      body: {
        selector: ".home-media-text-body",
        kind: "text",
        label: "Story text",
        sizes: ["sm", "lg"],
        on: PAGE,
        inSection: true,
      },
      image: {
        selector: ".home-media-text-image",
        kind: "media",
        label: "Story photograph",
      },
    },
  },
  testimonial: {
    parts: {
      "": {
        selector: ".home-testimonial",
        kind: "box",
        label: "Review card",
        inSection: true,
      },
      quote: {
        selector: ".home-testimonial-quote",
        kind: "text",
        label: "Review words",
        sizes: ["base", "2xl"],
        on: PAGE,
        inSection: true,
        within: "testimonial",
      },
      attribution: {
        selector: ".home-testimonial-attribution",
        kind: "text",
        label: "Review name",
        sizes: ["xs", "base"],
        on: PAGE,
        inSection: true,
        within: "testimonial",
      },
    },
  },
  column: {
    parts: {
      "": {
        selector: ".home-multicolumn-item",
        kind: "box",
        label: "Column",
        inSection: true,
      },
      heading: {
        selector: ".home-multicolumn-heading",
        kind: "text",
        label: "Column heading",
        sizes: ["base", "2xl"],
        on: PAGE,
        inSection: true,
        within: "column",
      },
    },
  },
  accordion: {
    parts: {
      item: {
        selector: ".home-accordion-item, .home-faq-item",
        kind: "box",
        label: "Question row",
        inSection: true,
      },
      question: {
        selector: ".home-accordion-q, .home-faq-q",
        kind: "text",
        label: "Question",
        sizes: ["sm", "xl"],
        on: PAGE,
        inSection: true,
        within: "accordion.item",
      },
    },
  },
  gallery: {
    parts: {
      image: {
        selector: ".home-gallery-image",
        kind: "media",
        label: "Gallery photograph",
      },
      caption: {
        selector: ".home-gallery-caption",
        kind: "text",
        label: "Gallery caption",
        sizes: ["xs", "base"],
        on: PAGE,
        inSection: true,
      },
    },
  },
  newsletter: {
    parts: {
      heading: {
        selector: ".home-newsletter-heading",
        kind: "text",
        label: "Newsletter heading",
        sizes: ["lg", "4xl"],
        ownsColour: true,
      },
    },
  },
  usp: {
    parts: {
      title: {
        selector: ".home-usp-title",
        kind: "text",
        label: "Promise bar line",
        sizes: ["xs", "lg"],
        ownsColour: true,
      },
    },
  },
  ticker: {
    parts: {
      item: {
        selector: ".home-ticker-item",
        kind: "text",
        label: "Ticker line",
        sizes: ["xs", "lg"],
        ownsColour: true,
      },
    },
  },
  announcement: {
    parts: {
      "": {
        selector: '[data-sm="announcement"]',
        kind: "text",
        label: "Announcement bar",
        sizes: ["xs", "sm"],
        ownsColour: true,
      },
    },
  },
  header: {
    variants: {
      values: [
        "classic",
        "market",
        "centered",
        "minimal",
        "transparent",
        "hamburger",
        "stacked",
        "utility",
      ],
      root: "sm-header-",
    },
    parts: {
      brand: {
        selector: '[data-sm="header-brand"]',
        kind: "text",
        label: "Store name in the header",
        sizes: ["base", "2xl"],
        ownsColour: true,
      },
      "nav-link": {
        selector: '[data-sm="nav-link"]',
        kind: "text",
        label: "Menu link",
        sizes: ["xs", "base"],
        ownsColour: true,
      },
    },
  },
  footer: {
    variants: {
      values: ["rich", "minimal", "editorial", "centered", "compact"],
      root: "sm-footer-",
    },
    parts: {
      heading: {
        selector: '[data-sm="footer-heading"]',
        kind: "text",
        label: "Footer column heading",
        sizes: ["xs", "lg"],
        ownsColour: true,
      },
      link: {
        selector: '[data-sm="footer-links"] a',
        kind: "text",
        label: "Footer link",
        sizes: ["xs", "base"],
        ownsColour: true,
      },
    },
  },
  product: {
    variants: {
      values: ["classic", "grocery", "editorial", "stacked"],
      root: "sm-pdp-",
    },
    parts: {
      title: {
        selector: ".pdp-name",
        kind: "text",
        label: "Product name on its page",
        sizes: ["xl", "4xl"],
        on: PAGE,
        large: true,
      },
      price: {
        selector: ".pdp-price-sell",
        kind: "text",
        label: "Price on the product page",
        sizes: ["lg", "3xl"],
        on: PAGE,
      },
      category: {
        selector: ".pdp-category",
        kind: "text",
        label: "Category on the product page",
        sizes: ["xs", "sm"],
        on: PAGE,
      },
      frame: {
        selector: ".sm-gallery-frame",
        kind: "media",
        label: "Product photo frame",
      },
      row: {
        selector: ".pdp-accordion-row",
        kind: "band",
        label: "Product details row",
      },
    },
  },
  collection: {
    parts: {
      title: {
        selector: ".shop-title, .shop-collection-title",
        kind: "text",
        label: "Collection title",
        sizes: ["xl", "5xl"],
        on: PAGE,
        large: true,
      },
      subtitle: {
        selector: ".shop-collection-desc",
        kind: "text",
        label: "Collection description",
        sizes: ["sm", "lg"],
        on: PAGE,
      },
      toolbar: {
        selector: ".shop-toolbar",
        kind: "band",
        label: "Sort and filter bar",
      },
      grid: { selector: ".shop-grid", kind: "grid", label: "Product grid" },
    },
  },
};

export interface ResolvedHook {
  base: string;
  part: string;
  variant: string | null;
  def: HookDef;
  /** The hook without its variant filter: "product-card.title". */
  plain: string;
}

const HOOK_PATTERN =
  /^([a-z][a-z-]*)(?:\[variant=([a-z_]+)\])?(?:\.([a-z][a-z-]*))?$/;

/** A hook name, checked against the catalogue. Null when it names nothing. */
export function resolveStyleHook(hook: unknown): ResolvedHook | null {
  if (typeof hook !== "string" || hook.length > 80) return null;
  const match = HOOK_PATTERN.exec(hook);
  if (!match) return null;
  const [, base, variant, part = ""] = match;
  const known = Object.hasOwn(STYLE_HOOKS, base) ? STYLE_HOOKS[base] : null;
  if (!known || !Object.hasOwn(known.parts, part)) return null;
  if (variant !== undefined && !known.variants?.values.includes(variant))
    return null;
  return {
    base,
    part,
    variant: variant ?? null,
    def: known.parts[part],
    plain: part ? `${base}.${part}` : base,
  };
}

/** Every plain hook name, for prompts, the builder's list and tests. */
export function styleHookNames(): string[] {
  return Object.entries(STYLE_HOOKS).flatMap(([base, def]) =>
    Object.keys(def.parts).map((part) => (part ? `${base}.${part}` : base)),
  );
}

/** The properties a hook may take, in compile order. */
export function allowedProperties(def: HookDef): string[] {
  const groups = KIND_GROUPS[def.kind];
  return PROPERTY_ORDER.filter((name) => {
    const spec = STYLE_PROPERTIES[name];
    if (!groups.includes(spec.group)) return false;
    if (spec.group === "color" && def.ownsColour) return false;
    if (spec.group === "motion" && name !== "transition" && !def.states?.length)
      return false;
    return true;
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Validation
// ───────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function channel(hex: string, at: number): number {
  return parseInt(hex.slice(at, at + 2), 16) / 255;
}
function luminance(hex: string): number {
  const parts = [channel(hex, 1), channel(hex, 3), channel(hex, 5)].map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
}
const HEX = /^#[0-9a-fA-F]{6}$/;
/** WCAG contrast, or null when either colour is not a 6-digit hex. */
function contrast(a: string | undefined, b: string | undefined): number | null {
  if (!a || !b || !HEX.test(a) || !HEX.test(b)) return null;
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

export const STYLE_TEXT_CONTRAST = 4.5;
export const STYLE_LARGE_TEXT_CONTRAST = 3;

export interface StylesheetContext {
  /** The theme's design, for the colour checks. Without it only the
   *  vocabulary is checked (a merchant palette is checked in the browser). */
  design?: Pick<ThemeDesign, "palette" | "schemes">;
  brandPrimary?: string;
}

const ruleKey = (rule: { hook: string; state?: unknown; viewport?: unknown }) =>
  `${rule.hook}|${rule.state ?? ""}|${rule.viewport ?? ""}`;

/** What is wrong with ONE rule's own shape and vocabulary. */
function ruleShapeIssues(raw: unknown, at: string): string[] {
  if (!isRecord(raw)) return [`${at} must be an object.`];
  const issues: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!["hook", "state", "viewport", "declarations"].includes(key))
      issues.push(`${at}.${key} is not a rule field.`);
  }
  const hook = resolveStyleHook(raw.hook);
  if (!hook) {
    issues.push(
      `${at}.hook ${JSON.stringify(raw.hook)} is not in the hook catalogue.`,
    );
    return issues;
  }
  const { def } = hook;
  if (raw.state !== undefined) {
    if (!STYLE_STATES.includes(raw.state as StyleState))
      issues.push(`${at}.state must be one of ${STYLE_STATES.join(", ")}.`);
    else if (!def.states?.includes(raw.state as StyleState))
      issues.push(
        def.states?.length
          ? `${at}.state: ${hook.plain} only takes ${def.states.join(", ")}.`
          : `${at}.state: ${hook.plain} takes no state rule.`,
      );
  }
  if (
    raw.viewport !== undefined &&
    !STYLE_VIEWPORTS.includes(raw.viewport as StyleViewport)
  )
    issues.push(`${at}.viewport must be one of ${STYLE_VIEWPORTS.join(", ")}.`);
  if (!isRecord(raw.declarations)) {
    issues.push(`${at}.declarations must be an object.`);
    return issues;
  }
  const entries = Object.entries(raw.declarations);
  if (entries.length === 0) issues.push(`${at}.declarations is empty.`);
  if (entries.length > STYLESHEET_MAX_DECLARATIONS)
    issues.push(
      `${at}.declarations has more than ${STYLESHEET_MAX_DECLARATIONS} entries.`,
    );
  const allowed = allowedProperties(def);
  const inState = raw.state !== undefined;
  for (const [name, value] of entries) {
    const where = `${at}.declarations.${name}`;
    const spec = Object.hasOwn(STYLE_PROPERTIES, name)
      ? STYLE_PROPERTIES[name]
      : null;
    if (!spec) {
      issues.push(`${where} is not a style property.`);
      continue;
    }
    if (!allowed.includes(name)) {
      issues.push(
        `${where}: ${hook.plain} (${def.kind}) takes only ${allowed.join(", ")}.`,
      );
      continue;
    }
    if (spec.stateOnly && !inState) {
      issues.push(`${where} is only allowed in a hover, focus or active rule.`);
      continue;
    }
    if (spec.baseOnly && inState) {
      issues.push(`${where} is not allowed in a state rule.`);
      continue;
    }
    if (!spec.values.includes(value as StyleValue)) {
      issues.push(
        `${where} ${JSON.stringify(value)} must be one of ${spec.values.map((v) => JSON.stringify(v)).join(", ")}.`,
      );
      continue;
    }
    if (name === "fontSize" && def.sizes) {
      const [min, max] = def.sizes;
      const step = FONT_SIZE_ORDER.indexOf(value as StyleFontSize);
      if (
        step < FONT_SIZE_ORDER.indexOf(min) ||
        step > FONT_SIZE_ORDER.indexOf(max)
      )
        issues.push(
          `${where} "${value}": ${hook.plain} takes ${min} to ${max}.`,
        );
    }
    if (spec.group === "space") {
      const ceiling = SPACE_CEILING[def.kind];
      if (
        ceiling &&
        SPACE_ORDER.indexOf(value as StyleSpace) > SPACE_ORDER.indexOf(ceiling)
      )
        issues.push(
          `${where} "${value}": ${hook.plain} takes at most "${ceiling}".`,
        );
    }
    if (
      name === "tone" &&
      def.overPhoto &&
      SEE_THROUGH_TONES.includes(String(value))
    )
      issues.push(
        `${where} "${value}": ${hook.plain} can lie over a photograph, so it needs a tone with a background (ink, accent, surface, page, soft or sand).`,
      );
    if (
      (spec.group === "color" || spec.group === "fill") &&
      def.coloursOwnedUnder &&
      hook.variant &&
      `${STYLE_HOOKS[hook.base].variants?.root ?? ""}${hook.variant}` ===
        def.coloursOwnedUnder
    )
      issues.push(
        `${where}: the ${hook.variant} layout draws ${hook.plain} over the photograph in its own colours, so it takes no ${name} there.`,
      );
    if (name === "transform" && value === "zoom" && def.kind !== "media")
      issues.push(`${where} "zoom" is for photographs only.`);
  }
  return issues;
}

/** The fill each box hook is given by the base rules (no state, no viewport
 *  filter counts too: a phone-only fill is still a surface text can sit on). */
function fillsByHook(
  rules: readonly ThemeStyleRule[],
): Map<string, Set<string>> {
  const fills = new Map<string, Set<string>>();
  for (const rule of rules) {
    const fill = rule.declarations.fill;
    const hook = resolveStyleHook(rule.hook);
    if (!hook || typeof fill !== "string" || fill === "none") continue;
    const set = fills.get(hook.plain) ?? new Set<string>();
    set.add(fill);
    fills.set(hook.plain, set);
  }
  return fills;
}

const FILL_PALETTE: Record<string, keyof ThemeDesign["palette"]> = {
  surface: "surface",
  page: "cream",
  soft: "creamDeep",
  sand: "sand",
  tile: "tile",
};
const TONE_PALETTE: Record<
  string,
  [keyof ThemeDesign["palette"] | "accent", keyof ThemeDesign["palette"]]
> = {
  ink: ["ink", "onInk"],
  accent: ["accent", "onAccent"],
  surface: ["surface", "ink"],
  page: ["cream", "ink"],
  soft: ["creamDeep", "ink"],
  sand: ["sand", "ink"],
};

/** What is wrong with one (shape-valid) rule's COLOURS in this theme. */
function ruleColourIssues(
  rule: ThemeStyleRule,
  at: string,
  rules: readonly ThemeStyleRule[],
  context: StylesheetContext,
): string[] {
  const design = context.design;
  const hook = resolveStyleHook(rule.hook);
  if (!design || !hook) return [];
  const palette = design.palette;
  const accent = palette.accent ?? context.brandPrimary;
  const hex = (key: keyof ThemeDesign["palette"] | "accent") =>
    key === "accent" ? accent : (palette[key] as string | undefined);
  const issues: string[] = [];
  const say = (
    property: string,
    value: unknown,
    ratio: number | null,
    floor: number,
    what: string,
  ) => {
    if (ratio !== null && ratio >= floor) return;
    issues.push(
      ratio === null
        ? `${at}.declarations.${property} "${value}" cannot be checked: ${what} is not a 6-digit hex in this palette.`
        : `${at}.declarations.${property} "${value}" reads at ${ratio.toFixed(2)}:1 ${what}; it needs ${floor}:1. Choose another value or change the palette.`,
    );
  };

  const tone = rule.declarations.tone;
  if (typeof tone === "string" && Object.hasOwn(TONE_PALETTE, tone)) {
    const [bg, fg] = TONE_PALETTE[tone];
    say(
      "tone",
      tone,
      contrast(hex(bg), hex(fg)),
      STYLE_TEXT_CONTRAST,
      "as text on its own background",
    );
  }

  const fill = rule.declarations.fill;
  if (typeof fill === "string" && Object.hasOwn(FILL_PALETTE, fill)) {
    const surface = hex(FILL_PALETTE[fill]);
    // Everything inside the box is ink or soft ink.
    say(
      "fill",
      fill,
      contrast(surface, palette.ink),
      STYLE_TEXT_CONTRAST,
      "against the theme's text colour",
    );
    say(
      "fill",
      fill,
      contrast(surface, palette.inkSoft),
      STYLE_TEXT_CONTRAST,
      "against the theme's soft text colour",
    );
  }

  const colour = rule.declarations.color;
  if (typeof colour === "string" && colour !== "ink") {
    const floor = hook.def.large
      ? STYLE_LARGE_TEXT_CONTRAST
      : STYLE_TEXT_CONTRAST;
    const text =
      colour === "accent" ? accent : (palette.inkSoft as string | undefined);
    const surfaces = new Map<string, string | undefined>();
    for (const key of hook.def.on ?? PAGE) surfaces.set(key, palette[key]);
    const fills = hook.def.within
      ? fillsByHook(rules).get(hook.def.within)
      : undefined;
    for (const name of fills ?? [])
      surfaces.set(`the ${name} fill`, hex(FILL_PALETTE[name]));
    for (const [name, surface] of surfaces)
      say(
        "color",
        colour,
        contrast(text, surface),
        floor,
        `on ${name.startsWith("the ") ? name : `the theme's ${name} colour`}`,
      );
    // Inside a section's colour scheme the tokens are re-pointed.
    if (hook.def.inSection && context.brandPrimary) {
      for (const id of SECTION_SCHEMES) {
        let scheme: ReturnType<typeof resolveScheme>;
        try {
          scheme = resolveScheme(id, design, accent ?? context.brandPrimary);
        } catch {
          // A palette too broken to derive a band from is reported by the
          // palette's own checks.
          continue;
        }
        say(
          "color",
          colour,
          contrast(
            colour === "accent" ? scheme.accent : scheme.textSoft,
            scheme.background,
          ),
          floor,
          `inside a "${id}" section band`,
        );
      }
    }
  }
  return issues;
}

/**
 * The strict report: everything a stylesheet gets wrong, as written. An empty
 * list means it compiles, stays inside the storefront and reads.
 */
export function stylesheetIssues(
  raw: unknown,
  context: StylesheetContext = {},
  root = "definition.preset.stylesheet",
): string[] {
  if (!Array.isArray(raw)) return [`${root} must be a list of rules.`];
  const issues: string[] = [];
  if (raw.length > STYLESHEET_MAX_RULES)
    issues.push(`${root} has more than ${STYLESHEET_MAX_RULES} rules.`);
  const sound: ThemeStyleRule[] = [];
  const soundAt: string[] = [];
  const seen = new Map<string, number>();
  raw.slice(0, STYLESHEET_MAX_RULES).forEach((rule, index) => {
    const at = `${root}[${index}]`;
    const own = ruleShapeIssues(rule, at);
    issues.push(...own);
    if (own.length) return;
    const typed = rule as ThemeStyleRule;
    const key = ruleKey(typed);
    const first = seen.get(key);
    if (first !== undefined) {
      issues.push(
        `${at} repeats rule ${first} (same hook, state and viewport); merge them.`,
      );
      return;
    }
    seen.set(key, index);
    sound.push(typed);
    soundAt.push(at);
  });
  sound.forEach((rule, index) =>
    issues.push(...ruleColourIssues(rule, soundAt[index], sound, context)),
  );
  if (!issues.length) {
    const bytes = new TextEncoder().encode(compileStylesheet(sound)).length;
    if (bytes > STYLESHEET_MAX_BYTES)
      issues.push(
        `${root} compiles to ${bytes} bytes; the limit is ${STYLESHEET_MAX_BYTES}.`,
      );
  }
  return issues;
}

/**
 * The rules that can be kept from a stylesheet that has faults: every rule
 * with a fault of its own is dropped, then any rule whose colours no longer
 * read against what is left. Used where failing the whole theme over its
 * styling would be worse than shipping it with fewer rules (the Studio's last
 * repair attempt, a stored package read on a newer build).
 */
export function salvageStylesheet(
  raw: unknown,
  context: StylesheetContext = {},
): { rules: ThemeStyleRule[]; dropped: number } {
  if (!Array.isArray(raw)) return { rules: [], dropped: 0 };
  const seen = new Set<string>();
  let rules: ThemeStyleRule[] = [];
  for (const rule of raw.slice(0, STYLESHEET_MAX_RULES)) {
    if (ruleShapeIssues(rule, "rule").length) continue;
    const typed = normalizeRule(rule as ThemeStyleRule);
    const key = ruleKey(typed);
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(typed);
  }
  // A dropped fill can only remove a surface, never add one, so one pass
  // settles; the loop is the proof rather than the need.
  for (;;) {
    const kept = rules.filter(
      (rule) => !ruleColourIssues(rule, "rule", rules, context).length,
    );
    if (kept.length === rules.length) break;
    rules = kept;
  }
  while (
    rules.length &&
    new TextEncoder().encode(compileStylesheet(rules)).length >
      STYLESHEET_MAX_BYTES
  )
    rules = rules.slice(0, -1);
  return { rules, dropped: raw.length - rules.length };
}

/** A rule with its keys in one fixed order, so a stored stylesheet and the
 *  same one read back from jsonb compare equal. */
function normalizeRule(rule: ThemeStyleRule): ThemeStyleRule {
  return {
    hook: rule.hook,
    ...(rule.state ? { state: rule.state } : {}),
    ...(rule.viewport ? { viewport: rule.viewport } : {}),
    declarations: Object.fromEntries(
      PROPERTY_ORDER.filter((name) =>
        Object.hasOwn(rule.declarations, name),
      ).map((name) => [name, rule.declarations[name]]),
    ),
  };
}

/** A valid stylesheet in its canonical form (see `normalizeRule`). */
export function normalizeStylesheet(
  rules: readonly ThemeStyleRule[],
): ThemeStyleRule[] {
  return rules.map(normalizeRule);
}

// ───────────────────────────────────────────────────────────────────────────
// Compilation
// ───────────────────────────────────────────────────────────────────────────

/** The CSS selector(s) for one rule, each under the scope. */
function selectorsFor(
  rule: ThemeStyleRule,
  hook: ResolvedHook,
  /** A root class these declarations must not apply under. */
  except?: string,
): string[] {
  const base = STYLE_HOOKS[hook.base];
  const variants = base.variants;
  const scope =
    (hook.variant && variants?.root
      ? `${SCOPE}.${variants.root}${hook.variant}`
      : SCOPE) + (except ? `:not(.${except})` : "");
  // A part of a self-marked base lives inside the marked element.
  const inside =
    hook.variant && variants?.self ? `${variants.self}${hook.variant} ` : "";
  return hook.def.selector.split(",").flatMap((piece) => {
    const element = piece.trim();
    if (!rule.state) return [`${scope} ${inside}${element}`];
    if (hook.def.owner) {
      // The card is what is hovered; the photo inside it is what moves.
      return [
        `${scope} ${inside}${hook.def.owner}:hover ${element}`,
        `${scope} ${inside}${hook.def.owner}:focus-within ${element}`,
      ];
    }
    return [`${scope} ${inside}${element}:${rule.state}`];
  });
}

/**
 * The stylesheet as CSS, every selector under the storefront root. The same
 * rules always compile to the same text, so it can be cached by its digest.
 * ★ Call it only with rules `stylesheetIssues` passed; a rule that names an
 *   unknown hook, property or value is skipped, never guessed at.
 */
export function compileStylesheet(rules: readonly ThemeStyleRule[]): string {
  const plain: string[] = [];
  const motion: string[] = [];
  const byViewport = new Map<
    StyleViewport,
    { plain: string[]; motion: string[] }
  >();
  const hover: string[] = [];
  const hoverMotion: string[] = [];
  const clip = new Set<string>();

  // Base rules first, then viewport rules, then state rules: a state wins
  // over the rest of its element's styling whatever order they were written.
  const ordered = [...rules].sort(
    (a, b) =>
      Number(!!a.state) - Number(!!b.state) ||
      Number(!!a.viewport) - Number(!!b.viewport),
  );
  for (const rule of ordered) {
    const hook = resolveStyleHook(rule.hook);
    if (!hook || !isRecord(rule.declarations)) continue;
    // ★ A state and a viewport become part of a selector and a media query,
    //   so they are read from the closed lists here too, never trusted from
    //   the rule: this function may be handed rules nobody validated.
    if (rule.state !== undefined && !hook.def.states?.includes(rule.state))
      continue;
    if (rule.viewport !== undefined && !STYLE_VIEWPORTS.includes(rule.viewport))
      continue;
    const still: string[] = [];
    const moving: string[] = [];
    // Colours the storefront owns under one layout (`coloursOwnedUnder`).
    const colours: string[] = [];
    const variantClass = hook.variant
      ? `${STYLE_HOOKS[hook.base].variants?.root ?? ""}${hook.variant}`
      : "";
    for (const name of PROPERTY_ORDER) {
      if (!Object.hasOwn(rule.declarations, name)) continue;
      const spec = STYLE_PROPERTIES[name];
      const value = rule.declarations[name];
      if (!spec.values.includes(value)) continue;
      // The same placement rules validation holds, so an unvalidated rule
      // cannot, say, move a control outside a hover.
      if (spec.stateOnly && !rule.state) continue;
      if (spec.baseOnly && rule.state) continue;
      if (!allowedProperties(hook.def).includes(name)) continue;
      if (
        hook.def.coloursOwnedUnder &&
        (spec.group === "color" || spec.group === "fill")
      ) {
        // Asked for on that very layout: not compiled at all.
        if (variantClass !== hook.def.coloursOwnedUnder)
          colours.push(...spec.css(value));
        continue;
      }
      (MOTION_PROPERTIES.includes(name) ? moving : still).push(
        ...spec.css(value),
      );
      if (name === "transform" && value === "zoom" && hook.def.frame)
        clip.add(`${SCOPE} ${hook.def.frame}`);
    }
    const selector = selectorsFor(rule, hook).join(",\n");
    const block = (declarations: string[], under = selector) =>
      `${under} {\n${declarations.map((d) => `  ${d};`).join("\n")}\n}`;
    // A variant filter that is not the owning layout already excludes it.
    const colourBlock = colours.length
      ? block(
          colours,
          selectorsFor(
            rule,
            hook,
            hook.variant ? undefined : hook.def.coloursOwnedUnder,
          ).join(",\n"),
        )
      : null;
    const target = rule.viewport
      ? (byViewport.get(rule.viewport) ??
        byViewport
          .set(rule.viewport, { plain: [], motion: [] })
          .get(rule.viewport)!)
      : null;
    // A hover that sticks after a tap is a bug on a phone, so hover rules
    // apply only where there is a pointer that hovers.
    const isHover = rule.state === "hover";
    for (const made of [still.length ? block(still) : null, colourBlock]) {
      if (!made) continue;
      if (isHover && !target) hover.push(made);
      else if (target) target.plain.push(wrapHover(made, isHover));
      else plain.push(made);
    }
    if (moving.length) {
      if (isHover && !target) hoverMotion.push(block(moving));
      else if (target) target.motion.push(wrapHover(block(moving), isHover));
      else motion.push(block(moving));
    }
  }

  const out: string[] = [];
  if (clip.size)
    out.push(`${[...clip].sort().join(",\n")} {\n  overflow: hidden;\n}`);
  out.push(...plain);
  if (motion.length)
    out.push(media("(prefers-reduced-motion: no-preference)", motion));
  for (const viewport of STYLE_VIEWPORTS) {
    const group = byViewport.get(viewport);
    if (!group) continue;
    if (group.plain.length)
      out.push(media(VIEWPORT_MEDIA[viewport], group.plain));
    if (group.motion.length)
      out.push(
        media(
          `${VIEWPORT_MEDIA[viewport]} and (prefers-reduced-motion: no-preference)`,
          group.motion,
        ),
      );
  }
  if (hover.length) out.push(media("(hover: hover)", hover));
  if (hoverMotion.length)
    out.push(
      media(
        "(hover: hover) and (prefers-reduced-motion: no-preference)",
        hoverMotion,
      ),
    );
  return out.join("\n");
}

const COMPILED = new WeakMap<readonly ThemeStyleRule[], string>();

/**
 * The CSS for a theme's stored stylesheet, as the storefront serves it.
 * ★ Read through `salvageStylesheet` however it was stored: a rule this build
 *   no longer knows (a release authored on another build) is left out, never
 *   compiled on trust. Only the vocabulary is judged here; the colours were
 *   judged against the theme's palette when the release was made.
 * Cached per rules array, which a registered theme release keeps for its
 * lifetime.
 */
export function themeStylesheetCss(
  rules: readonly ThemeStyleRule[] | undefined,
): string {
  if (!Array.isArray(rules) || rules.length === 0) return "";
  let css = COMPILED.get(rules);
  if (css === undefined) {
    css = compileStylesheet(salvageStylesheet(rules).rules);
    COMPILED.set(rules, css);
  }
  return css;
}

function indent(block: string): string {
  return block
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
function media(query: string, blocks: string[]): string {
  return `@media ${query} {\n${blocks.map(indent).join("\n")}\n}`;
}
function wrapHover(block: string, isHover: boolean): string {
  return isHover ? media("(hover: hover)", [block]) : block;
}

// ───────────────────────────────────────────────────────────────────────────
// Reading a stylesheet as a design fact
// ───────────────────────────────────────────────────────────────────────────

/**
 * What a stylesheet says, as a set of "hook:property=value" facts with the
 * variant filter, state and viewport left out. Two themes are alike in their
 * styling to the degree these sets overlap (the catalogue fingerprint).
 */
export function stylesheetFacts(
  rules: readonly ThemeStyleRule[] | undefined,
): string[] {
  const facts = new Set<string>();
  for (const rule of rules ?? []) {
    const hook = resolveStyleHook(rule.hook);
    if (!hook || !isRecord(rule.declarations)) continue;
    const state = rule.state ? `:${rule.state}` : "";
    for (const [name, value] of Object.entries(rule.declarations))
      facts.add(`${hook.plain}${state}:${name}=${value}`);
  }
  return [...facts].sort();
}

/** 0 when two stylesheets say the same things, 1 when they share nothing.
 *  Two themes with no stylesheet at all are identical in this respect. */
export function stylesheetDistance(
  a: readonly ThemeStyleRule[] | undefined,
  b: readonly ThemeStyleRule[] | undefined,
): number {
  const [x, y] = [new Set(stylesheetFacts(a)), new Set(stylesheetFacts(b))];
  if (!x.size && !y.size) return 0;
  let shared = 0;
  for (const fact of x) if (y.has(fact)) shared += 1;
  return 1 - shared / (x.size + y.size - shared);
}

/** A plain sentence per rule, for the builder's read-only "Theme styles". */
export function describeStyleRule(rule: ThemeStyleRule): string {
  const hook = resolveStyleHook(rule.hook);
  const what = hook?.def.label ?? rule.hook;
  const when = [
    hook?.variant ? `${hook.variant.replace(/_/g, " ")} style` : "",
    rule.state === "hover"
      ? "on hover"
      : rule.state === "active"
        ? "when pressed"
        : rule.state === "focus-visible"
          ? "when focused"
          : "",
    rule.viewport ? `on ${rule.viewport}s` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const how = Object.entries(rule.declarations ?? {})
    .map(
      ([name, value]) =>
        `${name.replace(/([A-Z])/g, " $1").toLowerCase()} ${value}`,
    )
    .join("; ");
  return `${what}${when ? ` (${when})` : ""}: ${how}`;
}
