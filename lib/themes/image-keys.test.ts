// Which settings keys hold a picture (22 Nov 2026): the phone photograph of
// an opening slide was reported "declared but nothing renders it" because
// only the key `image_url` was followed.
import { describe, expect, it } from "vitest";
import { isImageUrlKey } from "./image-keys";
import { studio } from "./definitions/studio";
import { collectThemeImageUrls } from "./validation";

describe("isImageUrlKey", () => {
  it("names every picture field a section can carry", () => {
    for (const key of [
      "image_url",
      "mobile_image_url",
      "cover_image_url",
      "poster_url",
      "logo_url",
    ])
      expect(isImageUrlKey(key), key).toBe(true);
  });

  it("does not name a video, a link or a look-alike", () => {
    for (const key of [
      "video_url",
      "url",
      "cta_url",
      "href",
      "image",
      "image_url_note",
      "imageUrl",
    ])
      expect(isImageUrlKey(key), key).toBe(false);
  });
});

describe("collectThemeImageUrls", () => {
  it("★ lists a slide's phone photograph, a poster and a logo beside its image_url", () => {
    const theme = structuredClone(studio);
    const page = theme.preset.pages[0];
    page.sections = [
      {
        ...page.sections[0],
        config: {
          slides: [
            {
              image_url: "/themes/studio/wide.webp",
              mobile_image_url: "/themes/studio/phone.webp",
            },
          ],
          poster_url: "/themes/studio/poster.webp",
          items: [{ logo_url: "/themes/studio/logo.webp" }],
          video_url: "/themes/studio/film.mp4",
          empty: { mobile_image_url: "" },
        },
      } as unknown as (typeof page.sections)[number],
    ];
    const urls = collectThemeImageUrls(theme);
    for (const path of ["wide", "phone", "poster", "logo"])
      expect(urls.has(`/themes/studio/${path}.webp`), path).toBe(true);
    // A film is not a picture, and an empty field names nothing.
    expect(urls.has("/themes/studio/film.mp4")).toBe(false);
    expect(urls.has("")).toBe(false);
  });
});
