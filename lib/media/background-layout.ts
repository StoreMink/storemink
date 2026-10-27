// Background removal: the arithmetic, with no server imports, so it is tested
// directly and the product editor can share the background vocabulary.
//
// ★ THE PRODUCT IS CENTRED AND SIZED, NOT JUST CUT OUT. A cut-out dropped on
//   white at whatever size it had in the merchant's photo makes a catalogue
//   where every product is a different size. Each one is scaled so its longer
//   side fills PRODUCT_FILL of the frame, the convention marketplaces use
//   (Amazon asks for the product to fill 85% of a main image), so a grid of
//   them reads as one shoot.
// ★ NO SCENES HERE. A product in a scene is re-shot by Mink AI from the real
//   photo (lib/media/photo-edit.ts); placing the cut-out on a drawn set was
//   tried and judged unconvincing (owner, 2026-10-18).
// ★ THE SHADOW IS DRAWN FROM THE PRODUCT'S OWN FOOTPRINT (the bottom rows of
//   its mask), never painted onto the product. A product on white with no
//   shadow reads as floating; one ellipse the width of its base fixes that.

/** How much of the frame the product fills along its limiting side. */
export const PRODUCT_FILL = 0.84;

/** A mask value at or above this is product. */
export const MASK_THRESHOLD = 128;

/** Product scaled up by more than this looks soft. */
export const MAX_UPSCALE = 1.6;

export type BackgroundChoice =
  | { kind: "white" }
  | { kind: "transparent" }
  | { kind: "colour"; hex: string };

/**
 * A background from untrusted input, or null. A colour must be exactly
 * `#rrggbb`: it is drawn as a fill and named in a file path, so nothing else
 * is accepted.
 */
export function parseBackground(value: unknown): BackgroundChoice | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "white") return { kind: "white" };
  if (kind === "transparent") return { kind: "transparent" };
  if (kind === "colour") {
    const hex = (value as { hex?: unknown }).hex;
    if (typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex)) {
      return { kind: "colour", hex: hex.toLowerCase() };
    }
  }
  return null;
}

/** A stable short name for a background, used in the stored file's name so
 *  asking for the same background twice reuses the first result. */
export function backgroundKey(background: BackgroundChoice): string {
  switch (background.kind) {
    case "white":
      return "white";
    case "transparent":
      return "transparent";
    case "colour":
      return `c${background.hex.slice(1).toLowerCase()}`;
  }
}

/** Whether a background can carry a shadow: a transparent one cannot, since
 *  the merchant may place it on any colour. */
export function canHaveShadow(background: BackgroundChoice): boolean {
  return background.kind !== "transparent";
}

/** The fill as RGBA for sharp. */
export function backgroundFill(background: BackgroundChoice): {
  r: number;
  g: number;
  b: number;
  alpha: number;
} {
  if (background.kind === "transparent") return { r: 0, g: 0, b: 0, alpha: 0 };
  if (background.kind === "white") return { r: 255, g: 255, b: 255, alpha: 1 };
  const hex = background.hex.slice(1);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    alpha: 1,
  };
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The smallest box holding every product pixel of a single-channel mask, or
 * null when there is none.
 */
export function maskBounds(
  mask: Uint8Array,
  width: number,
  height: number,
  threshold = MASK_THRESHOLD,
): Box | null {
  if (mask.length < width * height) return null;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (mask[row + x] >= threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

/**
 * Where a cut-out of `cut` goes in a frame of `frame`: scaled so its limiting
 * side fills `fill` of the frame, keeping its shape, centred.
 */
export function placeInFrame(
  cut: { width: number; height: number },
  frame: { width: number; height: number },
  fill = PRODUCT_FILL,
): Box & { scale: number } {
  const scale = Math.min(
    (frame.width * fill) / cut.width,
    (frame.height * fill) / cut.height,
  );
  const width = Math.max(1, Math.round(cut.width * scale));
  const height = Math.max(1, Math.round(cut.height * scale));
  return {
    width,
    height,
    left: Math.round((frame.width - width) / 2),
    top: Math.round((frame.height - height) / 2),
    scale,
  };
}

export interface ShadowLayer {
  /** How far below the product's base the shadow reaches, in pixels. */
  depth: number;
  /** Blur radius (sigma), in pixels. */
  blur: number;
  opacity: number;
}

/**
 * The two shadows under a placed product of `height` pixels: a short, dark
 * contact shadow right under its base and a deeper, faint one around it.
 */
export function shadowLayersFor(height: number): ShadowLayer[] {
  return [
    {
      depth: Math.max(Math.round(height * 0.025), 4),
      blur: Math.max(height * 0.006, 1.5),
      opacity: 0.45,
    },
    {
      depth: Math.max(Math.round(height * 0.07), 10),
      blur: Math.max(height * 0.025, 5),
      opacity: 0.18,
    },
  ];
}

/** Only a base this low in the product casts a ground shadow: a strap or a
 *  handle hanging in mid-air does not touch the ground. */
const GROUND_FROM = 0.55;

/**
 * A ground shadow cast straight down from the product's base: for every column
 * whose lowest product pixel is near the bottom, a band `depth` pixels deep
 * that starts dark at that pixel and fades out. Following the base column by
 * column is what keeps an angled sole grounded along its whole length; one
 * ellipse under the lowest point left the rest of it floating.
 *
 * Returns `width × (height + depth)` values, aligned with the product's top
 * left corner.
 */
export function groundShadow(
  alpha: Uint8Array,
  width: number,
  height: number,
  depth: number,
  threshold = MASK_THRESHOLD,
): Uint8Array {
  const rows = height + depth;
  const out = new Uint8Array(width * rows);
  if (alpha.length < width * height || depth < 1) return out;
  const lowestAllowed = Math.floor(height * GROUND_FROM);
  for (let x = 0; x < width; x += 1) {
    let base = -1;
    for (let y = height - 1; y >= lowestAllowed; y -= 1) {
      if (alpha[y * width + x] >= threshold) {
        base = y;
        break;
      }
    }
    if (base < 0) continue;
    for (let d = 0; d < depth; d += 1) {
      const fade = 1 - d / depth;
      out[(base + d) * width + x] = Math.round(255 * fade * fade);
    }
  }
  return out;
}

/** Things a merchant should know about a cut-out before using it. */
export type CutoutCheck = "touches_edge" | "small";

/**
 * Free checks on a cut-out, from the mask alone.
 *
 * - `touches_edge`: the product runs off the photo's edge, so part of it may
 *   be missing from the cut-out.
 * - `small`: the product is small in the photo, so filling a product frame
 *   means enlarging it past MAX_UPSCALE.
 */
export function cutoutChecks(
  bounds: Box,
  photo: { width: number; height: number },
  frame: { width: number; height: number },
): CutoutCheck[] {
  const checks: CutoutCheck[] = [];
  const margin = 2;
  if (
    bounds.left <= margin ||
    bounds.top <= margin ||
    bounds.left + bounds.width >= photo.width - margin ||
    bounds.top + bounds.height >= photo.height - margin
  ) {
    checks.push("touches_edge");
  }
  if (placeInFrame(bounds, frame).scale > MAX_UPSCALE) checks.push("small");
  return checks;
}

/** What each check means, in the merchant's words. */
export const CUTOUT_CHECK_MESSAGES: Record<CutoutCheck, string> = {
  touches_edge:
    "The product touches the edge of your photo, so part of it may be missing. A photo with some space around the product works best.",
  small:
    "The product is small in your photo, so it was enlarged and may look soft. A closer photo will look sharper.",
};

export function isCutoutCheck(value: unknown): value is CutoutCheck {
  return value === "touches_edge" || value === "small";
}
