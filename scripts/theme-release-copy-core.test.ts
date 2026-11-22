// Copying a Theme Studio theme between environments: what is copied, what is
// left alone and what refuses the whole copy (owner, 22 Nov 2026).
import { describe, expect, it } from "vitest";
import {
  COPY_FORMAT,
  compareVersions,
  describePlan,
  parseExportFile,
  pictureUrls,
  planCopy,
  type ExportFile,
  type TargetTheme,
} from "./theme-release-copy-core";

const D1 = "a".repeat(64);
const D2 = "b".repeat(64);
const D3 = "c".repeat(64);

const file = (
  over: Partial<ExportFile["themes"][number]> = {},
): ExportFile => ({
  format: COPY_FORMAT,
  sourceDatabase: "storemink_local",
  exportedAt: "2026-11-22T18:00:00.000Z",
  themes: [
    {
      themeId: "roast",
      currentVersion: "1.1.0",
      visibility: "public",
      releases: [
        { version: "1.1.0", manifestDigest: D2, package: { a: 1 } },
        { version: "1.0.0", manifestDigest: D1, package: { a: 0 } },
      ],
      ...over,
    },
  ],
});
const target = (over: Partial<TargetTheme> = {}): Map<string, TargetTheme> =>
  new Map([
    ["roast", { releases: new Map(), catalog: null, demoStore: null, ...over }],
  ]);
const themesOf = (plan: ReturnType<typeof planCopy>) => {
  if (!plan.ok) throw new Error(plan.problems.join("; "));
  return plan.themes;
};

describe("planCopy", () => {
  it("★★ a theme the target has never seen: every release oldest first, a new demo store, the catalogue last", () => {
    const [roast] = themesOf(planCopy(file(), target()));
    expect(roast.releases).toEqual([
      { version: "1.0.0", manifestDigest: D1, action: "insert" },
      { version: "1.1.0", manifestDigest: D2, action: "insert" },
    ]);
    expect(roast.expose).toEqual({ version: "1.1.0", visibility: "public" });
    expect(roast.demo).toBe("create");
    expect(roast.catalog).toBe("create");
  });

  it("a theme the target does not know at all is planned the same way", () => {
    const [roast] = themesOf(planCopy(file(), new Map()));
    expect(roast.catalog).toBe("create");
  });

  it("★ run again: releases already there with the same content are left alone, and nothing moves", () => {
    const [roast] = themesOf(
      planCopy(
        file(),
        target({
          releases: new Map([
            ["1.0.0", D1],
            ["1.1.0", D2],
          ]),
          catalog: { version: "1.1.0", visibility: "public" },
          demoStore: { isDemo: true },
        }),
      ),
    );
    expect(roast.releases.map((r) => r.action)).toEqual(["exists", "exists"]);
    expect(roast.catalog).toBe("unchanged");
    expect(roast.demo).toBe("reset");
  });

  it("★★ a release that exists with DIFFERENT content refuses the whole copy: a release is never rewritten", () => {
    const plan = planCopy(
      file(),
      target({ releases: new Map([["1.1.0", D3]]) }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.problems.join(" ")).toContain(
      "roast@1.1.0 already exists in the target with different content",
    );
  });

  it("the next version of a theme the target already offers moves the catalogue forward", () => {
    const [roast] = themesOf(
      planCopy(
        file(),
        target({
          releases: new Map([["1.0.0", D1]]),
          catalog: { version: "1.0.0", visibility: "public" },
          demoStore: { isDemo: true },
        }),
      ),
    );
    expect(roast.releases.map((r) => r.action)).toEqual(["exists", "insert"]);
    expect(roast.catalog).toBe("move");
  });

  it("★★ the catalogue never goes BACKWARDS: a target already on a newer version keeps it, and its demo is not reseeded", () => {
    const [roast] = themesOf(
      planCopy(
        file(),
        target({
          releases: new Map([["1.2.0", D3]]),
          catalog: { version: "1.2.0", visibility: "public" },
          demoStore: { isDemo: true },
        }),
      ),
    );
    expect(roast.expose).toBeNull();
    expect(roast.demo).toBe("leave");
    expect(roast.catalog).toBe("leave");
    expect(roast.notes.join(" ")).toContain("already offers v1.2.0");
    // The releases themselves are still copied.
    expect(roast.releases.map((r) => r.action)).toEqual(["insert", "insert"]);
  });

  it("★★ a demo slug held by a REAL store refuses the copy: seeding would reset it", () => {
    const plan = planCopy(file(), target({ demoStore: { isDemo: false } }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.problems.join(" ")).toContain("is not a demo store");
  });

  it("★ a theme id the target deleted for good refuses the copy", () => {
    const plan = planCopy(file(), target({ deleted: true }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.problems).toEqual([
      "roast was permanently deleted in the target. Its id stays reserved there, so it cannot be copied in again.",
    ]);
    expect(planCopy(file(), target({ deleted: false })).ok).toBe(true);
  });

  it("★ --visibility hidden copies without offering; a change of visibility alone moves the pointer", () => {
    const [hidden] = themesOf(
      planCopy(file(), target(), { visibility: "hidden" }),
    );
    expect(hidden.expose).toEqual({ version: "1.1.0", visibility: "hidden" });
    const [shown] = themesOf(
      planCopy(
        file(),
        target({
          releases: new Map([
            ["1.0.0", D1],
            ["1.1.0", D2],
          ]),
          catalog: { version: "1.1.0", visibility: "hidden" },
          demoStore: { isDemo: true },
        }),
      ),
    );
    expect(shown.catalog).toBe("move");
  });

  it("a theme the source does not offer copies its releases only", () => {
    const [roast] = themesOf(
      planCopy(file({ currentVersion: null, visibility: null }), target()),
    );
    expect(roast.expose).toBeNull();
    expect(roast.catalog).toBe("leave");
  });
});

describe("parseExportFile", () => {
  it("accepts what the export writes", () => {
    expect(parseExportFile(file()).ok).toBe(true);
  });

  it("★ refuses anything that is not one, and says why", () => {
    const bad = (value: unknown) => {
      const parsed = parseExportFile(value);
      return parsed.ok ? "" : parsed.problems.join(" ");
    };
    expect(bad(null)).toContain("Not a theme release export");
    expect(bad({ format: "other" })).toContain("Not a theme release export");
    expect(bad({ format: COPY_FORMAT, themes: [] })).toContain("no themes");
    expect(bad(file({ themeId: "Roast!" }))).toContain("no valid id");
    expect(bad(file({ releases: [] }))).toContain("has no releases");
    expect(bad(file({ currentVersion: "9.9.9" }))).toContain(
      "which the export does not carry",
    );
    expect(
      bad(
        file({
          releases: [
            { version: "1.1.0", manifestDigest: "short", package: {} },
            { version: "1.1.0", manifestDigest: D1, package: {} },
          ],
        }),
      ),
    ).toMatch(
      /no content digest.*appears twice|appears twice.*no content digest/,
    );
    const twice = file();
    twice.themes.push(twice.themes[0]);
    expect(bad(twice)).toContain("roast appears twice");
  });
});

describe("the small pieces", () => {
  it("versions compare by number, not as text", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.9.9", "1.0.0")).toBe(-1);
    expect(compareVersions("nonsense", "1.0.0")).toBe(-1);
  });

  it("finds every picture address in a package, once each", () => {
    expect(
      pictureUrls({
        a: "https://storage.googleapis.com/bucket/one.webp",
        b: ["https://storage.googleapis.com/bucket/two.webp", "plain words"],
        c: { d: "https://storage.googleapis.com/bucket/one.webp", e: 4 },
        f: "see https://example.com in a sentence",
      }),
    ).toEqual([
      "https://storage.googleapis.com/bucket/one.webp",
      "https://storage.googleapis.com/bucket/two.webp",
    ]);
  });

  it("says the plan in words", () => {
    const lines = describePlan(themesOf(planCopy(file(), target()))).join("\n");
    expect(lines).toContain("release v1.0.0");
    expect(lines).toContain("will be created and seeded from v1.1.0");
    expect(lines).toContain("will offer v1.1.0 as public");
  });
});
