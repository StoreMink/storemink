/** Writes lib/themes/font-widths.json: how wide each printable ASCII
 * character is in every storefront theme font, at every weight from 300 to 900, as
 * Chrome itself lays it out. Theme Studio's planning measures a header menu
 * with it before anything is rendered (lib/themes/text-width.ts).
 *
 * Run after a build or a dev session has fetched the fonts (they are read
 * from .next/static/media), with the capture job's dependencies installed:
 *   node scripts/theme-font-widths.mjs
 * Uses local Chrome on macOS, or CHROME_EXECUTABLE_PATH / Playwright
 * Chromium. No network: every font is handed to the page as bytes.
 * `lib/themes/text-width.test.ts` fails when a font in lib/themes/fonts.ts has
 * no entry, so a font added to the catalogue needs this run again.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const requireJob = createRequire(
  new URL("../jobs/theme-studio-capture/package.json", import.meta.url),
);
const { chromium } = requireJob("playwright-core");
const requireApp = createRequire(new URL("../package.json", import.meta.url));
const fontkit = requireApp(
  "next/dist/compiled/@next/font/dist/fontkit/index.js",
).default;

const MEDIA = new URL("../.next/static/media/", import.meta.url);
const OUT = new URL("../lib/themes/font-widths.json", import.meta.url);
export const WEIGHTS = [300, 400, 500, 600, 700, 800, 900];
const FIRST = 32;
const LAST = 126;

const catalogue = readFileSync(
  new URL("../lib/themes/fonts.ts", import.meta.url),
  "utf8",
);
const families = [...catalogue.matchAll(/^\s+family: "([^"]+)",$/gm)].map(
  (m) => m[1],
);
if (!families.length)
  throw new Error("No families found in lib/themes/fonts.ts");

// Every upright Latin file of each family, with the weights it covers.
const files = new Map(families.map((family) => [family, []]));
for (const name of readdirSync(MEDIA).filter((n) => n.endsWith(".woff2"))) {
  const bytes = readFileSync(new URL(name, MEDIA));
  let font;
  try {
    font = fontkit(bytes);
  } catch {
    continue;
  }
  let latin = true;
  for (let c = FIRST; c <= LAST && latin; c++)
    latin = font.hasGlyphForCodePoint(c);
  if (!latin) continue;
  if (/italic/i.test(font.subfamilyName ?? "")) continue;
  if ((font["OS/2"]?.fsSelection?.italic ?? false) === true) continue;
  // "Bodoni Moda 11pt", "Outfit Thin": the longest catalogue family the
  // file's name starts with (so "DM Serif Display" never takes "DM Sans").
  const family = families
    .filter((f) => font.familyName === f || font.familyName.startsWith(`${f} `))
    .sort((a, b) => b.length - a.length)[0];
  if (!family) continue;
  const axis = font.variationAxes?.wght;
  const weight = axis
    ? `${axis.min} ${axis.max}`
    : String(font["OS/2"]?.usWeightClass ?? 400);
  const list = files.get(family);
  if (!list.some((f) => f.weight === weight))
    list.push({ weight, data: bytes.toString("base64") });
}
const missing = families.filter((f) => !files.get(f).length);
if (missing.length)
  throw new Error(
    `No Latin font file in .next/static/media for: ${missing.join(", ")}. Build or open the storefront once so next/font fetches them.`,
  );

const macChrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath =
  process.env.CHROME_EXECUTABLE_PATH ||
  (existsSync(macChrome) ? macChrome : chromium.executablePath());
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  const faces = [...files.entries()]
    .flatMap(([family, list]) =>
      list.map(
        (f) =>
          `@font-face{font-family:"w-${families.indexOf(family)}";src:url(data:font/woff2;base64,${f.data}) format("woff2");font-weight:${f.weight};font-style:normal;}`,
      ),
    )
    .join("\n");
  await page.setContent(`<!doctype html><style>${faces}</style><body></body>`);
  const table = await page.evaluate(
    async ({ count, weights, first, last }) => {
      const out = [];
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      for (let i = 0; i < count; i++) {
        const row = {};
        for (const weight of weights) {
          const font = `${weight} 1000px "w-${i}"`;
          await document.fonts.load(font, "AaZz09");
          if (!document.fonts.check(font, "Aa"))
            throw new Error(`font ${i} did not load at ${weight}`);
          ctx.font = font;
          const widths = [];
          for (let c = first; c <= last; c++)
            widths.push(
              Math.round(ctx.measureText(String.fromCharCode(c)).width),
            );
          row[weight] = widths;
        }
        out.push(row);
      }
      return out;
    },
    { count: families.length, weights: WEIGHTS, first: FIRST, last: LAST },
  );
  const json = {
    note: "Advance widths in thousandths of an em for characters 32 to 126, by family and weight, measured in Chrome by scripts/theme-font-widths.mjs. Do not edit by hand.",
    first: FIRST,
    weights: WEIGHTS,
    families: Object.fromEntries(families.map((f, i) => [f, table[i]])),
  };
  writeFileSync(OUT, `${JSON.stringify(json)}\n`);
  console.log(
    `Wrote ${families.length} families to lib/themes/font-widths.json`,
  );
} finally {
  await browser.close();
}
