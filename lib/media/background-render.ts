// Background removal: the image half. sharp only, with no database, storage
// or credentials, so it runs in tests and in a local check against the real
// image-matting service. background-edit.ts does the rest.

import {
  type BackgroundChoice,
  type Box,
  type CutoutCheck,
  backgroundFill,
  cutoutChecks,
  maskBounds,
  placeInFrame,
} from "./background-layout";

type SharpFactory = (
  input?: Buffer | Uint8Array | import("sharp").SharpOptions,
  options?: import("sharp").SharpOptions,
) => import("sharp").Sharp;

// Imported lazily, as everywhere else: a missing native library must surface
// as this feature's error, not take the importing module down.
async function loadSharp(): Promise<SharpFactory> {
  const mod = await import("sharp");
  return mod.default as unknown as SharpFactory;
}

export interface Matte {
  /** PNG mask, white where the product is. */
  mask: Buffer;
  width: number;
  height: number;
}

export interface CutOutResult {
  /** The product alone: RGBA PNG, cropped to the product. */
  png: Buffer;
  bounds: Box;
  checks: CutoutCheck[];
}

/**
 * The product from `photo`, using the service's mask, cropped to the product.
 * Null when the mask holds no product at all.
 */
export async function cutOut(
  photo: Buffer,
  matte: Matte,
  frame: { width: number; height: number },
): Promise<CutOutResult | null> {
  const sharp = await loadSharp();
  const size = { width: matte.width, height: matte.height };
  const maskRaw = await sharp(matte.mask)
    .extractChannel(0)
    .resize(size.width, size.height, { fit: "fill" })
    .raw({ depth: "uchar" })
    .toBuffer();
  const bounds = maskBounds(maskRaw, size.width, size.height);
  if (!bounds) return null;

  // The same orientation and size the service matted, so the mask lines up.
  // Raw pixels between steps: sharp applies a crop BEFORE it joins a channel,
  // so both in one pipeline would join a full-size mask to a cropped photo,
  // and an encoded intermediate would lose quality.
  const rgb = await sharp(photo)
    .rotate()
    .resize(size.width, size.height, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .removeAlpha()
    .raw({ depth: "uchar" })
    .toBuffer();
  const rgba = await sharp(rgb, { raw: { ...size, channels: 3 } })
    .joinChannel(maskRaw, { raw: { ...size, channels: 1 } })
    .raw({ depth: "uchar" })
    .toBuffer();
  const png = await sharp(rgba, { raw: { ...size, channels: 4 } })
    .extract(bounds)
    .png({ compressionLevel: 6 })
    .toBuffer();
  return { png, bounds, checks: cutoutChecks(bounds, size, frame) };
}

/**
 * The cut-out placed on `background` in a frame of exactly `frame`: centred,
 * filling PRODUCT_FILL of the frame. WebP; transparent keeps its alpha.
 */
export async function renderOnBackground(
  cutoutPng: Buffer,
  cutoutSize: { width: number; height: number },
  frame: { width: number; height: number },
  background: BackgroundChoice,
): Promise<Buffer> {
  const sharp = await loadSharp();
  const place = placeInFrame(cutoutSize, frame);
  const product = await sharp(cutoutPng)
    .resize(place.width, place.height, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
  const fill = backgroundFill(background);
  const canvas = sharp({
    create: {
      width: frame.width,
      height: frame.height,
      channels: 4,
      background: fill,
    },
  }).composite([{ input: product, left: place.left, top: place.top }]);
  if (background.kind === "transparent") {
    return canvas.webp({ quality: 90, alphaQuality: 100 }).toBuffer();
  }
  // Flattened through a raw buffer: sharp would otherwise flatten BEFORE the
  // composite and leave the product's own transparency over nothing.
  const composed = await canvas.raw({ depth: "uchar" }).toBuffer();
  return sharp(composed, {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  })
    .flatten({ background: fill })
    .webp({ quality: 90 })
    .toBuffer();
}
