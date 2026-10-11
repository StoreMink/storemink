import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Drift guard: every storefront page passes the storefront gate.
//
// requireStorefrontStore() is where an unknown host 404s, a locked visitor is
// sent to /password, and — while the owner has not chosen a theme — everyone
// past the password is sent to /in-progress. A layout cannot stop a child page
// rendering (CODEBASE.md §3), so the gate only holds if EVERY page reaches it:
// itself, or through a layout inside (pages) that calls it before the page's
// own data reads. A page added without it would show a pending store's
// storefront (and a closed store's) to anybody. In the style of the
// RESERVED_PAGE_SLUGS drift test.
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), "app", "(storefront)");
const PAGES = join(ROOT, "(pages)");

function source(file: string): string {
  // Comments DISCUSS the gate in several of these files; only code counts.
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "components" ? [] : walk(path);
    }
    return /^page\.(t|j)sx?$/.test(entry.name) ? [path] : [];
  });
}

function callsGate(file: string): boolean {
  return /\brequireStorefrontStore(Id)?\s*\(/.test(source(file));
}

/** A layout between the page and (pages) that calls the gate. The root
 *  (storefront) layout is NOT one: it resolves the store with
 *  getCurrentStoreOrNull() and only chooses the shell. */
function guardedByLayout(page: string): boolean {
  for (let dir = dirname(page); dir.startsWith(PAGES); dir = dirname(dir)) {
    for (const name of ["layout.tsx", "layout.jsx"]) {
      const layout = join(dir, name);
      if (existsSync(layout) && callsGate(layout)) return true;
    }
    if (dir === PAGES) break;
  }
  return false;
}

// The only pages that may not call the gate, and why.
const EXEMPT: Record<string, string> = {
  // The gate's own targets: calling it would redirect them to themselves.
  "(pages)/password/page.tsx": "the password page",
  "(pages)/in-progress/page.tsx": "the store-in-progress page",
  // Reaches it through getMyOrder(), which calls requireStorefrontStoreId()
  // for a signed-in shopper; a signed-out one gets a 404 and no order data.
  "(pages)/orders/[id]/collect/page.tsx": "via getMyOrder",
};

describe("storefront gate coverage", () => {
  const pages = walk(ROOT).map((file) => ({
    file,
    rel: relative(ROOT, file),
  }));

  it("finds the storefront pages", () => {
    // A guard that silently stops matching would pass for ever.
    expect(pages.length).toBeGreaterThan(15);
    expect(pages.map((p) => p.rel)).toContain("page.tsx");
  });

  it("every page calls requireStorefrontStore itself or under a (pages) layout", () => {
    const unguarded = pages
      .filter(({ rel }) => !(rel in EXEMPT))
      .filter(({ file }) => !callsGate(file) && !guardedByLayout(file))
      .map(({ rel }) => rel);
    expect(
      unguarded,
      "These storefront pages never reach requireStorefrontStore(), so a store " +
        "without a theme (or a closed one) would render them past the gate. " +
        "Call requireStorefrontStore() / requireStorefrontStoreId() in the page.",
    ).toEqual([]);
  });

  it("the gate's own targets never call it, which is what stops a loop", () => {
    for (const rel of [
      "(pages)/password/page.tsx",
      "(pages)/in-progress/page.tsx",
    ]) {
      expect(callsGate(join(ROOT, rel)), rel).toBe(false);
    }
    const inProgress = source(join(PAGES, "in-progress", "page.tsx"));
    // It re-asks the gate's questions itself, in the gate's order.
    expect(inProgress).toMatch(/storefrontAccess\(store\)/);
    expect(inProgress).toMatch(/isThemePending\(store\)/);
    expect(inProgress.indexOf("storefrontAccess(store)")).toBeLessThan(
      inProgress.indexOf("isThemePending(store)"),
    );
  });

  it("the exemptions still hold for the reason given", () => {
    for (const rel of Object.keys(EXEMPT)) {
      expect(existsSync(join(ROOT, rel)), rel).toBe(true);
    }
    expect(
      source(join(PAGES, "orders", "[id]", "collect", "page.tsx")),
    ).toMatch(/getMyOrder\(/);
    const actions = source(
      join(process.cwd(), "app", "actions", "customer-order-actions.ts"),
    );
    const getMyOrder = actions.slice(
      actions.indexOf("export async function getMyOrder("),
    );
    expect(getMyOrder.slice(0, 600)).toMatch(/requireStorefrontStoreId\(\)/);
  });

  it("the storefront layout picks its shell with storefrontShell()", () => {
    // The behaviour is pinned by rendering: layout.test.tsx (the layout drops
    // its header, footer, cart and sign-in for a pending or locked store) and
    // lib/store/storefront-shell.test.ts (the decision). This only checks the
    // layout still asks that function, with the live access answer.
    expect(source(join(ROOT, "layout.tsx"))).toMatch(
      /storefrontShell\(\s*store\s*,\s*await\s+storefrontAccess\(store\)\s*\)/,
    );
  });
});
