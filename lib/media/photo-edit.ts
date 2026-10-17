// AI product photography: the merchant's real photo, re-shot by Mink AI in a
// setting they choose ("on a marble counter", "hanging from a tree in a
// garden", "worn by a model on a city street"). Client-safe: the editor and
// Mink's chat both read the limits, and the server builds the prompt here.
//
// ★★ THE MODEL REDRAWS THE PRODUCT. This is the Shopify Sidekick approach the
//    owner chose (2026-10-18) after the cut-out-on-a-drawn-set pipeline put a
//    flat T-shirt "standing" on garden stone: a product only looks
//    photographed in a scene when the scene's light, drape and perspective
//    reach the product itself, and that means the model draws it. So the
//    prompt spends most of its words on keeping the item the same, and the
//    merchant compares the result with the original before using it. Small
//    details (a print, a label) can still drift, and every screen says so.
// ★ PEOPLE: only when the merchant asks (a model wearing the product). Adults
//    only, never a real or famous person; the provider call allows adults and
//    blocks prominent people, and this prompt repeats the rule.

import type { ImageSpec } from "./image-specs";

/** What the merchant may type: long enough for a real brief, short of an essay. */
export const PHOTO_EDIT_INSTRUCTION_MAX = 400;
export const PHOTO_EDIT_INSTRUCTION_MIN = 3;

/**
 * The merchant's request, cleaned: control characters dropped, whitespace
 * collapsed, capped. Null when there is nothing usable left.
 */
export function normalizeEditInstruction(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PHOTO_EDIT_INSTRUCTION_MAX)
    .trim();
  return cleaned.length >= PHOTO_EDIT_INSTRUCTION_MIN ? cleaned : null;
}

/**
 * The rules that keep the product the same item, shared by the photo editor
 * and Mink's chat (lib/mink/media-generation.ts) so the two cannot drift.
 */
export const PRODUCT_FIDELITY_RULES = [
  "KEEP THE PRODUCT EXACTLY THE SAME",
  "- It must stay the very same item a customer will receive: the same colour and shade, material and texture, shape, cut and proportions, pattern, stitching, buttons and hardware, and every label, print, logo or lettering that is on it, unchanged and in the same place.",
  "- Do not restyle, simplify, recolour, correct, improve or replace it, and do not add a second product or a different variant.",
].join("\n");

export const PRODUCT_SCENE_RULES = [
  "MAKE IT A REAL PHOTOGRAPH OF THAT SCENE",
  "- Build the requested setting around the product the way a professional product photographer would, so the product looks photographed there and never pasted in: light that matches the setting, true-to-life shadows and reflections, correct perspective and real-world scale.",
  "- Present the product the way that kind of item is naturally shown in that setting: clothing hangs, drapes or is worn with real folds and weight; objects rest on a surface with a contact shadow.",
  "- Include a person only if the request asks for one, for example a model wearing or holding the product. Any person must be an adult, must not be a real or famous person, must be fully and modestly clothed, and the product stays the clear subject.",
  "- Keep the whole product inside the frame with breathing room on every side. Never crop through it.",
].join("\n");

export const PRODUCT_PHOTO_EXCLUSIONS = [
  "DO NOT",
  "- Add text, words, prices, watermarks, logos, borders or frames.",
  "- Change what the product is.",
].join("\n");

/** The whole prompt for one edit of the attached photo. */
export function photoEditPrompt(instruction: string, spec: ImageSpec): string {
  return [
    "You are editing a real product photograph for an online store. The attached photograph shows the product.",
    "",
    "THE MERCHANT'S REQUEST",
    instruction,
    "",
    PRODUCT_FIDELITY_RULES,
    "",
    PRODUCT_SCENE_RULES,
    "",
    PRODUCT_PHOTO_EXCLUSIONS,
    "",
    `Output one photograph with a ${spec.aspect} aspect ratio, composed for that frame: ${spec.hint}`,
  ].join("\n");
}
