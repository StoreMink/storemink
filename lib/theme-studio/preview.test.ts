import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { getThemeDefinition } from "@/lib/themes";
import { withService } from "@/lib/db/client";
import { themeDefinitionToPackageV2 } from "./contracts";
import { operatorImagePackage } from "./_test-helpers";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/themes/apply", () => ({
  applyThemeDefinition: vi.fn(async () => ({ success: true, errors: [] })),
}));

const {
  previewPagesFor,
  rewriteThemeAssets,
  PREVIEW_MISSING_PATH,
  openThemeStudioPreview,
  sweepThemeStudioPreviews,
} = await import("./preview");

describe("previewPagesFor", () => {
  it("resolves the six review surfaces against the package", () => {
    const pkg = themeDefinitionToPackageV2(getThemeDefinition("basket"));
    const pages = previewPagesFor(pkg);
    expect(pages.map((p) => p.surface)).toEqual([
      "home",
      "shop",
      "product",
      "cart",
      "content",
      "not_found",
    ]);
    const product = pkg.definition.preset.sampleData!.products[0];
    expect(pages[2].path).toBe(`/shop/${product.slug}`);
    expect(pages.at(-1)!.path).toBe(PREVIEW_MISSING_PATH);
  });

  it("omits a surface the package cannot show rather than linking a 404", () => {
    // A deep copy: the package shares the bundled definition's objects.
    const pkg = structuredClone(
      themeDefinitionToPackageV2(getThemeDefinition("basket")),
    );
    pkg.definition.preset.sampleData = undefined;
    pkg.definition.preset.pages = pkg.definition.preset.pages.filter(
      (p) => p.slug === "",
    );
    expect(previewPagesFor(pkg).map((p) => p.surface)).toEqual([
      "home",
      "shop",
      "cart",
      "not_found",
    ]);
  });
});

describe("rewriteThemeAssets", () => {
  it("replaces every theme-asset reference and blanks an unknown slot", () => {
    const def = structuredClone(getThemeDefinition("basket"));
    const home = def.preset.pages.find((p) => p.slug === "")!;
    (home.sections[0].config as unknown as Record<string, unknown>).image_url =
      "theme-asset://hero";
    def.preset.sampleData!.products[0].image_url = "theme-asset://product";
    def.preset.sampleData!.products[1].image_url = "theme-asset://missing";
    const out = rewriteThemeAssets(
      def,
      new Map([
        ["hero", "/api/theme-studio/placeholders/a"],
        ["product", "/api/theme-studio/placeholders/b"],
      ]),
    );
    expect(JSON.stringify(out)).not.toContain("theme-asset://");
    const outHome = out.preset.pages.find((p) => p.slug === "")!;
    expect(
      (outHome.sections[0].config as unknown as Record<string, unknown>)
        .image_url,
    ).toBe("/api/theme-studio/placeholders/a");
    expect(out.preset.sampleData!.products[0].image_url).toBe(
      "/api/theme-studio/placeholders/b",
    );
    expect(out.preset.sampleData!.products[1].image_url).toBe("");
    // The input is not mutated.
    expect(def.preset.sampleData!.products[0].image_url).toBe(
      "theme-asset://product",
    );
  });
});

describe("a preview a capture is measuring", () => {
  afterEach(() => vi.unstubAllEnvs());
  const projectId = "22222222-2222-4222-8222-222222222222";
  const opening = "33333333-3333-4333-8333-333333333333";
  const actor = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "op@x.dev",
  };
  const sibling = (n: number) => ({
    id: `preview-${n}`,
    storeId: `0000000${n}-0000-4000-8000-000000000000`,
    versionId: `version-${n}`,
  });

  /** Reads in the order openThemeStudioPreview makes them; deletes recorded
   * by the store id they name. */
  function openDb(measuring: string[]) {
    const pkg = operatorImagePackage();
    const reads: unknown[] = [
      [{ id: projectId, status: "ready" }],
      [{ id: opening, versionNumber: 4, packageJson: pkg }],
      [],
      [{ n: 3 }],
      // Least recently opened first.
      [sibling(1), sibling(2), sibling(3)],
      measuring.map((versionId) => ({ versionId })),
      [],
    ];
    const deleted: unknown[] = [];
    const db = {
      select: () => {
        const result = reads.shift() ?? [
          { expiresAt: "2026-10-25 10:00:00+00", packageJson: pkg },
        ];
        const query = {
          from: () => query,
          where: () => query,
          orderBy: () => query,
          for: () => query,
          limit: () => query,
          innerJoin: () => query,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(result).then(resolve),
        };
        return query;
      },
      delete: () => ({
        where: (cond: SQL) => ({
          returning: async () => {
            deleted.push(...new PgDialect().sqlToQuery(cond).params);
            return [{ id: "gone" }];
          },
        }),
      }),
      insert: () => ({
        values: () => ({ returning: async () => [{ id: "new-row" }] }),
      }),
      update: () => ({ set: () => ({ where: async () => [] }) }),
    };
    vi.mocked(withService).mockImplementation((async (work: unknown) =>
      (work as (db: unknown) => unknown)(db)) as never);
    vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "x".repeat(40));
    return deleted;
  }

  it("evicts the least recently opened preview when nothing is measuring", async () => {
    const deleted = openDb([]);
    await openThemeStudioPreview(actor, { projectId, versionId: opening });
    expect(deleted).toContain(sibling(1).storeId);
    expect(deleted).not.toContain(sibling(2).storeId);
  });

  it("★ never evicts the store a capture is measuring; the next oldest goes", async () => {
    const deleted = openDb([sibling(1).versionId]);
    await openThemeStudioPreview(actor, { projectId, versionId: opening });
    expect(deleted).not.toContain(sibling(1).storeId);
    expect(deleted).toContain(sibling(2).storeId);
    expect(deleted).not.toContain(sibling(3).storeId);
  });

  it("★ the retention sweep leaves a measured store alone, and keeps its shape", async () => {
    let where: unknown = null;
    const db = {
      select: () => {
        const query = {
          from: () => query,
          where: (cond: unknown) => {
            where = cond;
            return query;
          },
          orderBy: () => query,
          limit: async () => [],
        };
        return query;
      },
    };
    vi.mocked(withService).mockImplementation((async (work: unknown) =>
      (work as (db: unknown) => unknown)(db)) as never);
    expect(await sweepThemeStudioPreviews()).toEqual({ removed: 0 });
    const { sql } = new PgDialect().sqlToQuery(where as SQL);
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "theme_studio_captures"');
    expect(sql).toContain(
      '"theme_studio_captures"."version_id" = "theme_studio_previews"."version_id"',
    );
    expect(sql).toMatch(
      /"theme_studio_captures"\."status" = 'running'\s+AND "theme_studio_captures"\."lease_expires_at" > now\(\)/,
    );
    // Today's three reasons to sweep are all still there.
    expect(sql).toContain('"theme_studio_previews"."expires_at" < now()');
    expect(sql).toContain("status = 'archived'");
  });
});
