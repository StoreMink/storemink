import { describe, expect, it, vi } from "vitest";
import type {
  SampleCleanupReport,
  SampleCleanupStore,
} from "@/lib/themes/sample-cleanup";
import type { SampleSeeds } from "@/lib/themes/sample-cleanup-rules";
import {
  parseRemoveSamplesArgs,
  reportLines,
  runRemoveThemeSamples,
  skipReason,
  type RemoveSamplesDeps,
} from "./remove-theme-samples-core";

const PREVIEW = {
  demo: true,
  studioPreview: {
    projectId: "11111111-1111-4111-8111-111111111111",
    versionId: "22222222-2222-4222-8222-222222222222",
  },
};

const STORES: SampleCleanupStore[] = [
  { id: "s-echoss", slug: "echoss", settings: { template: "vitrine" } },
  { id: "s-demo", slug: "demo-vitrine", settings: { demo: true } },
  { id: "s-preview", slug: "studio-preview-abc", settings: PREVIEW },
  { id: "s-shop", slug: "kesar-shop", settings: {} },
];

const SEEDS: SampleSeeds = { products: [], categories: [] };

function report(
  store: SampleCleanupStore,
  overrides: Partial<SampleCleanupReport> = {},
): SampleCleanupReport {
  return {
    storeId: store.id,
    slug: store.slug,
    cleaned: false,
    skipped: null,
    products: [],
    categories: [],
    menus: false,
    chromeDraft: false,
    chromePublished: false,
    pages: [],
    dryRun: true,
    ...overrides,
  };
}

function deps(over: Partial<RemoveSamplesDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const clean = vi.fn(
    async (
      store: SampleCleanupStore,
      _seeds: SampleSeeds,
      options: { commit: boolean },
    ) =>
      store.slug === "echoss"
        ? report(store, {
            products: [{ id: "p1", slug: "rowan-ankle-boot", name: "Rowan" }],
            categories: [{ id: "c1", slug: "shoes", name: "Shoes" }],
            menus: true,
            pages: [""],
            cleaned: options.commit,
            dryRun: !options.commit,
          })
        : report(store),
  );
  const value: RemoveSamplesDeps = {
    env: { DB_NAME: "storemink_local", DB_HOST: "127.0.0.1", DB_PORT: "5544" },
    readStores: vi.fn(async () => STORES),
    seedsFor: vi.fn(async () => SEEDS),
    clean,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...over,
  };
  return { value, out, err, clean };
}

describe("parseRemoveSamplesArgs", () => {
  it("is a dry run with no arguments", () => {
    expect(parseRemoveSamplesArgs([])).toEqual({
      commit: false,
      confirmDatabase: null,
      store: null,
      help: false,
    });
  });

  it("reads both flag spellings", () => {
    expect(
      parseRemoveSamplesArgs([
        "--commit",
        "--confirm-database",
        "storemink",
        "--store=echoss",
      ]),
    ).toEqual({
      commit: true,
      confirmDatabase: "storemink",
      store: "echoss",
      help: false,
    });
  });

  it("★ refuses an unknown argument rather than ignoring it", () => {
    expect(parseRemoveSamplesArgs(["--comit"])).toEqual({
      error: "Unknown argument: --comit",
    });
  });

  it("refuses a flag with no value", () => {
    expect(parseRemoveSamplesArgs(["--store"])).toEqual({
      error: "--store needs a value.",
    });
    expect(parseRemoveSamplesArgs(["--confirm-database", "--commit"])).toEqual({
      error: "--confirm-database needs a value.",
    });
  });
});

describe("skipReason", () => {
  it("★ leaves demo and Theme Studio preview stores alone", () => {
    expect(skipReason({ settings: { demo: true } })).toBe("demo");
    expect(skipReason({ settings: PREVIEW })).toBe("preview");
    expect(skipReason({ settings: {} })).toBeNull();
    expect(skipReason({ settings: null })).toBeNull();
  });
});

describe("reportLines", () => {
  const store = STORES[0]!;

  it("says what a dry run would do", () => {
    expect(
      reportLines(
        report(store, {
          products: [{ id: "p1", slug: "boot", name: "Boot" }],
          categories: [{ id: "c1", slug: "shoes", name: "Shoes" }],
          menus: true,
          chromePublished: true,
          pages: ["", "about"],
        }),
      ),
    ).toEqual([
      "echoss: would remove 1 sample product(s), 1 sample category",
      "  products: boot",
      "  categories: shoes",
      "  links to them would be taken out of: menus, header and footer (live), page (homepage), page about",
    ]);
  });

  it("says what a committed run did", () => {
    const lines = reportLines(
      report(store, {
        products: [{ id: "p1", slug: "boot", name: "Boot" }],
        dryRun: false,
        cleaned: true,
      }),
    );
    expect(lines[0]).toBe(
      "echoss: removed 1 sample product(s), 0 sample categories",
    );
  });

  it("names a store with nothing to do, and one on a legal hold", () => {
    expect(reportLines(report(store))).toEqual(["echoss: no samples"]);
    expect(reportLines(report(store, { skipped: "legal_hold" }))).toEqual([
      "echoss: skipped, the store is on a legal hold",
    ]);
  });

  it("writes no long dash", () => {
    const text = reportLines(
      report(store, {
        products: [{ id: "p1", slug: "boot", name: "Boot" }],
        menus: true,
      }),
    ).join("\n");
    expect(text).not.toMatch(/[–—]/);
  });
});

describe("runRemoveThemeSamples", () => {
  it("★ a dry run cleans every merchant store without writing", async () => {
    const d = deps();
    const code = await runRemoveThemeSamples([], d.value);
    expect(code).toBe(0);
    expect(d.clean).toHaveBeenCalledTimes(2);
    for (const call of d.clean.mock.calls) {
      expect(call[2]).toEqual({ commit: false });
    }
    // Demo and preview stores are never passed to the clean-up.
    expect(d.clean.mock.calls.map((c) => c[0].slug)).toEqual([
      "echoss",
      "kesar-shop",
    ]);
    expect(d.out).toContain("Mode: dry run (writes nothing)");
    expect(d.out.join("\n")).toContain(
      "Would remove 1 sample product(s) and 1 sample category from 1 store(s). Skipped 2 demo or preview store(s). 0 failed.",
    );
    expect(d.out.join("\n")).toContain(
      "--commit --confirm-database storemink_local",
    );
  });

  it("★★ refuses to write without the database named", async () => {
    const d = deps();
    expect(await runRemoveThemeSamples(["--commit"], d.value)).toBe(2);
    expect(d.value.readStores).not.toHaveBeenCalled();
    expect(d.clean).not.toHaveBeenCalled();
    expect(d.err.join("\n")).toContain("--confirm-database storemink_local");
  });

  it("★★ refuses to write when the named database is not the one read", async () => {
    const d = deps();
    expect(
      await runRemoveThemeSamples(
        ["--commit", "--confirm-database", "storemink"],
        d.value,
      ),
    ).toBe(2);
    expect(d.clean).not.toHaveBeenCalled();
  });

  it("refuses to write when DB_NAME is unset", async () => {
    const d = deps({ env: {} });
    expect(
      await runRemoveThemeSamples(
        ["--commit", "--confirm-database", ""],
        d.value,
      ),
    ).toBe(2);
    expect(d.clean).not.toHaveBeenCalled();
  });

  it("commits when the named database matches", async () => {
    const d = deps();
    const code = await runRemoveThemeSamples(
      ["--commit", "--confirm-database", "storemink_local"],
      d.value,
    );
    expect(code).toBe(0);
    for (const call of d.clean.mock.calls) {
      expect(call[2]).toEqual({ commit: true });
    }
    expect(d.out).toContain("Mode: COMMIT (writes)");
    expect(d.out.join("\n")).toContain("Removed 1 sample product(s)");
    expect(d.out.join("\n")).not.toContain("Nothing was written");
  });

  it("cleans one store with --store, and refuses an unknown one", async () => {
    const one = deps();
    expect(await runRemoveThemeSamples(["--store", "echoss"], one.value)).toBe(
      0,
    );
    expect(one.clean).toHaveBeenCalledTimes(1);

    const none = deps();
    expect(await runRemoveThemeSamples(["--store", "nobody"], none.value)).toBe(
      2,
    );
    expect(none.err.join("\n")).toContain('No store with the address "nobody"');
  });

  it("★ a store that fails is reported and the rest still run", async () => {
    const d = deps({
      clean: vi.fn(async (store: SampleCleanupStore) => {
        if (store.slug === "echoss") throw new Error("deadlock detected");
        return report(store);
      }),
    });
    expect(await runRemoveThemeSamples([], d.value)).toBe(1);
    expect(d.err.join("\n")).toContain(
      "echoss: failed, nothing of it was changed (deadlock detected)",
    );
    expect(d.out.join("\n")).toContain("kesar-shop: no samples");
    expect(d.out.join("\n")).toContain("1 failed.");
  });

  it("prints the usage for --help and does nothing", async () => {
    const d = deps();
    expect(await runRemoveThemeSamples(["--help"], d.value)).toBe(0);
    expect(d.value.readStores).not.toHaveBeenCalled();
    expect(d.out[0]).toContain("Usage:");
  });

  it("refuses an unknown argument before reading anything", async () => {
    const d = deps();
    expect(await runRemoveThemeSamples(["--force"], d.value)).toBe(2);
    expect(d.value.readStores).not.toHaveBeenCalled();
  });
});
