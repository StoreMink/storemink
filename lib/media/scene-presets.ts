// The ready-made scenes a merchant can photograph a product in, as shortcuts
// for the AI photo edit (lib/media/photo-edit.ts). Client-safe: the editor
// lists the labels, the server turns the chosen one into the request.
//
// ★ A PRESET IS A WELL-WORDED REQUEST, nothing more. Picking "Garden" sends
//   the same kind of sentence a merchant could type into "Describe a scene",
//   so presets and free text go through one prompt and one price. Each one
//   names a place, never a pose: how a T-shirt or a jar sits in that place is
//   the photographer's call, which the prompt leaves to the model.
// ★ NO PEOPLE IN A PRESET. A model wearing the product is something the
//   merchant asks for in their own words.

export interface ScenePreset {
  id: string;
  /** What the merchant sees. */
  label: string;
  /** One short line under the label. */
  description: string;
  /** Where the product is photographed, completing "Photograph the product …". */
  setting: string;
}

export const SCENE_PRESETS: readonly ScenePreset[] = [
  {
    id: "studio",
    label: "Studio",
    description: "A seamless warm white backdrop",
    setting:
      "in a professional photo studio, against a seamless warm off-white backdrop, in soft even light",
  },
  {
    id: "marble",
    label: "Marble counter",
    description: "White marble in a bright kitchen",
    setting:
      "on a polished white marble counter in a bright, airy kitchen, with the room softly out of focus",
  },
  {
    id: "wood",
    label: "Wooden table",
    description: "Warm oak against a plain wall",
    setting:
      "on a warm oak table in front of a plain cream wall, in soft window light",
  },
  {
    id: "linen",
    label: "Linen",
    description: "Soft undyed linen with gentle folds",
    setting:
      "on soft natural undyed linen with a few gentle folds, in warm daylight",
  },
  {
    id: "concrete",
    label: "Concrete",
    description: "Light grey, minimal and modern",
    setting:
      "against smooth light grey concrete, in a minimal modern space with soft daylight",
  },
  {
    id: "garden",
    label: "Garden",
    description: "Greenery in warm afternoon sun",
    setting:
      "outdoors in a lush garden, among green leaves, in warm afternoon sunlight",
  },
  {
    id: "beach",
    label: "Beach",
    description: "Fine sand with the sea behind",
    setting:
      "on a beach with fine pale sand and the sea behind, in soft bright daylight",
  },
  {
    id: "bathroom",
    label: "Bathroom shelf",
    description: "White tiles and soft light",
    setting:
      "on a clean white shelf in a bright bathroom, with white tiles and a few green plants softly out of focus",
  },
];

export function scenePreset(id: string): ScenePreset | null {
  return SCENE_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function isScenePresetId(value: unknown): value is string {
  return typeof value === "string" && scenePreset(value) !== null;
}

/** The request a preset stands for. */
export function sceneInstruction(preset: ScenePreset): string {
  return `Photograph the product ${preset.setting}.`;
}
