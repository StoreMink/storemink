// The one address matcher the dashboard's menus share: the sidebar, its links
// and the settings menu. Pure and client-safe.

/** The path without a trailing slash ("/" stays "/"). */
export function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/**
 * True when `pathname` is `href` or a page under it. `/dashboard` (Home)
 * matches only itself, or every dashboard page would light it up.
 */
export function pathMatches(pathname: string, href: string): boolean {
  return (
    pathname === href ||
    (href !== "/dashboard" && pathname.startsWith(`${href}/`))
  );
}
