import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));

import { PLACEHOLDER_LICENSE_NOTE } from "./compiler";
import type { ThemePackageV2 } from "./contracts";
import { captureBlockers } from "./capture-core";
import { describeSlots } from "./slot-images-core";
import { operatorImagePackage, placeholderPackage } from "./_test-helpers";
import {
  FRESH_PHOTO_RUN_MIN_MS,
  PHOTO_RUN_CONTINUATIONS,
  THEME_STUDIO_TEXT_CAPACITY_SCOPE,
  firstCapturePhase,
  reachesFinalCheck,
} from "./worker";

/** A complete package with these art slots back to placeholders. */
function withPlaceholders(ids: readonly string[]): ThemePackageV2 {
  const pkg = operatorImagePackage();
  return {
    ...pkg,
    assets: pkg.assets.map((asset) =>
      ids.includes(asset.id)
        ? {
            ...asset,
            source: "generated" as const,
            licenseNote: PLACEHOLDER_LICENSE_NOTE,
          }
        : asset,
    ),
  };
}

const art = describeSlots(operatorImagePackage())
  .filter((slot) => !slot.catalogPreview && !slot.catalogScreenshot)
  .map((slot) => slot.id);
const catalogue = describeSlots(operatorImagePackage())
  .filter((slot) => slot.catalogPreview || slot.catalogScreenshot)
  .map((slot) => slot.id);

// TS-1D: an operator's photo run joins the automatic final check only when
// its result can reach it, so nothing that can never be captured is hidden.
describe("whether a photo run's result can reach the final check", () => {
  it("a complete version can, exactly as the final capture's own blockers say", () => {
    const pkg = operatorImagePackage();
    expect(captureBlockers(pkg)).toEqual([]);
    expect(reachesFinalCheck(pkg, [])).toBe(true);
  });

  it("a placeholder still owed to a fill round does not stop it; one the run was never asked to draw does", () => {
    expect(art.length).toBeGreaterThan(2);
    const pkg = withPlaceholders([art[0]]);
    expect(reachesFinalCheck(pkg, [art[0]])).toBe(true);
    expect(reachesFinalCheck(pkg, [])).toBe(false);
    expect(reachesFinalCheck(pkg, [art[1]])).toBe(false);
    expect(
      reachesFinalCheck(withPlaceholders([art[0], art[1]]), [art[0]]),
    ).toBe(false);
  });

  it("catalogue pictures still to be captured never stop it: the final capture takes them", () => {
    expect(catalogue.length).toBeGreaterThan(0);
    expect(reachesFinalCheck(withPlaceholders(catalogue), [])).toBe(true);
  });

  it("a capture blocker in the design itself stops it, whatever is owed", () => {
    const pkg = operatorImagePackage();
    const categories = pkg.definition.preset.sampleData?.categories ?? [];
    expect(categories.length).toBeGreaterThan(0);
    const noCategoryImage: ThemePackageV2 = structuredClone(pkg);
    noCategoryImage.definition.preset.sampleData!.categories[0].image_url = "";
    expect(captureBlockers(noCategoryImage, "layout").length).toBeGreaterThan(
      0,
    );
    expect(reachesFinalCheck(noCategoryImage, art)).toBe(false);
  });

  it("a design with no catalogue picture to capture has nothing to check", () => {
    const pkg: ThemePackageV2 = structuredClone(operatorImagePackage());
    pkg.definition.catalog.previewImage = "https://example.test/card.webp";
    pkg.definition.catalog.screenshots = [];
    expect(captureBlockers(pkg, "layout")).toEqual([]);
    expect(reachesFinalCheck(pkg, [])).toBe(false);
  });

  it("agrees with the final capture's blockers whenever nothing is owed", () => {
    const noCatalogue: ThemePackageV2 = structuredClone(operatorImagePackage());
    noCatalogue.definition.catalog.previewImage =
      "https://example.test/card.webp";
    noCatalogue.definition.catalog.screenshots = [];
    for (const pkg of [
      operatorImagePackage(),
      placeholderPackage(),
      withPlaceholders([art[0]]),
      withPlaceholders(catalogue),
      noCatalogue,
    ]) {
      expect(reachesFinalCheck(pkg, [])).toBe(
        captureBlockers(pkg, "final").length === 0,
      );
    }
  });
});

// TS-3B (plan optimisation 5): an edit or a late repair of a theme whose
// pictures are all there goes straight to the final capture; anything with a
// placeholder still measures its layout first, before photos are paid for.
describe("which capture a new version's checks start with", () => {
  it("a version with nothing left to draw goes straight to the final capture", () => {
    const pkg = operatorImagePackage();
    expect(captureBlockers(pkg, "final")).toEqual([]);
    expect(firstCapturePhase(pkg)).toBe("final");
  });

  it("a first build, all placeholders, measures its layout first", () => {
    expect(firstCapturePhase(placeholderPackage())).toBe("layout");
  });

  it("one placeholder left is enough to measure the layout first", () => {
    expect(firstCapturePhase(withPlaceholders([art[0]]))).toBe("layout");
  });
});

describe("TS-3B constants the plan names", () => {
  it("keeps a fresh photo run for nine minutes of request and three continuations", () => {
    expect(FRESH_PHOTO_RUN_MIN_MS).toBe(9 * 60_000);
    expect(PHOTO_RUN_CONTINUATIONS).toBe(3);
    // Theme Studio's own capacity row for its text calls, never the shared one.
    expect(THEME_STUDIO_TEXT_CAPACITY_SCOPE).toBe("theme-studio-text");
  });
});
