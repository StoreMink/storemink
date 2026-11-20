import { randomUuid } from "@/lib/random-uuid";
import type { ThemeIndustry } from "@/lib/themes/meta";

// ---------------------------------------------------------------------------
// The pure rules behind New theme (wave TS-2, builder 2D; plan section 4,
// "New theme"). Client-safe and server-safe: no React, no server-only import,
// no clock. The page passes the server's limits in, so the numbers here are
// the ones the server enforces (contracts.ts THEME_STUDIO_LIMITS,
// repository.ts validateProjectInput, the references route).
//
// ★ CHECKED ON DROP, BEFORE ANYTHING IS CREATED. A screenshot of the wrong
// type or size is refused the moment it is dropped, so "Create and start"
// never makes a project it then cannot finish. The server still sniffs every
// file's bytes (references.ts): an animated or damaged image is only found
// there, after the theme exists, and the form hands that reason to the
// theme page.
//
// ★ WORDS. Plain sentences; no em dash or en dash; never a number of Mink
// credits.
// ---------------------------------------------------------------------------

/** The screenshot types the references route accepts (references.ts sniffs
 * the bytes; the browser's type is only the first check). */
export const SCREENSHOT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
] as const;

/** For the file input's `accept`. */
export const SCREENSHOT_ACCEPT = SCREENSHOT_TYPES.join(",");

const SCREENSHOT_EXTENSIONS = /\.(jpe?g|png|webp|avif)$/i;

/** What one message may carry (THEME_STUDIO_LIMITS: referenceImages,
 * referenceImageBytes, referenceTotalBytes), passed in by the page. */
export interface ScreenshotLimits {
  files: number;
  fileBytes: number;
  totalBytes: number;
}

/** The part of a File the checks read, so tests need no real file. */
export interface ScreenshotFileLike {
  name: string;
  type: string;
  size: number;
}

/** "850 KB", "1.2 MB", "10 MB". */
export function fileSizeWords(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

function isScreenshotType(file: ScreenshotFileLike): boolean {
  if ((SCREENSHOT_TYPES as readonly string[]).includes(file.type)) return true;
  // Some browsers leave the type empty (an AVIF on an older Safari, a file
  // from some drag sources): the name decides then, and the server's byte
  // sniffing has the last word either way.
  return file.type === "" && SCREENSHOT_EXTENSIONS.test(file.name);
}

/**
 * Which dropped or chosen files may join the list, and a sentence for each
 * one that may not. `current` is what the list already holds; the order of
 * `incoming` is kept, and a file is refused once the count or the total
 * would pass the limit.
 */
export function checkScreenshots<T extends ScreenshotFileLike>(
  current: readonly ScreenshotFileLike[],
  incoming: readonly T[],
  limits: ScreenshotLimits,
): { accepted: T[]; problems: string[] } {
  const accepted: T[] = [];
  const problems: string[] = [];
  let count = current.length;
  let total = current.reduce((sum, file) => sum + file.size, 0);
  const maxEach = fileSizeWords(limits.fileBytes);
  const maxTotal = fileSizeWords(limits.totalBytes);
  for (const file of incoming) {
    if (!isScreenshotType(file)) {
      problems.push(`${file.name}: use a JPEG, PNG, WebP or AVIF image.`);
    } else if (file.size === 0) {
      problems.push(`${file.name} is empty.`);
    } else if (file.size > limits.fileBytes) {
      problems.push(`${file.name} is larger than ${maxEach}.`);
    } else if (count >= limits.files) {
      problems.push(
        `${file.name} was not added: a theme starts with up to ${limits.files} screenshots.`,
      );
    } else if (total + file.size > limits.totalBytes) {
      problems.push(
        `${file.name} was not added: the screenshots may add up to ${maxTotal} at most.`,
      );
    } else {
      accepted.push(file);
      count += 1;
      total += file.size;
    }
  }
  return { accepted, problems };
}

// -------------------------------------------------------------------- the ID

/** repository.ts THEME_ID_RE: lowercase words joined by single hyphens. */
const THEME_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The ID a name suggests: "Aurora Skin" gives "aurora-skin". */
export function themeIdFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

/** Why the server would refuse this ID (repository.ts validateProjectInput),
 * in a sentence; null when it is fine. */
export function themeIdProblem(id: string): string | null {
  if (id.length < 3 || id.length > 80 || !THEME_ID_RE.test(id)) {
    return "The ID must be 3 to 80 lowercase letters or numbers, joined by single hyphens.";
  }
  if (id.startsWith("demo-")) return "The ID may not start with demo-.";
  return null;
}

/**
 * The name a new theme from another theme's brief starts with: "Aurora"
 * gives "Aurora 2" and "Aurora 2" gives "Aurora 3". A different name gives a
 * different ID, which the server needs: the source theme still holds its own.
 */
export function nextThemeName(name: string): string {
  const trimmed = name.trim();
  const numbered = /^(.*\S)\s+(\d{1,6})$/.exec(trimmed);
  const base = numbered ? numbered[1] : trimmed;
  const next = numbered ? Number(numbered[2]) + 1 : 2;
  const suffix = ` ${next}`;
  return `${base.slice(0, 100 - suffix.length).trimEnd()}${suffix}`;
}

// ---------------------------------------------------------------- industries

/**
 * Words in a brief that point at an industry. Only words that rarely mean
 * anything else in a design brief: "home" alone is the home page and "art"
 * alone is art direction, so neither is here.
 */
const INDUSTRY_WORDS: Partial<Record<ThemeIndustry, readonly string[]>> = {
  art: [
    "artwork",
    "artworks",
    "artist",
    "artists",
    "paintings",
    "art prints",
    "posters",
    "illustrations",
    "sculptures",
  ],
  automotive: [
    "automotive",
    "car",
    "cars",
    "auto parts",
    "car parts",
    "motorcycle",
    "motorcycles",
    "tyres",
    "tires",
    "vehicle",
    "vehicles",
  ],
  beauty: [
    "beauty",
    "skincare",
    "skin care",
    "skin",
    "cosmetic",
    "cosmetics",
    "makeup",
    "make up",
    "serum",
    "serums",
    "lipstick",
    "haircare",
    "hair care",
    "fragrance",
    "fragrances",
    "perfume",
    "perfumes",
    "nail polish",
  ],
  clothing: [
    "clothing",
    "clothes",
    "apparel",
    "fashion",
    "dress",
    "dresses",
    "shirt",
    "shirts",
    "t shirt",
    "t shirts",
    "tees",
    "saree",
    "sarees",
    "kurta",
    "kurtas",
    "jeans",
    "denim",
    "streetwear",
    "menswear",
    "womenswear",
    "garments",
    "ethnic wear",
  ],
  electronics: [
    "electronics",
    "gadget",
    "gadgets",
    "phones",
    "smartphones",
    "laptops",
    "headphones",
    "earbuds",
    "cameras",
    "speakers",
    "chargers",
    "smart home",
    "computers",
  ],
  entertainment: [
    "entertainment",
    "movies",
    "music",
    "vinyl",
    "concerts",
    "tickets",
    "comics",
    "video games",
    "gaming",
  ],
  "food-and-drink": [
    "food",
    "foods",
    "grocery",
    "groceries",
    "coffee",
    "tea",
    "teas",
    "bakery",
    "snacks",
    "chocolate",
    "chocolates",
    "spices",
    "masala",
    "cafe",
    "restaurant",
    "juice",
    "juices",
    "sweets",
    "honey",
    "beverages",
    "drinks",
    "wine",
    "pantry",
  ],
  garden: [
    "garden",
    "gardening",
    "plants",
    "houseplants",
    "seeds",
    "planters",
    "succulents",
    "florist",
    "flowers",
  ],
  hardware: [
    "hardware",
    "tools",
    "power tools",
    "plumbing",
    "fasteners",
    "building materials",
  ],
  home: [
    "home decor",
    "decor",
    "furniture",
    "homeware",
    "homewares",
    "interiors",
    "bedding",
    "candles",
    "cushions",
    "rugs",
    "lamps",
    "chandeliers",
    "kitchenware",
    "tableware",
    "linens",
  ],
  "jewelry-and-accessories": [
    "jewelry",
    "jewellery",
    "rings",
    "necklace",
    "necklaces",
    "earrings",
    "bracelets",
    "watches",
    "accessories",
    "handbags",
    "bags",
    "sunglasses",
    "wallets",
  ],
  kids: [
    "kids",
    "children",
    "childrens",
    "baby",
    "babies",
    "toddler",
    "toddlers",
    "newborn",
    "maternity",
  ],
  office: [
    "office supplies",
    "stationery",
    "notebooks",
    "pens",
    "planners",
    "desk accessories",
  ],
  pets: [
    "pet",
    "pets",
    "dog",
    "dogs",
    "cat",
    "cats",
    "puppy",
    "puppies",
    "kitten",
    "kittens",
    "aquarium",
  ],
  services: [
    "appointments",
    "bookings",
    "consulting",
    "consultancy",
    "tuition",
    "repairs",
  ],
  shoes: [
    "shoes",
    "shoe",
    "sneakers",
    "footwear",
    "boots",
    "sandals",
    "heels",
    "slippers",
  ],
  sports: [
    "sports",
    "sportswear",
    "fitness",
    "gym",
    "yoga",
    "cricket",
    "football",
    "cycling",
    "athletic",
  ],
  toys: ["toys", "toy", "board games", "puzzles", "dolls", "plush"],
  wellness: [
    "wellness",
    "health",
    "supplements",
    "vitamins",
    "ayurveda",
    "ayurvedic",
    "herbal",
    "nutrition",
    "protein",
    "meditation",
  ],
  wholesale: ["wholesale", "bulk", "b2b", "distributor", "distributors"],
};

/** Lowercase words separated by single spaces, padded, so a phrase matches
 * only whole words ("skin" never matches "skinny"). */
function words(text: string): string {
  return ` ${text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

/**
 * The industry a brief most likely means, for New theme to preselect (the
 * operator can change it): the offered industry whose words the brief uses
 * most, the earlier one in `offered` on a tie; null when the brief names
 * none. "General" is never guessed: it is a choice, not a reading.
 */
export function guessIndustry(
  brief: string,
  offered: readonly ThemeIndustry[],
): ThemeIndustry | null {
  const text = words(brief);
  if (text.trim() === "") return null;
  let best: ThemeIndustry | null = null;
  let bestHits = 0;
  for (const industry of offered) {
    const hits = (INDUSTRY_WORDS[industry] ?? []).filter((phrase) =>
      text.includes(words(phrase)),
    ).length;
    if (hits > bestHits) {
      best = industry;
      bestHits = hits;
    }
  }
  return best;
}

// --------------------------------------------------------------- the chain

/**
 * The sessionStorage key under which New theme leaves the server's reason
 * for a start that did not happen; the theme page (builder 2B) shows it once
 * under "Start building" and removes it (contract section 8.1).
 */
export function startRefusedKey(projectId: string): string {
  return `studio:start-refused:${projectId}`;
}

/**
 * A fresh idempotency key for one start: 32 hex characters, which
 * repository.ts accepts (`^[A-Za-z0-9_-]{16,80}$`). randomUuid() works on a
 * local `*.localtest.me` address over http too.
 */
export function newIdempotencyKey(): string {
  return randomUuid().replace(/-/g, "");
}
