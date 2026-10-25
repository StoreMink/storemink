import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { IMAGE_SPECS } from "@/lib/media/image-specs";
import { THEME_IMAGE_RULES } from "@/lib/themes/validation";
import { FAKE_IMAGE_LONG_EDGE, createFakeImageClient } from "./image-fake";
import type {
  ThemeImageAspectRatio,
  ThemeImageRequest,
} from "./image-provider";
import { prepareSlotImage } from "./slot-images";

// ---------------------------------------------------------------------------
// The offline image client's sizes. Theme Studio's fakes keep their 2K long
// edge; the revamp asks for the image model's own 2K output sizes, because
// its phone crop is cut from the stored wide photo and a 2048x878 hero leaves
// a 702px crop, under the storefront's 800px floor.
// ---------------------------------------------------------------------------

function request(aspectRatio: ThemeImageAspectRatio): ThemeImageRequest {
  return {
    purpose: "hero",
    briefId: "hero-1",
    aspectRatio,
    prompt: "A wide, calm studio scene with soft morning light.",
    references: [],
  };
}

async function draw(
  client: ReturnType<typeof createFakeImageClient>,
  aspectRatio: ThemeImageAspectRatio,
) {
  const result = await client.generateImage(
    request(aspectRatio),
    new AbortController().signal,
  );
  if (result.kind !== "ok")
    throw new Error(`expected an image, ${result.kind}`);
  const meta = await sharp(Buffer.from(result.bytes)).metadata();
  return { bytes: result.bytes, width: meta.width, height: meta.height };
}

const frame = (spec: { width: number; height: number }) => ({
  width: spec.width,
  height: spec.height,
  aspect: spec.width / spec.height,
});

describe("createFakeImageClient", () => {
  it("★ keeps Theme Studio's 2K long edge by default", async () => {
    const client = createFakeImageClient();
    expect(await draw(client, "21:9")).toMatchObject({
      width: FAKE_IMAGE_LONG_EDGE,
      height: 878,
    });
    expect(await draw(client, "4:5")).toMatchObject({
      width: 1638,
      height: FAKE_IMAGE_LONG_EDGE,
    });
  });

  it("★★ draws the image model's own 2K sizes when asked", async () => {
    const client = createFakeImageClient({ size: "model" });
    const sizes: Array<[ThemeImageAspectRatio, number, number]> = [
      ["21:9", 3168, 1344],
      ["16:9", 2752, 1536],
      ["4:3", 2400, 1792],
      ["4:5", 1856, 2304],
      ["1:1", 2048, 2048],
    ];
    for (const [ratio, width, height] of sizes) {
      expect(await draw(client, ratio)).toMatchObject({ width, height });
    }
  });

  it("★★ a model-size wide photo leaves a phone crop the storefront accepts; the 2K-edge one does not", async () => {
    const wideFrame = frame(IMAGE_SPECS.hero_wide);
    const phoneFrame = frame(IMAGE_SPECS.hero_phone);
    const phoneCrop = async (
      client: ReturnType<typeof createFakeImageClient>,
    ) => {
      const { bytes } = await draw(client, "21:9");
      const wide = await prepareSlotImage(
        bytes,
        wideFrame,
        THEME_IMAGE_RULES.maxWideBytes,
      );
      if (!wide.ok) throw new Error(`wide photo refused: ${wide.code}`);
      return prepareSlotImage(
        wide.value.bytes,
        phoneFrame,
        THEME_IMAGE_RULES.maxBytes,
      );
    };
    const model = await phoneCrop(createFakeImageClient({ size: "model" }));
    expect(model.ok).toBe(true);
    if (model.ok) expect(model.value.width).toBeGreaterThanOrEqual(800);
    expect(await phoneCrop(createFakeImageClient())).toEqual({
      ok: false,
      code: "too_small",
    });
  });
});
