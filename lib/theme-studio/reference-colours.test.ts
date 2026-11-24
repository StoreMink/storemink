// The colours of a reference screenshot, measured from its pixels (owner,
// 22 Nov 2026).
import { describe, expect, it } from "vitest";
import {
  REFERENCE_COLOURS_MAX,
  measureReferenceColours,
  measureRgbPixels,
  referenceColoursText,
} from "./reference-colours";

/** Pixels in the given shares (of 10,000), each a flat colour. */
function picture(parts: [hex: string, pixels: number][]): Uint8Array {
  const total = parts.reduce((sum, [, n]) => sum + n, 0);
  const out = new Uint8Array(total * 3);
  let at = 0;
  for (const [hex, n] of parts) {
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    for (let i = 0; i < n; i++) {
      out[at++] = rgb[0];
      out[at++] = rgb[1];
      out[at++] = rgb[2];
    }
  }
  return out;
}

const shop = picture([
  ["#f5f1ea", 6800], // the page
  ["#ffffff", 2000], // cards
  ["#1c1c1c", 700], // text
  ["#c2562e", 400], // buttons
  ["#8a8f93", 100], // a grey rule
]);

describe("measuring a screenshot's colours", () => {
  it("★ finds the page, the text and the accent, with exact colours and shares", () => {
    const measured = measureRgbPixels(shop)!;
    expect(measured.background).toBe("#f5f1ea");
    expect(measured.text).toBe("#1c1c1c");
    expect(measured.accent).toBe("#c2562e");
    expect(measured.dark).toBe(false);
    expect(measured.colours.slice(0, 4)).toEqual([
      { hex: "#f5f1ea", share: 0.68 },
      { hex: "#ffffff", share: 0.2 },
      { hex: "#1c1c1c", share: 0.07 },
      { hex: "#c2562e", share: 0.04 },
    ]);
  });

  it("reads a dark page as dark, with light text", () => {
    const measured = measureRgbPixels(
      picture([
        ["#101114", 8000],
        ["#f2efe8", 1500],
        ["#c9a56a", 500],
      ]),
    )!;
    expect(measured.background).toBe("#101114");
    expect(measured.dark).toBe(true);
    expect(measured.text).toBe("#f2efe8");
    expect(measured.accent).toBe("#c9a56a");
  });

  it("counts near shades as one colour, at their true average", () => {
    // A page with JPEG-like noise: three shades a few steps apart.
    const measured = measureRgbPixels(
      picture([
        ["#f5f1ea", 4000],
        ["#f3efe8", 3000],
        ["#f7f3ec", 2000],
        ["#1c1c1c", 1000],
      ]),
    )!;
    expect(measured.colours).toHaveLength(2);
    expect(measured.colours[0].share).toBe(0.9);
    expect(measured.background).toMatch(/^#f[4-6]f[0-2]e[9-b]$/);
  });

  it("names no text or accent a picture does not have, and reports at most six", () => {
    const flat = measureRgbPixels(picture([["#eeeeee", 10000]]))!;
    expect(flat).toMatchObject({ text: null, accent: null });
    const many = measureRgbPixels(
      picture(
        Array.from({ length: 12 }, (_, i): [string, number] => [
          `#${(i * 20).toString(16).padStart(2, "0")}${(255 - i * 20)
            .toString(16)
            .padStart(2, "0")}80`,
          800,
        ]),
      ),
    )!;
    expect(many.colours.length).toBeLessThanOrEqual(REFERENCE_COLOURS_MAX);
    // A grey of small share is no accent: it has no colour to speak of.
    expect(
      measureRgbPixels(
        picture([
          ["#ffffff", 9000],
          ["#777777", 1000],
        ]),
      )!.accent,
    ).toBeNull();
  });

  it("is the same answer for the same bytes, and none for too few", () => {
    expect(measureRgbPixels(shop)).toEqual(measureRgbPixels(shop.slice()));
    expect(measureRgbPixels(new Uint8Array(12))).toBeNull();
  });

  it("measures a stored image, and answers nothing for bytes that are not one", async () => {
    const sharp = (await import("sharp")).default;
    const page = await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 3,
        background: "#f5f1ea",
      },
    })
      .composite([
        {
          input: {
            create: {
              width: 120,
              height: 60,
              channels: 3,
              background: "#c2562e",
            },
          },
          left: 40,
          top: 40,
        },
      ])
      .png()
      .toBuffer();
    const measured = await measureReferenceColours(page.toString("base64"));
    expect(measured?.background).toBe("#f5f1ea");
    expect(measured?.accent).toBe("#c2562e");
    expect(await measureReferenceColours("UklGRg==")).toBeNull();
    expect(await measureReferenceColours("")).toBeNull();
  });
});

describe("the lines the planning stage reads", () => {
  it("gives each screenshot's measurements, numbered as the screenshots are", () => {
    const text = referenceColoursText([measureRgbPixels(shop), null]);
    expect(text).toContain("Colours measured from each reference screenshot");
    expect(text).toContain(
      "Reference 1: #f5f1ea 68%, #ffffff 20%, #1c1c1c 7%, #c2562e 4%",
    );
    expect(text).toContain("Largest (taken as the background): #f5f1ea.");
    expect(text).toContain("(taken as text): #1c1c1c.");
    expect(text).toContain("(a candidate accent): #c2562e.");
    // An unreadable screenshot has no line, and nothing claims one.
    expect(text).not.toContain("Reference 2");
  });

  it("is nothing at all when nothing could be measured", () => {
    expect(referenceColoursText([])).toBe("");
    expect(referenceColoursText([null, null])).toBe("");
  });
});
