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
export type CompactStep = (typeof COMPACT_STEPS)[number];

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
 * The fewest steps that make the header fit. `measure` applies the given
 * steps to the live header and reports the result; the last step is taken
 * even if it still does not fit, because there is nothing left to fold.
 */
export function chooseCompaction(
  measure: (steps: readonly CompactStep[]) => HeaderLayout,
): CompactStep[] {
  for (let n = 0; n < COMPACT_STEPS.length; n++) {
    const steps = COMPACT_STEPS.slice(0, n);
    if (headerFits(measure(steps))) return steps;
  }
  return [...COMPACT_STEPS];
}
