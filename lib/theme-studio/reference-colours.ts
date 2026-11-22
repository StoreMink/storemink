// ---------------------------------------------------------------------------
// The colours of a reference screenshot, MEASURED from its pixels (owner,
// 22 Nov 2026: a reference "should be analysed deeply").
//
// WHY. A model reading a screenshot names its colours in words ("a warm
// cream page, a terracotta accent") and guesses a hex, and the stage that
// built the theme never saw the picture at all. The exact page colour and
// accent were lost on the way. So StoreMink reads them itself, from the
// stored (already sanitised) image, and gives them to the planning stage as
// facts beside each screenshot.
//
// ★ A MEASUREMENT, NOT A JUDGEMENT. It answers "which colours cover this
//   picture, and how much of it": the largest is taken as the background,
//   the one that contrasts most with it as the text, the most saturated as
//   the accent. A photograph inside the screenshot counts toward the shares
//   too, which the prompt says; the model still looks at the picture and
//   decides which measured colour plays which part.
// ★ DETERMINISTIC: the same bytes give the same answer, so a run reclaimed
//   after a restart sends the request it sent the first time.
// ★ NEVER FATAL: an image that cannot be measured gives no measurement, and
//   the theme is planned from the picture alone.
// ---------------------------------------------------------------------------

/** The widest side the picture is measured at. */
const SAMPLE_EDGE = 200;
/**
 * Colours within this RGB distance are one colour. Wide enough to fold
 * compression noise into its colour (two neighbouring boxes are at most 14
 * apart), and narrow enough to keep a cream page (#f5f1ea) and its white
 * cards (27 apart) as the two colours they are.
 */
const MERGE_DISTANCE = 16;
/** The most colours reported for one screenshot. */
export const REFERENCE_COLOURS_MAX = 6;
/** A colour under this share of the picture is not reported. */
const MIN_SHARE = 0.01;
/** Text and accents are thin: they are looked for down to this share. */
const MIN_ROLE_SHARE = 0.003;

export interface MeasuredColour {
  /** #rrggbb */
  hex: string;
  /** Its share of the picture, 0 to 1 (3 decimals). */
  share: number;
}
export interface ReferenceColours {
  /** The colours that cover the picture, largest first. */
  colours: MeasuredColour[];
  /** The largest: taken as the page background. */
  background: string;
  /** The colour that contrasts most with the background, or null. */
  text: string | null;
  /** The most saturated colour of any size worth naming, or null. */
  accent: string | null;
  /** Whether the background is dark. */
  dark: boolean;
}

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b]
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
const linear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const luminance = (c: Cluster) =>
  0.2126 * linear(c.r / 255) +
  0.7152 * linear(c.g / 255) +
  0.0722 * linear(c.b / 255);
const contrast = (a: Cluster, b: Cluster) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** 0 (grey) to 1 (fully saturated). */
const chroma = (c: Cluster) =>
  (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;

interface Cluster {
  r: number;
  g: number;
  b: number;
  count: number;
}

/**
 * The colours of raw RGB pixels (3 bytes each). Pure, so it is tested
 * without an image decoder.
 */
export function measureRgbPixels(pixels: Uint8Array): ReferenceColours | null {
  const total = Math.floor(pixels.length / 3);
  if (total < 16) return null;
  // 5 bits a channel: 32,768 boxes, each keeping its true average colour.
  const boxes = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < total * 3; i += 3) {
    const key =
      ((pixels[i] >> 3) << 10) |
      ((pixels[i + 1] >> 3) << 5) |
      (pixels[i + 2] >> 3);
    const box = boxes.get(key);
    if (box) {
      box[0] += pixels[i];
      box[1] += pixels[i + 1];
      box[2] += pixels[i + 2];
      box[3] += 1;
    } else boxes.set(key, [pixels[i], pixels[i + 1], pixels[i + 2], 1]);
  }
  // Largest box first (ties by key, so the order never depends on a Map's).
  const ordered = [...boxes.entries()].sort(
    (a, b) => b[1][3] - a[1][3] || a[0] - b[0],
  );
  const clusters: Cluster[] = [];
  for (const [, [r, g, b, count]] of ordered) {
    const mean = { r: r / count, g: g / count, b: b / count };
    const home = clusters.find(
      (c) =>
        Math.hypot(c.r - mean.r, c.g - mean.g, c.b - mean.b) < MERGE_DISTANCE,
    );
    if (home) {
      const sum = home.count + count;
      home.r = (home.r * home.count + r) / sum;
      home.g = (home.g * home.count + g) / sum;
      home.b = (home.b * home.count + b) / sum;
      home.count = sum;
    } else clusters.push({ ...mean, count });
  }
  clusters.sort((a, b) => b.count - a.count);
  const background = clusters[0];
  const share = (c: Cluster) => c.count / total;
  const named = clusters.filter((c) => share(c) >= MIN_ROLE_SHARE);
  const text = named
    .filter((c) => c !== background && contrast(c, background) >= 3)
    .sort(
      (a, b) =>
        contrast(b, background) * Math.sqrt(share(b)) -
        contrast(a, background) * Math.sqrt(share(a)),
    )[0];
  const accent = named
    .filter((c) => c !== background && chroma(c) >= 0.3)
    .sort(
      (a, b) =>
        chroma(b) * Math.sqrt(share(b)) - chroma(a) * Math.sqrt(share(a)),
    )[0];
  const asHex = (c: Cluster) => hex(c.r, c.g, c.b);
  return {
    colours: clusters
      .filter((c) => share(c) >= MIN_SHARE)
      .slice(0, REFERENCE_COLOURS_MAX)
      .map((c) => ({
        hex: asHex(c),
        share: Math.round(share(c) * 1000) / 1000,
      })),
    background: asHex(background),
    text: text ? asHex(text) : null,
    accent: accent ? asHex(accent) : null,
    dark: luminance(background) < 0.18,
  };
}

/** The colours of one stored reference image, or null when unreadable. */
export async function measureReferenceColours(
  base64: string,
): Promise<ReferenceColours | null> {
  try {
    const sharp = (await import("sharp")).default;
    const { data } = await sharp(Buffer.from(base64, "base64"), {
      limitInputPixels: 40_000_000,
    })
      .resize(SAMPLE_EDGE, SAMPLE_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
        // Nearest: a blended pixel is a colour the picture does not have.
        kernel: "nearest",
      })
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
    return measureRgbPixels(data);
  } catch {
    return null;
  }
}

/** The measurements as the lines Stage A reads with the brief (v34+). */
export function referenceColoursText(
  measured: readonly (ReferenceColours | null)[],
): string {
  const lines = measured.flatMap((m, index) =>
    m
      ? [
          `Reference ${index + 1}: ${m.colours
            .map((c) => `${c.hex} ${Math.round(c.share * 100)}%`)
            .join(", ")}. Largest (taken as the ${
            m.dark ? "dark " : ""
          }background): ${m.background}.${
            m.text
              ? ` Strongest contrast with it (taken as text): ${m.text}.`
              : ""
          }${m.accent ? ` Most saturated (a candidate accent): ${m.accent}.` : ""}`,
        ]
      : [],
  );
  if (!lines.length) return "";
  return `\nColours measured from each reference screenshot's own pixels, with the share of the picture each covers. These are measurements, trusted over a colour read by eye; a photograph inside a screenshot counts toward the shares, so decide from the picture which measured colour is the page, the surface, the text and the accent.\n${lines.join("\n")}`;
}
