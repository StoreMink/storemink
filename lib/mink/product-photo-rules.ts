// The rules that make a Mink AI product photo show the SAME item, read by
// the image prompt for purpose `product` (lib/mink/media-generation.ts).
// Client-safe and import-free.
//
// ★★ THE MODEL REDRAWS THE PRODUCT. This is the Shopify Sidekick approach the
//    owner chose (2026-10-18): the merchant asks in Mink chat ("show this
//    hanging from a tree in a garden", "now on a model in a forest") and the
//    real photo is re-shot in that scene. A product only looks photographed
//    in a scene when the scene's light, drape and perspective reach the
//    product itself, which a cut-out pasted on a drawn set could not do. So
//    these rules spend most of their words on keeping the item the same, and
//    the merchant compares the result with the original before using it.
// ★ PEOPLE: only when the merchant asks (a model wearing the product). Adults
//    only, never a real or famous person; the provider call allows adults for
//    product photos and blocks prominent people, and the rules repeat it.
// ★ NOT IN THE PRODUCT EDITOR, by the owner's decision: scenes are made in
//    the chat, the way Sidekick does it, never from a form.

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
