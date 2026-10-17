import { describe, expect, it } from "vitest";
import { parseBackground, SCENE_FLOOR } from "./background-layout";
import { IMAGE_SPECS } from "./image-specs";
import {
  SCENE_PRESETS,
  isScenePresetId,
  scenePreset,
  scenePrompt,
} from "./scene-presets";

describe("scene presets", () => {
  it("has unique ids that the background parser accepts", () => {
    const ids = SCENE_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(parseBackground({ kind: "scene", preset: id })).not.toBeNull();
      expect(isScenePresetId(id)).toBe(true);
    }
    expect(isScenePresetId("disco")).toBe(false);
    expect(scenePreset("disco")).toBeNull();
  });

  it("keeps labels short enough for the editor's tiles", () => {
    for (const preset of SCENE_PRESETS) {
      expect(preset.label.length).toBeLessThanOrEqual(16);
      expect(preset.description.length).toBeLessThanOrEqual(40);
    }
  });

  it("asks for an empty set at the slot's shape, with the floor line the product stands on", () => {
    const prompt = scenePrompt(scenePreset("marble")!, IMAGE_SPECS.product);
    expect(prompt).toContain("empty set");
    expect(prompt).toContain("white marble countertop");
    expect(prompt).toContain("3:4 frame (1200 × 1600)");
    expect(prompt).toContain(`${Math.round(SCENE_FLOOR * 100)}% of the height`);
    expect(prompt).toMatch(/People, hands/);
    expect(prompt).toMatch(/Text, letters/);
  });

  it("never asks the model to draw a product", () => {
    for (const preset of SCENE_PRESETS) {
      expect(preset.scene).not.toMatch(/\b(product|bottle|shoe|sandal|bag)\b/i);
    }
  });
});
