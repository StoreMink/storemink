import { describe, expect, it } from "vitest";
import {
  MINK_MEDIA_PROMPT_MAX_CHARS,
  MINK_MEDIA_PURPOSES,
  MINK_MEDIA_PURPOSE_SPECS,
  REFERENCE_FORM_ISSUE,
  aspectRatioFor,
  isMinkAiMadePhotoUrl,
  isMinkGeneratedCampaignArtUrl,
  isMinkGeneratedProductPhotoUrl,
  validateMinkMediaGenerationRequest,
} from "./media-generation-contract";

const valid = {
  schemaVersion: 3,
  purpose: "hero",
  prompt: "A warm overhead still life of loose grains and pulses on linen.",
  referenceImageUrls: [],
  alt: "Grains and pulses arranged on a linen cloth",
};

describe("Phase 9E generation request", () => {
  it("accepts a complete request and normalises its text", () => {
    const result = validateMinkMediaGenerationRequest({
      ...valid,
      prompt: `  ${valid.prompt}  `,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prompt).toBe(valid.prompt);
    expect(result.value.purpose).toBe("hero");
    expect(result.value.referenceImageUrls).toEqual([]);
  });

  it("refuses an unknown key rather than ignoring it", () => {
    // A caller that sent `negativePrompt` believes it took effect. Silently
    // dropping it is how a merchant is told a guarantee applied that did not.
    const result = validateMinkMediaGenerationRequest({
      ...valid,
      negativePrompt: "no logos",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain("negativePrompt");
  });

  it("refuses a purpose it does not know, naming the ones it does", () => {
    const result = validateMinkMediaGenerationRequest({
      ...valid,
      purpose: "wallpaper",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain("hero");
  });

  it("refuses a prompt too thin to be worth a real image", () => {
    const result = validateMinkMediaGenerationRequest({
      ...valid,
      prompt: "rice",
    });
    expect(result.ok).toBe(false);
  });

  it("bounds a long prompt", () => {
    const result = validateMinkMediaGenerationRequest({
      ...valid,
      prompt: "a".repeat(MINK_MEDIA_PROMPT_MAX_CHARS + 1),
    });
    expect(result.ok).toBe(false);
  });

  it("requires alt text, because nothing else will ever ask for it", () => {
    const result = validateMinkMediaGenerationRequest({ ...valid, alt: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain("screen reader");
  });

  it("bounds and normalises exact reference image URLs", () => {
    const url = "https://storage.googleapis.com/bucket/product.webp";
    const result = validateMinkMediaGenerationRequest({
      ...valid,
      referenceImageUrls: [url, url],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.referenceImageUrls).toEqual([url]);

    expect(
      validateMinkMediaGenerationRequest({
        ...valid,
        referenceImageUrls: Array.from(
          { length: 5 },
          (_, index) => `https://example.com/${index}.png`,
        ),
      }).ok,
    ).toBe(false);
  });

  describe("a picture attached in this chat as a reference", () => {
    const id = "0f3a9c42-7b1d-4e6a-9c2b-1d5e8f7a6b3c";
    const bare = `/api/mink/attachments/${id}`;

    it("★ accepts the bare attachment address as it is", () => {
      const result = validateMinkMediaGenerationRequest({
        ...valid,
        referenceImageUrls: [bare],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.referenceImageUrls).toEqual([bare]);
    });

    it("★★ accepts the address with any host the model put in front of it, normalised to the bare path", () => {
      const result = validateMinkMediaGenerationRequest({
        ...valid,
        referenceImageUrls: [
          `https://echoss.storemink.com${bare}`,
          `http://echoss.localtest.me:3000/api/mink/attachments/${id.toUpperCase()}`,
          "https://storage.googleapis.com/bucket/product.webp",
        ],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // One address in three spellings is one reference, the bare path.
      expect(result.value.referenceImageUrls).toEqual([
        bare,
        "https://storage.googleapis.com/bucket/product.webp",
      ]);
    });

    it("still refuses http:// and every other non-https path", () => {
      for (const entry of [
        "http://cdn.example.com/product.png",
        "http://echoss.storemink.com/uploads/product.png",
        "/uploads/product.png",
        "/api/mink/attachments/not-an-id",
        `${bare}/extra`,
        "ftp://storage.googleapis.com/bucket/product.webp",
      ]) {
        const result = validateMinkMediaGenerationRequest({
          ...valid,
          referenceImageUrls: [entry],
        });
        expect(result.ok, entry).toBe(false);
        if (result.ok) continue;
        expect(result.issues).toContain(REFERENCE_FORM_ISSUE);
      }
    });

    it("★ names both accepted forms in the refusal", () => {
      // The model reads this back after a refused reference. Saying only
      // "HTTPS URL" told it an attachment address was not allowed, which is
      // false since attachments became references.
      expect(REFERENCE_FORM_ISSUE).toBe(
        "References need HTTPS or an attachment address.",
      );
    });
  });

  it("requires the caller to report the outcome of its reference reads", () => {
    const result = validateMinkMediaGenerationRequest({
      purpose: valid.purpose,
      prompt: valid.prompt,
      alt: valid.alt,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain("referenceImageUrls");
  });

  it("reports every problem at once so one retry can fix them all", () => {
    const result = validateMinkMediaGenerationRequest({
      schemaVersion: 3,
      purpose: "nope",
      prompt: "x",
      referenceImageUrls: "none",
      alt: "",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the shape a purpose pins", () => {
  it("gives every purpose an aspect ratio the image model accepts", () => {
    const supported = new Set(["1:1", "3:4", "4:3", "16:9", "9:16", "21:9"]);
    for (const purpose of MINK_MEDIA_PURPOSES) {
      expect(supported.has(aspectRatioFor(purpose))).toBe(true);
      expect(MINK_MEDIA_PURPOSE_SPECS[purpose].label).toBeTruthy();
      expect(MINK_MEDIA_PURPOSE_SPECS[purpose].placement).toBeTruthy();
    }
  });

  it("takes the aspect from the purpose, never from the caller", () => {
    // ★ Pinned because the temptation is to add an `aspectRatio` field. A
    //   model choosing 9:16 for a hero produces an image the renderer then
    //   crops through the middle of its subject.
    const result = validateMinkMediaGenerationRequest({
      ...valid,
      aspectRatio: "9:16",
    });
    expect(result.ok).toBe(false);
  });

  it("pins editorial blog covers to a landscape social-preview shape", () => {
    expect(MINK_MEDIA_PURPOSE_SPECS.blog_cover).toMatchObject({
      label: "Blog cover",
      aspectRatio: "16:9",
    });
    expect(aspectRatioFor("blog_cover")).toBe("16:9");
  });
});

describe("catalogue product photos (purpose product)", () => {
  const STORE = "a0000000-0000-4000-8000-000000000001";
  const art = `https://storage.googleapis.com/b/stores/${STORE}/mink-generated/11111111-1111-4111-8111-111111111111.jpg`;
  const photo = `https://storage.googleapis.com/b/stores/${STORE}/mink-generated/product-photos/11111111-1111-4111-8111-111111111111.jpg`;
  const upload = `https://storage.googleapis.com/b/stores/${STORE}/media/photo.webp`;

  it("is a declared purpose whose shape follows the store's card", () => {
    expect(MINK_MEDIA_PURPOSES).toContain("product");
    expect(MINK_MEDIA_PURPOSE_SPECS.product.label).toBe("Product photo");
    // Portrait is the storefront default; a square-card store gets 1:1.
    expect(aspectRatioFor("product")).toBe("3:4");
    expect(aspectRatioFor("product", "portrait")).toBe("3:4");
    expect(aspectRatioFor("product", "square")).toBe("1:1");
    // The shape never reaches any other purpose.
    expect(aspectRatioFor("hero", "square")).toBe("21:9");
  });

  it("★ knows a picture Mink drew from a real photo, wherever Mink drew it", () => {
    const base = "https://storage.googleapis.com/bucket/stores/s/";
    expect(
      isMinkAiMadePhotoUrl(`${base}mink-generated/product-photos/a.jpg`),
    ).toBe(true);
    expect(isMinkAiMadePhotoUrl(`${base}mink-generated/b.jpg`)).toBe(true);
    // A scene photo from the photo editor.
    expect(isMinkAiMadePhotoUrl(`${base}edited/ai-c.webp`)).toBe(true);
    // The merchant's own photo, and a cut-out on white, are real.
    expect(isMinkAiMadePhotoUrl(`${base}uploads/d.png`)).toBe(false);
    expect(isMinkAiMadePhotoUrl(`${base}edited/x-product-white.webp`)).toBe(
      false,
    );
  });

  it("★ the shape is the server's, so the validator refuses it on the wire", () => {
    const result = validateMinkMediaGenerationRequest({
      ...valid,
      purpose: "product",
      productPhotoShape: "square",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain(
      "productPhotoShape is not allowed",
    );
  });

  it("★★ tells a catalogue photo from campaign art by its folder alone", () => {
    expect(isMinkGeneratedProductPhotoUrl(photo)).toBe(true);
    expect(isMinkGeneratedCampaignArtUrl(photo)).toBe(false);
    expect(isMinkGeneratedCampaignArtUrl(art)).toBe(true);
    expect(isMinkGeneratedProductPhotoUrl(art)).toBe(false);
    // A merchant's own upload is neither.
    expect(isMinkGeneratedCampaignArtUrl(upload)).toBe(false);
    expect(isMinkGeneratedProductPhotoUrl(upload)).toBe(false);
  });
});
