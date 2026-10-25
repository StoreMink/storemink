import { describe, expect, it } from "vitest";
import {
  gate,
  GATE_LABELS,
  type GateFinding,
  type GateId,
  type GateResult,
} from "./acceptance-gates";
import {
  deterministicRepairs,
  qaProgress,
  qaImproved,
  parseQaRepairs,
} from "./qa-diagnosis";

/** A failed gate as stored before severity-v1: no severity, so every
 * finding counts as serious, as it did when it was measured. */
const legacy = (id: GateId, findings: GateFinding[]): GateResult => ({
  id,
  label: GATE_LABELS[id],
  required: true,
  status: "fail",
  findings,
});
const crop = (fraction: number) => [
  legacy("browser.image_crops", [
    {
      code: "extreme_crop",
      where: "tablet768 · content",
      message: `Only ${fraction}% of the source frame remains visible (img.home-hero-img).`,
    },
  ]),
];
const scores = {
  artDirection: 4,
  distinctness: 4,
  commerceClarity: 4,
  typography: 3,
  imagery: 4,
  responsiveComposition: 4,
  detailQuality: 4,
  brandAdaptability: 4,
};
describe("QA diagnosis and progress", () => {
  const contrast = (ratio: number) =>
    qaProgress([
      gate("browser.accessibility", [
        {
          code: "color-contrast",
          where: "phone360 · home",
          message:
            "Colour contrast (12 elements, serious); first: .shop-card-base",
          contrast: [{ target: ".shop-card-base", ratio, required: 4.5 }],
        },
      ]),
    ]);
  it("recognises 2.71 to 4.39 contrast repair progress while keeping the 4.5 gate", () => {
    expect(qaImproved(contrast(4.39), contrast(2.71))).toBe(true);
    expect(contrast(4.39).patterns).toHaveLength(1);
    expect(qaImproved(contrast(2.71), contrast(4.39))).toBe(false);
    expect(qaImproved(contrast(4.4), contrast(4.39))).toBe(false);
    expect(
      qaImproved(contrast(4.39), {
        ...contrast(2.71),
        contrastDeficits: undefined,
      }),
    ).toBe(false);
  });
  it("routes hit areas to the renderer, contrast and image frames to settings", () => {
    const r = deterministicRepairs([
      legacy("browser.tap_targets", [
        { code: "small_target", message: "9×9px (button.home-carousel-dot)." },
      ]),
      gate("browser.accessibility", [
        { code: "color-contrast", message: "Contrast" },
      ]),
      ...crop(24),
      gate("browser.accessibility", [
        { code: "button-name", message: "No name" },
      ]),
    ]);
    expect(r.map((x) => x.kind)).toEqual([
      "renderer",
      "settings",
      "settings",
      "renderer",
    ]);
    expect(r.some((x) => x.kind === "image")).toBe(false);
  });
  it("does not let improved contrast conceal a worsened crop", () => {
    const before = {
      ...contrast(2.71),
      severity: 20,
      patternSeverity: { contrast: 12, crop: 8 },
    };
    const after = {
      ...contrast(4.39),
      severity: 20,
      patternSeverity: { contrast: 11, crop: 9 },
    };
    expect(qaImproved(after, before)).toBe(false);
  });
  it("stops unchanged or worse frames, allows a meaningful improvement", () => {
    const p = qaProgress(crop(24));
    expect(qaImproved(qaProgress(crop(24)), p)).toBe(false);
    expect(qaImproved(qaProgress(crop(23)), p)).toBe(false);
    expect(qaImproved(qaProgress(crop(28)), p)).toBe(true);
    expect(qaImproved(qaProgress([]), p)).toBe(true);
    expect(qaImproved(qaProgress(crop(25)), p)).toBe(false); // noise
  });
  it("tracks vertical clipping severity and bare element targets", () => {
    const clipping = (px: number) =>
      qaProgress([
        gate("browser.clipped_text", [
          {
            code: "clipped_text",
            where: "phone360 · home",
            message: `Text is clipped by 0px horizontally and ${px}px vertically (h2).`,
          },
        ]),
      ]);
    expect(qaImproved(clipping(10), clipping(20))).toBe(true);
    expect(clipping(10).patterns[0]).toContain("h2");
  });
  it("does not count changing words or finding order as progress", () => {
    const a = gate("browser.clipped_text", [
      {
        code: "clipped_text",
        where: "phone360 · home",
        message: "Text clipped 8px (h2.home-title).",
      },
      {
        code: "clipped_text",
        where: "phone390 · home",
        message: "Text clipped 8px (h2.home-title).",
      },
    ]);
    const b = structuredClone(a);
    b.findings.reverse();
    b.findings[0].message = "Clipped text 8px (h2.home-title).";
    expect(qaProgress([a])).toEqual(qaProgress([b]));
    expect(qaImproved(qaProgress([b]), qaProgress([a]))).toBe(false);
    b.findings.pop();
    expect(qaImproved(qaProgress([b]), qaProgress([a]))).toBe(true);
  });
  it("tracks low-score deficits and rejection removal without accepting new rejections", () => {
    const p = qaProgress([], { scores, rejections: ["generic_surface"] });
    expect(
      qaImproved(
        qaProgress([], { scores, rejections: ["generic_surface"] }),
        p,
      ),
    ).toBe(false);
    expect(
      qaImproved(
        qaProgress([], {
          scores: { ...scores, typography: 4 },
          rejections: ["generic_surface"],
        }),
        p,
      ),
    ).toBe(true);
    expect(qaImproved(qaProgress([], { scores, rejections: [] }), p)).toBe(
      true,
    );
    expect(
      qaImproved(
        qaProgress([], {
          scores: { ...scores, typography: 5 },
          rejections: ["needs_custom_code"],
        }),
        p,
      ),
    ).toBe(false);
  });
  it("counts resolving an artwork target as progress even when overall scores stay the same", () => {
    const hero = { kind: "image" as const, target: "hero", reason: "Backdrop" };
    const product = {
      kind: "image" as const,
      target: "product",
      reason: "Warped handle",
    };
    const previous = qaProgress([], {
      scores,
      rejections: [],
      repairs: [hero, product],
    });
    expect(
      qaImproved(
        qaProgress([], { scores, rejections: [], repairs: [product] }),
        previous,
      ),
    ).toBe(true);
    expect(
      qaImproved(
        qaProgress([], { scores, rejections: [], repairs: [hero, product] }),
        previous,
      ),
    ).toBe(false);
    expect(
      qaImproved(
        qaProgress([], {
          scores,
          rejections: [],
          repairs: [{ ...product, target: "invented" }],
        }),
        previous,
      ),
    ).toBe(false);
  });
  it("validates closed routes and bounded targets", () => {
    expect(
      parseQaRepairs([
        { kind: "image", target: "hero", reason: "Subject is cropped" },
      ]),
    ).toHaveLength(1);
    expect(
      parseQaRepairs([{ kind: "deploy", target: null, reason: "Run code" }]),
    ).toBeNull();
    expect(
      parseQaRepairs([{ kind: "image", reason: "missing target" }]),
    ).toBeNull();
    expect(
      parseQaRepairs([
        { kind: "settings", target: "x", reason: "x".repeat(801) },
      ]),
    ).toBeNull();
  });
});

it("routes a failing performance gate to the renderer, never to a settings call", () => {
  const repairs = deterministicRepairs([
    {
      id: "browser.performance",
      label: "Performance",
      required: true,
      status: "fail",
      findings: [
        {
          code: "lcp",
          message: "LCP 4216ms; the limit is 3000ms.",
          where: "phone390 · home",
        },
      ],
    },
  ]);
  expect(repairs).toEqual([
    {
      kind: "renderer",
      target: null,
      reason: "Performance: LCP 4216ms; the limit is 3000ms.",
    },
  ]);
});

describe("warnings in the repair loop (severity-v1)", () => {
  const overflow = gate("browser.overflow", [
    {
      code: "horizontal_overflow",
      where: "phone360 · home",
      message: "The page is 40px wider than the viewport (div.hero).",
    },
  ]);
  const tapTarget = gate("browser.tap_targets", [
    {
      code: "small_target",
      where: "phone390 · home",
      message:
        "9×9px interactive target (button.home-carousel-dot); minimum is 24×24px.",
    },
  ]);
  const tightCrop = gate("browser.image_crops", [
    {
      code: "extreme_crop",
      where: "tablet768 · content",
      message:
        "Only 24% of the source frame remains visible (img.home-hero-img).",
    },
  ]);
  const language = gate("routes.markup", [
    { code: "lang", where: "/", message: "The page has no language." },
  ]);

  it("never turns a warning into paid work or a pattern that must not return", () => {
    expect(deterministicRepairs([tapTarget, tightCrop, language])).toEqual([]);
    expect(qaProgress([tapTarget, tightCrop, language]).patterns).toEqual([]);
  });

  it("does not let a renderer-only warning turn a repairable run into a renderer stop", () => {
    expect(
      deterministicRepairs([overflow, tapTarget, language]).map((r) => r.kind),
    ).toEqual(["settings"]);
  });

  it("keeps security-like markup serious while it is filed as renderer work", () => {
    const markup = gate("routes.markup", [
      { code: "lang", where: "/", message: "The page has no language." },
      {
        code: "external_resource",
        where: "/",
        message: "Loads https://t.example/a.js from another origin.",
      },
    ]);
    expect(markup.findings[0]).toMatchObject({
      code: "external_resource",
      severity: "serious",
    });
    expect(deterministicRepairs([markup])).toEqual([
      {
        kind: "renderer",
        target: null,
        reason:
          "Rendered markup: Loads https://t.example/a.js from another origin.",
      },
    ]);
  });

  it("counts a fix as progress when a new warning appears beside it", () => {
    const before = qaProgress([overflow]);
    const after = qaProgress([
      gate("browser.overflow", []),
      tightCrop,
      tapTarget,
    ]);
    expect(after.patterns).toEqual([]);
    expect(qaImproved(after, before)).toBe(true);
  });

  it("reads the same selector from an axe finding written before and after severity-v1", () => {
    const axe = (separator: string) =>
      qaProgress([
        gate("browser.accessibility", [
          {
            code: "button-name",
            impact: "critical",
            where: "phone360 · home",
            message: `Buttons must have discernible text (1 element, critical)${separator}examples: button.cart-icon: Fix any of the following`,
          },
        ]),
      ]).patterns;
    const before = axe(` ${String.fromCharCode(0x2014)} `);
    expect(before).toEqual([
      "browser.accessibility:button-name:phone360 · home:button.cart-icon",
    ]);
    expect(axe("; ")).toEqual(before);
  });

  it("repairs a gate that stops the run with nothing to say as incomplete", () => {
    const skipped = gate("routes.links", [], { status: "skipped" });
    expect(deterministicRepairs([skipped])).toEqual([
      {
        kind: "settings",
        target: null,
        reason: "Navigation links: Required evidence is incomplete.",
      },
    ]);
    expect(qaProgress([skipped]).patterns).toEqual(["routes.links:incomplete"]);
  });
});
