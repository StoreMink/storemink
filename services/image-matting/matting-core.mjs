// Image-matting service: the pure half (docs/image-matting-service.md).
//
// Everything here is arithmetic on buffers, with no native dependency, so the
// main test suite can run it without onnxruntime or a model file. server.mjs
// owns decoding (sharp), inference (onnxruntime-node) and HTTP.
//
// ★ THE MODEL SEES A 1024×1024 SQUARE, STRETCHED, NOT PADDED. BiRefNet was
// trained on images resized to 1024×1024 whatever their shape, so a stretched
// input is what it expects; padding would spend a third of a portrait photo's
// pixels on a border the model then has to classify. The mask comes back at
// 1024×1024 and is stretched back to the photo's own shape.

import { createHash, timingSafeEqual } from "node:crypto";

/** The square BiRefNet's "general" models take. */
export const MODEL_SIZE = 1024;

/** ImageNet normalisation, the statistics BiRefNet was trained with. */
export const MEAN = Object.freeze([0.485, 0.456, 0.406]);
export const STD = Object.freeze([0.229, 0.224, 0.225]);

/** Largest upload accepted. A phone photo is 2–8 MB; 20 MB matches what
 * lib/mink/media-preparation.ts will download from the store's own bucket. */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** Largest decoded image, the limit lib/theme-studio/references.ts applies to
 * untrusted uploads: a small file can decode to a huge bitmap. */
export const MAX_INPUT_PIXELS = 40_000_000;

/** Longest edge of the photo the mask and cutout are produced at. Bigger
 * photos are scaled down first: every product image slot is at most 2400 px
 * wide, so 4096 leaves room to crop without holding a 40 MP bitmap. */
export const MAX_OUTPUT_EDGE = 4096;

/** Below this share of foreground pixels the model found no product. */
export const EMPTY_COVERAGE = 0.005;
/** Above this share it separated nothing from the background. */
export const FULL_COVERAGE = 0.98;

/** What a request may ask for: the mask alone, or the photo with the mask as
 * its alpha channel. */
export const OUTPUTS = Object.freeze(["mask", "cutout"]);

/**
 * The image type from its first bytes. A declared Content-Type is never
 * trusted: a caller can say anything, and sharp would then be asked to decode
 * whatever the bytes really are.
 *
 * @param {Uint8Array} bytes
 * @returns {"jpeg" | "png" | "webp" | null}
 */
export function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "webp";
  }
  return null;
}

/**
 * The `output` query parameter, or null when it names nothing we produce.
 * Absent means the mask, which is the smallest response and all the web app
 * needs: it already holds the photo.
 *
 * @param {string | null | undefined} value
 * @returns {"mask" | "cutout" | null}
 */
export function parseOutput(value) {
  if (value === null || value === undefined || value === "") return "mask";
  return OUTPUTS.includes(value) ? value : null;
}

/**
 * Interleaved RGB bytes (the shape sharp's raw output has) to the model's
 * input: float32, planar (all red, then all green, then all blue), scaled to
 * 0–1 and normalised per channel.
 *
 * @param {Uint8Array} rgb  size × size × 3 bytes, row-major, RGBRGB…
 * @param {number} size
 * @returns {Float32Array} 3 × size × size values
 */
export function toInputTensor(rgb, size = MODEL_SIZE) {
  const plane = size * size;
  if (rgb.length !== plane * 3) {
    throw new RangeError(
      `Expected ${plane * 3} RGB bytes for a ${size}×${size} input, got ${rgb.length}.`,
    );
  }
  const out = new Float32Array(plane * 3);
  const scale = [1 / (255 * STD[0]), 1 / (255 * STD[1]), 1 / (255 * STD[2])];
  const shift = [MEAN[0] / STD[0], MEAN[1] / STD[1], MEAN[2] / STD[2]];
  for (let i = 0, p = 0; p < plane; p += 1, i += 3) {
    out[p] = rgb[i] * scale[0] - shift[0];
    out[plane + p] = rgb[i + 1] * scale[1] - shift[1];
    out[2 * plane + p] = rgb[i + 2] * scale[2] - shift[2];
  }
  return out;
}

/**
 * Whether a model output holds logits rather than probabilities. The official
 * exports end without a sigmoid, but a re-export may include one, and applying
 * it twice squeezes every pixel into 0.5-0.73: a mask that looks plausible and
 * is wrong. So the range decides, not the file name.
 *
 * @param {Float32Array} values
 */
export function looksLikeLogits(values) {
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v < 0 || v > 1) return true;
  }
  return false;
}

/**
 * The model's single-channel output to an 8-bit mask (255 = product).
 *
 * @param {Float32Array} values  one plane, size × size
 * @returns {Uint8Array}
 */
export function maskFromOutput(values) {
  const logits = looksLikeLogits(values);
  const mask = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const raw = values[i];
    const p = logits ? 1 / (1 + Math.exp(-raw)) : raw;
    // NaN (a broken model) becomes 0: never claim a pixel is product without
    // a number saying so.
    mask[i] = Number.isFinite(p)
      ? Math.round(Math.min(1, Math.max(0, p)) * 255)
      : 0;
  }
  return mask;
}

/**
 * What a mask says about the cut-out, cheaply enough to send with every
 * response. `coverage` is the share of pixels that are clearly product;
 * `soft` is the share in between, which is high when the model was unsure
 * (and is where halos come from).
 *
 * @param {Uint8Array} mask
 */
export function maskStats(mask) {
  if (mask.length === 0) return { coverage: 0, soft: 0 };
  let solid = 0;
  let soft = 0;
  for (let i = 0; i < mask.length; i += 1) {
    const v = mask[i];
    if (v >= 128) solid += 1;
    if (v > 16 && v < 239) soft += 1;
  }
  return { coverage: solid / mask.length, soft: soft / mask.length };
}

/**
 * A verdict the caller can act on without looking at pixels. `empty` and
 * `full` are not errors here (the mask is still returned) because the web app
 * decides what to tell the merchant; the service only reports.
 *
 * @param {{ coverage: number }} stats
 * @returns {"ok" | "empty" | "full"}
 */
export function judgeMask(stats) {
  if (stats.coverage < EMPTY_COVERAGE) return "empty";
  if (stats.coverage > FULL_COVERAGE) return "full";
  return "ok";
}

/**
 * The size a photo is processed at: its own, unless an edge is over
 * MAX_OUTPUT_EDGE, in which case it is scaled to fit, keeping its shape.
 *
 * @param {number} width
 * @param {number} height
 */
export function outputSize(width, height, maxEdge = MAX_OUTPUT_EDGE) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Constant-time comparison of a presented secret with the configured one, so
 * a wrong guess cannot be refined by timing how far it got. Both sides are
 * hashed first because `timingSafeEqual` needs equal lengths, and comparing
 * lengths first would leak the secret's length.
 *
 * @param {string | null | undefined} presented
 * @param {string} expected
 */
export function secretMatches(presented, expected) {
  if (typeof presented !== "string" || presented.length === 0) return false;
  if (typeof expected !== "string" || expected.length === 0) return false;
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}
