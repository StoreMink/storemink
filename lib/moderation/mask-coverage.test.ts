import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// COVERAGE GUARD: the page swap reaches every storefront reader (takedown,
// design 5.6 "Where it runs", plan stage T8a and item A17).
//
// When StoreMink blocks a file, its address must reach no page: every
// storefront reader hands what it read to `maskBlockedMedia`, which puts the
// placeholder's own address in place of a blocked one. A reader added later
// without it would show the blocked file again with nothing failing, so this
// file holds four lines:
//
// 1. Every export of the five reader modules is classified: MASKED (its body
//    calls `maskBlockedMedia` or `maskBlockedMediaWith`, imported from
//    lib/moderation/blocked-objects, and never inside a database scope's
//    callback or an `unstable_cache`) or EXEMPT, each with its reason. A new
//    export fails until it is one or the other. Type-only exports (interfaces
//    and type aliases) carry no data and are not listed.
// 2. Every storefront file that renders a raw `<img>` element (one the image
//    optimizer, and so the proxy's interception, never sees) is listed with
//    where its address comes from. A new one fails until its address is shown
//    to come through a masked read.
// 3. No dashboard file reads the masked brand except the ones listed: an
//    EDITOR that writes the brand back must use `getStoreBrandForEditing`, or
//    a blocked logo is erased from the store's settings.
// 4. Plan E7, R5: nothing outside lib/moderation/ and migration 0269 writes
//    `moderation_blocked_at` (the database's moderation_flag_guard refuses
//    such a write too; this finds it in review instead of in production).
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, "..", "..");
const MASK_MODULE = "@/lib/moderation/blocked-objects";
const MASK_CALLS = new Set(["maskBlockedMedia", "maskBlockedMediaWith"]);
const SCOPE_CALLS = new Set([
  "withAnon",
  "withService",
  "withUser",
  "withServiceAndNotices",
  "unstable_cache",
]);

type Classification = {
  masked: string[];
  exempt: Record<string, string>;
};

const READERS: Record<string, Classification> = {
  "lib/storefront/queries.ts": {
    masked: [
      "getPublishedProducts",
      "getActiveCategories",
      "getPublishedBlogCards",
      "getPublishedPage",
      "getStoreMenus",
      "getStoreBillingSettings",
    ],
    exempt: {
      getBlogTaxonomyNames:
        "category and tag names for the write editor's pickers; no address",
      getStoreTaxClasses: "tax class names and rates; no address",
      getPublishedPageSlugs:
        "page slugs and dates for the sitemap; a blocked page is already hidden by RLS, and the sitemap's image entries are filtered elsewhere (imageEntry in app/sitemap.ts)",
    },
  },
  "lib/chrome/queries.ts": {
    masked: ["getStoreChrome"],
    exempt: {
      getDraftChromeForPreview:
        "the builder's preview of the merchant's own unpublished chrome, behind the builder permission; the builder shows its own blocked marks",
      getDraftChromeForEditor:
        "the builder's editor saves this draft back, so masking it would write the placeholder over the merchant's own address",
    },
  },
  "lib/sections/resolve-data.ts": {
    masked: ["fetchSectionDatasets", "resolveSectionData"],
    exempt: {},
  },
  "lib/store/brand.ts": {
    masked: ["getStoreBrand", "getStoreBrandById"],
    exempt: {
      DEFAULT_PRIMARY: "the default accent colour; no address",
      brandFromSettings:
        "a pure mapper over a settings object the caller already holds; the Branding editor and Mink's design reads take the stored values on purpose, and Mink's campaign brand snapshot drops a blocked logo itself (readBrand)",
      getStoreBrandForEditing:
        "the Website Builder saves logoUrl back with every brand change, so masking it would erase a blocked logo from the store's settings for good",
    },
  },
  "app/api/storefront/search/route.ts": {
    masked: ["GET"],
    exempt: {
      runtime: "route configuration (the Node runtime); no data",
      dynamic: "route configuration (never prerendered); no data",
    },
  },
};

/**
 * Storefront files that render a raw `<img>`, with where its address comes
 * from. Shrink only: a file that stops rendering one is removed from here.
 */
const RAW_IMG_FILES: Record<string, string> = {
  "app/(storefront)/(pages)/password/page.tsx":
    "the store's logo, from getStoreBrand (a blocked logo is removed)",
  "app/(storefront)/(pages)/in-progress/page.tsx":
    "the store's logo, from getStoreBrand (a blocked logo is removed)",
  "app/(storefront)/components/header/Header.jsx":
    "the store's logo, from getStoreBrand through the storefront layout",
  "app/(storefront)/components/footer/Footer.jsx":
    "the store's logo from getStoreBrand, and StoreMink's own bundled mark",
  "app/(storefront)/components/header/desktop-nav.tsx":
    "menu feature images, from getStoreChrome (masked)",
  "app/(storefront)/components/header/predictive-search.tsx":
    "thumbnails from /api/storefront/search, whose answer is masked",
  "app/(storefront)/components/option-picker.tsx":
    "colour photos from the product: getPublishedProducts (masked) and the product page's own read (getProduct, masked)",
  "app/(storefront)/(pages)/checkout/page.tsx":
    "cart thumbnails, captured from masked product reads; the refreshed image getCartStock returns is masked",
  "app/(storefront)/(pages)/orders/order-history.tsx":
    "order line photos from getMyOrders, which masks them",
  "app/(storefront)/(pages)/orders/[id]/page.tsx":
    "order line photos from getMyOrder, which masks them",
  "app/(storefront)/components/sections/hero-media.tsx":
    "an <img> inside <picture> from getImageProps: its addresses come from section config through getPublishedPage (masked) and go through /_next/image, which the proxy intercepts too (proxy.ts)",
  "components/invoice/invoice-document.tsx":
    "the invoice logo: the shopper's invoice reads getStoreBillingSettings, which removes a blocked logo; the dashboard copy reads the merchant's own saved settings",
  "components/ui/image-upload.tsx":
    "a dashboard editing widget showing the merchant's own upload; never rendered on the storefront",
  "components/ui/background-editor.tsx":
    "a dashboard editing widget showing the merchant's own photo; never rendered on the storefront",
};
const RAW_IMG_DIRS = ["app/(storefront)", "components"];

/**
 * Dashboard files that still read the masked brand, with why that is safe or
 * who changes it. Remove an entry once its file switches.
 */
const DASHBOARD_BRAND_READERS: Record<string, string> = {};

// ── Helpers ────────────────────────────────────────────────────────────────

function read(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

function parse(file: string, text: string): ts.SourceFile {
  const kind = file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : file.endsWith(".js") || file.endsWith(".mjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

function files(dir: string, test: (path: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(abs, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(ROOT, full).split("\\").join("/");
        if (test(rel)) out.push(rel);
      }
    }
  };
  walk(join(ROOT, dir));
  return out;
}

const hasExport = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );

type ExportedValue = { name: string; node: ts.Node };

/** The runtime (value) exports of a module, each with the node to scan. */
function valueExports(source: ts.SourceFile): {
  values: ExportedValue[];
  problems: string[];
} {
  const values: ExportedValue[] = [];
  const problems: string[] = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExport(statement)) {
      values.push({ name: statement.name?.text ?? "default", node: statement });
    } else if (ts.isVariableStatement(statement) && hasExport(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          values.push({ name: declaration.name.text, node: declaration });
        } else {
          problems.push(`a destructured export at ${declaration.getText()}`);
        }
      }
    } else if (ts.isClassDeclaration(statement) && hasExport(statement)) {
      values.push({ name: statement.name?.text ?? "default", node: statement });
    } else if (ts.isExportAssignment(statement)) {
      values.push({ name: "default", node: statement });
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      problems.push(
        `a re-export (${statement.getText()}): list what it exports here`,
      );
    }
  }
  return { values, problems };
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/**
 * The mask calls inside `node`, each with the scope calls (a database scope
 * or `unstable_cache`) whose callback it sits in.
 */
function maskCalls(node: ts.Node): { enclosing: string[] }[] {
  const found: { enclosing: string[] }[] = [];
  const visit = (current: ts.Node, enclosing: string[]) => {
    if (ts.isCallExpression(current)) {
      const name = calleeName(current);
      if (name && MASK_CALLS.has(name)) found.push({ enclosing });
      if (name && SCOPE_CALLS.has(name)) {
        visit(current.expression, enclosing);
        for (const arg of current.arguments) {
          const isCallback =
            ts.isArrowFunction(arg) || ts.isFunctionExpression(arg);
          visit(arg, isCallback ? [...enclosing, name] : enclosing);
        }
        return;
      }
    }
    ts.forEachChild(current, (child) => visit(child, enclosing));
  };
  visit(node, []);
  return found;
}

function importsMask(source: ts.SourceFile): boolean {
  return source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === MASK_MODULE &&
      !statement.importClause?.isTypeOnly &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => !element.isTypeOnly && MASK_CALLS.has(element.name.text),
      ),
  );
}

/** Every file that renders a raw `<img>` element. */
function rendersRawImg(file: string): boolean {
  const source = parse(file, read(file));
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === "img"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Whether a file calls `getStoreBrand()` itself. */
function callsMaskedBrand(file: string): boolean {
  const source = parse(file, read(file));
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node) && calleeName(node) === "getStoreBrand") {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// ── R5: who writes moderation_blocked_at ───────────────────────────────────

const R5_DIRS = [
  "app",
  "lib",
  "components",
  "hooks",
  "scripts",
  "jobs",
  "services",
  "drizzle",
];
const R5_ALLOWED: { prefix: string; why: string }[] = [
  {
    prefix: "lib/moderation/",
    why: "StoreMink's own moderation code, which blocks and lifts",
  },
  {
    prefix: "drizzle/migrations/sql/20261030_0269_content_takedown.sql",
    why: "the migration whose trigger sets and clears the flag",
  },
];

/** The text inside the parentheses that open at `open`. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/** Each place `text` writes the flag, as a short description. */
function flagWrites(text: string): string[] {
  const writes: string[] = [];
  // SQL: an assignment in an UPDATE's SET list (after SET or a comma).
  const assignment = /(\bset\b|,)\s*"?moderation_blocked_at"?\s*=(?!=)/gi;
  for (const match of text.matchAll(assignment)) {
    writes.push(`SQL assignment: ${match[0].replace(/\s+/g, " ")}`);
  }
  // SQL: an INSERT naming the column.
  const insert = /insert\s+into\s+[\w."]+\s*\(([^)]*)\)/gi;
  for (const match of text.matchAll(insert)) {
    if (/\bmoderation_blocked_at\b/i.test(match[1])) {
      writes.push(`SQL insert: ${match[0].replace(/\s+/g, " ").slice(0, 80)}`);
    }
  }
  // Drizzle: the column in a set(), values() or onConflictDoUpdate() call.
  const call = /\.(set|values|onConflictDoUpdate)\s*\(/g;
  for (const match of text.matchAll(call)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    if (/\bmoderationBlockedAt\b/.test(balanced(text, open))) {
      writes.push(`Drizzle .${match[1]}() naming moderationBlockedAt`);
    }
  }
  return writes;
}

// ── The tests ──────────────────────────────────────────────────────────────

describe("the page swap's coverage (takedown T8a)", () => {
  for (const [file, classification] of Object.entries(READERS)) {
    describe(file, () => {
      const source = parse(file, read(file));
      const { values, problems } = valueExports(source);
      const names = values.map((value) => value.name);

      it("has no export this file cannot classify", () => {
        expect(problems).toEqual([]);
      });

      it("classifies every export, and every classified name exists", () => {
        const listed = [
          ...classification.masked,
          ...Object.keys(classification.exempt),
        ];
        const unclassified = names.filter((name) => !listed.includes(name));
        const missing = listed.filter((name) => !names.includes(name));
        const both = classification.masked.filter(
          (name) => name in classification.exempt,
        );
        expect(
          unclassified,
          `export(s) of ${file} that neither mask nor say why not: add maskBlockedMedia (outside any scope) or an exemption with its reason`,
        ).toEqual([]);
        expect(missing, `listed here but not exported by ${file}`).toEqual([]);
        expect(both).toEqual([]);
        for (const [name, why] of Object.entries(classification.exempt)) {
          expect(why.trim().length, `${name} needs a reason`).toBeGreaterThan(
            20,
          );
        }
      });

      if (classification.masked.length > 0) {
        it("imports the page swap from lib/moderation/blocked-objects", () => {
          expect(importsMask(source)).toBe(true);
        });
      }

      for (const name of classification.masked) {
        it(`${name} masks what it returns, outside every scope`, () => {
          const exported = values.find((value) => value.name === name);
          expect(exported, `${name} is not exported`).toBeDefined();
          const calls = maskCalls(exported!.node);
          expect(
            calls.length,
            `${name} returns rows without maskBlockedMedia`,
          ).toBeGreaterThan(0);
          for (const call of calls) {
            expect(
              call.enclosing,
              `${name} masks inside ${call.enclosing.join(" > ")}: mask after the scope returns (a reload opens its own scope) and never inside unstable_cache (a block would not show until it expires)`,
            ).toEqual([]);
          }
        });
      }
    });
  }

  it("finds the mask calls it is looking for (the detector works)", () => {
    const sample = parse(
      "sample.ts",
      `export const a = cache(async () => maskBlockedMedia(await withAnon(fn)));
       export const b = cache(async () => withAnon(async (db) => maskBlockedMedia(db)));
       export const c = unstable_cache(async () => maskBlockedMediaWith(x, set));
       export async function d() { return 1; }`,
    );
    const { values } = valueExports(sample);
    const byName = new Map(values.map((v) => [v.name, maskCalls(v.node)]));
    expect(byName.get("a")).toEqual([{ enclosing: [] }]);
    expect(byName.get("b")).toEqual([{ enclosing: ["withAnon"] }]);
    expect(byName.get("c")).toEqual([{ enclosing: ["unstable_cache"] }]);
    expect(byName.get("d")).toEqual([]);
  });

  it("lists every storefront file that renders a raw <img>", () => {
    const rendering = RAW_IMG_DIRS.flatMap((dir) =>
      files(
        dir,
        (path) => /\.(tsx|jsx)$/.test(path) && !path.includes(".test."),
      ),
    ).filter(rendersRawImg);
    const unlisted = rendering.filter((file) => !(file in RAW_IMG_FILES));
    const stale = Object.keys(RAW_IMG_FILES).filter(
      (file) => !rendering.includes(file),
    );
    expect(
      unlisted,
      "a storefront file renders a raw <img> the optimizer never sees: show its address comes through a masked read, then list it here with where it comes from",
    ).toEqual([]);
    expect(
      stale,
      "listed here but no longer renders a raw <img>: remove it",
    ).toEqual([]);
    for (const [file, why] of Object.entries(RAW_IMG_FILES)) {
      expect(why.trim().length, `${file} needs a reason`).toBeGreaterThan(20);
    }
  });

  it("lets no other dashboard file read the masked brand", () => {
    const readers = files(
      "app/dashboard",
      (path) => /\.(ts|tsx)$/.test(path) && !path.includes(".test."),
    ).filter(callsMaskedBrand);
    const unlisted = readers.filter(
      (file) => !(file in DASHBOARD_BRAND_READERS),
    );
    expect(
      unlisted,
      "a dashboard file reads the masked brand: an editor that saves the brand back must read getStoreBrandForEditing, or a blocked logo is erased from the settings",
    ).toEqual([]);
  });

  describe("R5: nothing outside lib/moderation/ and 0269 writes moderation_blocked_at", () => {
    it("recognises a write and leaves a read alone (the detector works)", () => {
      expect(
        flagWrites(
          "update public.products set moderation_blocked_at = now() where id = $1",
        ),
      ).toHaveLength(1);
      expect(
        flagWrites(
          "update public.blogs set title = 'x', moderation_blocked_at = null",
        ),
      ).toHaveLength(1);
      expect(
        flagWrites(
          "insert into public.products (id, moderation_blocked_at) values ($1, now())",
        ),
      ).toHaveLength(1);
      expect(
        flagWrites(
          "db.update(products).set({ moderationBlockedAt: new Date() })",
        ),
      ).toHaveLength(1);
      expect(
        flagWrites(
          "db.select({ moderationBlockedAt: products.moderationBlockedAt }).from(products)",
        ),
      ).toEqual([]);
      expect(
        flagWrites(
          "select 1 from public.products where moderation_blocked_at is null",
        ),
      ).toEqual([]);
      // The migration's own trigger is found too, so a detector that stops
      // matching cannot pass for ever.
      expect(
        flagWrites(
          read("drizzle/migrations/sql/20261030_0269_content_takedown.sql"),
        ).length,
      ).toBeGreaterThan(0);
    });

    it("finds no write anywhere else", () => {
      const scanned = R5_DIRS.flatMap((dir) =>
        files(dir, (path) => /\.(ts|tsx|js|jsx|mjs|sql)$/.test(path)),
      ).filter(
        (file) =>
          !R5_ALLOWED.some((allowed) => file.startsWith(allowed.prefix)),
      );
      const writes = scanned.flatMap((file) => {
        const text = read(file);
        if (!/moderation_blocked_at|moderationBlockedAt/.test(text)) return [];
        return flagWrites(text).map((write) => `${file}: ${write}`);
      });
      expect(
        writes,
        "only StoreMink's moderation code and migration 0269 may set or clear the flag: block or lift through content_blocks instead",
      ).toEqual([]);
    });
  });
});
