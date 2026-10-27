// Shared helpers for server-paginated dashboard list pages.

/** Normalize a Next searchParams value (string | string[] | undefined). */
export function pickParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/** Parse a 1-based page number from a search param, clamped to >= 1. */
export function pickPage(v: string | string[] | undefined): number {
  const n = parseInt(pickParam(v) || "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Replace `(),:*%\` with spaces, trim, and cap at 100 characters. Callers bind
 *  the result inside `%…%` for ILIKE, so dropping `%` and `\` stops a term
 *  adding its own wildcard or escape. */
export function sanitizeSearch(q: string): string {
  return q
    .replace(/[(),:*%\\]/g, " ")
    .trim()
    .slice(0, 100);
}

/** Default rows per dashboard list page. */
export const DASHBOARD_PAGE_SIZE = 50;
