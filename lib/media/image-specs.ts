// The exact size every upload slot is rendered at.
//
// ★ ONE CATALOGUE, read by the upload widget (which states the size and warns
// when a photo will be cropped) AND by the Refine with Mink AI route (which
// produces exactly this size). Client-safe: no server imports.
//
// ★ EVERY RATIO IS ONE THE IMAGE MODEL ACCEPTS (1:1, 3:4, 4:3, 4:5, 16:9,
// 21:9), so a refine is composed at the target shape rather than cropped into
// it afterwards. The width and height are what the storefront actually shows
// at full size on a large screen, so a photo at this size is never upscaled.
//
// ★ `refine: false` for brand marks. A logo is the merchant's identity; an AI
// "retouch" of one is a different logo, so those slots state a size and offer
// nothing else.

export type ImageAspect = "1:1" | "3:4" | "4:3" | "4:5" | "16:9" | "21:9";

export interface ImageSpec {
  /** What the slot is, in the merchant's words. */
  label: string;
  width: number;
  height: number;
  aspect: ImageAspect;
  /** Whether Refine with Mink AI is offered for this slot. */
  refine: boolean;
  /**
   * Whether Change background is offered: the product cut out and placed on
   * white, a colour or transparency, or re-shot by Mink AI in a scene. Only
   * where the photo IS a product: a banner or blog cover is a scene already,
   * and cutting one subject out of it would throw the picture away.
   */
  background: boolean;
  /** One short sentence on how the storefront uses it. */
  hint: string;
}

export const IMAGE_SPECS = {
  product: {
    label: "Product photo",
    width: 1200,
    height: 1600,
    aspect: "3:4",
    refine: true,
    background: true,
    hint: "Product cards show photos in a 3:4 portrait frame, edge to edge.",
  },
  product_square: {
    label: "Product photo",
    width: 1200,
    height: 1200,
    aspect: "1:1",
    refine: true,
    background: true,
    hint: "Product cards show photos in a square frame, edge to edge.",
  },
  category: {
    label: "Category image",
    width: 1200,
    height: 1200,
    aspect: "1:1",
    refine: true,
    background: true,
    hint: "Category tiles and circles are square.",
  },
  blog_cover: {
    label: "Blog cover",
    width: 1600,
    height: 900,
    aspect: "16:9",
    refine: true,
    background: false,
    hint: "Blog covers are shown wide, at 16:9.",
  },
  hero_wide: {
    label: "Full-width banner",
    width: 2520,
    height: 1080,
    aspect: "21:9",
    refine: true,
    background: false,
    hint: "Full-width banners are wide; keep the subject near the centre so phones keep it.",
  },
  hero_side: {
    label: "Hero image",
    width: 1200,
    height: 1500,
    aspect: "4:5",
    refine: true,
    background: false,
    hint: "Shown beside the heading in a tall frame.",
  },
  hero_phone: {
    label: "Phone image",
    width: 1080,
    height: 1350,
    aspect: "4:5",
    refine: true,
    background: false,
    hint: "Shown instead of the main image on phones.",
  },
  portrait: {
    label: "Portrait image",
    width: 1200,
    height: 1500,
    aspect: "4:5",
    refine: true,
    background: false,
    hint: "Shown in a 4:5 portrait frame.",
  },
  square: {
    label: "Square image",
    width: 1200,
    height: 1200,
    aspect: "1:1",
    refine: true,
    background: false,
    hint: "Shown in a square frame.",
  },
  landscape: {
    label: "Landscape image",
    width: 1600,
    height: 1200,
    aspect: "4:3",
    refine: true,
    background: false,
    hint: "Shown in a 4:3 landscape frame.",
  },
  video_poster: {
    label: "Video poster",
    width: 1920,
    height: 1080,
    aspect: "16:9",
    refine: true,
    background: false,
    hint: "Shown before the video plays, at 16:9.",
  },
  menu: {
    label: "Menu image",
    width: 800,
    height: 1000,
    aspect: "4:5",
    refine: true,
    background: false,
    hint: "Shown beside the menu links on larger screens.",
  },
  logo: {
    label: "Logo",
    width: 600,
    height: 200,
    aspect: "21:9",
    refine: false,
    background: false,
    hint: "A transparent PNG or SVG with little empty space around it looks sharpest.",
  },
} as const satisfies Record<string, ImageSpec>;

export type ImageSpecKey = keyof typeof IMAGE_SPECS;

export function isImageSpecKey(value: unknown): value is ImageSpecKey {
  return typeof value === "string" && Object.hasOwn(IMAGE_SPECS, value);
}

/** The product-photo slot for the store's card photo shape (Website Builder →
 *  Brand → Storefront layout → Card photo shape). */
export function productPhotoSpec(
  cardPhoto: "portrait" | "square" | undefined,
): "product" | "product_square" {
  return cardPhoto === "square" ? "product_square" : "product";
}

/** The slot for a 4:5 / 1:1 / 4:3 ratio setting used by several sections. */
export function specForRatio(
  ratio: "portrait" | "square" | "landscape" | undefined,
): ImageSpecKey {
  return ratio === "square"
    ? "square"
    : ratio === "landscape"
      ? "landscape"
      : "portrait";
}

/**
 * How much of a photo the slot will crop away, as a fraction of its area
 * (0 = an exact fit). The card and section frames use `object-fit: cover`, so
 * a photo of a different shape loses its edges.
 */
export function croppedFraction(
  width: number,
  height: number,
  spec: Pick<ImageSpec, "width" | "height">,
): number {
  if (!(width > 0) || !(height > 0)) return 0;
  const source = width / height;
  const target = spec.width / spec.height;
  return source > target ? 1 - target / source : 1 - source / target;
}

/**
 * A sentence for an uploaded photo that will not show as uploaded, or null
 * when it fits. ★ A small difference is not worth a warning: under 6% of the
 * area is the same tolerance the Mink media preparation uses.
 */
export function imageFitWarning(
  width: number,
  height: number,
  spec: Pick<ImageSpec, "width" | "height" | "aspect">,
): string | null {
  if (!(width > 0) || !(height > 0)) return null;
  const crop = croppedFraction(width, height, spec);
  if (crop > 0.06) {
    const edges =
      width / height > spec.width / spec.height ? "sides" : "top and bottom";
    return `This photo is ${width} × ${height}. The ${aspectWord(spec.aspect)} frame will crop about ${Math.round(crop * 100)}% from the ${edges}.`;
  }
  if (width < spec.width * 0.6) {
    return `This photo is ${width} × ${height}, smaller than the recommended ${spec.width} × ${spec.height}, so it may look soft on large screens.`;
  }
  return null;
}

function aspectWord(aspect: ImageAspect): string {
  switch (aspect) {
    case "1:1":
      return "square";
    case "3:4":
    case "4:5":
      return `${aspect} portrait`;
    default:
      return `${aspect} landscape`;
  }
}

/** What one refine costs, in Mink credits (owner's price, 2026-10-06). */
export const IMAGE_REFINE_CREDITS = 2;

/**
 * What background removal costs, in Mink credits (owner's price, 2026-10-17):
 * once per photo. Trying another background for the same photo reuses the
 * cut-out and is free.
 */
export const IMAGE_CUTOUT_CREDITS = 1;

/**
 * What one AI product photo costs, in Mink credits (owner's price, 2026-10-17,
 * kept for the Sidekick-style edit on 2026-10-18): the real cost of one
 * Gemini 3.1 Flash Image call (about ₹9) at what a credit sells for. Charged
 * per photo created, from the photo editor's Scene option and from Mink chat
 * alike; "Try again" is another photo.
 */
export const IMAGE_EDIT_CREDITS = 5;
