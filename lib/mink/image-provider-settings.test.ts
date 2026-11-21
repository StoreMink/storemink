import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVAMP_IMAGE_SETTINGS,
  ELEVENLABS_IMAGE_MODELS,
  elevenLabsAspectRatio,
  elevenLabsModelDef,
  isElevenLabsImageModel,
  isRevampImageProvider,
} from "./image-provider-settings";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("redesign photo provider settings", () => {
  it("defaults to Vertex with Nano Banana 2 kept for ElevenLabs", () => {
    expect(DEFAULT_REVAMP_IMAGE_SETTINGS).toEqual({
      provider: "vertex",
      elevenLabsModel: "gemini-3.1-flash-image",
    });
  });

  it("reads only the two providers and the listed models", () => {
    expect(isRevampImageProvider("vertex")).toBe(true);
    expect(isRevampImageProvider("elevenlabs")).toBe(true);
    expect(isRevampImageProvider("openai")).toBe(false);
    expect(isElevenLabsImageModel("gpt-image-2")).toBe(true);
    expect(isElevenLabsImageModel("dall-e-3")).toBe(false);
    expect(isElevenLabsImageModel(null)).toBe(false);
  });

  it("keeps a ratio the model takes and picks the nearest otherwise", () => {
    const nb2 = elevenLabsModelDef("gemini-3.1-flash-image");
    expect(elevenLabsAspectRatio(nb2, "21:9")).toBe("21:9");
    const seedream = elevenLabsModelDef("bytedance-seedream-5-lite");
    expect(elevenLabsAspectRatio(seedream, "21:9")).toBe("16:9");
    expect(elevenLabsAspectRatio(seedream, "4:5")).toBe("3:4");
    expect(elevenLabsAspectRatio(seedream, "2:3")).toBe("3:4");
    expect(elevenLabsAspectRatio(seedream, "5:4")).toBe("4:3");
  });

  it("matches the database's list of models (migration 0278)", () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        "drizzle/migrations/sql/20261121_0278_mink_image_provider.sql",
      ),
      "utf8",
    );
    for (const model of ELEVENLABS_IMAGE_MODELS) {
      expect(sql).toContain(`'${model.id}'`);
    }
    const listed =
      sql.match(/elevenlabs_model = ANY \(ARRAY\[([^\]]*)\]/)?.[1] ?? "";
    expect(listed.split(",").length).toBe(ELEVENLABS_IMAGE_MODELS.length);
  });
});
