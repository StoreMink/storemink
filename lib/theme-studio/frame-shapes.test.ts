// A picture's shape comes from the frame it is shown in (owner, 22 Nov 2026).
import { describe, expect, it } from "vitest";
import type { ThemeIntent } from "./contracts";
import {
  FRAME_RATIO,
  briefsInFrameShapes,
  frameOrientations,
  orientationOf,
} from "./frame-shapes";

const slot = (id: string) => `theme-asset://${id}`;
const pages = [
  {
    sections: [
      {
        type: "hero_carousel",
        config: {
          slides: [
            {
              image_url: slot("hero-1"),
              mobile_image_url: slot("hero-1-phone"),
            },
            { image_url: slot("hero-2") },
          ],
        },
      },
      {
        type: "media_text",
        config: {
          image_url: slot("story"),
          media_ratio: "portrait",
          items: [{ image_url: slot("story-step") }],
        },
      },
      {
        type: "multicolumn",
        config: {
          image_ratio: "square",
          items: [
            { image_url: slot("value-1") },
            // An item's own setting wins over its section's.
            { image_url: slot("value-2"), image_ratio: "landscape" },
          ],
        },
      },
      {
        type: "shop_by_category",
        config: { tiles: [{ image_url: slot("cat") }] },
      },
      { type: "promo_banner", config: { image_url: slot("banner") } },
      // A tile grid's frames depend on its layout: nothing is claimed.
      { type: "tile_grid", config: { tiles: [{ image_url: slot("tile") }] } },
      // An external or empty address is no slot.
      {
        type: "media_text",
        config: { image_url: "", video_url: "https://x.test/v.mp4" },
      },
    ],
  },
  // Used again on another page: the first frame stands.
  {
    sections: [{ type: "promo_banner", config: { image_url: slot("story") } }],
  },
];
const briefs = (ratios: Record<string, string>): ThemeIntent =>
  ({
    assetBriefs: Object.entries(ratios).map(([id, aspectRatio]) => ({
      id,
      aspectRatio,
      purpose: id === "products" ? "Product photography" : id,
      subject: id,
      artDirection: "",
      source: "generate",
    })),
  }) as unknown as ThemeIntent;
const shaped = (ratios: Record<string, string>) =>
  Object.fromEntries(
    briefsInFrameShapes(briefs(ratios), pages, (id) => id === "products").map(
      (brief) => [brief.id, brief.aspectRatio],
    ),
  );

describe("reading the frames", () => {
  it("names the orientation of a ratio", () => {
    expect(orientationOf("4:5")).toBe("portrait");
    expect(orientationOf("1:1")).toBe("square");
    expect(orientationOf("4:3")).toBe("landscape");
    expect(orientationOf("3:2")).toBe("landscape");
    expect(orientationOf("16:9")).toBe("wide");
    expect(orientationOf("21:9")).toBe("wide");
    expect(orientationOf("nonsense")).toBeNull();
  });

  it("finds each slot's frame from its section and that section's settings", () => {
    expect(Object.fromEntries(frameOrientations(pages))).toEqual({
      "hero-1": "wide",
      "hero-1-phone": "portrait",
      "hero-2": "wide",
      story: "portrait",
      "story-step": "portrait",
      "value-1": "square",
      "value-2": "landscape",
      cat: "square",
      banner: "wide",
    });
  });
});

describe("★★ a brief takes the shape of its frame", () => {
  it("makes landscape product photography portrait: the first live theme's fault", () => {
    expect(shaped({ products: "4:3" }).products).toBe("4:5");
    // A square or portrait product photo already fits a card.
    expect(shaped({ products: "1:1" }).products).toBe("1:1");
    expect(shaped({ products: "3:4" }).products).toBe("3:4");
  });

  it("turns a picture in the wrong orientation to its frame's own ratio", () => {
    expect(
      shaped({
        "hero-1": "4:3",
        "hero-1-phone": "16:9",
        story: "16:9",
        "value-1": "4:5",
        "value-2": "1:1",
        cat: "4:3",
        banner: "1:1",
      }),
    ).toEqual({
      "hero-1": FRAME_RATIO.wide,
      "hero-1-phone": FRAME_RATIO.portrait,
      story: FRAME_RATIO.portrait,
      "value-1": FRAME_RATIO.square,
      "value-2": FRAME_RATIO.landscape,
      cat: FRAME_RATIO.square,
      banner: FRAME_RATIO.wide,
    });
  });

  it("leaves a picture already in its frame's orientation exactly as planned", () => {
    const planned = {
      "hero-1": "16:9",
      "hero-2": "21:9",
      story: "2:3",
      "value-2": "3:2",
      cat: "1:1",
      // Wide fills a landscape frame.
      banner: "21:9",
    };
    expect(shaped(planned)).toEqual(planned);
    expect(shaped({ "value-2": "16:9" })["value-2"]).toBe("16:9");
  });

  it("claims nothing for a picture whose frame it cannot know", () => {
    expect(shaped({ tile: "4:3", unused: "9:16" })).toEqual({
      tile: "4:3",
      unused: "9:16",
    });
  });
});

describe("★★ every opening slide gets a phone photograph", () => {
  // Imported here to keep the first block's imports as they were.
  const brief = (id: string, aspectRatio = "21:9") => ({
    id,
    purpose: `Homepage opening ${id}`,
    subject: "Cold brew poured over ice",
    aspectRatio,
    artDirection: "Warm morning light.",
    source: "generate" as const,
    people: "none" as const,
  });
  const intentWith = (...ids: string[]) =>
    ({ assetBriefs: ids.map((id) => brief(id)) }) as unknown as ThemeIntent;
  const draftWith = (sections: unknown[], slug: string | undefined = "") => ({
    pages: [
      { slug: "our-story", sections: [] },
      { slug, sections },
    ],
  });
  const carousel = (slides: unknown[]) => ({
    type: "hero_carousel",
    configJson: JSON.stringify({ height: "large", slides }),
  });
  const slidesOf = (draft: unknown) =>
    JSON.parse(
      (draft as { pages: { sections: { configJson: string }[] }[] }).pages[1]
        .sections[0].configJson,
    ).slides as { image_url: string; mobile_image_url?: string }[];

  it("adds a portrait brief of the same scene for each slide and points the slide at it", async () => {
    const { withPhoneOpening, PHONE_BRIEF_DIRECTION } =
      await import("./frame-shapes");
    const draft = draftWith([
      carousel([
        { image_url: "theme-asset://hero-1", heading: "Smooth" },
        { image_url: "theme-asset://hero-2" },
      ]),
      { type: "ticker", configJson: "{}" },
    ]);
    const before = JSON.stringify(draft);
    const out = withPhoneOpening(draft, intentWith("hero-1", "hero-2"), 40);
    expect(slidesOf(out.draft).map((s) => s.mobile_image_url)).toEqual([
      "theme-asset://hero-1-phone",
      "theme-asset://hero-2-phone",
    ]);
    expect(slidesOf(out.draft)[0]).toMatchObject({ heading: "Smooth" });
    const phone = out.intent.assetBriefs.find((b) => b.id === "hero-1-phone")!;
    expect(phone).toMatchObject({
      aspectRatio: "4:5",
      subject: "Cold brew poured over ice",
      purpose: "Homepage opening hero-1 (phone)",
      people: "none",
    });
    expect(phone.artDirection.startsWith(PHONE_BRIEF_DIRECTION)).toBe(true);
    expect(phone.artDirection).toContain("Warm morning light.");
    expect(out.intent.assetBriefs).toHaveLength(4);
    // The draft it was given is not changed.
    expect(JSON.stringify(draft)).toBe(before);
    // And a second pass (a repair round) adds nothing more.
    const again = withPhoneOpening(out.draft, out.intent, 40);
    expect(again.intent.assetBriefs).toHaveLength(4);
    expect(again.draft).toBe(out.draft);
  });

  it("keeps a phone photograph a slide already names, and serves a single full-band hero too", async () => {
    const { withPhoneOpening } = await import("./frame-shapes");
    const own = withPhoneOpening(
      draftWith([
        carousel([
          {
            image_url: "theme-asset://hero-1",
            mobile_image_url: "theme-asset://hero-2",
          },
        ]),
      ]),
      intentWith("hero-1", "hero-2"),
      40,
    );
    expect(own.intent.assetBriefs).toHaveLength(2);
    const single = withPhoneOpening(
      draftWith([
        {
          type: "hero",
          configJson: JSON.stringify({ image_url: "theme-asset://hero-1" }),
        },
      ]),
      intentWith("hero-1"),
      40,
    );
    expect(
      JSON.parse(
        (single.draft as { pages: { sections: { configJson: string }[] }[] })
          .pages[1].sections[0].configJson,
      ).mobile_image_url,
    ).toBe("theme-asset://hero-1-phone");
  });

  it("leaves alone what it has no business with", async () => {
    const { withPhoneOpening } = await import("./frame-shapes");
    const intent = intentWith("hero-1");
    // No room for another brief.
    const full = draftWith([carousel([{ image_url: "theme-asset://hero-1" }])]);
    expect(withPhoneOpening(full, intent, 1).draft).toBe(full);
    // The opening is not a photograph band, or is switched off.
    const ticker = draftWith([{ type: "ticker", configJson: "{}" }]);
    expect(withPhoneOpening(ticker, intent, 40).draft).toBe(ticker);
    // A slide naming a slot no brief describes, an external address, bad JSON.
    for (const sections of [
      [carousel([{ image_url: "theme-asset://unknown" }])],
      [carousel([{ image_url: "https://example.com/a.jpg" }])],
      [{ type: "hero_carousel", configJson: "{not json" }],
    ]) {
      const draft = draftWith(sections);
      const out = withPhoneOpening(draft, intent, 40);
      expect(out.draft).toBe(draft);
      expect(out.intent).toBe(intent);
    }
    expect(withPhoneOpening(null, intent, 40).draft).toBeNull();
  });
});
