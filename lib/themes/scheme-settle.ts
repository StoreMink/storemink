// ---------------------------------------------------------------------------
// Settling a theme's section colour schemes so text reads on them.
//
// WHY. The first live build under prompt v34 (22 Nov 2026) spent every repair
// it had and then failed, after twelve minutes and five paid model calls, on
// one line: "Muted text in the Brand scheme is hard to read (4.35:1, needs
// 4.5:1)". Muted text is not a colour a model writes: it is 76% of a band's
// text mixed with 24% of its background (schemes.ts SCHEME_MIX), so the only
// way a model can move it is to guess a different band colour and hope. It
// guessed four times. Each round it fixed what it was told and broke a
// neighbour: a card colour, a ringed button.
//
// That is arithmetic, not design, so StoreMink does it. For each scheme a
// theme uses or declares, where a pair the validator checks does not read:
//   1. the band's text moves toward black or white, whichever reads better;
//   2. if that is not enough for the muted text, the band's own background
//      moves away from its text, a few per cent at a time;
//   3. a card colour the text does not read on is dropped for the derived
//      one, and that for the band's own colour;
//   4. button colours whose label does not read are dropped for the derived
//      ones, and a ringed button that does not read takes the band's text.
// ★ A SHADE MOVES, NEVER A HUE: every step is a mix toward black or white.
// ★ ONLY A SCHEME THAT FAILS IS TOUCHED, and then it becomes a declared
//   scheme, so the change stays inside that band: the theme's palette, its
//   buttons elsewhere and its other bands are exactly as written.
// ★ IT CHECKS ITSELF with the validator's own functions; a scheme it cannot
//   settle is left as the model wrote it, and the ordinary repair runs.
// Pure: no database, no provider.
// ---------------------------------------------------------------------------

import { buttonsDrawColourAsText } from "./buttons";
import {
  SCHEME_MIX,
  SECTION_SCHEMES,
  isHex,
  isSectionScheme,
  mixHex,
  resolveScheme,
  schemeContrast,
  schemeContrastIssues,
  type SectionScheme,
  type ThemeColorScheme,
} from "./schemes";
import type { ThemeDesign } from "./types";

/** Body text, and a button label (small text): WCAG AA. */
const TEXT = 4.5;
/** How far a band's background may move from what was written, in steps of
 *  four per cent toward black or white. */
const BACKGROUND_STEPS = 12;

const soft = (text: string, background: string) =>
  mixHex(text, background, SCHEME_MIX.textSoft);
const reads = (text: string, background: string) =>
  schemeContrast(text, background) >= TEXT &&
  schemeContrast(soft(text, background), background) >= TEXT;

/** What the validator would say about one scheme (validation.ts). */
export function schemeProblems(
  id: SectionScheme,
  design: ThemeDesign,
  brandPrimary: string,
): string[] {
  const resolved = resolveScheme(id, design, brandPrimary);
  const out = schemeContrastIssues(id, resolved).map((issue) => issue.message);
  if (
    buttonsDrawColourAsText(design.buttons) &&
    schemeContrast(resolved.accent, resolved.background) < TEXT
  )
    out.push(`Ringed buttons in the ${id} scheme are hard to read.`);
  const declared = design.schemes?.[id];
  if (
    declared &&
    isHex(declared.accent) &&
    isHex(declared.onAccent) &&
    schemeContrast(declared.onAccent, declared.accent) < TEXT
  )
    out.push(`schemes.${id}: button labels are hard to read.`);
  return out;
}

function settleOne(
  id: SectionScheme,
  design: ThemeDesign,
  brandPrimary: string,
): ThemeColorScheme {
  const written = resolveScheme(id, design, brandPrimary);
  const declared = design.schemes?.[id];
  let { background, text } = written;

  if (!reads(text, background)) {
    const pole =
      schemeContrast("#000000", background) >=
      schemeContrast("#ffffff", background)
        ? "#000000"
        : "#ffffff";
    for (let step = 1; step <= 10 && !reads(text, background); step++)
      text = mixHex(pole, written.text, step * 10);
    const away = pole === "#ffffff" ? "#000000" : "#ffffff";
    for (
      let step = 1;
      step <= BACKGROUND_STEPS && !reads(text, background);
      step++
    )
      background = mixHex(away, written.background, step * 4);
  }

  const next: ThemeColorScheme = { background, text };
  // Cards: the written colour if the text reads on it, else the derived
  // one, else the band's own.
  if (
    declared &&
    isHex(declared.surface) &&
    schemeContrast(text, declared.surface) >= TEXT
  )
    next.surface = declared.surface;
  const withSurface = (scheme: ThemeColorScheme) =>
    resolveScheme(
      id,
      { ...design, schemes: { ...design.schemes, [id]: scheme } },
      brandPrimary,
    );
  if (schemeContrast(text, withSurface(next).surface) < TEXT)
    next.surface = background;

  // Buttons: the written pair if its label reads (and, ringed, if it reads
  // on the band), else the derived pair, else the band's text on the band.
  const ringed = buttonsDrawColourAsText(design.buttons);
  const fits = (accent: string, onAccent: string) =>
    schemeContrast(onAccent, accent) >= TEXT &&
    (!ringed || schemeContrast(accent, background) >= TEXT);
  if (
    declared &&
    isHex(declared.accent) &&
    isHex(declared.onAccent) &&
    fits(declared.accent, declared.onAccent)
  ) {
    next.accent = declared.accent;
    next.onAccent = declared.onAccent;
  } else {
    const derived = withSurface(next);
    if (!fits(derived.accent, derived.onAccent)) {
      next.accent = text;
      next.onAccent = background;
    }
  }
  return next;
}

export interface SchemeSettlement {
  design: ThemeDesign;
  /** One line per scheme that was changed, for the run's log. */
  changes: string[];
}

/**
 * The design with every scheme it uses or declares made readable, where
 * shade alone can do it. `used` is the schemes the theme's sections name
 * (schemes.ts `schemesUsed`).
 */
export function settleSchemeContrast(
  design: ThemeDesign,
  brandPrimary: string,
  used: ReadonlySet<SectionScheme>,
): SchemeSettlement {
  const palette = design.palette as unknown as Record<string, unknown>;
  // The validator checks schemes only once the palette is whole; so does this.
  if (
    !["cream", "creamDeep", "surface", "ink", "onInk", "onAccent"].every(
      (key) => isHex(palette[key]),
    ) ||
    !isHex(design.palette.accent ?? brandPrimary)
  )
    return { design, changes: [] };
  const check = new Set<SectionScheme>([
    ...Object.keys(design.schemes ?? {}).filter(isSectionScheme),
    ...used,
  ]);
  let current = design;
  const changes: string[] = [];
  for (const id of SECTION_SCHEMES) {
    if (!check.has(id)) continue;
    const declared = current.schemes?.[id];
    // A declaration that is not two hex colours is the validator's to name.
    if (declared && !(isHex(declared.background) && isHex(declared.text)))
      continue;
    if (!schemeProblems(id, current, brandPrimary).length) continue;
    const before = resolveScheme(id, current, brandPrimary);
    const settled = settleOne(id, current, brandPrimary);
    const candidate: ThemeDesign = {
      ...current,
      schemes: { ...current.schemes, [id]: settled },
    };
    // Kept only when the validator would now pass it whole.
    if (schemeProblems(id, candidate, brandPrimary).length) continue;
    const after = resolveScheme(id, candidate, brandPrimary);
    const moved = (
      [
        ["background", before.background, after.background],
        ["text", before.text, after.text],
        ["cards", before.surface, after.surface],
        ["buttons", before.accent, after.accent],
      ] as const
    )
      .filter(([, from, to]) => from !== to)
      .map(([what, from, to]) => `${what} ${from} to ${to}`);
    changes.push(`schemes.${id}: ${moved.join(", ") || "declared as derived"}`);
    current = candidate;
  }
  return { design: current, changes };
}
