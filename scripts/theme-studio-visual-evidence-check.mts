/** Offline synthetic memory/evidence check. No DB, browser or provider calls.
 * Six surfaces at five widths use long sources up to 46 million pixels.
 * This profiles decoding, not visual judgment or production completion time. */
import sharp from "sharp";
import {
  buildVisualEvidence,
  prepareVisualScreenshot,
} from "../lib/theme-studio/visual-evidence";
import { configureWorkerImages } from "../lib/theme-studio/worker-runtime";

process.env.THEME_STUDIO_WORKER_ONLY = "true";
configureWorkerImages();
const frames = new Map<string, Buffer>();
const samples: { assetId: string; viewport: string; page: string }[] = [];
for (const [viewport, width, height] of [
  ["phone360", 360, 27000],
  ["phone390", 390, 27000],
  ["tablet768", 768, 26000],
  ["laptop1024", 1024, 30000],
  ["desktop1440", 1440, 32000],
] as const) {
  const rows = Array.from(
    { length: Math.ceil(height / 500) },
    (_, i) =>
      `<rect x="20" y="${i * 500 + 30}" width="${width - 40}" height="360" fill="${i % 2 ? "#ddddaa" : "#7799aa"}"/><text x="30" y="${i * 500 + 440}" font-size="18">Product ${i} — ₹1,250 · Shop collection</text>`,
  ).join("");
  const original = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${rows}</svg>`,
    ),
  )
    .jpeg({ quality: 55 })
    .toBuffer();
  frames.set(viewport, (await prepareVisualScreenshot(original)).bytes);
  for (const page of ["home", "shop", "product", "cart", "about", "journal"]) {
    samples.push({ assetId: `${viewport}:${page}`, viewport, page });
  }
}
let loads = 0;
const started = performance.now();
const blocks = await buildVisualEvidence(
  samples,
  async (id) => {
    loads++;
    const bytes = frames.get(id.split(":")[0]);
    if (!bytes) throw new Error("Missing fixture");
    return bytes;
  },
  new AbortController().signal,
);
const images = blocks.filter((b) => b.type === "image");
if (images.length !== 17 || loads !== 30)
  throw new Error("Incomplete evidence");
console.log(
  JSON.stringify({
    sources: loads,
    screenshotAttachments: images.length,
    evidenceSeconds: (performance.now() - started) / 1000,
    rssMiBAtEnd: Math.round(process.memoryUsage().rss / 1048576),
    processMaxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    synthetic: true,
  }),
);
