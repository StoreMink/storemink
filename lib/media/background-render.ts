// Background removal: the image half. sharp only, with no database, storage
// or credentials, so it runs in tests and in a local check against the real
// image-matting service. background-edit.ts does the rest.

import {
  type BackgroundChoice,
  type Box,
  type CutoutCheck,
  backgroundFill,
  canHaveShadow,
  cutoutChecks,
  maskBounds,
  placeInFrame,
  placeOnFloor,
  groundShadow,
  shadowLayersFor,
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

/** The cut-out at its placed size, and its alpha for the shadow. */
async function placedProduct(
  sharp: SharpFactory,
  cutoutPng: Buffer,
  place: Box,
): Promise<{ png: Buffer; alpha: Uint8Array }> {
  const png = await sharp(cutoutPng)
    .resize(place.width, place.height, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
  const alpha = await sharp(png)
    .ensureAlpha()
    .extractChannel(3)
    .raw({ depth: "uchar" })
    .toBuffer();
  return { png, alpha };
}

/**
 * A frame-sized transparent layer holding the product's shadows, cast down
 * from its base and blurred.
 */
async function shadowLayer(
  sharp: SharpFactory,
  frame: { width: number; height: number },
  place: Box,
  alpha: Uint8Array,
  strength: "light" | "scene",
): Promise<Buffer> {
  const layers = await Promise.all(
    shadowLayersFor(place.height, strength).map(async (layer) => {
      const pad = Math.ceil(layer.blur * 3) + 2;
      const rows = place.height + layer.depth;
      const caster = groundShadow(
        alpha,
        place.width,
        place.height,
        layer.depth,
      );
      const width = place.width + pad * 2;
      const height = rows + pad * 2;
      const blurred = await sharp(Buffer.from(caster), {
        raw: { width: place.width, height: rows, channels: 1 },
      })
        .extend({
          top: pad,
          bottom: pad,
          left: pad,
          right: pad,
          background: "#000000",
        })
        .blur(layer.blur)
        .linear(layer.opacity, 0)
        // extend() pads with a colour, which makes the image three-channel;
        // the alpha is any one of them.
        .extractChannel(0)
        .raw({ depth: "uchar" })
        .toBuffer();
      const input = await sharp({
        create: { width, height, channels: 3, background: "#000000" },
      })
        .joinChannel(blurred, { raw: { width, height, channels: 1 } })
        .png()
        .toBuffer();
      return cropToFrame(
        sharp,
        { input, left: place.left - pad, top: place.top - pad },
        { width, height },
        frame,
      );
    }),
  );
  return sharp({
    create: {
      width: frame.width,
      height: frame.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(layers.filter((layer): layer is Layer => layer !== null))
    .png()
    .toBuffer();
}

type Layer = { input: Buffer; left: number; top: number };

/**
 * The part of an overlay that falls inside the frame, positioned there. sharp
 * refuses an overlay that starts outside the canvas or runs past its edge,
 * which a shadow does whenever its product stands near the frame's edge.
 */
async function cropToFrame(
  sharp: SharpFactory,
  layer: Layer,
  size: { width: number; height: number },
  frame: { width: number; height: number },
): Promise<Layer | null> {
  const left = Math.max(layer.left, 0);
  const top = Math.max(layer.top, 0);
  const right = Math.min(layer.left + size.width, frame.width);
  const bottom = Math.min(layer.top + size.height, frame.height);
  if (right <= left || bottom <= top) return null;
  if (
    left === layer.left &&
    top === layer.top &&
    right - left === size.width &&
    bottom - top === size.height
  ) {
    return layer;
  }
  const input = await sharp(layer.input)
    .extract({
      left: left - layer.left,
      top: top - layer.top,
      width: right - left,
      height: bottom - top,
    })
    .png()
    .toBuffer();
  return { input, left, top };
}

/**
 * The cut-out placed on `background` in a frame of exactly `frame`: centred,
 * filling PRODUCT_FILL of the frame, with a soft shadow under it unless the
 * background is transparent or `shadow` is off. WebP; transparent keeps its
 * alpha.
 */
export async function renderOnBackground(
  cutoutPng: Buffer,
  cutoutSize: { width: number; height: number },
  frame: { width: number; height: number },
  background: BackgroundChoice,
  options: { shadow?: boolean } = {},
): Promise<Buffer> {
  const sharp = await loadSharp();
  const place = placeInFrame(cutoutSize, frame);
  const { png, alpha } = await placedProduct(sharp, cutoutPng, place);
  const fill = backgroundFill(background);
  const layers: { input: Buffer; left: number; top: number }[] = [];
  if (options.shadow && canHaveShadow(background)) {
    layers.push({
      input: await shadowLayer(sharp, frame, place, alpha, "light"),
      left: 0,
      top: 0,
    });
  }
  layers.push({ input: png, left: place.left, top: place.top });
  const canvas = sharp({
    create: {
      width: frame.width,
      height: frame.height,
      channels: 4,
      background: fill,
    },
  }).composite(layers);
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

/**
 * The cut-out standing in a generated scene: smaller than on a plain
 * background, its base on the SCENE_FLOOR line the scene was drawn for, with a
 * darker shadow so it sits on the surface. The scene is fitted to the frame;
 * the product's pixels are copied, never adjusted, because shoppers buy on
 * colour.
 */
export async function renderOnScene(
  cutoutPng: Buffer,
  cutoutSize: { width: number; height: number },
  scene: Buffer,
  frame: { width: number; height: number },
): Promise<Buffer> {
  const sharp = await loadSharp();
  const place = placeOnFloor(cutoutSize, frame);
  const { png, alpha } = await placedProduct(sharp, cutoutPng, place);
  const shadow = await shadowLayer(sharp, frame, place, alpha, "scene");
  const base = await sharp(scene)
    .rotate()
    .resize(frame.width, frame.height, { fit: "cover", position: "centre" })
    .removeAlpha()
    .png()
    .toBuffer();
  return sharp(base)
    .composite([
      { input: shadow, left: 0, top: 0 },
      { input: png, left: place.left, top: place.top },
    ])
    .webp({ quality: 90 })
    .toBuffer();
}
