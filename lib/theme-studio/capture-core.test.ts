import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_CAPTURE_MAX_ATTEMPTS,
  CAPTURED_LICENSE_NOTE,
  applyCapturedImages,
  captureBlockers,
  captureErrorKind,
  captureRetryDecision,
  captureShots,
  isDeployRecaptureKey,
  isEvidenceRecapture,
  isReservedCaptureKey,
  recheckIdempotencyKey,
  recheckReasonOf,
  remeasuresInPlace,
  versionPassedChecks,
} from "./capture-core";
import { PLACEHOLDER_LICENSE_NOTE } from "./compiler";
import { validateThemePackageV2, type ThemePackageV2 } from "./contracts";
import { createFakeModelClient } from "./fake-provider";
import { runThemeGeneration } from "./pipeline";

let built: Promise<ThemePackageV2> | null = null;

/** The offline theme: every slot a placeholder. Built once, copied per test. */
async function fixture(): Promise<ThemePackageV2> {
  built ??= (async () => {
    const base = {
      name: "Clay & Co",
      brief: "A calm ceramics shop.",
      industries: ["home" as const],
      catalogSizes: ["small" as const],
      requiredFeatures: [],
      referenceCount: 0,
    };
    const outcome = await runThemeGeneration(
      createFakeModelClient(base),
      {
        facts: {
          name: base.name,
          themeId: "clay-co",
          industries: ["home"],
          catalogSizes: ["small"],
          requiredFeatures: [],
          baseThemeName: null,
        },
        compile: {
          themeId: "clay-co",
          name: base.name,
          industries: ["home"],
          catalogSizes: ["small"],
          requiredFeatures: [],
          baseEngine: null,
          versionNumber: 1,
          modelKey: "gemini-3.8-flash",
          modelLabel: "Gemini 3.8 Flash",
          referenceDigests: [],
        },
        providerModel: "fake",
        promptVersion: "test",
        messages: [{ kind: "brief", body: base.brief }],
        references: [],
      },
      new AbortController().signal,
    );
    if (outcome.kind !== "version") throw new Error(outcome.kind);
    return outcome.package;
  })();
  return structuredClone(await built);
}

/** The fixture with every art slot holding a real (generated) image. */
async function drawn(): Promise<ThemePackageV2> {
  const pkg = await fixture();
  const catalog = new Set([
    pkg.definition.catalog.previewImage,
    ...pkg.definition.catalog.screenshots.map((s) => s.src),
  ]);
  for (const asset of pkg.assets) {
    if (!catalog.has(asset.path)) {
      asset.licenseNote = "Generated for this theme.";
    }
  }
  return pkg;
}

describe("what a capture photographs", () => {
  it("allows placeholder frames only in layout preflight and keeps final capture blocked", async () => {
    const pkg = await fixture();
    expect(captureBlockers(pkg).join(" ")).toContain("placeholder");
    expect(captureBlockers(pkg, "layout")).toEqual([]);
    pkg.definition.preset.sampleData!.products[0].image_url =
      pkg.definition.catalog.previewImage;
    expect(captureBlockers(pkg, "layout").join(" ")).toContain(
      "catalog screenshot slot",
    );
  });
  it("refuses catalog slots reused as storefront art so capture cannot invalidate browser evidence", async () => {
    const pkg = await drawn();
    pkg.definition.preset.sampleData!.products[0].image_url =
      pkg.definition.catalog.previewImage;
    expect(captureBlockers(pkg).join(" ")).toContain(
      "storefront image uses a catalog screenshot slot",
    );
  });
  it("shoots the card and both screenshots, each rendered larger than its slot", async () => {
    const shots = captureShots(await fixture());
    expect(shots.map((s) => s.slotId)).toEqual([
      "preview",
      "screenshot-desktop",
      "screenshot-mobile",
    ]);
    const bySlot = new Map(shots.map((s) => [s.slotId, s]));
    expect(bySlot.get("preview")).toMatchObject({
      viewport: { width: 1280, height: 960 },
      deviceScaleFactor: 2,
      mobile: false,
      path: "/",
    });
    expect(bySlot.get("screenshot-desktop")).toMatchObject({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      mobile: false,
    });
    expect(bySlot.get("screenshot-mobile")).toMatchObject({
      viewport: { width: 390, height: 823 },
      deviceScaleFactor: 3,
      mobile: true,
    });
    // The crop step never upscales, so every render must cover its slot.
    for (const shot of shots) {
      expect(
        shot.viewport.width * shot.deviceScaleFactor,
      ).toBeGreaterThanOrEqual(shot.target.width);
      expect(
        shot.viewport.height * shot.deviceScaleFactor,
      ).toBeGreaterThanOrEqual(shot.target.height);
      expect(shot.viewport.width / shot.viewport.height).toBeCloseTo(
        shot.target.aspect,
        2,
      );
    }
    expect(bySlot.get("preview")!.byteLimit).toBeLessThan(
      bySlot.get("screenshot-desktop")!.byteLimit,
    );
  });

  it("names the pictures without calling them placeholders", async () => {
    const shots = captureShots(await fixture());
    expect(shots.map((s) => s.alt)).toEqual([
      "Clay & Co: the storefront home page",
      "Clay & Co storefront on desktop",
      "Clay & Co storefront on mobile",
    ]);
  });
});

describe("when a capture would be pointless", () => {
  it("blocks legacy packages whose categories have no images even when all art slots are drawn", async () => {
    const pkg = await drawn();
    const category = pkg.definition.preset.sampleData!.categories![0];
    delete category.image_url;
    expect(captureBlockers(pkg)).toEqual([
      `1 categories have no image slot. Revise the theme to add imagery for: ${category.name}.`,
    ]);
  });

  it("waits while any art slot is still a placeholder", async () => {
    const blockers = captureBlockers(await fixture());
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/still a placeholder/);
  });

  it("has nothing to say once the art is real, whatever the catalog pictures are", async () => {
    expect(captureBlockers(await drawn())).toEqual([]);
  });

  it("refuses a version with no catalog pictures to take", async () => {
    const pkg = await drawn();
    pkg.definition.catalog.previewImage = "/themes/x/card.webp";
    pkg.definition.catalog.screenshots = [];
    // No longer catalog pictures, those slots would count as art.
    for (const asset of pkg.assets) asset.licenseNote = "Real image.";
    expect(captureBlockers(pkg)).toEqual([
      "This version has no catalog card or screenshot to capture.",
    ]);
  });
});

describe("the next version's package", () => {
  it("puts the captured pictures in, as StoreMink's own, with real alt text", async () => {
    const pkg = await drawn();
    const shots = captureShots(pkg);
    const captured = shots.map((shot, i) => ({
      slotId: shot.slotId,
      row: {
        id: `asset-${i}`,
        purpose: "image",
        sha256: String(i).repeat(64).slice(0, 64),
        width: shot.target.width,
        height: shot.target.height,
      },
    }));
    const applied = applyCapturedImages(pkg, captured, 4);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    for (const { slotId, row } of captured) {
      const asset = applied.value.assets.find((a) => a.id === slotId)!;
      expect(asset).toMatchObject({
        sha256: row.sha256,
        source: "operator-owned",
        licenseNote: CAPTURED_LICENSE_NOTE,
      });
      expect(asset.licenseNote).not.toBe(PLACEHOLDER_LICENSE_NOTE);
    }
    expect(
      applied.value.definition.catalog.screenshots.map((s) => s.alt),
    ).toEqual([
      "Clay & Co storefront on desktop",
      "Clay & Co storefront on mobile",
    ]);
    expect(applied.value.definition.release.version).toBe("0.0.4");
    expect(applied.value.definition.release.notes.at(-1)).toBe(
      "Catalog pictures captured from the preview: preview, screenshot-desktop, screenshot-mobile.",
    );
    expect(
      validateThemePackageV2(JSON.parse(JSON.stringify(applied.value))).ok,
    ).toBe(true);
  });

  it("refuses a picture of the wrong shape and an empty capture", async () => {
    const pkg = await drawn();
    const [card] = captureShots(pkg);
    expect(
      applyCapturedImages(
        pkg,
        [
          {
            slotId: card.slotId,
            row: {
              id: "a",
              purpose: "image",
              sha256: "a".repeat(64),
              width: 1600,
              height: 1600,
            },
          },
        ],
        2,
      ).ok,
    ).toBe(false);
    expect(applyCapturedImages(pkg, [], 2).ok).toBe(false);
  });
});

describe("isEvidenceRecapture", () => {
  const produced = {
    origin: "asset_edit",
    visibility: "internal",
    qaStatus: "pending",
    editDetail: { kind: "capture" },
  };
  it("recognises only a hidden, unjudged version an earlier capture produced", () => {
    expect(isEvidenceRecapture(produced)).toBe(true);
    // A generated or revised version still needs its catalog pictures taken.
    expect(isEvidenceRecapture({ ...produced, origin: "run" })).toBe(false);
    // An operator's image edit (no `kind`) is not a capture result.
    expect(
      isEvidenceRecapture({
        ...produced,
        editDetail: { fromVersionId: "v", slots: ["hero"] },
      }),
    ).toBe(false);
    // Already revealed or judged: a fresh capture, not a re-measure.
    expect(isEvidenceRecapture({ ...produced, visibility: "operator" })).toBe(
      false,
    );
    expect(isEvidenceRecapture({ ...produced, qaStatus: "failed" })).toBe(
      false,
    );
    expect(isEvidenceRecapture({ ...produced, editDetail: null })).toBe(false);
  });
});

describe("re-check keys", () => {
  const uuid = "0f6b4c1e-8f3a-4d2b-9c7e-1a2b3c4d5e6f";
  it("carries the reason inside the 16 to 80 characters the capture CHECK allows", () => {
    for (const reason of ["check_again", "publish_recheck"] as const) {
      const key = recheckIdempotencyKey(reason, uuid);
      expect(key).toBe(`recheck_${reason}_${uuid}`);
      expect(key.length).toBeGreaterThanOrEqual(16);
      expect(key.length).toBeLessThanOrEqual(80);
      expect(key).toMatch(/^[A-Za-z0-9_-]{16,80}$/);
      expect(recheckReasonOf(key)).toBe(reason);
    }
  });
  it("reads no reason from any other key", () => {
    expect(recheckReasonOf(`recheck_publish_${uuid}`)).toBeNull();
    expect(recheckReasonOf(`recheck_check_again_${uuid}x`)).toBeNull();
    expect(recheckReasonOf(`auto_final_${uuid}`)).toBeNull();
    expect(recheckReasonOf("capture-test-key-01")).toBeNull();
    expect(recheckReasonOf(undefined as unknown as string)).toBeNull();
  });
  it("knows a deploy re-capture by the prefix visual QA writes", () => {
    expect(isDeployRecaptureKey(`auto_recapture_${uuid}`)).toBe(true);
    expect(isDeployRecaptureKey(`auto_final_${uuid}`)).toBe(false);
    expect(isDeployRecaptureKey(undefined as unknown as string)).toBe(false);
  });
  it("keeps the server's prefixes out of an operator's key", () => {
    expect(
      isReservedCaptureKey(recheckIdempotencyKey("check_again", uuid)),
    ).toBe(true);
    expect(isReservedCaptureKey(`auto_recapture_${uuid}`)).toBe(true);
    expect(isReservedCaptureKey(`auto_final_${uuid}`)).toBe(true);
    expect(isReservedCaptureKey("capture-test-key-01")).toBe(false);
    expect(isReservedCaptureKey(`capture-${uuid}`)).toBe(false);
  });
});

describe("what is re-measured in place", () => {
  const uuid = "0f6b4c1e-8f3a-4d2b-9c7e-1a2b3c4d5e6f";
  const recheck = {
    automatic: true,
    idempotencyKey: recheckIdempotencyKey("publish_recheck", uuid),
  };
  const deploy = { automatic: true, idempotencyKey: `auto_recapture_${uuid}` };
  const retry = { automatic: true, idempotencyKey: "retry-key-0123456789" };
  const passed = {
    origin: "asset_edit",
    visibility: "operator",
    qaStatus: "passed",
    editDetail: { kind: "capture" },
  };
  const produced = {
    origin: "asset_edit",
    visibility: "internal",
    qaStatus: "pending",
    editDetail: { kind: "capture" },
  };

  it("takes a version that passed as visible and judged", () => {
    expect(versionPassedChecks(passed)).toBe(true);
    expect(versionPassedChecks({ ...passed, qaStatus: "failed" })).toBe(false);
    expect(versionPassedChecks({ ...passed, qaStatus: "not_required" })).toBe(
      false,
    );
    expect(versionPassedChecks(produced)).toBe(false);
  });

  it("★ re-checks and deploy re-captures of a visible version that passed", () => {
    expect(remeasuresInPlace(recheck, passed)).toBe(true);
    expect(
      remeasuresInPlace(
        {
          automatic: true,
          idempotencyKey: recheckIdempotencyKey("check_again", uuid),
        },
        passed,
      ),
    ).toBe(true);
    expect(remeasuresInPlace(deploy, passed)).toBe(true);
    // A version from a generation run that passed is the same case.
    expect(
      remeasuresInPlace(recheck, { ...passed, origin: "run", editDetail: {} }),
    ).toBe(true);
  });

  it("keeps re-measuring the hidden version an earlier capture produced", () => {
    expect(remeasuresInPlace(deploy, produced)).toBe(true);
    expect(remeasuresInPlace(retry, produced)).toBe(true);
    expect(remeasuresInPlace(recheck, produced)).toBe(true);
  });

  it("★ gives every other version a new hidden version", () => {
    // Retry automatic QA on a failed version: an operator's key, never in place.
    expect(remeasuresInPlace(retry, { ...passed, qaStatus: "failed" })).toBe(
      false,
    );
    expect(remeasuresInPlace(retry, passed)).toBe(false);
    // A re-check of a version that never passed takes fresh catalogue pictures.
    expect(remeasuresInPlace(recheck, { ...passed, qaStatus: "failed" })).toBe(
      false,
    );
    expect(
      remeasuresInPlace(recheck, { ...passed, qaStatus: "not_required" }),
    ).toBe(false);
    expect(remeasuresInPlace(deploy, { ...passed, qaStatus: "failed" })).toBe(
      false,
    );
    // A generated version still needs its catalogue pictures taken.
    expect(
      remeasuresInPlace(deploy, { ...produced, origin: "run", editDetail: {} }),
    ).toBe(false);
    // Manual captures never re-measure.
    expect(remeasuresInPlace({ ...recheck, automatic: false }, passed)).toBe(
      false,
    );
    expect(remeasuresInPlace({ ...deploy, automatic: false }, produced)).toBe(
      false,
    );
  });
});

// ★ Owner, 24 Oct 2026: a capture error a retry cannot fix fails at once.
describe("which reported capture errors are tried again", () => {
  it.each([
    // The same every time: a screenshot over the 512 KB limit, a report or
    // screenshot set the server refuses, an outdated job.
    "qa_screenshot_too_large",
    "qa_report_invalid",
    "qa_screenshots_invalid",
    "qa_screenshot_unusable",
    "capture_unusable",
    "capture_job_outdated",
  ])("%s comes back identically: deterministic", (code) => {
    expect(captureErrorKind(code)).toBe("deterministic");
  });

  it.each([
    // ★ One of our own preview pages answering 404 or another 4xx: a preview
    // answers 404 while the database is briefly out of reach too (the
    // preview gate and the store lookup fail closed), so it is judged by its
    // repeats, never failed on its first report. So is the not-found sample
    // answering 200, a status 0 and a redirect.
    "preview_status_404",
    "preview_status_403",
    "preview_status_401",
    "preview_status_410",
    "preview_status_400",
    "preview_status_499",
    "preview_status_200",
    "preview_status_0",
    "preview_status_302",
  ])("%s is judged by its repeats", (code) => {
    expect(captureErrorKind(code)).toBe("other");
  });

  it.each([
    "capture_timeout",
    "qa_measure_timeout",
    "capture_network",
    "acceptance_route_fetch",
    "capture_build_changed",
    "preview_status_429",
    "preview_status_500",
    "preview_status_502",
    "preview_status_503",
    "preview_status_504",
  ])("%s is the weather: transient", (code) => {
    expect(captureErrorKind(code)).toBe("transient");
  });

  it.each([
    "capture_browser_error",
    "qa_probe_missing",
    "qa_measure_failed",
    "capture_work_failed",
    "capture_failed",
    "preview_status_4041",
  ])("%s is neither: judged by its repeats", (code) => {
    expect(captureErrorKind(code)).toBe("other");
  });

  const decide = (
    code: string,
    attemptCount: number,
    previousCode: string | null = null,
  ) =>
    captureRetryDecision({
      code,
      kind: captureErrorKind(code),
      attemptCount,
      maxAttempts: AUTOMATIC_CAPTURE_MAX_ATTEMPTS,
      previousCode,
    });

  it("★ a deterministic error fails on its first report, with tries left", () => {
    expect(decide("qa_screenshot_too_large", 1)).toBe("fail");
  });

  it("★ a preview page's 404 is tried again, and fails only when the next try reports it again", () => {
    // The database was briefly out of reach: the next try loads the page.
    expect(decide("preview_status_404", 1)).toBe("requeue");
    expect(decide("capture_timeout", 2, "preview_status_404")).toBe("requeue");
    // A 404, then a different result, then a 404 again: still tried again.
    expect(decide("preview_status_404", 3, "capture_browser_error")).toBe(
      "requeue",
    );
    // The same 404 on two tries in a row is the page itself: it fails on
    // the second try, not the fifth.
    expect(decide("preview_status_404", 2, "preview_status_404")).toBe("fail");
    expect(decide("preview_status_403", 2, "preview_status_403")).toBe("fail");
    // A different 4xx before it is not a repeat.
    expect(decide("preview_status_404", 2, "preview_status_403")).toBe(
      "requeue",
    );
  });

  it("★ a transient error keeps every try, even when it repeats", () => {
    for (let attempt = 1; attempt < AUTOMATIC_CAPTURE_MAX_ATTEMPTS; attempt++)
      expect(decide("capture_timeout", attempt, "capture_timeout")).toBe(
        "requeue",
      );
    expect(
      decide(
        "capture_timeout",
        AUTOMATIC_CAPTURE_MAX_ATTEMPTS,
        "capture_timeout",
      ),
    ).toBe("fail");
  });

  it("★ any other error fails when the same code repeats on two tries in a row", () => {
    expect(decide("capture_browser_error", 1)).toBe("requeue");
    expect(decide("capture_browser_error", 2, "capture_browser_error")).toBe(
      "fail",
    );
    // A different code before it, or a try that lapsed without a report.
    expect(decide("capture_browser_error", 2, "capture_timeout")).toBe(
      "requeue",
    );
    expect(decide("capture_browser_error", 3, null)).toBe("requeue");
    // Out of tries, whatever it was.
    expect(
      decide("capture_browser_error", AUTOMATIC_CAPTURE_MAX_ATTEMPTS, null),
    ).toBe("fail");
  });
});
