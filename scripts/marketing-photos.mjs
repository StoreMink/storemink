#!/usr/bin/env node
// Generates the photographs for storemink.com's marketing pages
// (public/marketing/**) with the Gemini image model Theme Studio uses, then
// crops and encodes each for its slot. Provenance: docs/marketing-assets.md.
//
// Every picture on the marketing site is made here. None is a theme's seed
// image or a catalogue product photo (owner's rule, 2026-10-09), and none is a
// stock photo: no third-party photograph, logo, branded product or real person
// is used or referenced.
//
// Paid: one Vertex call per photograph, no retries. Dry by default; pass
// `--live --yes` to spend. Needs ADC (`gcloud auth application-default login`)
// and GCP_PROJECT_ID (or --project). Raw JPEGs are kept under --raw-dir
// (default .marketing-raw/, gitignored) so a crop can be redone for free.
//
// Usage:
//   node scripts/marketing-photos.mjs                         # plan only
//   node scripts/marketing-photos.mjs --live --yes            # everything
//   node scripts/marketing-photos.mjs --live --yes --only hero-model
//   node scripts/marketing-photos.mjs --live --yes --skip-existing
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  Modality,
  ProminentPeople,
} from "@google/genai";

const MODEL = "gemini-3-pro-image";
const ROOT = path.resolve("public/marketing");

// The look is shopify.com's: editorial, candid, premium and quiet. Every
// prompt ends with this block so the set reads as one shoot.
const STYLE =
  "Premium editorial photograph in the style of a top fashion and lifestyle e-commerce brand campaign: candid and natural, shot on a 35mm or 50mm lens with shallow depth of field, soft natural daylight, a muted warm palette, true-to-life skin and materials, no HDR, no cartoonish saturation. Indian settings and people where people appear. Absolutely no text, lettering, numbers, logos, brand marks, price tags, labels, signage or readable screens anywhere in the frame; any phone, tablet or laptop screen shows only a soft, unreadable blur.";

/** @type {{ id: string; out: string; aspect: string; width: number; height: number; prompt: string }[]} */
export const PHOTOS = [
  // Hero: what the phone shows, and two product tiles floating beside it.
  {
    id: "hero-model",
    out: "hero/model.webp",
    aspect: "3:4",
    width: 1000,
    height: 1250,
    prompt:
      "Fashion lookbook photograph for an online store: a young Indian woman in a relaxed forest-green linen shirt and cream wide-leg trousers, standing three-quarter to camera against a sunlit terracotta plaster wall, calm confident expression, torso and hands visible, soft directional afternoon light.",
  },
  {
    id: "hero-float-sunglasses",
    out: "hero/float-sunglasses.webp",
    aspect: "1:1",
    width: 800,
    height: 800,
    prompt:
      "Product still life: a pair of tortoiseshell acetate sunglasses resting on a sunlit sandstone ledge at the edge of a swimming pool, hard afternoon light with crisp shadows, water out of focus behind.",
  },
  {
    id: "hero-float-sneaker",
    out: "hero/float-sneaker.webp",
    aspect: "1:1",
    width: 800,
    height: 800,
    prompt:
      "Product still life: a single off-white leather sneaker on a pale stone step with a sliver of morning sunlight across it, minimal and calm.",
  },

  // The online store page hero: a store being built.
  {
    id: "scene-builder-desk",
    out: "scenes/builder-desk.webp",
    aspect: "16:9",
    width: 1600,
    height: 900,
    prompt:
      "A designer's desk seen from a slight angle: a laptop and a phone both showing a soft, unreadable blur of a clean online store with product photographs, linen fabric swatches, a notebook with a pencil sketch of a logo mark, and a cup of chai beside them, a pair of Indian hands on the keyboard, warm daylight.",
  },

  // Three merchant stages.
  {
    id: "story-start",
    out: "stories/start.webp",
    aspect: "4:3",
    width: 1200,
    height: 900,
    prompt:
      "A young founder at her kitchen table in India packing her first orders: kraft boxes, tissue paper, a roll of twine, a phone propped against a jar, morning light, candid and hopeful.",
  },
  {
    id: "story-grow",
    out: "stories/grow.webp",
    aspect: "4:3",
    width: 1200,
    height: 900,
    prompt:
      "A small team of three in a bright studio workshop in India, shelves of plain boxed stock behind them, one scanning a parcel with a phone, one at a laptop, one taping a box, busy and relaxed, candid.",
  },
  {
    id: "story-scale",
    out: "stories/scale.webp",
    aspect: "4:3",
    width: 1200,
    height: 900,
    prompt:
      "A flagship-style modern clothing store at golden hour seen from the pavement in an Indian city: tall glass front, warm interior light, mannequins in linen, a few customers inside, premium and calm.",
  },

  // Three setup steps.
  {
    id: "step-product",
    out: "steps/product.webp",
    aspect: "4:3",
    width: 1200,
    height: 900,
    prompt:
      "A maker photographing a hand-poured candle in a plain ceramic jar on a white tabletop, her phone on a small tripod, a softbox light to one side, a small studio corner, candid.",
  },
  {
    id: "step-customise",
    out: "steps/customise.webp",
    aspect: "4:3",
    width: 1200,
    height: 900,
    prompt:
      "Close-up of hands on a laptop whose screen shows a soft, unreadable blur of an online store being arranged, with paper colour swatches, a fabric sample and a pencil logo sketch beside the keyboard, warm desk light.",
  },
  {
    id: "step-payments",
    out: "steps/payments.webp",
    aspect: "4:3",
    width: 1200,
    height: 900,
    prompt:
      "A customer paying at a boutique counter by tapping her phone on a small card terminal held by the smiling shopkeeper, a wrapped parcel on the counter, soft daylight, candid; the terminal screen is a soft unreadable blur.",
  },

  // Small product tiles beside the GST invoice.
  {
    id: "detail-fabric",
    out: "details/fabric.webp",
    aspect: "1:1",
    width: 800,
    height: 800,
    prompt:
      "Product still life: a neat stack of folded block-printed cotton fabric in indigo and madder red on a pale linen cloth, soft daylight.",
  },
  {
    id: "detail-sandals",
    out: "details/sandals.webp",
    aspect: "1:1",
    width: 800,
    height: 800,
    prompt:
      "Product still life: a pair of tan leather sandals on a warm stone floor in a pool of sunlight, minimal.",
  },

  // The four channel scenes on the homepage.
  {
    id: "channel-online",
    out: "channels/online.webp",
    aspect: "4:3",
    width: 1200,
    height: 900,
    prompt:
      "A young Indian woman on a linen sofa in a sunlit apartment, holding her phone in both hands and smiling slightly as she browses a fashion store on it, a small paper shopping bag resting on the cushion beside her, a plant and a window with sheer curtains behind.",
  },
  {
    id: "channel-in-store",
    out: "channels/in-store.webp",
    aspect: "4:3",
    width: 1200,
    height: 900,
    prompt:
      "Inside a small modern boutique in India: a customer at the wooden counter handing a tan leather tote bag to the shopkeeper, who is ringing it up on a tablet till; the tablet screen shows only a soft, unreadable blur of a sales list with a total at the bottom, never a home screen of app icons; shelves of folded garments and accessories behind, soft daylight from the shop window, both people relaxed and mid-conversation.",
  },
  {
    id: "channel-enquiry",
    out: "channels/enquiry.webp",
    aspect: "4:3",
    width: 1200,
    height: 900,
    prompt:
      "A small-business owner at her studio workbench in India, phone held to her ear, writing a customer's request in a notebook while looking over samples of handmade ceramic cups and bowls laid out in front of her; warm afternoon light through a window, a kettle and shelves of stock behind.",
  },
  {
    id: "channel-wholesale",
    out: "channels/wholesale.webp",
    aspect: "4:3",
    width: 1200,
    height: 900,
    prompt:
      "In a bright, tidy stockroom in India, a wholesale buyer and a supplier checking cartons of packaged goods together, one holding a tablet, stacked plain brown boxes on steel shelving, a hand truck beside them, both focused on the stock.",
  },
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1];
};

const live = flag("live");
const yes = flag("yes");
const only = args.flatMap((a, i) => (a === "--only" ? [args[i + 1]] : []));
const skipExisting = flag("skip-existing");
const project = option("project") ?? process.env.GCP_PROJECT_ID;
const location = option("location") ?? "global";
const rawDir = path.resolve(option("raw-dir") ?? ".marketing-raw");

async function encode(raw, photo) {
  const target = path.join(ROOT, photo.out);
  await mkdir(path.dirname(target), { recursive: true });
  let quality = 82;
  for (;;) {
    const buffer = await sharp(raw)
      .resize(photo.width, photo.height, {
        fit: "cover",
        position: "attention",
      })
      .webp({ quality })
      .toBuffer();
    if (buffer.byteLength <= 360 * 1024 || quality <= 60) {
      await writeFile(target, buffer);
      return { target, bytes: buffer.byteLength, quality };
    }
    quality -= 6;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A 429 is refused before the model runs, so waiting it out cannot bill
 *  twice: the one error worth retrying (the Theme Studio client's rule). */
function isRateLimited(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("429") || text.includes("RESOURCE_EXHAUSTED");
}

const RATE_LIMIT_WAITS_MS = [20_000, 40_000, 80_000, 120_000, 120_000];

async function generate(ai, photo) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await generateOnce(ai, photo);
    } catch (error) {
      if (!isRateLimited(error) || attempt >= RATE_LIMIT_WAITS_MS.length)
        throw error;
      const wait = RATE_LIMIT_WAITS_MS[attempt];
      console.log(`${photo.id}: rate limited, waiting ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

async function generateOnce(ai, photo) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      { role: "user", parts: [{ text: `${photo.prompt}\n\n${STYLE}` }] },
    ],
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE],
      candidateCount: 1,
      safetySettings: [
        HarmCategory.HARM_CATEGORY_HARASSMENT,
        HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      ].map((category) => ({
        category,
        threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
      })),
      imageConfig: {
        aspectRatio: photo.aspect,
        imageSize: "2K",
        // People are the subject of many of these, unlike the theme assets.
        personGeneration: "ALLOW_ADULT",
        prominentPeople: ProminentPeople.BLOCK_PROMINENT_PEOPLE,
        outputMimeType: "image/jpeg",
        outputCompressionQuality: 95,
      },
    },
  });
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) throw new Error(`${photo.id}: refused (${blocked})`);
  const candidate = response.candidates?.[0];
  const inline = candidate?.content?.parts?.find(
    (part) => part.inlineData?.data,
  )?.inlineData;
  if (!inline?.data)
    throw new Error(
      `${photo.id}: no image (${candidate?.finishReason ?? "no candidate"})`,
    );
  const usage = response.usageMetadata ?? {};
  return { raw: Buffer.from(inline.data, "base64"), usage };
}

async function main() {
  const wanted = PHOTOS.filter(
    (p) => only.length === 0 || only.includes(p.id),
  ).filter((p) => !skipExisting || !existsSync(path.join(ROOT, p.out)));
  if (!live) {
    console.log(
      `Dry run. Would generate ${wanted.length} photo(s) with ${MODEL} on ${project ?? "(no project)"}/${location}:`,
    );
    for (const p of wanted) console.log(`  ${p.id} -> ${p.out} (${p.aspect})`);
    console.log("Pass --live --yes to spend.");
    return;
  }
  if (!yes)
    throw new Error("--live needs --yes: each photograph is a paid call.");
  if (!project) throw new Error("Set GCP_PROJECT_ID or pass --project.");
  await mkdir(rawDir, { recursive: true });
  const ai = new GoogleGenAI({ vertexai: true, project, location });
  const failures = [];
  for (const photo of wanted) {
    const rawPath = path.join(rawDir, `${photo.id}.jpg`);
    try {
      let raw;
      if (flag("reuse") && existsSync(rawPath)) {
        raw = await readFile(rawPath);
        console.log(
          `${photo.id}: reusing ${path.relative(process.cwd(), rawPath)}`,
        );
      } else {
        const started = Date.now();
        const result = await generate(ai, photo);
        raw = result.raw;
        await writeFile(rawPath, raw);
        console.log(
          `${photo.id}: ${raw.byteLength} bytes in ${((Date.now() - started) / 1000).toFixed(1)}s, tokens in/out ${result.usage.promptTokenCount ?? "?"}/${result.usage.candidatesTokenCount ?? "?"}`,
        );
      }
      const meta = await sharp(raw).metadata();
      const out = await encode(raw, photo);
      console.log(
        `  ${meta.width}x${meta.height} -> ${path.relative(process.cwd(), out.target)} ${out.bytes} bytes (q${out.quality})`,
      );
    } catch (error) {
      failures.push(photo.id);
      console.error(
        `${photo.id}: FAILED`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  if (failures.length) {
    console.error(
      `Failed: ${failures.join(", ")}. Re-run with --only <id> after checking the error.`,
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
