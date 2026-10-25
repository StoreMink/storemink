import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import type { ThemeStudioAcceptanceRunView } from "@/lib/theme-studio/acceptance";
import { gate } from "@/lib/theme-studio/acceptance-gates";
import {
  PICTURE_FINDINGS,
  PICTURE_REVIEW_CODES,
  hasPlaceholderItem,
  redrawSlotIds,
  studioChecksModel,
} from "./checks-model";

// What the Checks tab lists (wave TS-2, builder 2C): Must fix, Warnings and
// Passed by kind, keyed the way the status words count them.

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

function run(
  gates: ThemeStudioAcceptanceRunView["gates"],
): ThemeStudioAcceptanceRunView {
  return {
    id: "run",
    versionId: "v2",
    status: "failed",
    packageDigest: "d",
    assetsDigest: "a",
    buildId: "build",
    evidenceDigest: null,
    createdByEmail: "op@storemink.com",
    createdAt: "2026-10-25T04:00:00Z",
    completedAt: "2026-10-25T04:05:00Z",
    gates,
    userAgent: null,
    currentBuild: true,
  };
}

const contrast = (where: string, ratio: number, target = ".hero-title") => ({
  code: "color-contrast",
  where,
  message: `Low contrast in ${target}`,
  targets: [target],
  contrast: [{ target, ratio, required: 4.5 }],
});

describe("studioChecksModel", () => {
  it("groups serious findings by kind, each sentence with its places", () => {
    const model = studioChecksModel({
      run: run([
        gate("browser.accessibility", [
          contrast("phone390 · product", 3.9),
          contrast("phone360 · home", 3.9),
          contrast("phone390 · shop", 2.1, ".shop-hero"),
        ]),
      ]),
      review: null,
    });
    expect(model.mustFix).toHaveLength(1);
    const [item] = model.mustFix;
    expect(item.key).toBe("checks|browser.accessibility|color-contrast");
    expect(item.heading).toBe("Readable text");
    expect(item.count).toBe(3);
    expect(item.lines).toEqual([
      {
        text: "Some text is hard to read (3.9 to 1, needs 4.5 to 1).",
        places: ["Product at 390 px", "Home at 360 px"],
      },
      {
        text: "Some text is hard to read (2.1 to 1, needs 4.5 to 1).",
        places: ["Shop at 390 px"],
      },
    ]);
    expect(item.storeMink).toBe(false);
    expect(item.measured).toBe(
      "phone390 · product: Low contrast in .hero-title",
    );
  });

  it("lists a check that does not stop Publish under Warnings and Passed, never under Must fix", () => {
    const model = studioChecksModel({
      run: run([
        gate("browser.tap_targets", [
          {
            code: "small_target",
            where: "phone390 · shop",
            message: "20×20px interactive target (.chip); minimum is 24×24px.",
          },
        ]),
        gate("routes.links", []),
      ]),
      review: null,
    });
    expect(model.mustFix).toEqual([]);
    expect(model.warnings.map((w) => w.key)).toEqual([
      "checks|browser.tap_targets|small_target",
    ]);
    expect(model.warnings[0].storeMink).toBe(true);
    expect(model.passed).toEqual([
      {
        id: "browser.tap_targets",
        heading: "Button sizes on phones",
        withWarnings: true,
      },
      { id: "routes.links", heading: "Links", withWarnings: false },
    ]);
  });

  it("keeps a minor finding inside a check that stops Publish out of Warnings (the Publish dialog's own rule)", () => {
    const model = studioChecksModel({
      run: run([
        gate("browser.clipped_text", [
          {
            code: "clipped_text",
            where: "phone390 · shop",
            message: "Text is clipped by 9px.",
            clipped: { x: 9, y: 0 },
          },
          {
            code: "clipped_text",
            where: "phone360 · home",
            message: "Text is clipped by 1px.",
            clipped: { x: 1, y: 0 },
          },
        ]),
      ]),
      review: null,
    });
    expect(model.mustFix).toHaveLength(1);
    expect(model.mustFix[0].lines).toEqual([
      { text: "Some text is cut off by 9 px.", places: ["Shop at 390 px"] },
    ]);
    expect(model.warnings).toEqual([]);
    expect(model.passed).toEqual([]);
  });

  it("never passes a required check that was not passed and says nothing serious", () => {
    const model = studioChecksModel({
      run: run([
        { ...gate("browser.coverage", []), status: "fail" as const },
        gate("package.schema", [{ code: "skipped", message: "Not run." }], {
          status: "skipped",
        }),
      ]),
      review: null,
    });
    expect(model.mustFix.map((item) => item.key)).toEqual([
      "checks|browser.coverage|",
      "checks|package.schema|skipped",
    ]);
    expect(model.mustFix[0].lines[0].text).toBe(
      "Part of the checks could not run, so it does not count as passed.",
    );
    expect(model.passed).toEqual([]);
  });

  it("calls a kind StoreMink's own only when every finding of it is", () => {
    const clip = (target: string, where: string) => ({
      code: "clipped_text",
      where,
      message: `Text is clipped by 9px (${target}).`,
      clipped: { x: 9, y: 0 },
      targets: [target],
    });
    const shared = studioChecksModel({
      run: run([
        gate("browser.clipped_text", [
          clip(".shop-card-base", "phone390 · shop"),
          clip(".pdp-price-base", "phone390 · product"),
        ]),
      ]),
      review: null,
    });
    expect(shared.mustFix[0].storeMink).toBe(true);
    const mixed = studioChecksModel({
      run: run([
        gate("browser.clipped_text", [
          clip(".shop-card-base", "phone390 · shop"),
          clip(".hero-title", "phone390 · home"),
        ]),
      ]),
      review: null,
    });
    expect(mixed.mustFix[0].storeMink).toBe(false);
  });

  it("never lists a check that did not run as passed, even one that is not required", () => {
    const model = studioChecksModel({
      run: run([
        gate(
          "browser.performance",
          [{ code: "skipped", message: "Speed was not measured." }],
          { required: false, status: "skipped" },
        ),
      ]),
      review: null,
    });
    expect(model.passed).toEqual([]);
    expect(model.mustFix).toEqual([]);
    expect(model.warnings.map((w) => w.key)).toEqual([
      "checks|browser.performance|skipped",
    ]);
  });

  it("keys the design review as the status counts it: serious per row or photo, warnings per code", () => {
    const model = studioChecksModel({
      run: null,
      review: {
        outcome: "serious",
        serious: [
          { code: "very_low_score", row: "responsiveComposition", score: 2 },
          { code: "very_low_score", row: "commerceClarity", score: 2 },
          { code: "image_hard_problem", slotId: "hero-main" },
        ],
        warnings: [
          { code: "low_score", row: "typography", score: 3 },
          { code: "low_score", row: "imagery", score: 3 },
          { code: "image_redraw", slotId: "category-bowls" },
        ],
      },
    });
    expect(model.mustFix.map((item) => item.key)).toEqual([
      "review|very_low_score|responsiveComposition",
      "review|very_low_score|commerceClarity",
      "review|image_hard_problem|hero-main",
    ]);
    expect(model.warnings.map((item) => item.key)).toEqual([
      "review|low_score",
      "review|image_redraw",
    ]);
    expect(model.warnings[0].lines.map((line) => line.text)).toEqual([
      "The design review scored the typography 3 of 5; it asks for 4.",
      "The design review scored the photos 3 of 5; it asks for 4.",
    ]);
    expect(model.mustFix[2]).toMatchObject({
      picture: true,
      slotIds: ["hero-main"],
      heading: "Photos",
    });
    expect(model.warnings[1]).toMatchObject({
      picture: true,
      slotIds: ["category-bowls"],
    });
  });

  it("marks the picture problems a redraw clears, with the slots they name", () => {
    const model = studioChecksModel({
      run: run([
        gate("assets.integrity", [
          { code: "missing", where: "hero-main", message: "Gone." },
          { code: "digest", where: "logo", message: "No digest." },
        ]),
        gate("assets.provenance", [
          {
            code: "placeholder",
            message: "3 artwork images are placeholders.",
          },
        ]),
      ]),
      review: null,
    });
    const byKey = new Map(model.mustFix.map((item) => [item.key, item]));
    expect(byKey.get("checks|assets.integrity|missing")).toMatchObject({
      picture: true,
      slotIds: ["hero-main"],
    });
    expect(byKey.get("checks|assets.integrity|digest")?.picture).toBe(false);
    expect(hasPlaceholderItem(model.mustFix)).toBe(true);
    expect(hasPlaceholderItem([])).toBe(false);
    expect(
      hasPlaceholderItem(
        model.mustFix.filter((item) => item.code !== "placeholder"),
      ),
    ).toBe(false);
    // A missing licence note is a picture source problem, not a placeholder.
    const licence = studioChecksModel({
      run: run([
        gate("assets.provenance", [
          { code: "license", where: "hero-main", message: "No note." },
        ]),
      ]),
      review: null,
    });
    expect(licence.mustFix).toHaveLength(1);
    expect(hasPlaceholderItem(licence.mustFix)).toBe(false);
    expect(
      redrawSlotIds(model.mustFix, new Set(["hero-main", "logo"])),
    ).toEqual(["hero-main"]);
    expect(redrawSlotIds(model.mustFix, new Set())).toEqual([]);
  });

  it("says nothing with a long dash, whatever was stored", () => {
    const model = studioChecksModel({
      run: run([
        gate("routes.links", [
          {
            code: "broken",
            where: `/shop ${EM} sale ${EN} 2`,
            message: `Returned 404 ${EM} gone`,
          },
        ]),
      ]),
      review: null,
    });
    const text = JSON.stringify(
      model.mustFix.map((item) => [item.heading, item.lines]),
    );
    expect(text.includes(EM) || text.includes(EN)).toBe(false);
  });
});

describe("★ the picture lists agree with the status words (progress.ts)", () => {
  const source = readFileSync(
    join("lib", "theme-studio", "progress.ts"),
    "utf8",
  );

  it("redraws exactly the check findings progress.ts counts as pictures", () => {
    const block = /const PICTURE_FINDINGS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(
      source,
    )?.[1];
    expect(block).toBeTruthy();
    const theirs: Record<string, string[]> = {};
    for (const entry of block!.matchAll(/"([\w.]+)":\s*\[([^\]]*)\]/g))
      theirs[entry[1]] = [...entry[2].matchAll(/"([\w]+)"/g)].map((m) => m[1]);
    expect(theirs).toEqual(
      Object.fromEntries(
        Object.entries(PICTURE_FINDINGS).map(([k, v]) => [k, [...v]]),
      ),
    );
  });

  it("redraws the review findings progress.ts counts as pictures, plus the small-problem warning", () => {
    const block =
      /const PICTURE_REVIEW_CODES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(
        source,
      )?.[1];
    expect(block).toBeTruthy();
    const theirs = [...block!.matchAll(/"([\w]+)"/g)].map((m) => m[1]);
    expect(theirs.length).toBeGreaterThan(0);
    expect(PICTURE_REVIEW_CODES.filter((c) => !theirs.includes(c))).toEqual([
      "image_redraw",
    ]);
    for (const code of theirs) expect(PICTURE_REVIEW_CODES).toContain(code);
  });
});
