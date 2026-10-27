// ---------------------------------------------------------------------------
// ★★ HISTORY'S LOADED LIST, REFRESHED WITHOUT LOSING WHAT WAS SCROLLED IN.
// Pure and client-safe (app/dashboard/mink-ai.ts). After every answer the
// sidebar asks for its first page again (a new chat moves to the top, a title
// arrives). Replacing the list with that page would throw away every chat the
// merchant had scrolled down to, and the scroll position with them; asking for
// everything loaded would grow without bound. So page 1 is MERGED by id into
// what is loaded: the page's rows first, then the loaded rows that sort below
// the page's last row. A loaded row that sorts above it and is missing from
// the page was deleted or expired elsewhere, and goes.
// ---------------------------------------------------------------------------

/** What the merge reads of a History row. */
export interface MinkHistoryRow {
  id: string;
  lastMessageAt: string;
}

export interface MinkHistoryList<T extends MinkHistoryRow> {
  items: T[];
  /** The next page's cursor; null when every chat is loaded. */
  cursor: string | null;
}

/**
 * A Postgres or ISO timestamp as [milliseconds, microseconds within them],
 * so two rows a few microseconds apart still sort as the server sorts them.
 * Postgres writes "2026-10-26 07:07:12.123456+00", which not every browser
 * parses as it stands; it is rewritten as ISO first. NaN when unreadable.
 */
export function historyInstant(value: string): [number, number] {
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
  const iso = value
    .trim()
    .replace(" ", "T")
    .replace(/\.(\d{1,3})\d*/, ".$1")
    .replace(/([+-]\d{2})$/, "$1:00")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const micros = Number(fraction.padEnd(6, "0").slice(3, 6)) || 0;
  return [Date.parse(iso), micros];
}

/** True when `row` comes after `last` in History's order (newest first, then id). */
export function sortsAfter(row: MinkHistoryRow, last: MinkHistoryRow): boolean {
  const [rowMs, rowMicros] = historyInstant(row.lastMessageAt);
  const [lastMs, lastMicros] = historyInstant(last.lastMessageAt);
  if (Number.isFinite(rowMs) && Number.isFinite(lastMs)) {
    if (rowMs !== lastMs) return rowMs < lastMs;
    if (rowMicros !== lastMicros) return rowMicros < lastMicros;
  }
  return row.id < last.id;
}

/** Page 1 merged into the loaded list (see the header). */
export function mergeHistoryRefresh<T extends MinkHistoryRow>(
  previous: MinkHistoryList<T>,
  page: { items: T[]; nextCursor: string | null },
): MinkHistoryList<T> {
  // Every chat fits on page 1: it is the whole list.
  if (page.nextCursor === null) return { items: page.items, cursor: null };
  const last = page.items[page.items.length - 1];
  if (!last) return { items: page.items, cursor: page.nextCursor };
  const onPage = new Set(page.items.map((row) => row.id));
  const tail = previous.items.filter(
    (row) => !onPage.has(row.id) && sortsAfter(row, last),
  );
  return {
    items: [...page.items, ...tail],
    // ★ The merchant had scrolled past page 1: their place is kept, and the
    //   next page continues below the last row they had.
    cursor: tail.length > 0 ? previous.cursor : page.nextCursor,
  };
}
