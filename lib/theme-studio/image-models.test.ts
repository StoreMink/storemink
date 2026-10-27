import { ThinkingLevel, type GenerateContentConfig } from "@google/genai";
import { describe, expect, it } from "vitest";
import { IMAGE_SPECS } from "@/lib/media/image-specs";
import { MINK_MEDIA_PURPOSE_SPECS } from "@/lib/mink/media-generation-contract";
import { PERSONALIZATION_PHOTO_ASPECT } from "@/lib/mink/storefront-personalization-contract";
import { THEME_IMAGE_RULES } from "@/lib/themes/validation";
import {
  IMAGE_SAMPLING_PARAMETERS,
  IMAGE_SIZES,
  THEME_STUDIO_IMAGE_MODEL_KEY,
  THEME_STUDIO_ROLLBACK_IMAGE_MODEL_KEY,
  homepageOpeningPhotoIds,
  imageRequestConfig,
  isNanoBanana21,
  themeStudioImageSize,
  type ImageSize,
} from "./image-models";
import { placeholderPackage } from "./_test-helpers";
import {
  THEME_IMAGE_ASPECT_RATIOS,
  THEME_IMAGE_PURPOSES,
  type ThemeImageAspectRatio,
} from "./image-provider";
import { slotTargetSize } from "./slot-images-core";

// ---------------------------------------------------------------------------
// ★★ One image model for every picture (owner, 25 Oct 2026), the size each
// caller asks for, and the rules every request to the model follows.
// ---------------------------------------------------------------------------

const NB21 = "gemini-nano-banana-2.1";

/** A request as a caller builds it, before it is fitted to the model. */
function stated(
  change: Partial<GenerateContentConfig> = {},
  imageConfig: GenerateContentConfig["imageConfig"] = {},
): GenerateContentConfig {
  return {
    candidateCount: 1,
    imageConfig: { aspectRatio: "4:5", imageSize: "2K", ...imageConfig },
    thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    ...change,
  };
}

const SAMPLING: Partial<GenerateContentConfig> = {
  temperature: 1,
  topP: 0.9,
  topK: 40,
  seed: 7,
  presencePenalty: 0.1,
  frequencyPenalty: 0.1,
  responseLogprobs: true,
  logprobs: 3,
};

describe("the one image model", () => {
  it("★★ is Nano Banana 2.1 (owner, 25 Oct 2026), with Pro only as the owner's rollback", () => {
    expect(THEME_STUDIO_IMAGE_MODEL_KEY).toBe("gemini-nano-banana-2.1");
    expect(THEME_STUDIO_ROLLBACK_IMAGE_MODEL_KEY).toBe("gemini-3-pro-image");
  });

  it("knows 2.1 and its published versions, and nothing else", () => {
    for (const model of [NB21, `${NB21}-001`, `${NB21}-10-2026`]) {
      expect(isNanoBanana21(model), model).toBe(true);
    }
    for (const model of [
      "gemini-3-pro-image",
      "gemini-3.1-flash-image",
      "gemini-nano-banana-2",
      "gemini-nano-banana-2.10",
      `${NB21}-lite`,
      `${NB21}-preview`,
      "",
    ]) {
      expect(isNanoBanana21(model), model).toBe(false);
    }
  });
});

/** The slides the homepage opens with, as worker.ts names them. */
const SLIDES: ReadonlySet<string> = new Set(["home-slide"]);

describe("★★ Theme Studio's photo size (owner, 25 Oct 2026)", () => {
  it("draws every photo at 2K, and at 4K only the homepage's hero slides: a hero in a wide frame that the homepage opens with", () => {
    for (const purpose of THEME_IMAGE_PURPOSES) {
      for (const aspectRatio of THEME_IMAGE_ASPECT_RATIOS) {
        const wide = aspectRatio === "16:9" || aspectRatio === "21:9";
        const where = `${purpose} ${aspectRatio}`;
        expect(
          themeStudioImageSize(
            { purpose, aspectRatio, briefId: "home-slide" },
            SLIDES,
          ),
          where,
        ).toBe(purpose === "hero" && wide ? "4K" : "2K");
        // ★ The same frame for a photo the homepage does not open with: a
        // wide banner hero that opens a story or promo page is 2K.
        expect(
          themeStudioImageSize(
            { purpose, aspectRatio, briefId: "story-page-hero" },
            SLIDES,
          ),
          where,
        ).toBe("2K");
        // A caller that names no slides draws every photo at 2K.
        expect(
          themeStudioImageSize({ purpose, aspectRatio, briefId: "home-slide" }),
          where,
        ).toBe("2K");
        expect(themeStudioImageSize({ purpose, aspectRatio }), where).toBe(
          "2K",
        );
      }
    }
  });

  it("never names a size the model does not draw", () => {
    for (const purpose of THEME_IMAGE_PURPOSES) {
      for (const aspectRatio of THEME_IMAGE_ASPECT_RATIOS) {
        expect(IMAGE_SIZES).toContain(
          themeStudioImageSize(
            { purpose, aspectRatio, briefId: "home-slide" },
            SLIDES,
          ),
        );
      }
    }
    // A frame it cannot read is not wide.
    expect(
      themeStudioImageSize(
        { purpose: "hero", aspectRatio: "wide", briefId: "home-slide" },
        SLIDES,
      ),
    ).toBe("2K");
  });

  /** The placeholder package with its homepage (and a story page) opening
   * as given, each image naming one of the package's own slots. */
  function opening(home: unknown[], story: unknown[] = []) {
    const pkg = structuredClone(placeholderPackage());
    const path = (i: number) => pkg.assets[i].path;
    const pages = pkg.definition.preset.pages as unknown as {
      slug: string;
      sections: unknown[];
    }[];
    const fill = (sections: unknown[]) =>
      JSON.parse(
        JSON.stringify(sections).replace(/"@(\d+)"/g, (_m, i) =>
          JSON.stringify(path(Number(i))),
        ),
      );
    const homePage = pages.find((page) => page.slug === "");
    if (!homePage) throw new Error("no homepage");
    homePage.sections = fill(home);
    pages.push({ ...structuredClone(homePage), slug: "story" });
    pages[pages.length - 1].sections = fill(story);
    return { pkg, id: (i: number) => pkg.assets[i].id };
  }

  it("★ the photos the homepage opens with: a hero_carousel's slides, or a fullbleed hero's photo, never a hero elsewhere", () => {
    const carousel = (...images: string[]) => ({
      type: "hero_carousel",
      config: { slides: images.map((image_url) => ({ image_url })) },
    });
    const hero = (variant: string, image_url: string) => ({
      type: "hero",
      config: { variant, image_url },
    });
    // The slideshow's slides, and nothing below it or on another page.
    let built = opening(
      [carousel("@0", "@1"), hero("banner", "@2")],
      [carousel("@3"), hero("banner", "@4")],
    );
    expect(homepageOpeningPhotoIds(built.pkg)).toEqual(
      new Set([built.id(0), built.id(1)]),
    );
    // A fullbleed hero's photo; a disabled section before it is skipped.
    built = opening([
      { ...carousel("@0"), enabled: false },
      hero("fullbleed", "@1"),
    ]);
    expect(homepageOpeningPhotoIds(built.pkg)).toEqual(new Set([built.id(1)]));
    // A page listed before the homepage is still not the homepage.
    built = opening([hero("fullbleed", "@1")], [carousel("@2", "@3")]);
    (built.pkg.definition.preset.pages as unknown as unknown[]).reverse();
    expect(homepageOpeningPhotoIds(built.pkg)).toEqual(new Set([built.id(1)]));
    // A banner or split hero never opens the homepage (opening.ts): none.
    built = opening([hero("banner", "@0")]);
    expect(homepageOpeningPhotoIds(built.pkg)).toEqual(new Set());
    // Another first section, an image no slot holds, or no homepage: none.
    built = opening([{ type: "rich_text", config: {} }, carousel("@0")]);
    expect(homepageOpeningPhotoIds(built.pkg)).toEqual(new Set());
    built = opening([carousel("https://example.com/elsewhere.jpg", "")]);
    expect(homepageOpeningPhotoIds(built.pkg)).toEqual(new Set());
    const none = structuredClone(placeholderPackage());
    (none.definition.preset.pages as unknown as { slug: string }[]).forEach(
      (page) => {
        page.slug = `not-home-${page.slug}`;
      },
    );
    expect(homepageOpeningPhotoIds(none)).toEqual(new Set());
  });
});

describe("★★ every request to 2.1 (owner's spec, section 3)", () => {
  it("never carries a sampling parameter, whatever the caller put in", () => {
    const sent = imageRequestConfig(NB21, stated(SAMPLING));
    for (const parameter of IMAGE_SAMPLING_PARAMETERS) {
      expect(sent, parameter).not.toHaveProperty(parameter);
    }
    expect(Object.keys(SAMPLING).sort()).toEqual(
      [...IMAGE_SAMPLING_PARAMETERS].sort(),
    );
    // A published version follows the same rule.
    expect(
      imageRequestConfig(`${NB21}-001`, stated(SAMPLING)),
    ).not.toHaveProperty("temperature");
  });

  it("keeps the caller's size and thinking level and everything else as stated", () => {
    expect(
      imageRequestConfig(
        NB21,
        stated(
          { thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH } },
          { imageSize: "4K", aspectRatio: "21:9" },
        ),
      ),
    ).toEqual({
      candidateCount: 1,
      imageConfig: { aspectRatio: "21:9", imageSize: "4K" },
      thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
    });
  });

  it("asks for 1K when a legacy caller names 512 or 0.5K, which 2.1 refuses", () => {
    for (const legacy of ["512", "0.5K"]) {
      expect(
        imageRequestConfig(NB21, stated({}, { imageSize: legacy })).imageConfig
          ?.imageSize,
      ).toBe("1K");
    }
    for (const size of IMAGE_SIZES) {
      expect(
        imageRequestConfig(NB21, stated({}, { imageSize: size })).imageConfig
          ?.imageSize,
      ).toBe(size);
    }
  });

  it("★ refuses, before anything is sent, a request with no size, an unknown one, or no thinking level", () => {
    expect(() =>
      imageRequestConfig(NB21, stated({}, { imageSize: undefined })),
    ).toThrow(/must state its size/);
    expect(() =>
      imageRequestConfig(NB21, { ...stated(), imageConfig: undefined }),
    ).toThrow(/must state its size/);
    for (const unknown of ["2k", "8K", "1024", ""]) {
      expect(() =>
        imageRequestConfig(NB21, stated({}, { imageSize: unknown })),
      ).toThrow(/must state its size/);
    }
    expect(() =>
      imageRequestConfig(NB21, stated({ thinkingConfig: undefined })),
    ).toThrow(/thinking level/);
    expect(() =>
      imageRequestConfig(NB21, stated({ thinkingConfig: {} })),
    ).toThrow(/thinking level/);
  });

  it("never changes the caller's own config", () => {
    const config = stated(SAMPLING, { imageSize: "512" });
    const before = structuredClone(config);
    imageRequestConfig(NB21, config);
    imageRequestConfig("gemini-3-pro-image", config);
    expect(config).toEqual(before);
  });
});

describe("★★ a request to any other model (the owner's rollback)", () => {
  it("has no thinking config, as before 25 Oct, and everything else as given", () => {
    for (const model of [
      "gemini-3-pro-image",
      "gemini-3-pro-image-001",
      "gemini-3.1-flash-image",
    ]) {
      const sent = imageRequestConfig(
        model,
        stated(SAMPLING, { imageSize: "4K" }),
      );
      expect(sent, model).not.toHaveProperty("thinkingConfig");
      expect(sent.imageConfig?.imageSize).toBe("4K");
      // Whatever a rollback sends today, it keeps: sampling included.
      expect(sent.temperature).toBe(1);
      expect(sent.seed).toBe(7);
    }
    // A legacy size is passed through as given: only 2.1 refuses it.
    expect(
      imageRequestConfig(
        "gemini-3.1-flash-image",
        stated({}, { imageSize: "512" }),
      ).imageConfig?.imageSize,
    ).toBe("512");
    // ...but every request still states a size.
    expect(() =>
      imageRequestConfig(
        "gemini-3-pro-image",
        stated({}, { imageSize: undefined }),
      ),
    ).toThrow(/must state its size/);
  });
});

// ---------------------------------------------------------------------------
// ★★ No picture is drawn at a size StoreMink's own checks refuse.
// ---------------------------------------------------------------------------

type Frame = Record<ImageSize, readonly [number, number]>;

/**
 * The picture each size gives at each frame StoreMink asks for: Google's size
 * table for its Gemini 3 image models (each size twice the one below it).
 * Measured on Nano Banana 2.1 on storemink-staging, 25 Oct 2026: 2K at 4:3
 * (2400x1792), 4:5 (1856x2304), 1:1 (2048x2048), 16:9 (2752x1536) and 3:4
 * (1792x2400); 4K at 21:9 (6336x2688); 1K at 1:1 (1024x1024). The rest are
 * the table's (2K at 21:9 also measured on Pro, 3168x1344).
 */
const DRAWN: Record<ThemeImageAspectRatio, Frame> = {
  "1:1": { "1K": [1024, 1024], "2K": [2048, 2048], "4K": [4096, 4096] },
  "2:3": { "1K": [848, 1264], "2K": [1696, 2528], "4K": [3392, 5056] },
  "3:2": { "1K": [1264, 848], "2K": [2528, 1696], "4K": [5056, 3392] },
  "3:4": { "1K": [896, 1200], "2K": [1792, 2400], "4K": [3584, 4800] },
  "4:3": { "1K": [1200, 896], "2K": [2400, 1792], "4K": [4800, 3584] },
  "4:5": { "1K": [928, 1152], "2K": [1856, 2304], "4K": [3712, 4608] },
  "5:4": { "1K": [1152, 928], "2K": [2304, 1856], "4K": [4608, 3712] },
  "9:16": { "1K": [768, 1376], "2K": [1536, 2752], "4K": [3072, 5504] },
  "16:9": { "1K": [1376, 768], "2K": [2752, 1536], "4K": [5504, 3072] },
  "21:9": { "1K": [1584, 672], "2K": [3168, 1344], "4K": [6336, 2688] },
};

function aspect(ratio: string): number {
  const [w, h] = ratio.split(":").map(Number);
  return w / h;
}

/** The slot a frame is drawn for: a placeholder of exactly that shape. */
function slotOf(ratio: string) {
  return { width: Math.round(1000 * aspect(ratio)), height: 1000 };
}

describe("★★ the sizes each caller asks for pass StoreMink's own checks", () => {
  it("the table keeps each frame's shape, each size twice the one below", () => {
    for (const [ratio, frame] of Object.entries(DRAWN)) {
      for (const size of IMAGE_SIZES) {
        const [w, h] = frame[size];
        expect(Math.abs(w / h / aspect(ratio) - 1), ratio).toBeLessThan(0.05);
      }
      expect(frame["2K"]).toEqual(frame["1K"].map((edge) => edge * 2));
      expect(frame["4K"]).toEqual(frame["2K"].map((edge) => edge * 2));
    }
  });

  it("★★ Theme Studio and the redesign: every frame at the size asked for is at least 800 px wide and at least its slot's stored size, so nothing is refused, warned or enlarged", () => {
    for (const purpose of THEME_IMAGE_PURPOSES) {
      for (const ratio of THEME_IMAGE_ASPECT_RATIOS) {
        // Theme Studio's size, and the redesign's 2K for every photo.
        for (const size of [
          themeStudioImageSize(
            { purpose, aspectRatio: ratio, briefId: "home-slide" },
            SLIDES,
          ),
          "2K" as const,
        ]) {
          const [width, height] = DRAWN[ratio][size];
          const target = slotTargetSize(slotOf(ratio));
          if (!target) throw new Error(ratio);
          const where = `${purpose} ${ratio} at ${size}`;
          expect(width, where).toBeGreaterThanOrEqual(
            THEME_IMAGE_RULES.minWidth,
          );
          expect(width, where).toBeGreaterThanOrEqual(target.width);
          expect(height, where).toBeGreaterThanOrEqual(target.height);
        }
      }
    }
  });

  it("★★ Mink: a 2K picture is at least every upload slot's size, so Refine's exact fit only ever shrinks", () => {
    for (const [key, spec] of Object.entries(IMAGE_SPECS)) {
      const [width, height] = DRAWN[spec.aspect]["2K"];
      expect(width, key).toBeGreaterThanOrEqual(spec.width);
      expect(height, key).toBeGreaterThanOrEqual(spec.height);
    }
  });

  it("★★ Mink: every frame a chat image, a product re-shoot or a personalisation photo asks for is at least as wide at 2K as the widest slot of that shape", () => {
    const frames = new Set<string>([
      ...Object.values(MINK_MEDIA_PURPOSE_SPECS).map(
        (spec) => spec.aspectRatio,
      ),
      // A product photo for a square-card store (aspectRatioFor).
      "1:1",
      ...Object.values(PERSONALIZATION_PHOTO_ASPECT),
    ]);
    for (const ratio of frames) {
      const [width, height] = DRAWN[ratio as ThemeImageAspectRatio]["2K"];
      const widest = Object.values(IMAGE_SPECS).filter(
        (spec) => spec.aspect === ratio,
      );
      for (const spec of widest) {
        expect(width, `${ratio} for ${spec.label}`).toBeGreaterThanOrEqual(
          spec.width,
        );
        expect(height, `${ratio} for ${spec.label}`).toBeGreaterThanOrEqual(
          spec.height,
        );
      }
      expect(width, ratio).toBeGreaterThanOrEqual(THEME_IMAGE_RULES.minWidth);
    }
  });

  it("★ a legacy 512 or 0.5K becomes 1K, except at the one frame whose 1K picture is under the 800 px minimum, which becomes 2K", () => {
    const under = THEME_IMAGE_ASPECT_RATIOS.filter(
      (ratio) => DRAWN[ratio]["1K"][0] < THEME_IMAGE_RULES.minWidth,
    );
    expect(under).toEqual(["9:16"]);
    for (const ratio of THEME_IMAGE_ASPECT_RATIOS) {
      const size = imageRequestConfig(
        NB21,
        stated({}, { imageSize: "512", aspectRatio: ratio }),
      ).imageConfig?.imageSize as ImageSize;
      expect(size, ratio).toBe(under.includes(ratio) ? "2K" : "1K");
      expect(DRAWN[ratio][size][0], ratio).toBeGreaterThanOrEqual(
        THEME_IMAGE_RULES.minWidth,
      );
    }
  });
});
