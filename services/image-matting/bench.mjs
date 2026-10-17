// Benchmark for the image-matting service (docs/image-matting-service.md).
//
//   node bench.mjs --url http://localhost:8080 --runs 3 --out ./bench-out photo1.jpg photo2.png
//   node bench.mjs --url https://<service>.run.app --runs 3 --out ./bench-out photo.jpg
//
// For an https URL it asks gcloud for an identity token, which is what a
// private Cloud Run service wants (`--token none` to skip, `--token <value>`
// to supply one). MATTING_SECRET in the environment is sent as the header.
//
// Per photo it records the round trip seen here and the service's own
// Server-Timing, and writes three pictures to --out so edge quality can be
// judged by eye: the mask, the cut-out on white, and the cut-out on a
// checkerboard (which shows halos and holes that white hides).

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import sharp from "sharp";

function parseArgs(argv) {
  const args = {
    url: "http://localhost:8080",
    runs: 3,
    out: "./bench-out",
    token: "auto",
    files: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--runs") args.runs = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--token") args.token = argv[++i];
    else args.files.push(a);
  }
  if (args.files.length === 0) throw new Error("Pass at least one photo.");
  return args;
}

function identityToken(args) {
  if (args.token === "none") return null;
  if (args.token !== "auto") return args.token;
  if (!args.url.startsWith("https://")) return null;
  return execFileSync("gcloud", ["auth", "print-identity-token"], {
    encoding: "utf8",
  }).trim();
}

function serverTiming(header) {
  const out = {};
  for (const part of (header ?? "").split(",")) {
    const m = /^\s*([a-z]+);dur=([\d.]+)/i.exec(part);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

async function checkerboard(width, height, cell = 24) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><pattern id="c" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse">
      <rect width="${cell * 2}" height="${cell * 2}" fill="#ffffff"/>
      <rect width="${cell}" height="${cell}" fill="#d9d9d9"/>
      <rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="#d9d9d9"/>
    </pattern></defs><rect width="100%" height="100%" fill="url(#c)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function previews(photo, maskPng, width, height, outDir, stem) {
  const rgb = await sharp(photo)
    .rotate()
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .toBuffer();
  const mask = await sharp(maskPng).extractChannel(0).raw().toBuffer();
  const cutout = await sharp(rgb)
    .joinChannel(mask, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  const onWhite = await sharp(cutout)
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 90 })
    .toBuffer();
  const onChecker = await sharp(await checkerboard(width, height))
    .composite([{ input: cutout }])
    .jpeg({ quality: 90 })
    .toBuffer();
  // One sheet to look at: original | mask | on white | on checker.
  const tileW = 600;
  const tileH = Math.round((height / width) * tileW);
  const tiles = await Promise.all(
    [photo, maskPng, onWhite, onChecker].map((input, i) =>
      (i === 0 ? sharp(input).rotate() : sharp(input))
        .resize(tileW, tileH, { fit: "fill" })
        .flatten({ background: "#ffffff" })
        .toBuffer(),
    ),
  );
  const sheet = await sharp({
    create: {
      width: tileW * 4 + 30,
      height: tileH,
      channels: 3,
      background: "#888888",
    },
  })
    .composite(
      tiles.map((input, i) => ({ input, left: i * (tileW + 10), top: 0 })),
    )
    .jpeg({ quality: 85 })
    .toBuffer();
  await writeFile(join(outDir, `${stem}-mask.png`), maskPng);
  await writeFile(join(outDir, `${stem}-white.jpg`), onWhite);
  await writeFile(join(outDir, `${stem}-checker.jpg`), onChecker);
  await writeFile(join(outDir, `${stem}-sheet.jpg`), sheet);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  const token = identityToken(args);
  const headers = { "content-type": "application/octet-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (process.env.MATTING_SECRET)
    headers["x-matting-secret"] = process.env.MATTING_SECRET;

  const results = [];
  let first = true;
  for (const file of args.files) {
    const photo = await readFile(file);
    const runs = [];
    let last = null;
    for (let i = 0; i < args.runs; i += 1) {
      const started = performance.now();
      const res = await fetch(
        `${args.url.replace(/\/$/, "")}/v1/matte?output=mask`,
        {
          method: "POST",
          headers,
          body: photo,
        },
      );
      const body = Buffer.from(await res.arrayBuffer());
      const wall = performance.now() - started;
      if (!res.ok)
        throw new Error(
          `${basename(file)}: HTTP ${res.status} ${body.toString("utf8").slice(0, 200)}`,
        );
      const timing = serverTiming(res.headers.get("server-timing"));
      runs.push({ wall, ...timing, coldCandidate: first && i === 0 });
      last = { body, res };
    }
    first = false;
    const h = last.res.headers;
    const width = Number(h.get("x-matting-width"));
    const height = Number(h.get("x-matting-height"));
    const stem = basename(file, extname(file));
    await previews(photo, last.body, width, height, args.out, stem);
    const warm = runs.length > 1 ? runs.slice(1) : runs;
    results.push({
      photo: basename(file),
      bytes: photo.length,
      size: `${width}x${height}`,
      model: h.get("x-matting-model"),
      verdict: h.get("x-matting-verdict"),
      coverage: Number(h.get("x-matting-coverage")),
      soft: Number(h.get("x-matting-soft")),
      rssMb: Number(h.get("x-matting-rss-mb")),
      peakMb: Number(h.get("x-matting-peak-mb")),
      firstWallMs: Math.round(runs[0].wall),
      warmWallMs: Math.round(median(warm.map((r) => r.wall))),
      warmInferMs: Math.round(median(warm.map((r) => r.infer ?? 0))),
      warmTotalMs: Math.round(median(warm.map((r) => r.total ?? 0))),
      runs,
    });
  }

  // The per-run detail goes to results.json; the table shows the summary.
  console.table(
    results.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== "runs")),
    ),
  );
  await writeFile(
    join(args.out, "results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(`Pictures and results.json written to ${args.out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
