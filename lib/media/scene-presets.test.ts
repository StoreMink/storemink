import { describe, expect, it } from "vitest";
import { normalizeEditInstruction } from "./photo-edit";
import {
  SCENE_PRESETS,
  isScenePresetId,
  sceneInstruction,
  scenePreset,
} from "./scene-presets";

describe("scene presets", () => {
  it("has unique, simple ids", () => {
    const ids = SCENE_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
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

  it("turns each preset into a request the edit accepts as it is", () => {
    for (const preset of SCENE_PRESETS) {
      const request = sceneInstruction(preset);
      expect(request).toMatch(/^Photograph the product /);
      // Already clean: normalising changes nothing, so a preset and the same
      // words typed by hand are one request.
      expect(normalizeEditInstruction(request)).toBe(request);
    }
    expect(sceneInstruction(scenePreset("garden")!)).toContain("garden");
  });

  it("names a place, never a person: people are the merchant's own words", () => {
    for (const preset of SCENE_PRESETS) {
      expect(preset.setting).not.toMatch(
        /\b(model|person|people|woman|man|hand|wearing)\b/i,
      );
    }
  });
});
