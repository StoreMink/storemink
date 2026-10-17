import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { SCENE_FLOOR, placeInFrame, placeOnFloor } from "./background-layout";
import { renderOnBackground, renderOnScene } from "./background-render";

const FRAME = { width: 600, height: 800 };

/** A solid red product cut-out: 200 × 150, fully opaque. */
async function cutout(): Promise<Buffer> {
  return sharp({
    create: {
      width: 200,
      height: 150,
      channels: 4,
      background: { r: 200, g: 30, b: 30, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

/** Within WebP's rounding of the red product colour. */
function expectProductRed(p: { r: number; g: number; b: number }) {
  expect(Math.abs(p.r - 200)).toBeLessThanOrEqual(3);
  expect(Math.abs(p.g - 30)).toBeLessThanOrEqual(3);
  expect(Math.abs(p.b - 30)).toBeLessThanOrEqual(3);
}

async function pixel(bytes: Buffer, x: number, y: number) {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

describe("renderOnBackground", () => {
  it("draws a shadow just below the product's base when asked, and none otherwise", async () => {
    const png = await cutout();
    const size = { width: 200, height: 150 };
    const place = placeInFrame(size, FRAME);
    const below = place.top + place.height + 3;
    const x = place.left + Math.round(place.width / 2);

    const plain = await renderOnBackground(png, size, FRAME, { kind: "white" });
    const shaded = await renderOnBackground(
      png,
      size,
      FRAME,
      { kind: "white" },
      { shadow: true },
    );
    expect((await pixel(plain, x, below)).r).toBe(255);
    expect((await pixel(shaded, x, below)).r).toBeLessThan(235);
    // Far from the product the background is untouched.
    expect((await pixel(shaded, 5, 5)).r).toBe(255);
    // The product itself is copied, not darkened.
    expectProductRed(await pixel(shaded, x, place.top + 10));
  });

  it("never puts a shadow on a transparent background", async () => {
    const png = await cutout();
    const size = { width: 200, height: 150 };
    const place = placeInFrame(size, FRAME);
    const out = await renderOnBackground(
      png,
      size,
      FRAME,
      { kind: "transparent" },
      { shadow: true },
    );
    const below = await pixel(
      out,
      place.left + 100,
      place.top + place.height + 3,
    );
    expect(below.a).toBe(0);
  });
});

describe("renderOnScene", () => {
  it("stands the product on the floor line of the scene, with a shadow", async () => {
    const png = await cutout();
    const size = { width: 200, height: 150 };
    const scene = await sharp({
      create: {
        width: FRAME.width,
        height: FRAME.height,
        channels: 3,
        background: "#d8ccb8",
      },
    })
      .png()
      .toBuffer();
    const out = await renderOnScene(png, size, scene, FRAME);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([600, 800]);

    const place = placeOnFloor(size, FRAME);
    expect(place.top + place.height).toBe(Math.round(800 * SCENE_FLOOR));
    const x = place.left + Math.round(place.width / 2);
    expectProductRed(await pixel(out, x, place.top + place.height - 5));
    const shadow = await pixel(out, x, place.top + place.height + 3);
    expect(shadow.r).toBeLessThan(0xd8 - 20);
    const untouched = await pixel(out, 5, 5);
    expect(Math.abs(untouched.r - 0xd8)).toBeLessThanOrEqual(2);
  });
});
