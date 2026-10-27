import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GATE_LABELS,
  THEME_STUDIO_QA_VIEWPORTS,
  type GateFinding,
} from "@/lib/theme-studio/acceptance-gates";
import { REJECTION_CONDITIONS } from "@/lib/theme-studio/scorecard";
import {
  CHECK_HEADINGS,
  FINDING_TEXT,
  REVIEW_FINDING_CODES,
  STOP_REASON_CODES,
  STUDIO_VIEWPORT_WIDTHS,
  buildTimeWords,
  checkCoverageWords,
  clockWords,
  copyDetailsText,
  designLabel,
  durationWords,
  findingWords,
  isKnownStopCode,
  placeWords,
  plainWords,
  ratioWords,
  reasonPhrase,
  reviewFindingWords,
  stopPhrase,
  stopReasonWords,
} from "./studio-words";
import type { StopKind } from "./studio-ui";

// ---------------------------------------------------------------------------
// TS-2A: the one words file. A sentence for every finding and stop code
// StoreMink writes (read from the sources, so a new code without words fails
// here), the measurement and the place in a finding's sentence, "StoreMink
// has been told" on StoreMink's own findings, Design N from one helper, the
// check screenshots' coverage from what was really measured, and never a
// long dash, a raw code or a number of credits in anything a person reads.
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, "../../../../../..");
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

function readable(text: string, what = text) {
  expect(text.includes(EM), what).toBe(false);
  expect(text.includes(EN), what).toBe(false);
  expect(text, what).not.toMatch(/credit/i);
  // No code-like word (snake_case, a gate id) reaches a sentence.
  expect(text, what).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  expect(text, what).not.toMatch(/\b(?:package|assets|routes|browser)\.[a-z]/);
}

function source(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

const finding = (
  code: string,
  extra: Partial<GateFinding> = {},
): GateFinding => ({
  code,
  message: "",
  ...extra,
});

describe("Design numbers", () => {
  it("names a design by its version number, everywhere", () => {
    expect(designLabel(1)).toBe("Design 1");
    expect(designLabel(12)).toBe("Design 12");
    expect(designLabel(0)).toBe("This design");
    expect(designLabel(Number.NaN)).toBe("This design");
    expect(designLabel(2.5)).toBe("This design");
  });
});

describe("time words", () => {
  it("says durations the way the progress card shows them", () => {
    expect(durationWords(50_000)).toBe("50 s");
    expect(durationWords(219_000)).toBe("3 min 39 s");
    expect(durationWords(180_000)).toBe("3 min");
    expect(durationWords(26 * 60_000 + 40_000)).toBe("26 min");
    expect(durationWords(65 * 60_000)).toBe("1 h 5 min");
    expect(durationWords(120 * 60_000)).toBe("2 h");
    expect(durationWords(0)).toBe("0 s");
    expect(durationWords(-5)).toBe("0 s");
    expect(durationWords(Number.NaN)).toBe("0 s");
  });

  it("tells the time in India time, with the date only on another day", () => {
    // 04:35 UTC is 10:05 in India.
    expect(clockWords("2026-10-25T04:35:00Z", "2026-10-25T09:00:00Z")).toBe(
      "10:05",
    );
    expect(clockWords("2026-10-01T04:35:00Z", "2026-10-25T09:00:00Z")).toBe(
      "1 Oct, 10:05",
    );
    // 19:00 UTC on 24 Oct is already 25 Oct in India.
    expect(clockWords("2026-10-24T19:00:00Z", "2026-10-25T09:00:00Z")).toBe(
      "00:30",
    );
    expect(clockWords("2025-12-31T04:35:00Z", "2026-10-25T09:00:00Z")).toBe(
      "31 Dec 2025, 10:05",
    );
    expect(clockWords("not a time", "2026-10-25T09:00:00Z")).toBe(
      "an unknown time",
    );
  });

  it("says the build time range as a sentence", () => {
    expect(
      buildTimeWords({
        fromMinutes: 35,
        toMinutes: 75,
        basedOn: 0,
        source: "default",
      }),
    ).toBe("Usually 35 to 75 minutes.");
  });
});

describe("stop reasons", () => {
  it("gives every stop code its own plain sentence", () => {
    for (const kind of Object.keys(STOP_REASON_CODES) as StopKind[]) {
      for (const code of STOP_REASON_CODES[kind]) {
        const sentence = stopReasonWords(code, kind);
        expect(sentence, `${kind}:${code}`).not.toBe(
          stopReasonWords(null, kind),
        );
        expect(sentence).toMatch(/[.]$/);
        readable(sentence, `${kind}:${code}`);
        expect(isKnownStopCode(code, kind)).toBe(true);
      }
    }
  });

  it("words the two families by pattern and anything else by kind", () => {
    expect(stopReasonWords("preview_status_404", "capture")).toBe(
      "A preview page answered with status 404 instead of opening, so the checks could not measure it. Check again.",
    );
    expect(isKnownStopCode("preview_status_503", "capture")).toBe(true);
    expect(isKnownStopCode("preview_status_503", "review")).toBe(false);
    expect(stopReasonWords("images_anchor_timeout", "run")).toBe(
      "The style picture could not be drawn, so nothing else was.",
    );
    expect(stopReasonWords("brand_new_code", "review")).toBe(
      "The automatic checks stopped.",
    );
    expect(stopReasonWords(undefined, "run")).toBe("This step stopped.");
    expect(isKnownStopCode("brand_new_code", "run")).toBe(false);
    expect(isKnownStopCode(null, "run")).toBe(false);
    // An inherited property is not a code.
    expect(stopReasonWords("constructor", "run")).toBe("This step stopped.");
    expect(isKnownStopCode("toString", "review")).toBe(false);
  });

  it("covers the stop codes TS-1 and TS-3 write outside the studio-ui guard's files", () => {
    const repository = [
      ...source("lib/theme-studio/repository.ts").matchAll(
        /errorCode: "([a-z0-9_]+)"/g,
      ),
    ].map((m) => m[1]);
    expect(repository.length).toBeGreaterThan(0);
    for (const code of repository)
      expect(isKnownStopCode(code, "review")).toBe(true);
    const stop = /THEME_STUDIO_STOP_CODE = "([a-z0-9_]+)"/.exec(
      source("lib/theme-studio/stop.ts"),
    )?.[1];
    expect(stop).toBe("cancelled");
    for (const kind of ["run", "capture", "review"] as const)
      expect(isKnownStopCode(stop, kind)).toBe(true);
    // The design review's own input errors (visual-qa.ts REVIEW_INPUT_ERRORS).
    const inputErrors = /REVIEW_INPUT_ERRORS[^=]*= new Set\(\[([^\]]+)\]/.exec(
      source("lib/theme-studio/visual-qa.ts"),
    )?.[1];
    const codes = [...(inputErrors ?? "").matchAll(/"([a-z0-9_]+)"/g)].map(
      (m) => m[1],
    );
    expect(codes).toContain("qa_input_missing");
    for (const code of codes)
      expect(isKnownStopCode(code, "review")).toBe(true);
  });

  it("makes a short phrase for the status words from a stop sentence", () => {
    expect(stopPhrase("capture_timeout", "capture")).toBe(
      "the capture took too long",
    );
    expect(stopPhrase("capture_build_changed", "capture")).toBe(
      "StoreMink was updated during every try of the capture",
    );
    expect(stopPhrase("qa_no_progress", "review")).toBe(
      "the automatic fixes stopped helping, so Theme Studio stopped them",
    );
    expect(reasonPhrase("Theme Studio stopped it. Then more.")).toBe(
      "Theme Studio stopped it",
    );
    expect(reasonPhrase("")).toBe("");
    const long = reasonPhrase(`${"word ".repeat(40)}end.`);
    expect(long.length).toBeLessThanOrEqual(103);
    expect(long.endsWith("...")).toBe(true);
    expect(reasonPhrase(`It broke ${EM} badly.`)).toBe("it broke, badly");
  });
});

describe("finding words", () => {
  it("has a heading for every check, and no gate id as one", () => {
    for (const gate of Object.keys(GATE_LABELS)) {
      expect(CHECK_HEADINGS[gate], gate).toBeTruthy();
      readable(CHECK_HEADINGS[gate]);
    }
    expect(Object.keys(CHECK_HEADINGS).sort()).toEqual(
      Object.keys(GATE_LABELS).sort(),
    );
  });

  it("has its own sentence for every finding code the checks write", () => {
    // The finding codes acceptance-gates.ts and acceptance.ts write as
    // literals, read from the sources so a new one without words fails.
    const written = new Set(
      [
        ...source("lib/theme-studio/acceptance-gates.ts").matchAll(
          /\bcode: "([a-z0-9_-]+)"/g,
        ),
        ...source("lib/theme-studio/acceptance.ts").matchAll(
          /\bcode: "([a-z0-9_-]+)"/g,
        ),
        ...source("lib/theme-studio/acceptance-gates.ts").matchAll(
          /\[\/[^\]]+\/, "([a-z_]+)"\]/g,
        ),
      ].map((m) => m[1]),
    );
    // fetchCode's three answers and imageRuleCode's fallback.
    for (const code of ["fetch", "budget", "timeout", "size"])
      written.add(code);
    expect(written.has("horizontal_overflow")).toBe(true);
    expect(written.has("state_unopened")).toBe(true);
    expect(written.has("preview_over_budget")).toBe(true);
    const worded = new Set([
      "skipped",
      "unmeasured",
      ...Object.values(FINDING_TEXT).flatMap((table) => Object.keys(table)),
    ]);
    const missing = [...written].filter((code) => !worded.has(code));
    expect(missing).toEqual([]);
  });

  it("never answers a bare code, and an unknown code gets its check's sentence", () => {
    for (const gate of Object.keys(GATE_LABELS)) {
      for (const code of [
        "brand_new_code",
        "skipped",
        "unmeasured",
        ...Object.keys(FINDING_TEXT[gate] ?? {}),
      ]) {
        const words = findingWords(gate, finding(code));
        readable(words.text, `${gate}:${code}`);
        readable(words.heading, `${gate}:${code}`);
        expect(words.text.length).toBeGreaterThan(10);
      }
    }
    expect(findingWords("routes.render", finding("brand_new_code")).text).toBe(
      "A page did not open as it should.",
    );
    expect(findingWords("made.up", finding("x")).text).toBe(
      "A check found a problem it did not name.",
    );
    expect(findingWords("made.up", finding("x")).heading).toBe("Checks");
    // A check that could not run says so, whichever check it is.
    expect(findingWords("browser.accessibility", finding("skipped")).text).toBe(
      "This check could not run, so it does not count as passed.",
    );
    expect(findingWords("browser.coverage", finding("unmeasured")).text).toBe(
      "This could not be measured, so it does not count as passed.",
    );
  });

  it("states contrast with its measurement and its place", () => {
    const words = findingWords(
      "browser.accessibility",
      finding("color-contrast", {
        where: "phone390 · product",
        impact: "serious",
        nodes: 1,
        targets: [".pdp-price-base"],
        contrast: [{ target: ".pdp-price-base", ratio: 3.94, required: 4.5 }],
        severity: "serious",
      }),
    );
    expect(words).toEqual({
      heading: "Readable text",
      text: "The struck price on the product page is hard to read (3.9 to 1, needs 4.5 to 1). This is in StoreMink's shared storefront code, not in this theme. StoreMink has been told.",
      place: "Product at 390 px",
      serious: true,
      storeMink: true,
    });
    // Rounded down, so a ratio just under the line never reads as passing,
    // and one at the line keeps a second decimal so it never looks equal.
    expect(ratioWords(4.47, 4.5)).toBe("4.4");
    expect(ratioWords(2.71, 4.5)).toBe("2.7");
    expect(ratioWords(4.52, 4.5)).toBe("4.52");
    expect(ratioWords(3, 3)).toBe("3");
    // The theme's own text: no StoreMink line.
    const own = findingWords(
      "browser.accessibility",
      finding("color-contrast", {
        where: "desktop1440 · home",
        contrast: [{ target: "h1.hero-title", ratio: 2.1, required: 3 }],
      }),
    );
    expect(own.text).toBe(
      "Some text is hard to read (2.1 to 1, needs 3 to 1).",
    );
    expect(own.storeMink).toBe(false);
    expect(own.serious).toBe(true);
    // Measured inside an opened panel, the panel names it.
    const menu = findingWords(
      "browser.accessibility",
      finding("color-contrast", {
        where: "phone360 · home · menu drawer",
        contrast: [{ target: "a.nav", ratio: 1.37, required: 4.5 }],
      }),
    );
    expect(
      menu.text.startsWith("Text in the menu drawer is hard to read (1.3 to 1"),
    ).toBe(true);
    expect(menu.place).toBe("Home at 360 px, menu drawer open");
    // A stricter line than AA (7 to 1) is held to the AA line, as severity is.
    const aaa = findingWords(
      "browser.accessibility",
      finding("color-contrast", {
        where: "phone390 · home",
        contrast: [{ target: "p.lede", ratio: 2.5, required: 7 }],
      }),
    );
    expect(aaa.text).toBe(
      "Some text is hard to read (2.5 to 1, needs 4.5 to 1).",
    );
    // No ratio it could read: still a sentence, and serious.
    const unread = findingWords(
      "browser.accessibility",
      finding("color-contrast", { where: "phone390 · shop" }),
    );
    expect(unread.text).toBe(
      "Some text is too faint to read, and its contrast could not be measured.",
    );
    expect(unread.serious).toBe(true);
  });

  it("reads the measurement out of a stored message where the finding keeps it there", () => {
    const cases: [string, GateFinding, string][] = [
      [
        "browser.overflow",
        finding("horizontal_overflow", {
          message: "The page is 24px wider than the viewport (.hero).",
          where: "phone360 · home",
        }),
        "The page is 24 px wider than the screen, so it scrolls sideways.",
      ],
      [
        "browser.clipped_text",
        finding("clipped_text", { clipped: { x: 0, y: 7 } }),
        "Some text is cut off by 7 px.",
      ],
      [
        "browser.image_crops",
        finding("extreme_crop", {
          message: "Only 31% of the source frame remains visible (img.tile).",
        }),
        "A photo is cropped so tightly that only 31% of it shows.",
      ],
      [
        "browser.media",
        finding("broken_image", { message: "3 images failed to load." }),
        "3 pictures did not load.",
      ],
      [
        "browser.performance",
        finding("lcp", { message: "LCP 4200ms; the limit is 3000ms." }),
        "The main content took 4.2 s to show; the limit is 3 s.",
      ],
      [
        "routes.render",
        finding("status", { message: "Returned 500, expected 200." }),
        "The page answered with status 500 instead of 200.",
      ],
      [
        "routes.links",
        finding("broken", { message: "Returned 404." }),
        "A link leads to a page that answered with status 404.",
      ],
      [
        "assets.provenance",
        finding("placeholder", {
          message:
            "3 artwork slot(s) are still StoreMink placeholders. Open Images to generate them.",
        }),
        "3 pictures are still a placeholder.",
      ],
      [
        "browser.coverage",
        finding("state_unopened", { where: "phone390 · home · cart drawer" }),
        "The cart drawer did not open when its button was pressed.",
      ],
      [
        "browser.tap_targets",
        finding("small_target", {
          message: "20×18px interactive target (.chip); minimum is 24×24px.",
          where: "phone390 · shop",
        }),
        "A button or link is 20 by 18 px; the smallest easy size to tap is 24 by 24 px. This is in StoreMink's shared storefront code, not in this theme. StoreMink has been told.",
      ],
    ];
    for (const [gate, input, text] of cases)
      expect(findingWords(gate, input).text, `${gate}:${input.code}`).toBe(
        text,
      );
  });

  it("follows the severity and platform rules, never deciding them itself", () => {
    expect(
      findingWords(
        "browser.tap_targets",
        finding("small_target", { severity: "minor" }),
      ),
    ).toMatchObject({ serious: false, storeMink: true });
    // A finding measured before severity-v1 counts as serious.
    expect(findingWords("routes.links", finding("broken")).serious).toBe(true);
    // Could not check it: never StoreMink's.
    expect(findingWords("browser.coverage", finding("skipped")).storeMink).toBe(
      false,
    );
  });

  it("words the theme validator's codes by area, the important ones on their own", () => {
    expect(
      findingWords(
        "package.design",
        finding("design.contrast", {
          message:
            "Body text on the page is hard to read (4.21:1, needs 4.5:1).",
        }),
      ).text,
    ).toBe(
      "Some text in the theme's colours is hard to read (4.2 to 1, needs 4.5 to 1).",
    );
    expect(
      findingWords("package.content", finding("pages.placeholder")).text,
    ).toBe("Some page text is unfinished placeholder copy.");
    expect(
      findingWords("package.content", finding("sample.brand_new")).text,
    ).toBe("The theme's sample products or categories are not finished.");
    expect(
      findingWords("package.content", finding("capability_gap")).text,
    ).toBe(
      "The design needs something StoreMink's storefront cannot show yet.",
    );
    expect(
      findingWords("package.security", finding("markup")).place,
    ).toBeNull();
  });

  it("names places plainly", () => {
    expect(placeWords("tablet768 · not_found")).toBe(
      "Not-found page at 768 px",
    );
    expect(placeWords("/shop/linen-shirt")).toBe("The page /shop/linen-shirt");
    expect(placeWords("definition.catalog.features")).toBeNull();
    expect(placeWords(undefined)).toBeNull();
    expect(
      findingWords(
        "assets.integrity",
        finding("missing", { where: "hero-main" }),
      ).place,
    ).toBe("Picture: hero main");
  });

  it("keeps its widths equal to the check's widths", () => {
    expect(STUDIO_VIEWPORT_WIDTHS).toEqual(
      Object.fromEntries(
        Object.entries(THEME_STUDIO_QA_VIEWPORTS).map(([key, size]) => [
          key,
          size.width,
        ]),
      ),
    );
  });
});

describe("design review words", () => {
  it("has a sentence for every review finding code StoreMink writes", () => {
    const written = new Set([
      ...REJECTION_CONDITIONS.map((c) => c.key),
      ...[
        ...source("lib/theme-studio/scorecard.ts").matchAll(
          /code: "([a-z0-9_]+)"/g,
        ),
        ...source("lib/theme-studio/qa-image-issues.ts").matchAll(
          /code: "([a-z0-9_]+)"/g,
        ),
        ...source("lib/theme-studio/visual-qa-request.ts").matchAll(
          /code: "([a-z0-9_]+)"/g,
        ),
      ].map((m) => m[1]),
    ]);
    expect(written.has("image_hard_problem")).toBe(true);
    expect(written.has("revise_requested")).toBe(true);
    const missing = [...written].filter(
      (c) => !REVIEW_FINDING_CODES.includes(c),
    );
    expect(missing).toEqual([]);
    for (const code of written) {
      const words = reviewFindingWords(
        { code, row: "typography", score: 2, slotId: "hero-1" },
        true,
      );
      readable(words.text, code);
      expect(words.text).not.toBe(
        "The design review found something it did not name.",
      );
    }
  });

  it("names the row and the score in plain words", () => {
    expect(
      reviewFindingWords(
        { code: "very_low_score", row: "responsiveComposition", score: 2 },
        true,
      ),
    ).toEqual({
      heading: "Design review",
      text: "The design review scored the phone layout 2 of 5, too low for a store to work well.",
      place: null,
      serious: true,
      storeMink: false,
    });
    expect(
      reviewFindingWords({ code: "low_total", score: 31 }, false).text,
    ).toBe("The design review gave 31 of 40 in all; it asks for 34.");
    expect(
      reviewFindingWords(
        { code: "image_hard_problem", slotId: "product-1" },
        true,
      ),
    ).toMatchObject({ heading: "Photos", place: "Picture: product 1" });
    expect(reviewFindingWords({ code: "brand_new" }, false).text).toBe(
      "The design review found something it did not name.",
    );
  });
});

describe("what the checks saw", () => {
  it("states the coverage from what was measured", () => {
    expect(
      checkCoverageWords({
        pages: ["home", "shop", "product", "cart", "content", "not_found"],
        widths: [1440, 360, 390, 768, 1024],
        panels: ["menu", "search", "cart", "account", "sign_in"],
        cartWasEmpty: true,
      }),
    ).toBe(
      "Checked 6 sample pages (home, shop, the first product, the cart while empty, the first content page and the not-found page) at 5 widths (360, 390, 768, 1024 and 1440 px), and opened the menu, search, cart, account and sign-in panels on the home page.",
    );
  });

  it("says when a theme has no product or content page, and what was not opened", () => {
    expect(
      checkCoverageWords({
        pages: ["home", "shop", "cart", "not_found"],
        widths: [390],
        panels: ["search"],
        cartWasEmpty: true,
      }),
    ).toBe(
      "Checked 4 sample pages (home, shop, the cart while empty and the not-found page) at 1 width (390 px), and opened the search panel on the home page. This theme has no product page and no content page, so none was checked.",
    );
    expect(
      checkCoverageWords({
        pages: ["home", "product", "content"],
        widths: [360, 1440],
        panels: [],
        cartWasEmpty: false,
      }),
    ).toBe(
      "Checked 3 sample pages (home, the first product and the first content page) at 2 widths (360 and 1440 px), and opened no header panels.",
    );
    expect(
      checkCoverageWords({
        pages: [],
        widths: [],
        panels: [],
        cartWasEmpty: false,
      }),
    ).toBe("These checks stored no screenshots.");
    // Never "while empty" unless the coverage says so.
    expect(
      checkCoverageWords({
        pages: ["cart", "product", "content"],
        widths: [390],
        panels: [],
        cartWasEmpty: false,
      }),
    ).toBe(
      "Checked 3 sample pages (the cart, the first product and the first content page) at 1 width (390 px), and opened no header panels.",
    );
  });
});

describe("Copy details", () => {
  it("puts one fact per line, in India time, without long dashes", () => {
    expect(
      copyDetailsText({
        themeName: "Aurora",
        themeId: "aurora",
        what: `Text in the menu ${EM} hard to read`,
        check: "browser.accessibility",
        code: "color-contrast",
        versionNumber: 2,
        build: "a1b2c3d",
        at: "2026-10-25T04:35:00.000Z",
      }),
    ).toBe(
      [
        "Theme: Aurora (aurora)",
        "What the screen said: Text in the menu, hard to read",
        "Check: browser.accessibility",
        "Code: color-contrast",
        "Design: Design 2 (version 2)",
        "Build: a1b2c3d",
        "Time: 25 Oct 2026, 10:05 India time (2026-10-25T04:35:00.000Z)",
      ].join("\n"),
    );
    expect(
      copyDetailsText({
        themeName: "Aurora",
        themeId: "aurora",
        what: "Stopped",
        check: null,
        code: null,
        versionNumber: null,
        build: null,
        at: null,
      }),
    ).toBe("Theme: Aurora (aurora)\nWhat the screen said: Stopped");
  });

  it("takes long dashes out of stored words", () => {
    expect(plainWords(`3${EN}5 pages ${EM} done`)).toBe("3 to 5 pages, done");
  });
});
