import sharp from "sharp";
import { createHash } from "node:crypto";
import type { ThemeStudioContentBlock } from "./provider";

export interface VisualEvidenceSample {
  assetId: string;
  viewport: string;
  page: string;
}

/** Keep full-page phone text at native width. Limiting height to 4096px made
 * long pages unreadable before the reviewer even received their thumbnails. */
export async function prepareVisualScreenshot(bytes: Uint8Array) {
  const source = sharp(bytes, {
    failOn: "warning",
    limitInputPixels: 50_000_000,
  });
  const meta = await source.metadata();
  if (!meta.width || !meta.height) throw new Error("qa_screenshot_unusable");
  const rotated = Boolean(meta.orientation && meta.orientation >= 5);
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;
  const outputHeight = Math.round(height * Math.min(1, 1440 / width));
  const pipeline = source
    .rotate()
    .resize({ width: 1440, withoutEnlargement: true });
  // WebP's maximum dimension is 16383. Long full-page captures need PNG
  // storage; their overview/detail attachments remain small WebP images.
  const long = outputHeight > 16383;
  const { data, info } = await (
    long
      ? pipeline.png({ compressionLevel: 6 })
      : pipeline.webp({ quality: 72 })
  ).toBuffer({ resolveWithObject: true });
  if (info.height > 100000 || data.byteLength > 10 * 1024 * 1024)
    throw new Error("qa_screenshot_too_large");
  return {
    bytes: data,
    mediaType: long ? ("image/png" as const) : ("image/webp" as const),
    width: info.width,
    height: info.height,
    sha256: createHash("sha256").update(data).digest("hex"),
    originalByteSize: bytes.byteLength,
  };
}

/** Overview sheets establish composition at all five widths. Separate native
 * width top/middle/footer strips make copy, controls and repeated modules
 * readable on phone and desktop. Decode one source at a time; never load the
 * thirty full-page images into a worker or decode six of them concurrently. */
export async function buildVisualEvidence(
  samples: readonly VisualEvidenceSample[],
  load: (id: string) => Promise<Buffer>,
  signal: AbortSignal,
): Promise<ThemeStudioContentBlock[]> {
  const groups = new Map<string, VisualEvidenceSample[]>();
  for (const sample of samples) {
    const list = groups.get(sample.viewport) ?? [];
    list.push(sample);
    groups.set(sample.viewport, list);
  }
  const blocks: ThemeStudioContentBlock[] = [];
  for (const [viewport, group] of groups) {
    const composites: { input: Buffer; left: number; top: number }[] = [];
    for (const [index, sample] of group.slice(0, 6).entries()) {
      signal.throwIfAborted();
      const bytes = await load(sample.assetId);
      signal.throwIfAborted();
      const source = sharp(bytes, { limitInputPixels: 50_000_000 });
      const meta = await source.metadata();
      if (!meta.width || !meta.height)
        throw new Error("qa_screenshot_unusable");
      composites.push({
        input: await source
          .clone()
          .resize({
            width: 760,
            height: 760,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 76 })
          .toBuffer(),
        left: (index % 2) * 800 + 20,
        top: Math.floor(index / 2) * 800 + 20,
      });
      if (viewport === "phone390" || viewport === "desktop1440") {
        const height = Math.min(800, meta.height);
        const starts = [
          ...new Set([
            0,
            Math.floor((meta.height - height) / 2),
            meta.height - height,
          ]),
        ];
        const strips: { input: Buffer; left: number; top: number }[] = [];
        for (const [region, top] of starts.entries()) {
          signal.throwIfAborted();
          strips.push({
            input: await source
              .clone()
              .extract({ left: 0, top, width: meta.width, height })
              .webp({ quality: 88 })
              .toBuffer(),
            left: 0,
            top: region * (height + 16),
          });
        }
        const detail = await sharp({
          create: {
            width: meta.width,
            height: starts.length * (height + 16) - 16,
            channels: 3,
            background: "#dddddd",
          },
        })
          .composite(strips)
          .webp({ quality: 88 })
          .toBuffer();
        blocks.push({
          type: "text",
          text: `Readable detail: ${viewport}, ${sample.page}. Native width ${meta.width}px. Strips in order from source y=${starts.join(", ")}, each ${height}px high; grey separators are capture boundaries, not storefront gaps. Check text, buttons, prices, duplicate signup forms and unsupported factual claims.`,
        });
        blocks.push({
          type: "image",
          mediaType: "image/webp",
          base64: detail.toString("base64"),
        });
      }
    }
    signal.throwIfAborted();
    const sheet = await sharp({
      create: { width: 1600, height: 2400, channels: 3, background: "#f5f5f2" },
    })
      .composite(composites)
      .webp({ quality: 80 })
      .toBuffer();
    blocks.push({
      type: "text",
      text: `Layout overview for ${viewport}, in row-major order: ${group
        .slice(0, 6)
        .map((sample, i) => `${i + 1}. ${sample.page}`)
        .join(
          "; ",
        )}. These thumbnails establish layout only; judge copy and control quality using the separate readable strips.`,
    });
    blocks.push({
      type: "image",
      mediaType: "image/webp",
      base64: sheet.toString("base64"),
    });
  }
  return blocks;
}
