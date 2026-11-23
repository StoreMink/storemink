// ---------------------------------------------------------------------------
// How wide a line of text is in a storefront theme font, without a browser.
//
// WHY. Theme Studio plans a header menu before anything is rendered (owner,
// 23 Nov 2026: "in the planning it should judge, if the logo is in the
// center, how much space is to the left, and design the number of buttons"),
// so it needs the width of "Our Story" in Bodoni Moda at 15px, 600, in
// capitals, as a number.
//
// ★ MEASURED IN CHROME, NOT GUESSED: `font-widths.json` holds every printable
//   ASCII character's advance in every catalogue font at every weight from
//   300 to 900, written by `scripts/theme-font-widths.mjs` from the very
//   font files the storefront serves. Seven weights, because some faces
//   widen unevenly with weight (Syne is 25% wider at 650 than a straight line
//   between 400 and 800 says); a weight between two is interpolated.
// ★ CHECKED AGAINST CHROME'S OWN LAYOUT of whole words (1,395 words, every
//   font, five weights): within 2.9% wide and 0.7% narrow, median 0.02%. It
//   sums advances and ignores kerning, which nearly always narrows a word, so
//   it errs wide: a menu it says fits does.
// ★ A character outside ASCII (é, ’) counts as the average letter of its
//   case. Letter-spacing is added after every character, as Chrome does.
// Pure and server-side in practice (the table is 120 KB): only Theme Studio
// imports it.
// ---------------------------------------------------------------------------

import table from "./font-widths.json";
import { fontFace } from "./fonts";

export type TextTransform = "none" | "uppercase" | "lowercase" | "capitalize";

export interface TextStyle {
  /** A stored font value (`design.fonts.body`) or a Google family name. */
  font: string;
  weight: number;
  sizePx: number;
  letterSpacingEm?: number;
  transform?: TextTransform;
}

type Rows = Record<string, number[]>;
const FAMILIES = table.families as Record<string, Rows>;
const WEIGHTS = table.weights;
const FIRST = table.first;

function familyOf(font: string): string | null {
  if (Object.hasOwn(FAMILIES, font)) return font;
  const family = fontFace(font)?.family;
  return family && Object.hasOwn(FAMILIES, family) ? family : null;
}

/** Whether `font` (a stored value or a family) has measured widths. */
export function hasTextWidths(font: string): boolean {
  return familyOf(font) !== null;
}

/** Every family the table holds. */
export function measuredFamilies(): string[] {
  return Object.keys(FAMILIES);
}

function transformed(text: string, transform: TextTransform): string {
  switch (transform) {
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    case "capitalize":
      return text.replace(
        /(^|\s)(\S)/g,
        (_, space: string, first: string) => space + first.toUpperCase(),
      );
    default:
      return text;
  }
}

const average = (row: number[], from: string, to: string) => {
  let sum = 0;
  for (let c = from.charCodeAt(0); c <= to.charCodeAt(0); c++)
    sum += row[c - FIRST];
  return sum / (to.charCodeAt(0) - from.charCodeAt(0) + 1);
};

/** One weight's advances, in thousandths of an em, interpolated between the
 *  two measured weights around it. */
function rowAt(rows: Rows, weight: number): number[] {
  const w = Math.max(WEIGHTS[0], Math.min(WEIGHTS[WEIGHTS.length - 1], weight));
  const upper = WEIGHTS.findIndex((x) => x >= w);
  if (WEIGHTS[upper] === w) return rows[String(w)];
  const lo = WEIGHTS[upper - 1];
  const hi = WEIGHTS[upper];
  const t = (w - lo) / (hi - lo);
  const a = rows[String(lo)];
  const b = rows[String(hi)];
  return a.map((v, i) => v + (b[i] - v) * t);
}

/**
 * The width in px of `text` set in `style`, as one unbroken line. Null when
 * the font has no measured widths (a font outside the catalogue).
 */
export function textWidth(text: string, style: TextStyle): number | null {
  const family = familyOf(style.font);
  if (!family) return null;
  const row = rowAt(FAMILIES[family], style.weight);
  const lower = average(row, "a", "z");
  const upper = average(row, "A", "Z");
  const shown = transformed(text, style.transform ?? "none");
  let units = 0;
  let count = 0;
  for (const char of shown) {
    count++;
    const code = char.codePointAt(0)!;
    if (code >= FIRST && code < FIRST + row.length) units += row[code - FIRST];
    else units += char !== char.toLowerCase() ? upper : lower;
  }
  return (
    (units / 1000) * style.sizePx +
    count * (style.letterSpacingEm ?? 0) * style.sizePx
  );
}
