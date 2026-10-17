// The scenes a merchant can put a product photo into, and the prompt that
// draws each one. Client-safe: the editor lists the labels, the server builds
// the prompt from the same entry.
//
// ★★ THE MODEL DRAWS AN EMPTY SET, NEVER THE PRODUCT. The prompt asks for the
//    surface with nothing on it; the merchant's own cut-out is placed on it
//    afterwards (lib/media/background-render.ts). That is the whole point of
//    this pipeline: a shopper sees the real item, not a picture of one.
// ★ PRESETS ONLY (owner's decision, 2026-10-17). A free-text scene is more
//   flexible and fails more often; each preset here is a set that reads as a
//   product photo with any product placed on it, and its prompt is ours.
// ★ THE PROMPT NAMES THE FLOOR LINE THE PRODUCT IS PLACED ON (SCENE_FLOOR),
//   so the drawn surface and the placed product agree about where "down" is.
//   A blurred background is asked for every time: sharp background detail
//   gives away scale, and the model does not know how big the product is.

import { SCENE_FLOOR } from "./background-layout";
import type { ImageSpec } from "./image-specs";

export interface ScenePreset {
  id: string;
  /** What the merchant sees. */
  label: string;
  /** One short line under the label. */
  description: string;
  /** The set, for the prompt. */
  scene: string;
}

export const SCENE_PRESETS: readonly ScenePreset[] = [
  {
    id: "studio",
    label: "Studio",
    description: "A seamless warm white backdrop",
    scene:
      "a seamless paper studio backdrop in a soft warm off-white that curves smoothly from the floor up into the wall, with no visible seam, corner or edge",
  },
  {
    id: "marble",
    label: "Marble counter",
    description: "White marble in a bright kitchen",
    scene:
      "a polished white marble countertop with soft grey veining, in a bright, airy kitchen that is completely out of focus behind it",
  },
  {
    id: "wood",
    label: "Wooden table",
    description: "Warm oak against a plain wall",
    scene:
      "a warm natural oak tabletop with fine wood grain, in front of a plain cream wall that is softly out of focus",
  },
  {
    id: "linen",
    label: "Linen",
    description: "Soft undyed linen with gentle folds",
    scene:
      "a surface covered in natural undyed linen fabric, smooth and flat at the front with a few gentle soft folds towards the back, in warm neutral tones",
  },
  {
    id: "concrete",
    label: "Concrete",
    description: "Light grey, minimal and modern",
    scene:
      "a smooth light grey polished concrete surface in front of a matching concrete wall, minimal and modern",
  },
  {
    id: "garden",
    label: "Garden stone",
    description: "Pale stone with greenery behind",
    scene:
      "a flat pale limestone ledge outdoors, with green leaves and a garden far behind it, completely blurred, in warm natural afternoon sunlight",
  },
  {
    id: "beach",
    label: "Beach",
    description: "Fine sand with the sea behind",
    scene:
      "smooth, fine, pale sand, with the sea and a clear sky far behind it, completely blurred, in soft bright daylight",
  },
  {
    id: "bathroom",
    label: "Bathroom shelf",
    description: "White tiles and soft light",
    scene:
      "a clean white ceramic shelf in a bright bathroom, with white tiles and a few green plant leaves far behind it, softly out of focus",
  },
];

export function scenePreset(id: string): ScenePreset | null {
  return SCENE_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function isScenePresetId(value: unknown): value is string {
  return typeof value === "string" && scenePreset(value) !== null;
}

/** The prompt that draws `preset` as an empty set for a frame of `spec`. */
export function scenePrompt(preset: ScenePreset, spec: ImageSpec): string {
  const floor = Math.round(SCENE_FLOOR * 100);
  return [
    "Photograph an empty set for a product photo. Nothing is standing on it yet: a product will be placed on it afterwards.",
    "",
    `THE SET: ${preset.scene}.`,
    "",
    `COMPOSITION, for a ${spec.aspect} frame (${spec.width} × ${spec.height}):`,
    "- The surface fills the lower half of the picture from side to side and continues beyond the bottom of the picture, so only its top is seen. Its far edge, or the line where the floor meets the wall, is a little above the middle of the picture.",
    `- The middle of the surface, around ${floor}% of the height from the top, is completely empty, flat and evenly lit, ready for a product to stand on.`,
    "- A catalogue camera angle: low, just above the surface, looking straight ahead.",
    "- Shallow depth of field: everything behind the surface is softly out of focus.",
    "- Soft, natural light from one side, with gentle shadows. Realistic colours.",
    "",
    "DO NOT INCLUDE:",
    "- Any product, bottle, jar, box, package, bag, shoe, garment, vase, plant pot, food or other object in the middle of the frame. Small decoration may appear only at the far left or right edge, out of focus.",
    "- People, hands, body parts or animals.",
    "- Text, letters, numbers, logos, labels, signs or watermarks.",
  ].join("\n");
}
