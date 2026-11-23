// ---------------------------------------------------------------------------
// How much of the storefront header to fold into the drawer so what is left
// fits on one row. Pure, so the decision is tested without a browser;
// `app/(storefront)/components/header/use-header-fit.ts` measures and applies.
//
// ★ FIT, NOT A BREAKPOINT. Whether the header fits at 900px depends on the
//   theme's font, how many menu links the merchant has, how long they are,
//   the logo, and whether search and the cart are switched on. A width that
//   is right for four short links in Inter overlaps six uppercase links in
//   Jost, so the header asks the page instead of guessing a number.
// ★ ONE STEP AT A TIME, in a fixed order, fewest removals first: the menu
//   (it moves to the drawer, behind the hamburger), then the delivery
//   control (also in the drawer), then the search box (a search icon opens
//   the same search). Everything folded away stays one tap away.
// ★ A HEADER THAT CAN STACK KEEPS ITS MENU (owner, 23 Nov 2026, after Muse's
//   centred-logo header hid every link behind the hamburger on a 1440px
//   screen: "menu on its own row"). Where the layout can put the menu on a
//   row of its own under the logo (STACK_STEPS; the centred-logo header on a
//   desktop screen, which says so in its CSS), the menu is never folded: the
//   row wraps instead. ★ It stacks only when the MENU is what does not fit
//   (STACK_CANDIDATES): the right-hand controls are folded first, because in
//   that grid the two sides have equal columns and never take room from each
//   other, so a crowded right side used to move a menu that fitted onto a
//   second row. Theme Studio plans a centred theme's menu to fit beside the
//   logo (lib/theme-studio/menu-fit.ts), so the second row is the fallback
//   for a merchant's longer menu.
// ★ The phone layout (≤768px) is still plain CSS, so a phone never waits on
//   this; the check only ever removes more than CSS already did.
// ★ ROWS, NOT ONE LINE (plan Phase 2d). The stacked and utility headers put
//   the menu, or the whole control cluster, on a second row, where it sits
//   right under the logo. Judged as one line that is an overlap, and the fit
//   would fold the menu the layout exists to show. Items are grouped into
//   rows by vertical overlap and the gap rule runs within each row; a box
//   with no vertical extent (older callers, the tests) is one row, as before.
// ---------------------------------------------------------------------------

export const COMPACT_STEPS = ["nav", "delivery", "search"] as const;
/** The steps of a header that can move its menu to a row of its own. */
export const STACK_STEPS = ["stack", "delivery", "search"] as const;
export type CompactStep =
  | (typeof COMPACT_STEPS)[number]
  | (typeof STACK_STEPS)[number];
type Candidates = readonly (readonly CompactStep[])[];

/** One step at a time, in order: nothing, the menu, then the delivery
 *  control, then the search box. */
export const COMPACT_CANDIDATES: Candidates = COMPACT_STEPS.map((_, n) =>
  COMPACT_STEPS.slice(0, n),
).concat([[...COMPACT_STEPS]]);

/** A header that can stack: the right-hand controls fold first, and the menu
 *  moves to its own row only when folding them did not make it fit. */
export const STACK_CANDIDATES: Candidates = [
  [],
  ["delivery"],
  ["delivery", "search"],
  ["stack"],
  ["stack", "delivery"],
  ["stack", "delivery", "search"],
];

/** Clear space required between neighbouring header items. */
export const MIN_ITEM_GAP = 12;

export interface FitBox {
  left: number;
  right: number;
  /** Vertical extent, so a two-row header is judged row by row. Absent on
   *  both: every item shares one row. */
  top?: number;
  bottom?: number;
  /** Narrower than this is "squeezed", not "fits" (a search box can shrink
   *  to a sliver without ever overlapping anything). */
  minWidth?: number;
}

/** Items grouped into rows: two items share a row when their vertical
 *  extents overlap by more than a pixel (a logo and a menu of different
 *  heights still do); an item with no extent joins the first row. */
export function headerRows(items: readonly FitBox[]): FitBox[][] {
  const rows: { top: number; bottom: number; items: FitBox[] }[] = [];
  const sorted = [...items].sort((a, b) => (a.top ?? 0) - (b.top ?? 0));
  for (const item of sorted) {
    const top = item.top ?? Number.NEGATIVE_INFINITY;
    const bottom = item.bottom ?? Number.POSITIVE_INFINITY;
    const row = rows.find((r) => top < r.bottom - 1 && bottom > r.top + 1);
    if (row) {
      row.items.push(item);
      row.top = Math.min(row.top, top);
      row.bottom = Math.max(row.bottom, bottom);
    } else rows.push({ top, bottom, items: [item] });
  }
  return rows.map((r) => r.items);
}

export interface HeaderLayout {
  clientWidth: number;
  scrollWidth: number;
  /** The visible header items: logo, menu, and each right-hand control. */
  items: readonly FitBox[];
}

export function headerFits(
  layout: HeaderLayout,
  gap: number = MIN_ITEM_GAP,
): boolean {
  // Something is pushing the header wider than the screen.
  if (layout.scrollWidth > layout.clientWidth + 1) return false;
  for (const item of layout.items) {
    if (item.minWidth && item.right - item.left < item.minWidth - 0.5)
      return false;
  }
  for (const row of headerRows(layout.items)) {
    const items = [...row].sort((a, b) => a.left - b.left);
    for (let i = 1; i < items.length; i++) {
      if (items[i].left < items[i - 1].right + gap) return false;
    }
  }
  return true;
}

/**
 * The first candidate that makes the header fit. `measure` applies the given
 * steps to the live header and reports the result; the last candidate is
 * taken even if it still does not fit, because there is nothing left to fold.
 * `candidates` is COMPACT_CANDIDATES, or STACK_CANDIDATES for a header that
 * can stack.
 */
export function chooseCompaction(
  measure: (steps: readonly CompactStep[]) => HeaderLayout,
  candidates: Candidates = COMPACT_CANDIDATES,
): CompactStep[] {
  for (let n = 0; n < candidates.length - 1; n++) {
    if (headerFits(measure(candidates[n]))) return [...candidates[n]];
  }
  return [...candidates[candidates.length - 1]];
}
