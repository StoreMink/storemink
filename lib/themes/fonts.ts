// ---------------------------------------------------------------------------
// The storefront's typefaces, in one place.
//
// ★ ONE CATALOGUE, EVERY CONSUMER DERIVES FROM IT: the merchant override
//   allowlist (`lib/chrome/design.ts` re-exports `DESIGN_FONTS`), the faux-bold
//   check (`typography.ts`), the Theme Studio Stage B schema and prompt, the
//   package contract, Mink's design reader and the builder's Type panel. Nine
//   faces used to live as nine hand-kept lists; a face added to one and not
//   another rendered the fallback stack with no error to explain why.
// ★ `app/layout.tsx` CANNOT derive from it: next/font/google runs at build
//   time and needs one static call per family. `fonts.test.ts` reads that file
//   and fails when the two disagree, which is the only way to keep a build-time
//   list and a runtime list the same.
// ★ A PAIRING IS THE UNIT STAGE B CHOOSES (plan Phase 2a). Two independent
//   font fields produced the same two or three faces on most themes (the
//   2026-10-04 variety audit: Plus Jakarta body on 4/7, Space Grotesk display
//   on 3/7); a curated display/body pair with moods and the directions it
//   suits is a choice the model can make deliberately and the fingerprint can
//   see. The package still stores two faces — a pairing is how they are
//   chosen, not a new storage shape.
// ★ Display-only faces (`body: false`) are refused as a BODY face: Bebas Neue
//   at 15px is not a reading face, whatever the brief says.
// ---------------------------------------------------------------------------

/** `next/font/google` fetches one file per style per family at build time;
 * the plan caps the catalogue so build time and CSS weight stay bounded. */
export const THEME_FONT_CAP = 32;

export const FONT_CATEGORIES = ["sans", "serif", "display", "mono"] as const;
export type FontCategory = (typeof FONT_CATEGORIES)[number];
export const FONT_CATEGORY_LABELS: Record<FontCategory, string> = {
  sans: "Sans serif",
  serif: "Serif",
  display: "Display",
  mono: "Monospace",
};

export interface ThemeFontFace {
  /** The key a design names (`fonts.body: "jost"`). Never changes. */
  key: string;
  /** The Google family, exactly as next/font's font data spells it. */
  family: string;
  /** The `next/font/google` export (`Space_Grotesk`). */
  export: string;
  /** The CSS variable `app/layout.tsx` declares. */
  variable: string;
  label: string;
  category: FontCategory;
  /** The weights really loaded: a variable face's whole axis, a static face's
   * list. What the faux-bold check reads. */
  range: { min: number; max: number };
  /** A static face lists the weights layout.tsx must declare; a variable
   * face declares none and loads its axis. */
  staticWeights: readonly number[] | null;
  /** Whether layout.tsx loads the italic style. */
  italic: boolean;
  /** Preloaded on every page (the platform's own look); everything else is
   * `preload: false` and fetched only by a store whose theme names it. */
  preloaded: boolean;
  /** Suited to body copy at reading sizes. */
  body: boolean;
  moods: readonly string[];
}

/** The nine original faces come FIRST, in the order `DESIGN_FONTS` always
 * listed them: prompt revisions before v25 enumerate exactly that list, and a
 * persisted paid request must keep its bytes (prompt-features.ts). */
export const THEME_FONT_FACES = [
  {
    key: "inter",
    family: "Inter",
    export: "Inter",
    variable: "--font-inter",
    label: "Inter",
    category: "sans",
    range: { min: 100, max: 900 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: true,
    moods: ["neutral", "modern", "trusted"],
  },
  {
    key: "fraunces",
    family: "Fraunces",
    export: "Fraunces",
    variable: "--font-fraunces",
    label: "Fraunces",
    category: "serif",
    range: { min: 100, max: 900 },
    staticWeights: null,
    italic: true,
    preloaded: false,
    body: true,
    moods: ["editorial", "warm", "expressive"],
  },
  {
    key: "spaceGrotesk",
    family: "Space Grotesk",
    export: "Space_Grotesk",
    variable: "--font-space-grotesk",
    label: "Space Grotesk",
    category: "sans",
    range: { min: 300, max: 700 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: true,
    moods: ["tech", "modern", "bold"],
  },
  {
    key: "jakarta",
    family: "Plus Jakarta Sans",
    export: "Plus_Jakarta_Sans",
    variable: "--font-jakarta",
    label: "Plus Jakarta Sans",
    category: "sans",
    range: { min: 200, max: 800 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: true,
    moods: ["friendly", "trusted", "general"],
  },
  {
    key: "jost",
    family: "Jost",
    export: "Jost",
    variable: "--font-jost",
    label: "Jost",
    category: "sans",
    range: { min: 300, max: 500 },
    staticWeights: [300, 400, 500],
    italic: false,
    preloaded: false,
    body: true,
    moods: ["geometric", "fashion", "minimal"],
  },
  {
    key: "instrumentSerif",
    family: "Instrument Serif",
    export: "Instrument_Serif",
    variable: "--font-instrument-serif",
    label: "Instrument Serif",
    category: "serif",
    range: { min: 400, max: 400 },
    staticWeights: [400],
    italic: false,
    preloaded: false,
    body: false,
    moods: ["editorial", "minimal", "fashion"],
  },
  {
    key: "outfit",
    family: "Outfit",
    export: "Outfit",
    variable: "--font-outfit",
    label: "Outfit",
    category: "sans",
    range: { min: 100, max: 900 },
    staticWeights: null,
    italic: false,
    preloaded: true,
    body: true,
    moods: ["friendly", "modern", "soft"],
  },
  {
    key: "roboto",
    family: "Roboto",
    export: "Roboto",
    variable: "--font-roboto",
    label: "Roboto",
    category: "sans",
    range: { min: 400, max: 700 },
    staticWeights: [400, 700],
    italic: false,
    preloaded: true,
    body: true,
    moods: ["neutral", "utility", "trusted"],
  },
  {
    key: "stickNoBills",
    family: "Stick No Bills",
    export: "Stick_No_Bills",
    variable: "--font-stick-no-bills",
    label: "Stick No Bills",
    category: "display",
    range: { min: 800, max: 800 },
    staticWeights: [800],
    italic: false,
    preloaded: true,
    body: false,
    moods: ["condensed", "bold", "loud"],
  },
  // ── Phase 2a additions ──────────────────────────────────────────────────
  {
    key: "playfairDisplay",
    family: "Playfair Display",
    export: "Playfair_Display",
    variable: "--font-playfair-display",
    label: "Playfair Display",
    category: "serif",
    range: { min: 400, max: 900 },
    staticWeights: null,
    italic: true,
    preloaded: false,
    body: false,
    moods: ["editorial", "boutique", "luxury"],
  },
  {
    key: "lora",
    family: "Lora",
    export: "Lora",
    variable: "--font-lora",
    label: "Lora",
    category: "serif",
    range: { min: 400, max: 700 },
    staticWeights: null,
    italic: true,
    preloaded: false,
    body: true,
    moods: ["warm", "bookish", "heritage"],
  },
  {
    key: "sourceSerif",
    family: "Source Serif 4",
    export: "Source_Serif_4",
    variable: "--font-source-serif",
    label: "Source Serif",
    category: "serif",
    range: { min: 200, max: 900 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: true,
    moods: ["reading", "classic", "trusted"],
  },
  {
    key: "cormorantGaramond",
    family: "Cormorant Garamond",
    export: "Cormorant_Garamond",
    variable: "--font-cormorant-garamond",
    label: "Cormorant Garamond",
    category: "serif",
    range: { min: 300, max: 700 },
    staticWeights: null,
    italic: true,
    preloaded: false,
    body: true,
    moods: ["luxury", "beauty", "refined"],
  },
  {
    key: "ebGaramond",
    family: "EB Garamond",
    export: "EB_Garamond",
    variable: "--font-eb-garamond",
    label: "EB Garamond",
    category: "serif",
    range: { min: 400, max: 800 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: true,
    moods: ["heritage", "bookish", "classic"],
  },
  {
    key: "newsreader",
    family: "Newsreader",
    export: "Newsreader",
    variable: "--font-newsreader",
    label: "Newsreader",
    category: "serif",
    range: { min: 200, max: 800 },
    staticWeights: null,
    italic: true,
    preloaded: false,
    body: true,
    moods: ["journal", "editorial", "press"],
  },
  {
    key: "bodoniModa",
    family: "Bodoni Moda",
    export: "Bodoni_Moda",
    variable: "--font-bodoni-moda",
    label: "Bodoni Moda",
    category: "serif",
    range: { min: 400, max: 900 },
    staticWeights: null,
    italic: true,
    preloaded: false,
    body: false,
    moods: ["luxury", "didone", "fashion"],
  },
  {
    key: "dmSerifDisplay",
    family: "DM Serif Display",
    export: "DM_Serif_Display",
    variable: "--font-dm-serif-display",
    label: "DM Serif Display",
    category: "serif",
    range: { min: 400, max: 400 },
    staticWeights: [400],
    italic: true,
    preloaded: false,
    body: false,
    moods: ["modern", "friendly", "pop"],
  },
  {
    key: "italiana",
    family: "Italiana",
    export: "Italiana",
    variable: "--font-italiana",
    label: "Italiana",
    category: "serif",
    range: { min: 400, max: 400 },
    staticWeights: [400],
    italic: false,
    preloaded: false,
    body: false,
    moods: ["fashion", "minimal", "luxury"],
  },
  {
    key: "marcellus",
    family: "Marcellus",
    export: "Marcellus",
    variable: "--font-marcellus",
    label: "Marcellus",
    category: "serif",
    range: { min: 400, max: 400 },
    staticWeights: [400],
    italic: false,
    preloaded: false,
    body: false,
    moods: ["heritage", "luxury", "classic"],
  },
  {
    key: "dmSans",
    family: "DM Sans",
    export: "DM_Sans",
    variable: "--font-dm-sans",
    label: "DM Sans",
    category: "sans",
    range: { min: 100, max: 1000 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: true,
    moods: ["modern", "friendly", "clean"],
  },
  {
    key: "manrope",
    family: "Manrope",
    export: "Manrope",
    variable: "--font-manrope",
    label: "Manrope",
    category: "sans",
    range: { min: 200, max: 800 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: true,
    moods: ["clean", "utility", "modern"],
  },
  {
    key: "sora",
    family: "Sora",
    export: "Sora",
    variable: "--font-sora",
    label: "Sora",
    category: "sans",
    range: { min: 100, max: 800 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: true,
    moods: ["geometric", "modern", "tech"],
  },
  {
    key: "figtree",
    family: "Figtree",
    export: "Figtree",
    variable: "--font-figtree",
    label: "Figtree",
    category: "sans",
    range: { min: 300, max: 900 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: true,
    moods: ["fresh", "friendly", "wellness"],
  },
  {
    key: "archivo",
    family: "Archivo",
    export: "Archivo",
    variable: "--font-archivo",
    label: "Archivo",
    category: "sans",
    range: { min: 100, max: 900 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: true,
    moods: ["industrial", "catalogue", "utility"],
  },
  {
    key: "workSans",
    family: "Work Sans",
    export: "Work_Sans",
    variable: "--font-work-sans",
    label: "Work Sans",
    category: "sans",
    range: { min: 100, max: 900 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: true,
    moods: ["neutral", "heritage", "trusted"],
  },
  {
    key: "nunito",
    family: "Nunito",
    export: "Nunito",
    variable: "--font-nunito",
    label: "Nunito",
    category: "sans",
    range: { min: 200, max: 1000 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: true,
    moods: ["rounded", "friendly", "kids"],
  },
  {
    key: "syne",
    family: "Syne",
    export: "Syne",
    variable: "--font-syne",
    label: "Syne",
    category: "display",
    range: { min: 400, max: 800 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: false,
    moods: ["statement", "art", "bold"],
  },
  {
    key: "bricolageGrotesque",
    family: "Bricolage Grotesque",
    export: "Bricolage_Grotesque",
    variable: "--font-bricolage-grotesque",
    label: "Bricolage Grotesque",
    category: "sans",
    range: { min: 200, max: 800 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: true,
    moods: ["bold", "contemporary", "expressive"],
  },
  {
    key: "oswald",
    family: "Oswald",
    export: "Oswald",
    variable: "--font-oswald",
    label: "Oswald",
    category: "display",
    range: { min: 200, max: 700 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: false,
    moods: ["condensed", "sport", "loud"],
  },
  {
    key: "bebasNeue",
    family: "Bebas Neue",
    export: "Bebas_Neue",
    variable: "--font-bebas-neue",
    label: "Bebas Neue",
    category: "display",
    range: { min: 400, max: 400 },
    staticWeights: [400],
    italic: false,
    preloaded: false,
    body: false,
    moods: ["poster", "streetwear", "loud"],
  },
  {
    key: "jetbrainsMono",
    family: "JetBrains Mono",
    export: "JetBrains_Mono",
    variable: "--font-jetbrains-mono",
    label: "JetBrains Mono",
    category: "mono",
    range: { min: 100, max: 800 },
    staticWeights: null,
    italic: false,
    preloaded: false,
    body: true,
    moods: ["tech", "electronics", "mono"],
  },
] as const satisfies readonly ThemeFontFace[];

export type DesignFont = (typeof THEME_FONT_FACES)[number]["key"];

/**
 * Key → the CSS value a design stores (`var(--font-jost)`).
 *
 * ★ AN ALLOWLIST, NOT A FREE STRING. The value is written into an inline
 * `style` attribute on `.storefront-root`, so an arbitrary font value is an
 * injection surface — the same reason `SectionStyle.background` is
 * `safeColor`-only.
 */
export const DESIGN_FONTS = Object.fromEntries(
  THEME_FONT_FACES.map((face) => [face.key, `var(${face.variable})`]),
) as Record<DesignFont, string>;
export const DESIGN_FONT_NAMES = THEME_FONT_FACES.map(
  (face) => face.key,
) as DesignFont[];
/** Every storable font value, catalogue order. */
export const THEME_FONT_VALUES: readonly string[] = Object.values(DESIGN_FONTS);
const THEME_FONT_VALUE_SET = new Set(THEME_FONT_VALUES);
const FACE_BY_VALUE = new Map<string, ThemeFontFace>(
  THEME_FONT_FACES.map((face) => [`var(${face.variable})`, face]),
);

/** The nine faces prompt revisions before v25 enumerated, in that order. */
export const LEGACY_DESIGN_FONT_KEYS = [
  "inter",
  "fraunces",
  "spaceGrotesk",
  "jakarta",
  "jost",
  "instrumentSerif",
  "outfit",
  "roboto",
  "stickNoBills",
] as const satisfies readonly DesignFont[];
export const LEGACY_DESIGN_FONT_VALUES: readonly string[] =
  LEGACY_DESIGN_FONT_KEYS.map((key) => DESIGN_FONTS[key]);

export function isThemeFontValue(value: unknown): value is string {
  return typeof value === "string" && THEME_FONT_VALUE_SET.has(value);
}

/** The face behind a stored value, or null for one the catalogue lacks. */
export function fontFace(value: string): ThemeFontFace | null {
  return FACE_BY_VALUE.get(value.trim()) ?? null;
}

/** The weights a stored value really has (typography.ts's faux-bold check). */
export function fontWeightRange(
  value: string,
): { min: number; max: number } | null {
  return fontFace(value)?.range ?? null;
}

/** Faces that cannot render a 600+ weight — the ones a heading or button
 * weight must be chosen for explicitly. */
export function limitedWeightFaces(): ThemeFontFace[] {
  return THEME_FONT_FACES.filter((face) => face.range.max < 600);
}

const WEIGHT_WORDS: Record<number, string> = {
  400: "regular",
  500: "medium",
};

/** "Instrument Serif (regular only), Jost (up to medium), …" for a prompt. */
export function limitedWeightSentence(): string {
  return limitedWeightFaces()
    .map((face) => {
      const top = WEIGHT_WORDS[face.range.max] ?? String(face.range.max);
      return `${face.label} (${face.range.min === face.range.max ? `${top} only` : `up to ${top}`})`;
    })
    .join(", ");
}

// ── Pairings ─────────────────────────────────────────────────────────────

export interface FontPairing {
  display: DesignFont;
  body: DesignFont;
  label: string;
  moods: readonly string[];
  /** Design directions (lib/theme-studio/design-directions.ts ids) it suits.
   * Guidance for the prompt, never a rule: a brief or reference wins. */
  directions: readonly string[];
}

/** The library Stage B picks from. Every catalogue face appears in at least
 * one pairing (pinned by fonts.test.ts), so no face is dead weight in the
 * build. */
export const FONT_PAIRINGS = {
  "editorial-fraunces": {
    display: "fraunces",
    body: "inter",
    label: "Fraunces headings, Inter body",
    moods: ["editorial", "magazine", "warm"],
    directions: ["magazine-editorial", "soft-and-natural"],
  },
  "luxury-didone": {
    display: "bodoniModa",
    body: "jost",
    label: "Bodoni Moda headings, Jost body",
    moods: ["luxury", "fashion", "high-contrast"],
    directions: ["luxury-minimal"],
  },
  "quiet-serif": {
    display: "instrumentSerif",
    body: "jost",
    label: "Instrument Serif headings, Jost body",
    moods: ["minimal", "fashion", "quiet"],
    directions: ["luxury-minimal", "magazine-editorial"],
  },
  "garamond-classic": {
    display: "ebGaramond",
    body: "workSans",
    label: "EB Garamond headings, Work Sans body",
    moods: ["heritage", "bookish", "trusted"],
    directions: ["classic-and-trusted", "magazine-editorial"],
  },
  "cormorant-luxe": {
    display: "cormorantGaramond",
    body: "manrope",
    label: "Cormorant Garamond headings, Manrope body",
    moods: ["luxury", "beauty", "refined"],
    directions: ["luxury-minimal", "soft-and-natural"],
  },
  "playfair-contrast": {
    display: "playfairDisplay",
    body: "figtree",
    label: "Playfair Display headings, Figtree body",
    moods: ["boutique", "editorial", "feminine"],
    directions: ["magazine-editorial", "luxury-minimal"],
  },
  "newsreader-press": {
    display: "newsreader",
    body: "archivo",
    label: "Newsreader headings, Archivo body",
    moods: ["journal", "press", "editorial"],
    directions: ["magazine-editorial", "classic-and-trusted"],
  },
  "lora-warm": {
    display: "lora",
    body: "nunito",
    label: "Lora headings, Nunito body",
    moods: ["warm", "friendly", "food"],
    directions: ["soft-and-natural", "playful-and-colourful"],
  },
  "serif-throughout": {
    display: "sourceSerif",
    body: "sourceSerif",
    label: "Source Serif throughout",
    moods: ["reading", "classic", "calm"],
    directions: ["classic-and-trusted", "magazine-editorial"],
  },
  "dm-serif-pop": {
    display: "dmSerifDisplay",
    body: "dmSans",
    label: "DM Serif Display headings, DM Sans body",
    moods: ["modern", "friendly", "pop"],
    directions: ["playful-and-colourful", "classic-and-trusted"],
  },
  "italiana-fashion": {
    display: "italiana",
    body: "jost",
    label: "Italiana headings, Jost body",
    moods: ["fashion", "minimal", "luxury"],
    directions: ["luxury-minimal"],
  },
  "marcellus-heritage": {
    display: "marcellus",
    body: "lora",
    label: "Marcellus headings, Lora body",
    moods: ["heritage", "luxury", "classic"],
    directions: ["luxury-minimal", "classic-and-trusted"],
  },
  "grotesk-modern": {
    display: "spaceGrotesk",
    body: "inter",
    label: "Space Grotesk headings, Inter body",
    moods: ["tech", "modern", "clean"],
    directions: ["bold-and-loud", "dense-catalogue"],
  },
  "bricolage-bold": {
    display: "bricolageGrotesque",
    body: "bricolageGrotesque",
    label: "Bricolage Grotesque throughout",
    moods: ["bold", "contemporary", "expressive"],
    directions: ["bold-and-loud", "playful-and-colourful"],
  },
  "syne-statement": {
    display: "syne",
    body: "dmSans",
    label: "Syne headings, DM Sans body",
    moods: ["statement", "art", "bold"],
    directions: ["bold-and-loud"],
  },
  "oswald-condensed": {
    display: "oswald",
    body: "roboto",
    label: "Oswald headings, Roboto body",
    moods: ["sport", "condensed", "loud"],
    directions: ["bold-and-loud", "dense-catalogue"],
  },
  "bebas-poster": {
    display: "bebasNeue",
    body: "workSans",
    label: "Bebas Neue headings, Work Sans body",
    moods: ["poster", "streetwear", "loud"],
    directions: ["bold-and-loud"],
  },
  "stick-condensed": {
    display: "stickNoBills",
    body: "outfit",
    label: "Stick No Bills headings, Outfit body",
    moods: ["condensed", "bold", "friendly"],
    directions: ["bold-and-loud", "playful-and-colourful"],
  },
  "sora-geometric": {
    display: "sora",
    body: "sora",
    label: "Sora throughout",
    moods: ["geometric", "modern", "tech"],
    directions: ["playful-and-colourful", "dense-catalogue"],
  },
  "manrope-clean": {
    display: "manrope",
    body: "manrope",
    label: "Manrope throughout",
    moods: ["clean", "utility", "modern"],
    directions: ["dense-catalogue", "classic-and-trusted"],
  },
  "archivo-utility": {
    display: "archivo",
    body: "archivo",
    label: "Archivo throughout",
    moods: ["catalogue", "industrial", "utility"],
    directions: ["dense-catalogue"],
  },
  "nunito-rounded": {
    display: "nunito",
    body: "nunito",
    label: "Nunito throughout",
    moods: ["rounded", "friendly", "kids"],
    directions: ["playful-and-colourful", "soft-and-natural"],
  },
  "outfit-friendly": {
    display: "outfit",
    body: "jakarta",
    label: "Outfit headings, Plus Jakarta Sans body",
    moods: ["friendly", "soft", "approachable"],
    directions: ["soft-and-natural", "playful-and-colourful"],
  },
  "jakarta-trusted": {
    display: "jakarta",
    body: "inter",
    label: "Plus Jakarta Sans headings, Inter body",
    moods: ["trusted", "general", "balanced"],
    directions: ["classic-and-trusted", "dense-catalogue"],
  },
  "mono-tech": {
    display: "jetbrainsMono",
    body: "inter",
    label: "JetBrains Mono headings, Inter body",
    moods: ["tech", "electronics", "precise"],
    directions: ["dense-catalogue", "bold-and-loud"],
  },
  "figtree-fresh": {
    display: "figtree",
    body: "figtree",
    label: "Figtree throughout",
    moods: ["fresh", "wellness", "light"],
    directions: ["soft-and-natural", "classic-and-trusted"],
  },
} as const satisfies Record<string, FontPairing>;

export type FontPairingKey = keyof typeof FONT_PAIRINGS;
export const FONT_PAIRING_KEYS = Object.keys(FONT_PAIRINGS) as FontPairingKey[];

export function isFontPairingKey(value: unknown): value is FontPairingKey {
  return typeof value === "string" && value in FONT_PAIRINGS;
}

/** The two stored values a pairing resolves to. */
export function pairingFonts(key: FontPairingKey): {
  body: string;
  display: string;
} {
  const pairing = FONT_PAIRINGS[key];
  return {
    body: DESIGN_FONTS[pairing.body],
    display: DESIGN_FONTS[pairing.display],
  };
}

/** The pairing two stored values came from, or null for a free choice. */
export function pairingForFonts(fonts: {
  body: string;
  display: string;
}): FontPairingKey | null {
  for (const key of FONT_PAIRING_KEYS) {
    const pair = pairingFonts(key);
    if (pair.body === fonts.body && pair.display === fonts.display) return key;
  }
  return null;
}

/** Direction id → the pairings suited to it, catalogue order. */
export const DIRECTION_PAIRINGS: Record<string, FontPairingKey[]> = (() => {
  const out: Record<string, FontPairingKey[]> = {};
  for (const key of FONT_PAIRING_KEYS) {
    for (const direction of FONT_PAIRINGS[key].directions) {
      (out[direction] ??= []).push(key);
    }
  }
  return out;
})();

/** One line per face for a prompt: value, name, class, weights, body-suited. */
export function describeFontCatalogue(): string {
  return THEME_FONT_FACES.map(
    (face) =>
      `${DESIGN_FONTS[face.key]} = ${face.label} (${face.category}, ${face.range.min === face.range.max ? `weight ${face.range.min}` : `weights ${face.range.min}–${face.range.max}`}${face.italic ? ", italic" : ""}${face.body ? "" : ", display only - never a body face"})`,
  ).join("; ");
}

/** One line per pairing for a prompt. */
export function describeFontPairings(): string {
  return FONT_PAIRING_KEYS.map((key) => {
    const pairing = FONT_PAIRINGS[key];
    return `${key}: ${pairing.label} - ${pairing.moods.join(", ")}`;
  }).join("; ");
}
