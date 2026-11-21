// ---------------------------------------------------------------------------
// Which service draws a storefront redesign's pictures: Google Vertex AI or
// ElevenLabs, and which ElevenLabs image model. Pure and client-safe: the
// operator console's switch and the server's reader share these words.
//
// ★ WHY THERE IS A SECOND PROVIDER. Vertex allows 2 image requests a minute
//   per project per base model, and that limit cannot be raised, so a
//   redesign's 11 or so pictures queue 31 to 45 seconds apart
//   (lib/theme-studio/provider-capacity.ts). ElevenLabs serves the same and
//   other image models through one API key with no such pacing.
//
// ★ THE MODEL LIST IS THE API REFERENCE'S, NOT THE APP'S. ElevenLabs offers
//   more image models in its app than its API accepts, and there is no
//   endpoint that lists them, so only `model_id` values the create schema
//   names belong here (checked 2026-11-21). Every model listed takes
//   reference images, which a redesign always sends.
// ---------------------------------------------------------------------------

export const REVAMP_IMAGE_PROVIDERS = ["vertex", "elevenlabs"] as const;
export type RevampImageProvider = (typeof REVAMP_IMAGE_PROVIDERS)[number];

export const REVAMP_IMAGE_PROVIDER_LABELS: Record<RevampImageProvider, string> =
  {
    vertex: "Google Vertex AI",
    elevenlabs: "ElevenLabs",
  };

/** The aspect ratios a redesign asks for (THEME_IMAGE_ASPECT_RATIOS). */
type Ratio =
  | "1:1"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:3"
  | "4:5"
  | "5:4"
  | "9:16"
  | "16:9"
  | "21:9";

const ALL_RATIOS: readonly Ratio[] = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
];

export interface ElevenLabsImageModelDef {
  id: string;
  label: string;
  /** The ratios it accepts out of the ones a redesign asks for. */
  ratios: readonly Ratio[];
  /** The `resolution` sent, or none for a model with no such field. */
  resolution: string | null;
  /** A short note for the operator, or null. */
  note: string | null;
}

export const ELEVENLABS_IMAGE_MODELS = [
  {
    id: "gemini-3.1-flash-image",
    label: "Nano Banana 2",
    ratios: ALL_RATIOS,
    resolution: "2K",
    note: null,
  },
  {
    id: "gemini-3-pro-image",
    label: "Nano Banana Pro",
    ratios: ALL_RATIOS,
    resolution: "2K",
    note: "Richer detail, about twice the credits.",
  },
  {
    id: "gemini-3.1-flash-lite-image",
    label: "Nano Banana 2 Lite",
    ratios: ALL_RATIOS,
    resolution: "1K",
    note: "1K only, so wide photos may be smaller than their frame.",
  },
  {
    id: "gpt-image-2",
    label: "GPT Image 2",
    ratios: ALL_RATIOS,
    resolution: "2K",
    note: null,
  },
  {
    id: "gpt-image-2.5-flare",
    label: "GPT Image 2.5 Flare",
    ratios: ALL_RATIOS,
    resolution: "2K",
    note: null,
  },
  {
    id: "gpt-image-2.5-sunburst",
    label: "GPT Image 2.5 Sunburst",
    ratios: ALL_RATIOS,
    resolution: "2K",
    note: null,
  },
  {
    id: "bytedance-seedream-5-lite",
    label: "Seedream 5 Lite",
    ratios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
    resolution: "2K",
    note: "Needs ElevenLabs to approve the model first.",
  },
  {
    id: "bytedance-seedream-5-pro",
    label: "Seedream 5 Pro",
    ratios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
    resolution: "2K",
    note: "Needs ElevenLabs to approve the model first.",
  },
] as const satisfies readonly ElevenLabsImageModelDef[];

export type ElevenLabsImageModel =
  (typeof ELEVENLABS_IMAGE_MODELS)[number]["id"];

export const DEFAULT_ELEVENLABS_IMAGE_MODEL: ElevenLabsImageModel =
  "gemini-3.1-flash-image";

export interface RevampImageSettings {
  provider: RevampImageProvider;
  elevenLabsModel: ElevenLabsImageModel;
}

export const DEFAULT_REVAMP_IMAGE_SETTINGS: RevampImageSettings = {
  provider: "vertex",
  elevenLabsModel: DEFAULT_ELEVENLABS_IMAGE_MODEL,
};

export function isRevampImageProvider(
  value: unknown,
): value is RevampImageProvider {
  return (
    typeof value === "string" &&
    (REVAMP_IMAGE_PROVIDERS as readonly string[]).includes(value)
  );
}

export function isElevenLabsImageModel(
  value: unknown,
): value is ElevenLabsImageModel {
  return (
    typeof value === "string" &&
    ELEVENLABS_IMAGE_MODELS.some((model) => model.id === value)
  );
}

export function elevenLabsModelDef(
  id: ElevenLabsImageModel,
): ElevenLabsImageModelDef {
  return (
    ELEVENLABS_IMAGE_MODELS.find((model) => model.id === id) ??
    ELEVENLABS_IMAGE_MODELS[0]
  );
}

/** Width over height of "4:5". */
function ratioValue(ratio: string): number {
  const [w, h] = ratio.split(":").map(Number);
  return w / h;
}

/**
 * The ratio sent to the model: the one asked for when the model takes it,
 * else the nearest it takes (by the log of width over height, so 21:9 is
 * nearer 16:9 than 1:1). The redesign crops every picture to its frame
 * afterwards, so a near ratio costs only a little of the picture's edge.
 */
export function elevenLabsAspectRatio(
  model: ElevenLabsImageModelDef,
  ratio: string,
): string {
  if ((model.ratios as readonly string[]).includes(ratio)) return ratio;
  const wanted = Math.log(ratioValue(ratio));
  let best: string = model.ratios[0];
  let bestGap = Number.POSITIVE_INFINITY;
  for (const candidate of model.ratios) {
    const gap = Math.abs(Math.log(ratioValue(candidate)) - wanted);
    if (gap < bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}
