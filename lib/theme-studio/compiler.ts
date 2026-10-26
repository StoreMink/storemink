import { sanitizeMenusForSave } from "@/lib/menus";
import {
  FONT_PAIRING_KEYS,
  THEME_FONT_VALUES,
  fontFace,
  isFontPairingKey,
  isThemeFontValue,
  pairingFonts,
} from "@/lib/themes/fonts";
import { explicitDraftStyleIssues } from "./style-choices";
import { paletteFamilyIssues } from "./fingerprint";
import type { PageSectionItem } from "@/lib/sections/registry";
import type {
  ThemeCatalogSize,
  ThemeEngineRef,
  ThemeFeature,
  ThemeIndustry,
} from "@/lib/themes/meta";
import type {
  ThemeCategorySeed,
  ThemeDefinition,
  ThemeDesign,
  ThemePageSeed,
  ThemeProductSeed,
} from "@/lib/themes/types";
import {
  THEME_PACKAGE_SCHEMA_VERSION,
  THEME_STUDIO_FEATURES,
  THEME_STUDIO_VIEWPORTS,
  validateThemePackageV2,
  type ThemeCapabilityGap,
  type ThemeIntent,
  type ThemePackageAsset,
  type ThemePackageV2,
  type ThemeStudioSurface,
} from "./contracts";
import type { ThemeStudioModelKey } from "./models";
import { USP_ICONS, validateSectionStyle } from "@/lib/homepage/section-types";
import {
  ACCOUNT_LAYOUTS,
  BLOG_ARTICLE_LAYOUTS,
  BLOG_INDEX_LAYOUTS,
  COLLECTION_FILTERS,
  COLLECTION_PAGINATIONS,
  PRODUCT_BLOCK_TYPES,
  PRODUCT_GALLERIES,
  defaultTemplates,
  hasProductBlock,
  normalizeTemplates,
  type ThemeTemplates,
} from "@/lib/themes/templates";
import {
  normalizeAnnouncement,
  type ThemeAnnouncement,
} from "@/lib/themes/announcement";
import {
  isSectionScheme,
  SCHEMELESS_SECTION_TYPES,
  SECTION_SCHEMES,
  type ThemeColorScheme,
  type ThemeColorSchemes,
} from "@/lib/themes/schemes";
import { PALETTE_KEYS, THEME_STUDIO_SECTION_TYPES } from "./schemas";
import { resolveOptionRows, type ProductOption } from "@/lib/products/options";
import {
  validateThemeHomepage,
  validateThemeLinks,
  validateThemePages,
  validateThemeSampleData,
  validateThemeCopy,
  validateStudioDesign,
} from "@/lib/themes/validation";

// ---------------------------------------------------------------------------
// Stage B compiler: model draft → ThemePackageV2.
//
// The model authors the CREATIVE parts (tokens, pages, copy, catalogue). The
// server owns everything that is a fact about StoreMink rather than a design
// choice — id, engine, release, catalog visibility, demo, renderer, viewports,
// provenance and the asset manifest — so the model cannot assert any of them.
//
// Every problem found here is returned as a sentence rather than thrown: the
// pipeline hands the list back to the model once per repair attempt, and a
// sentence the model can act on is the whole value of that loop.
// ---------------------------------------------------------------------------

export const THEME_ASSET_PREFIX = "theme-asset://";

/** Marks every placeholder in a package; publication must refuse any package
 * still carrying one. */
export const PLACEHOLDER_LICENSE_NOTE =
  "StoreMink placeholder. Replace with operator-owned, licensed or generated imagery before publication.";

/** Slots the server always provides, independent of the intent's briefs. */
export const SYSTEM_SLOTS = {
  preview: { aspectRatio: "4:3", alt: "Theme preview" },
  "screenshot-desktop": { aspectRatio: "16:10", alt: "Storefront on desktop" },
  "screenshot-mobile": { aspectRatio: "9:19", alt: "Storefront on mobile" },
} as const;

/** Own keys only: `in` would also match Object.prototype names such as
 * `constructor`, which pass the kebab-case id rule. */
function isSystemSlot(slot: string): slot is keyof typeof SYSTEM_SLOTS {
  return Object.hasOwn(SYSTEM_SLOTS, slot);
}

/**
 * The repair sentence for storefront content naming a catalog picture slot.
 * Those slots are photographs OF the finished storefront, replaced by capture
 * after acceptance measured it; a storefront image living in one would change
 * under the evidence, so capture refuses such a theme (captureBlockers). Saying
 * so here lets the model fix it before generation and imagery are paid for.
 */
function systemSlotIssue(where: string, slot: string): string | null {
  return isSystemSlot(slot)
    ? `${where} uses "${slot}", a catalog picture of the finished storefront; storefront images need their own asset brief.`
    : null;
}

/**
 * Stage A issues for asset briefs whose ids collide with the catalog picture
 * slots. Stage B cannot rename a brief, and the compiler refuses storefront
 * content naming a system slot, so a brief called `preview` could never be
 * used; a `screenshot-*` brief is classified as a catalog picture and is never
 * generated. Checked on NEW Stage A output only, not in the intent contract,
 * so intents already stored on versions stay readable.
 */
export function reservedBriefIssues(intent: {
  assetBriefs: readonly { id: string }[];
}): string[] {
  return intent.assetBriefs
    .filter((b) => isSystemSlot(b.id) || b.id.startsWith("screenshot-"))
    .map(
      (b) =>
        `assetBriefs id "${b.id}" is reserved for catalog pictures of the finished storefront; give this brief a different id.`,
    );
}

// ---------------------------------------------------------------------------
// Product photographs: one slot per product (Track 3.3).
//
// A product names the asset brief that says how the RANGE is photographed —
// backdrop, light, camera — and the compiler gives that product its own slot,
// `<brief>--<product slug>`. Stage A cannot write a brief per product: it runs
// before the products exist, and its twelve briefs would not cover sixteen
// products plus the rest of the theme. So the brief is shared and the slot is
// not: every product gets its own image, drawn to one staging.
//
// ★ The id is deterministic from the brief and the slug, so a revision that
// keeps a product keeps its slot — and the image carried into it.
// ---------------------------------------------------------------------------

export const PRODUCT_SLOT_SEPARATOR = "--";
const MAX_SLOT_ID = 80;

/** FNV-1a, base 36: a short, stable tag for an id too long to keep whole. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(0, 7);
}

/** The part of a brief id a shortened product slot keeps. */
function briefHead(briefId: string): string {
  return briefId.length <= 60 ? briefId : briefId.slice(0, 40);
}

/** The slot a product's photograph lives in. */
export function productSlotId(briefId: string, productSlug: string): string {
  const whole = `${briefId}${PRODUCT_SLOT_SEPARATOR}${productSlug}`;
  if (whole.length <= MAX_SLOT_ID) return whole;
  // Too long to keep whole: shorten the slug (and a very long brief), and tag
  // with a hash of the full id so two long slugs sharing a prefix still get
  // different slots.
  const head = briefHead(briefId);
  const room = MAX_SLOT_ID - head.length - PRODUCT_SLOT_SEPARATOR.length - 8;
  const tail = productSlug.slice(0, room).replace(/-+$/, "");
  return `${head}${PRODUCT_SLOT_SEPARATOR}${tail}-${shortHash(whole)}`;
}

/** The brief a product slot was made from: the longest brief id it starts
 *  with. Null for any other slot. */
export function productSlotBrief(
  slotId: string,
  briefIds: Iterable<string>,
): string | null {
  let best: string | null = null;
  for (const id of briefIds) {
    const matches = [id, briefHead(id)].some(
      (head) =>
        slotId.startsWith(`${head}${PRODUCT_SLOT_SEPARATOR}`) &&
        slotId.length > head.length + PRODUCT_SLOT_SEPARATOR.length,
    );
    if (matches && (!best || id.length > best.length)) best = id;
  }
  return best;
}

/** A product slot the compiler made, and what it was made from. */
export interface ProductSlot {
  briefId: string;
  productName: string;
}

export interface CompileFacts {
  themeId: string;
  name: string;
  industries: ThemeIndustry[];
  catalogSizes: ThemeCatalogSize[];
  requiredFeatures: ThemeFeature[];
  baseEngine: ThemeEngineRef | null;
  versionNumber: number;
  modelKey: ThemeStudioModelKey;
  modelLabel: string;
  promptVersion: string;
  referenceDigests: string[];
}

export interface SlotAsset {
  sha256: string;
  width: number;
  height: number;
}

export interface CompileResult {
  package: ThemePackageV2 | null;
  /** Slots the package references, each needing a stored placeholder. */
  slots: string[];
  issues: string[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slotOf(url: string): string | null {
  return url.startsWith(THEME_ASSET_PREFIX)
    ? url.slice(THEME_ASSET_PREFIX.length)
    : null;
}

/** Walk a section config: media must be a known slot, links must be site paths. */
function checkConfigUrls(
  value: unknown,
  where: string,
  known: Set<string>,
  used: Set<string>,
  issues: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      checkConfigUrls(item, `${where}[${i}]`, known, used, issues),
    );
    return;
  }
  if (!isRec(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const at = `${where}.${key}`;
    if (typeof nested === "string" && nested !== "") {
      if (key === "video_url") {
        issues.push(
          `${at} must be "": video is not supported in generated themes.`,
        );
      } else if (key.endsWith("_url")) {
        const slot = slotOf(nested);
        const reserved = slot ? systemSlotIssue(at, slot) : null;
        if (!slot)
          issues.push(
            `${at} must be "" or a theme-asset:// slot, not an external URL.`,
          );
        else if (reserved) issues.push(reserved);
        else if (!known.has(slot))
          issues.push(`${at} uses unknown image slot "${slot}".`);
        else used.add(slot);
      } else if (
        key.endsWith("_href") &&
        (!nested.startsWith("/") || nested.startsWith("//"))
      ) {
        issues.push(`${at} must be "" or a site path starting with "/".`);
      }
    } else {
      checkConfigUrls(nested, at, known, used, issues);
    }
  }
}

function checkLink(href: string, where: string, issues: string[]) {
  if (!href.startsWith("/") || href.startsWith("//")) {
    issues.push(`${where} must be a site path starting with "/".`);
  }
}

function normalizeGaps(value: unknown): ThemeCapabilityGap[] {
  return list(value).flatMap((raw) => {
    if (!isRec(raw)) return [];
    const { suggestedPlatformCapability, ...rest } = raw;
    return [
      {
        ...(rest as unknown as ThemeCapabilityGap),
        ...(typeof suggestedPlatformCapability === "string" &&
        suggestedPlatformCapability.trim()
          ? { suggestedPlatformCapability }
          : {}),
      },
    ];
  });
}

/**
 * The two stored faces. A pairing (prompt v25+) WINS over the draft's own
 * fonts: it is the choice the model made deliberately, and the two faces it
 * also wrote are the pairing spelled out. A null pairing is a free choice
 * from the catalogue, for a brief that names a typeface; the package
 * contract refuses anything the catalogue lacks.
 */
function chosenFonts(
  raw: Record<string, unknown>,
  fontPairing: unknown,
  issues: string[],
): { body: string; display: string } {
  if (fontPairing !== undefined && fontPairing !== null) {
    if (isFontPairingKey(fontPairing)) return pairingFonts(fontPairing);
    issues.push(
      `fontPairing must be null or one of: ${FONT_PAIRING_KEYS.join(", ")}.`,
    );
  }
  const fonts = { body: text(raw.body), display: text(raw.display) };
  for (const key of ["body", "display"] as const) {
    if (!isThemeFontValue(fonts[key])) {
      issues.push(
        `design.fonts.${key} must be one of the loaded font values: ${THEME_FONT_VALUES.join(", ")}.`,
      );
    }
  }
  // A free choice may still not put a poster face on body copy.
  const body = fontFace(fonts.body);
  if (body && !body.body) {
    issues.push(
      `design.fonts.body must be a face suited to body copy; ${body.label} is display only.`,
    );
  }
  return fonts;
}

function buildDesign(
  raw: unknown,
  issues: string[],
  fontPairing?: unknown,
): ThemeDesign | null {
  if (
    !isRec(raw) ||
    !isRec(raw.palette) ||
    !isRec(raw.fonts) ||
    !isRec(raw.shape)
  ) {
    issues.push("design must include palette, fonts and shape.");
    return null;
  }
  const paletteIn = raw.palette;
  const palette: Rec = {};
  for (const key of PALETTE_KEYS) palette[key] = paletteIn[key];
  palette.shadowRgb = paletteIn.shadowRgb;
  for (const key of ["accent", "accentDeep"] as const) {
    if (typeof paletteIn[key] === "string") palette[key] = paletteIn[key];
  }
  const layout: Rec = {};
  if (isRec(raw.layout)) {
    for (const [key, value] of Object.entries(raw.layout)) {
      if (value !== null && value !== undefined) layout[key] = value;
    }
  }
  // A null scheme means "derive it"; a null key inside one means the same
  // for that colour. Values are passed through unchecked — the package
  // contract and theme validation judge them and send problems back.
  const schemes: ThemeColorSchemes = {};
  if (isRec(raw.schemes)) {
    for (const id of SECTION_SCHEMES) {
      const scheme = raw.schemes[id];
      if (!isRec(scheme)) continue;
      const out: Rec = {};
      for (const key of [
        "background",
        "text",
        "surface",
        "accent",
        "onAccent",
      ] as const) {
        if (typeof scheme[key] === "string") out[key] = scheme[key];
      }
      schemes[id] = out as unknown as ThemeColorScheme;
    }
  }
  // A null setting keeps each heading's own value, so only chosen ones are
  // stored; theme validation judges the face against the weight.
  const typography: Rec = {};
  if (isRec(raw.typography)) {
    for (const [key, value] of Object.entries(raw.typography)) {
      if (typeof value === "string") typography[key] = value;
    }
  }
  // Buttons follow the same rule: a null keeps each button's own look.
  const buttons: Rec = {};
  if (isRec(raw.buttons)) {
    for (const [key, value] of Object.entries(raw.buttons)) {
      if (typeof value === "string") buttons[key] = value;
    }
  }
  // Page width and spacing: a null keeps today's width or gap.
  const page: Rec = {};
  if (isRec(raw.page)) {
    for (const [key, value] of Object.entries(raw.page)) {
      if (typeof value === "string") page[key] = value;
    }
  }
  // Motion: a null reveal keeps the storefront still.
  const motion: Rec = {};
  if (isRec(raw.motion) && typeof raw.motion.reveal === "string") {
    motion.reveal = raw.motion.reveal;
  }
  return {
    palette: palette as unknown as ThemeDesign["palette"],
    fonts: chosenFonts(raw.fonts, fontPairing, issues),
    shape: {
      card: text(raw.shape.card),
      control: text(raw.shape.control),
      sm: text(raw.shape.sm),
      pill: text(raw.shape.pill),
    },
    ...(Object.keys(layout).length > 0
      ? { layout: layout as ThemeDesign["layout"] }
      : {}),
    ...(Object.keys(schemes).length > 0 ? { schemes } : {}),
    ...(Object.keys(typography).length > 0
      ? { typography: typography as ThemeDesign["typography"] }
      : {}),
    ...(Object.keys(buttons).length > 0
      ? { buttons: buttons as ThemeDesign["buttons"] }
      : {}),
    ...(Object.keys(page).length > 0
      ? { page: page as ThemeDesign["page"] }
      : {}),
    ...(Object.keys(motion).length > 0
      ? { motion: motion as ThemeDesign["motion"] }
      : {}),
  };
}

/**
 * The draft's `{scheme, padding, width}` in the stored section-style shape.
 * ★ A band with a scheme and no padding would put its copy against the
 *   band's edge, so it gets the medium padding a merchant's preset gives.
 * Everything else goes through the registry's own style validator, which
 * also drops a scheme from a section type that cannot wear one.
 */
function buildSectionStyle(raw: unknown, type: string) {
  if (!isRec(raw)) return undefined;
  const scheme =
    isSectionScheme(raw.scheme) && !SCHEMELESS_SECTION_TYPES.includes(type)
      ? raw.scheme
      : undefined;
  const padding =
    raw.padding === "sm" || raw.padding === "md" || raw.padding === "lg"
      ? raw.padding
      : scheme
        ? "md"
        : undefined;
  return validateSectionStyle(
    { scheme, padding_y: padding, width: raw.width ?? undefined },
    type,
  );
}

function buildPages(
  raw: unknown,
  known: Set<string>,
  used: Set<string>,
  issues: string[],
): ThemePageSeed[] {
  const allowed = new Set<string>(THEME_STUDIO_SECTION_TYPES);
  return list(raw).flatMap((page, pageIndex) => {
    if (!isRec(page)) {
      issues.push(`pages[${pageIndex}] must be an object.`);
      return [];
    }
    const slug = typeof page.slug === "string" ? page.slug.trim() : "";
    const key = slug || "home";
    const sections: PageSectionItem[] = list(page.sections).flatMap(
      (section, i) => {
        const where = `pages[${pageIndex}].sections[${i}]`;
        if (!isRec(section) || !allowed.has(String(section.type))) {
          issues.push(`${where} has an unsupported section type.`);
          return [];
        }
        let config: unknown;
        try {
          config = JSON.parse(String(section.configJson ?? ""));
        } catch {
          issues.push(`${where}.configJson is not valid JSON.`);
          return [];
        }
        if (!isRec(config)) {
          issues.push(`${where}.configJson must encode a JSON object.`);
          return [];
        }
        checkConfigUrls(config, `${where}.config`, known, used, issues);
        if (
          section.type === "featured_products" &&
          config.source !== "featured"
        ) {
          issues.push(
            `${where}: featured_products must use source "featured".`,
          );
        }
        if (section.type === "shop_by_category" && config.source !== "all") {
          issues.push(`${where}: shop_by_category must use source "all".`);
        }
        if (
          section.type === "product_spotlight" &&
          (config.source !== "featured" || config.product_id)
        ) {
          issues.push(
            `${where}: product_spotlight must use source "featured" with product_id null (ids are assigned at install).`,
          );
        }
        const style = buildSectionStyle(section.style, String(section.type));
        return [
          {
            id: `${key}-${String(section.type).replace(/_/g, "-")}-${i + 1}`,
            type: section.type as PageSectionItem["type"],
            enabled: true,
            config: config as unknown as PageSectionItem["config"],
            ...(style ? { style } : {}),
          },
        ];
      },
    );
    const seoTitle = text(page.seoTitle);
    const seoDescription = text(page.seoDescription);
    return [
      {
        slug,
        title: text(page.title),
        ...(seoTitle ? { seo_title: seoTitle } : {}),
        ...(seoDescription ? { seo_description: seoDescription } : {}),
        sections,
      },
    ];
  });
}

/** Shortest SEO description the production validator accepts (TA-2.3). */
const SEO_DESCRIPTION_MIN = 20;
const SEO_DESCRIPTION_MAX = 160;

/**
 * Give every page a usable SEO description. The draft schema lets a model
 * leave one null, and the production validator requires 20+ characters on
 * every page, so without this a generated theme could pass acceptance and
 * then be refused at publication for a sentence it was never asked for. The
 * fallback is drawn only from text the draft already contains — the page
 * title and the theme's own description — never invented copy.
 */
function withSeoDescriptions(
  pages: ThemePageSeed[],
  themeDescription: string,
  themeName: string,
): ThemePageSeed[] {
  return pages.map((page) => {
    if ((page.seo_description?.trim().length ?? 0) >= SEO_DESCRIPTION_MIN) {
      return page;
    }
    const lead = page.slug === "" ? themeName : `${page.title} · ${themeName}`;
    const body = themeDescription || `${themeName} storefront`;
    // Shoppers read this (the page's meta description): no long dash.
    let description = `${lead}: ${body}`.replace(/\s+/g, " ").trim();
    if (description.length > SEO_DESCRIPTION_MAX) {
      description = `${description.slice(0, SEO_DESCRIPTION_MAX - 1).trimEnd()}…`;
    }
    return description.length >= SEO_DESCRIPTION_MIN
      ? { ...page, seo_description: description }
      : page;
  });
}

function buildCatalogue(
  draft: Rec,
  known: Set<string>,
  briefIds: Set<string>,
  used: Set<string>,
  productSlots: Map<string, ProductSlot>,
  issues: string[],
): { categories: ThemeCategorySeed[]; products: ThemeProductSeed[] } {
  const slotUrl = (slot: unknown, where: string): string | null => {
    const id = text(slot);
    if (!id) return null;
    const reserved = systemSlotIssue(where, id);
    if (reserved) {
      issues.push(reserved);
      return null;
    }
    if (!known.has(id)) {
      issues.push(`${where} uses unknown image slot "${id}".`);
      return null;
    }
    used.add(id);
    return `${THEME_ASSET_PREFIX}${id}`;
  };
  const categories = list(draft.categories).flatMap((raw, i) => {
    if (!isRec(raw)) return [];
    // Missing references never enter the asset manifest, so image generation
    // and placeholder checks cannot see them. Repair the draft before saving
    // a category tile that would render an empty-image icon forever.
    // A reserved slot gets its own, precise sentence from slotUrl below;
    // "needs an imageSlot" would read as if none had been given.
    if (
      !isSystemSlot(text(raw.imageSlot)) &&
      (!text(raw.imageSlot) || !briefIds.has(text(raw.imageSlot)))
    ) {
      issues.push(`categories[${i}] needs an imageSlot from the asset briefs.`);
    }
    const image = slotUrl(raw.imageSlot, `categories[${i}].imageSlot`);
    const description = text(raw.description);
    return [
      {
        name: text(raw.name),
        slug: text(raw.slug),
        ...(description ? { description } : {}),
        ...(image ? { image_url: image } : {}),
        sort_order: i,
      },
    ];
  });
  const products = list(draft.products).flatMap((raw, i) => {
    if (!isRec(raw)) return [];
    const where = `products[${i}]`;
    const slug = text(raw.slug);
    if (!KEBAB_RE.test(slug)) issues.push(`${where}.slug must be kebab-case.`);
    const base = Number(raw.basePrice);
    const selling = Number(raw.sellingPrice);
    if (selling > base)
      issues.push(`${where}.sellingPrice must not exceed basePrice.`);
    // A product names a BRIEF; its image is its own slot made from it. A
    // product slot copied back from a revision's current theme resolves to
    // the brief it was made from.
    const named = text(raw.imageSlot);
    const briefId = briefIds.has(named)
      ? named
      : productSlotBrief(named, briefIds);
    let image: string | null = null;
    if (!named) {
      issues.push(`${where} needs an imageSlot from the asset briefs.`);
    } else if (!briefId) {
      issues.push(
        `${where}.imageSlot "${named}" must be one of the intent's asset-brief ids.`,
      );
    } else if (KEBAB_RE.test(slug)) {
      const slot = productSlotId(briefId, slug);
      used.add(slot);
      productSlots.set(slot, { briefId, productName: text(raw.name) });
      image = `${THEME_ASSET_PREFIX}${slot}`;
    }
    const variants = list(raw.variants).flatMap((v, j) => {
      if (!isRec(v)) return [];
      const stock = Number(v.stock);
      if (!Number.isInteger(stock) || stock < 1) {
        issues.push(
          `${where}.variants[${j}].stock must be a positive integer.`,
        );
      }
      const optionValues = list(v.optionValues).map(text);
      return [
        {
          name: text(v.name),
          base_price: Number(v.basePrice),
          selling_price: Number(v.sellingPrice),
          stock,
          sort_order: j,
          ...(optionValues.length > 0 ? { option_values: optionValues } : {}),
        },
      ];
    });
    // Swatches arrive as a list of { value, hex } (the schema subset has no
    // map type) and are stored as the editor stores them, a value → hex map.
    const rawOptions = list(raw.options).flatMap((o) => {
      if (!isRec(o)) return [];
      const swatchList = list(o.swatches).filter(isRec);
      return [
        {
          name: text(o.name),
          values: list(o.values).map(text),
          ...(swatchList.length > 0
            ? {
                swatches: Object.fromEntries(
                  swatchList.map((sw) => [text(sw.value), text(sw.hex)]),
                ),
              }
            : {}),
        },
      ];
    });
    let options: ProductOption[] = [];
    let optionVariants = variants;
    if (rawOptions.length > 0) {
      const rows = resolveOptionRows(rawOptions, variants);
      if ("error" in rows) issues.push(`${where}.options: ${rows.error}`);
      else {
        options = rows.options;
        optionVariants = rows.variants;
      }
    }
    return [
      {
        name: text(raw.name),
        slug,
        description: text(raw.description),
        category_slug: text(raw.categorySlug),
        base_price: base,
        selling_price: selling,
        image_url: image ?? "",
        featured: raw.featured === true,
        sort_order: i,
        ...(options.length > 0 ? { options } : {}),
        ...(optionVariants.length > 0 ? { variants: optionVariants } : {}),
      },
    ];
  });
  if (categories.length === 0 || products.length === 0) {
    issues.push(
      "The sample catalogue needs at least one category and one product.",
    );
  }
  return { categories, products };
}

function assetKind(
  slot: string,
  intent: ThemeIntent,
  productSlots?: ReadonlyMap<string, ProductSlot>,
): ThemePackageAsset["kind"] {
  if (productSlots?.has(slot)) return "product";
  if (slot === "preview" || slot.startsWith("screenshot-")) return "preview";
  const brief = intent.assetBriefs.find((b) => b.id === slot);
  const purpose = `${brief?.purpose ?? ""} ${slot}`.toLowerCase();
  if (/hero|banner/.test(purpose)) return "hero";
  if (/product/.test(purpose)) return "product";
  if (/categor|collection/.test(purpose)) return "category";
  return "content";
}

/** A product photograph's shape when its brief was not written for products
 *  (a model pointing a product at the hero brief): square, which every
 *  product card crops cleanly. */
export const PRODUCT_SLOT_FALLBACK_RATIO = "1:1";

/** Aspect ratio and alt text for a slot's placeholder. */
export function slotSpec(
  slot: string,
  intent: ThemeIntent,
  productSlots?: ReadonlyMap<string, ProductSlot>,
): { aspectRatio: string; alt: string } {
  if (isSystemSlot(slot)) return SYSTEM_SLOTS[slot];
  const product = productSlots?.get(slot);
  if (product) {
    const brief = intent.assetBriefs.find((b) => b.id === product.briefId);
    return {
      aspectRatio:
        brief && assetKind(brief.id, intent) === "product"
          ? brief.aspectRatio
          : PRODUCT_SLOT_FALLBACK_RATIO,
      alt: (product.productName || slot).slice(0, 240),
    };
  }
  const brief = intent.assetBriefs.find((b) => b.id === slot);
  return {
    aspectRatio: brief?.aspectRatio ?? "4:3",
    alt: (brief?.subject ?? slot).slice(0, 240),
  };
}

// ---------------------------------------------------------------------------
// Page templates as one JSON string (prompt v33).
//
// v32 sent the templates as a closed object in the Stage B schema, and its
// enums and types were the guarantee: a gallery was one of five, an icon one
// of the trust-bar catalogue, afterIndex an integer. That object pushed the
// revision schemas past what Vertex accepts (prompt-features.ts), so v33
// carries the same templates as a string, the way a section's configJson is
// carried. The renderer's normaliser would quietly coerce whatever the string
// holds (an unknown icon becomes the first icon, an unknown gallery the
// default one), so every value the v32 schema used to refuse is named here
// and goes back to the model as a repair. What v32 already normalised without
// a word (a missing price or buy box appended, a repeated block dropped, an
// over-long list cut) stays silent. Two rules the prompt states are checked
// on this path too, since a revision now copies the templates forward: a
// promo tile links to a site path like the announcement does, and the
// sticky_bar block agrees with design.layout.stickyAddToCart.
// ---------------------------------------------------------------------------

/** At most this many template problems go back in one repair turn. */
const MAX_TEMPLATE_ISSUES = 8;
/** How much of the parser's own message a repair sentence quotes. */
const JSON_ERROR_MAX = 160;
const PROMO_THEMES = ["dark", "light"] as const;

/** A value as a repair sentence quotes it. */
function shown(value: unknown): string {
  if (value === undefined) return "missing";
  const json = JSON.stringify(value);
  return json.length > 40 ? `${json.slice(0, 37)}...` : json;
}

/** What the v32 schema guaranteed about a templates value and a JSON string
 * does not, one sentence per problem, each naming its path. Only the fields a
 * block's type uses are read, like the normaliser reads them. */
function templatesJsonIssues(raw: Rec): string[] {
  const issues: string[] = [];
  const record = (value: unknown, path: string): Rec | null => {
    if (isRec(value)) return value;
    issues.push(`${path} must be an object (it is ${shown(value)}).`);
    return null;
  };
  const array = (value: unknown, path: string): unknown[] | null => {
    if (Array.isArray(value)) return value;
    issues.push(`${path} must be a list (it is ${shown(value)}).`);
    return null;
  };
  const string = (value: unknown, path: string) => {
    if (typeof value !== "string")
      issues.push(`${path} must be a string (it is ${shown(value)}).`);
  };
  // A list written as numbers is one mistake, so it costs one sentence (a
  // size chart's cells would otherwise fill every slot of the repair turn).
  const strings = (value: unknown, path: string) => {
    const items = array(value, path) ?? [];
    const i = items.findIndex((item) => typeof item !== "string");
    if (i >= 0)
      issues.push(
        `${path} must be a list of strings (${path}[${i}] is ${shown(items[i])}).`,
      );
  };
  const choice = (value: unknown, path: string, values: readonly string[]) => {
    if (typeof value !== "string" || !values.includes(value))
      issues.push(
        `${path} must be one of ${values.join(", ")} (it is ${shown(value)}).`,
      );
  };

  const root = "templatesJson";
  const product = record(raw.product, `${root}.product`);
  if (product) {
    choice(product.gallery, `${root}.product.gallery`, PRODUCT_GALLERIES);
    array(product.blocks, `${root}.product.blocks`)?.forEach((entry, i) => {
      const at = `${root}.product.blocks[${i}]`;
      const block = record(entry, at);
      if (!block) return;
      choice(block.type, `${at}.type`, PRODUCT_BLOCK_TYPES);
      if (block.type === "trust_row") {
        array(block.items, `${at}.items`)?.forEach((value, j) => {
          const item = record(value, `${at}.items[${j}]`);
          if (!item) return;
          choice(item.icon, `${at}.items[${j}].icon`, USP_ICONS);
          string(item.label, `${at}.items[${j}].label`);
        });
      } else if (block.type === "accordion") {
        array(block.rows, `${at}.rows`)?.forEach((value, j) => {
          const row = record(value, `${at}.rows[${j}]`);
          if (!row) return;
          string(row.heading, `${at}.rows[${j}].heading`);
          string(row.body, `${at}.rows[${j}].body`);
        });
      } else if (block.type === "size_guide") {
        strings(block.columns, `${at}.columns`);
        array(block.sizes, `${at}.sizes`)?.forEach((value, j) => {
          const size = record(value, `${at}.sizes[${j}]`);
          if (!size) return;
          string(size.label, `${at}.sizes[${j}].label`);
          strings(size.values, `${at}.sizes[${j}].values`);
        });
      } else if (block.type === "rich_text") {
        string(block.html, `${at}.html`);
      }
    });
  }
  const collection = record(raw.collection, `${root}.collection`);
  if (collection) {
    choice(
      collection.filters,
      `${root}.collection.filters`,
      COLLECTION_FILTERS,
    );
    choice(
      collection.pagination,
      `${root}.collection.pagination`,
      COLLECTION_PAGINATIONS,
    );
    array(collection.promoTiles, `${root}.collection.promoTiles`)?.forEach(
      (value, k) => {
        const at = `${root}.collection.promoTiles[${k}]`;
        const tile = record(value, at);
        if (!tile) return;
        if (!Number.isInteger(tile.afterIndex))
          issues.push(
            `${at}.afterIndex must be a whole number (it is ${shown(tile.afterIndex)}).`,
          );
        for (const key of ["heading", "body", "cta_label", "href"])
          string(tile[key], `${at}.${key}`);
        // The normaliser would empty a bare slug and keep an off-site link;
        // a tile's link is held to the announcement's rule instead.
        const href = typeof tile.href === "string" ? tile.href.trim() : "";
        if (href && (!href.startsWith("/") || href.startsWith("//")))
          issues.push(
            `${at}.href must be "" or a site path starting with "/" (it is ${shown(tile.href)}).`,
          );
        choice(tile.theme, `${at}.theme`, PROMO_THEMES);
        if (tile.background !== null && typeof tile.background !== "string")
          issues.push(
            `${at}.background must be a hex colour or null (it is ${shown(tile.background)}).`,
          );
        // v32's closed tile had no picture; the normaliser would keep one.
        for (const key of ["image_url", "image_alt"])
          if (tile[key] !== undefined && tile[key] !== "")
            issues.push(
              `${at}.${key} is not a promo tile field: a generated theme's tile is a colour field, so leave it out.`,
            );
      },
    );
  }
  const blog = record(raw.blog, `${root}.blog`);
  if (blog) {
    choice(blog.index, `${root}.blog.index`, BLOG_INDEX_LAYOUTS);
    choice(blog.article, `${root}.blog.article`, BLOG_ARTICLE_LAYOUTS);
  }
  const account = record(raw.account, `${root}.account`);
  if (account) {
    choice(account.layout, `${root}.account.layout`, ACCOUNT_LAYOUTS);
    // null is the page's own colours, and "" the stored spelling of it.
    const scheme = account.scheme;
    if (scheme !== null && scheme !== "" && !isSectionScheme(scheme))
      issues.push(
        `${root}.account.scheme must be null or one of ${SECTION_SCHEMES.join(", ")} (it is ${shown(scheme)}).`,
      );
  }
  const more = issues.length - MAX_TEMPLATE_ISSUES;
  return more <= 0
    ? issues
    : [
        ...issues.slice(0, MAX_TEMPLATE_ISSUES),
        `templatesJson has ${more} more ${more === 1 ? "problem" : "problems"} like these; check every value against the Templates rules.`,
      ];
}

/** A v33 draft's templatesJson: parsed, checked against what the v32 schema
 * enforced, then completed by the renderer's normaliser exactly as v32's
 * object is. Undefined, with an issue, when the string is not one JSON
 * object. */
function parseTemplatesJson(
  raw: string,
  layout: ThemeDesign["layout"] | undefined,
  issues: string[],
): ThemeTemplates | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // The parser quotes the source, line breaks and all; a repair turn
    // lists one issue per line.
    const message = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim();
    issues.push(
      `templatesJson is not valid JSON (${message.slice(0, JSON_ERROR_MAX)}).`,
    );
    return undefined;
  }
  if (!isRec(parsed)) {
    // What it decoded to is the hint: a string means it was encoded twice.
    issues.push(
      `templatesJson must encode one JSON object (it is ${shown(parsed)}).`,
    );
    return undefined;
  }
  issues.push(...templatesJsonIssues(parsed));
  return normalizeTemplates(parsed, defaultTemplates(layout));
}

/** The storefront shows the phone's sticky add-to-cart from the sticky_bar
 * block alone (lib/chrome/types.ts), while the catalogue fingerprint reads
 * design.layout.stickyAddToCart, so a v33 draft writes the two to agree. The
 * v32 object path never checked this and still does not. */
function stickyBarIssue(
  templates: ThemeTemplates,
  layout: ThemeDesign["layout"] | undefined,
): string | null {
  const block = hasProductBlock(templates.product, "sticky_bar");
  if (block === (layout?.stickyAddToCart === true)) return null;
  return block
    ? 'templatesJson.product.blocks has a "sticky_bar" block but design.layout.stickyAddToCart is not true. The block is the phone\'s sticky add-to-cart, so write it exactly when that setting is true: set the setting true or leave the block out.'
    : 'design.layout.stickyAddToCart is true but templatesJson.product.blocks has no "sticky_bar" block. The block is the phone\'s sticky add-to-cart and the storefront shows nothing without it: add {"type":"sticky_bar"} or set the setting false.';
}

/**
 * A stored templates value as a v33 draft writes it, for a revision's current
 * theme (prompts.ts currentThemeForRevision). The stored shape differs from
 * the draft's in two spellings: a promo tile carries no picture fields (a
 * generated theme's tile is a colour field and its stored ones are always
 * empty), and the page's own colours and field are null where the stored
 * value says "". Normalising the result gives the stored value back exactly,
 * so a revision that copies it changes nothing.
 */
export function templatesForDraft(
  templates: ThemeTemplates,
): Record<string, unknown> {
  return {
    product: templates.product,
    collection: {
      filters: templates.collection.filters,
      pagination: templates.collection.pagination,
      promoTiles: templates.collection.promoTiles.map((tile) => ({
        afterIndex: tile.afterIndex,
        heading: tile.heading,
        body: tile.body,
        cta_label: tile.cta_label,
        href: tile.href,
        theme: tile.theme,
        background: tile.background || null,
      })),
    },
    blog: templates.blog,
    account: {
      layout: templates.account.layout,
      scheme: templates.account.scheme || null,
    },
  };
}

/** A theme's announcement bar as a draft writes it: both fields, "" for
 * none. */
export function announcementForDraft(
  announcement: ThemeAnnouncement | undefined,
): { text: string; href: string } {
  return { text: announcement?.text ?? "", href: announcement?.href ?? "" };
}

/** First pass: shape the draft and find the slots it needs. */
export function prepareDraft(
  draftInput: unknown,
  intent: ThemeIntent,
): {
  parts: {
    draft: Rec;
    design: ThemeDesign | null;
    pages: ThemePageSeed[];
    catalogue: {
      categories: ThemeCategorySeed[];
      products: ThemeProductSeed[];
    };
    productSlots: Map<string, ProductSlot>;
    /** v33: the templates the draft wrote as a JSON string, checked and
     * completed; undefined for a draft without one. */
    templatesFromJson?: ThemeTemplates;
  } | null;
  slots: string[];
  issues: string[];
} {
  const issues: string[] = [];
  if (!isRec(draftInput)) {
    return {
      parts: null,
      slots: [],
      issues: ["The draft must be a JSON object."],
    };
  }
  if (intent.schemaVersion === 2)
    issues.push(...explicitDraftStyleIssues(draftInput));
  const known = new Set<string>([
    ...intent.assetBriefs.map((b) => b.id),
    ...Object.keys(SYSTEM_SLOTS),
  ]);
  const briefIds = new Set(intent.assetBriefs.map((b) => b.id));
  const used = new Set<string>(Object.keys(SYSTEM_SLOTS));
  const productSlots = new Map<string, ProductSlot>();
  const design = buildDesign(draftInput.design, issues, draftInput.fontPairing);
  if (intent.schemaVersion === 2 && design)
    issues.push(
      ...paletteFamilyIssues(intent.paletteFamily, design.palette.cream),
    );
  const pages = buildPages(draftInput.pages, known, used, issues);
  const catalogue = buildCatalogue(
    draftInput,
    known,
    briefIds,
    used,
    productSlots,
    issues,
  );

  const menus = isRec(draftInput.menus) ? draftInput.menus : {};
  // Header items nest (children, grandchildren) and a top-level item may name
  // a mega-menu image slot, checked by the same rule as a section's *_url.
  const headerTree = (value: unknown): unknown[] =>
    list(value).flatMap((item) =>
      isRec(item) ? [item, ...headerTree(item.children)] : [],
    );
  checkConfigUrls(
    list(menus.header).map((item) =>
      // Only an item with children renders its image, so only that one spends
      // a slot; the cleaner drops the rest.
      isRec(item) && list(item.children).length
        ? { image_url: item.image_url }
        : {},
    ),
    "menus.header",
    known,
    used,
    issues,
  );
  const links = [
    ...headerTree(menus.header).filter(
      // A heading that only opens a submenu has no destination to check.
      (item) =>
        !(isRec(item) && text(item.href) === "" && list(item.children).length),
    ),
    ...list(menus.footerLegal),
    ...list(menus.footerGroups).flatMap((g) => (isRec(g) ? list(g.links) : [])),
  ];
  links.forEach((link, i) => {
    if (isRec(link)) checkLink(text(link.href), `menus link ${i + 1}`, issues);
  });
  // v32: the announcement bar's link, held to the same rule as a menu link;
  // its text is bounded by the renderer's normaliser at assembly.
  if (isRec(draftInput.announcement)) {
    const href = text(draftInput.announcement.href);
    if (href) checkLink(href, "announcement.href", issues);
  }
  // v33: the page templates as a JSON string. A v32 draft's object is
  // normalised in assemblePackage, as it always was.
  let templatesFromJson: ThemeTemplates | undefined;
  if (typeof draftInput.templatesJson === "string")
    templatesFromJson = parseTemplatesJson(
      draftInput.templatesJson,
      design?.layout,
      issues,
    );
  else if (draftInput.templatesJson !== undefined)
    issues.push("templatesJson must be a string holding one JSON object.");
  const sticky =
    templatesFromJson && design
      ? stickyBarIssue(templatesFromJson, design.layout)
      : null;
  if (sticky) issues.push(sticky);

  return {
    parts: {
      draft: draftInput,
      design,
      pages,
      catalogue,
      productSlots,
      ...(templatesFromJson ? { templatesFromJson } : {}),
    },
    slots: [...used].sort(),
    issues,
  };
}

/** Second pass: assemble and validate the package once slot assets exist. */
export function assemblePackage(
  prepared: NonNullable<ReturnType<typeof prepareDraft>["parts"]>,
  facts: CompileFacts,
  intent: ThemeIntent,
  slotAssets: Map<string, SlotAsset>,
  priorIssues: string[],
): CompileResult {
  const issues = [...priorIssues];
  const { draft, design, pages, catalogue, productSlots, templatesFromJson } =
    prepared;
  const features = [
    ...new Set([
      ...list(draft.features).filter((f): f is ThemeFeature =>
        THEME_STUDIO_FEATURES.includes(f as ThemeFeature),
      ),
      ...facts.requiredFeatures,
    ]),
  ];
  if (features.length === 0) issues.push("Declare at least one theme feature.");
  const engine: ThemeEngineRef =
    facts.baseEngine ??
    (design?.layout?.storefront === "grocery"
      ? { id: "storefront-grocery", version: 1 }
      : { id: "storefront-editorial", version: 1 });

  const brand = isRec(draft.brand) ? draft.brand : {};
  const menus = sanitizeMenusForSave(draft.menus);
  const surfaces = [
    ...new Set<ThemeStudioSurface>([
      "home",
      "shop",
      "product",
      "cart",
      ...intent.pagePlans.map((plan) => plan.surface),
    ]),
  ];

  const assets: ThemePackageAsset[] = [];
  for (const [slot, asset] of [...slotAssets.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    assets.push({
      id: slot,
      path: `${THEME_ASSET_PREFIX}${slot}`,
      kind: assetKind(slot, intent, productSlots),
      source: "generated",
      sha256: asset.sha256,
      width: asset.width,
      height: asset.height,
      alt: slotSpec(slot, intent, productSlots).alt,
      licenseNote: PLACEHOLDER_LICENSE_NOTE,
    });
  }

  if (!design) return { package: null, slots: [...slotAssets.keys()], issues };

  const definition: ThemeDefinition = {
    id: facts.themeId,
    name: facts.name,
    description: text(draft.description),
    engine,
    release: {
      version: `0.0.${facts.versionNumber}`,
      status: "draft",
      notes: [
        `Generated by Theme Studio with ${facts.modelLabel} (prompt ${facts.promptVersion}). Not reviewed.`,
      ],
    },
    catalog: {
      visibility: "hidden",
      industries: facts.industries,
      catalogSizes: facts.catalogSizes,
      features,
      keywords: list(draft.keywords).map(text).filter(Boolean),
      previewImage: `${THEME_ASSET_PREFIX}preview`,
      screenshots: [
        {
          src: `${THEME_ASSET_PREFIX}screenshot-desktop`,
          viewport: "desktop",
          alt: `${facts.name} storefront on desktop (placeholder until review screenshots exist)`,
        },
        {
          src: `${THEME_ASSET_PREFIX}screenshot-mobile`,
          viewport: "mobile",
          alt: `${facts.name} storefront on mobile (placeholder until review screenshots exist)`,
        },
      ],
    },
    demo: {
      slug: `demo-${facts.themeId}`,
      status: "unavailable",
      unavailableReason: "Generated candidate; no demo store yet.",
    },
    preset: {
      brand: {
        primaryColor: text(brand.primaryColor),
        ...(text(brand.tagline) ? { tagline: text(brand.tagline) } : {}),
        ...(text(brand.blurb) ? { blurb: text(brand.blurb) } : {}),
      },
      design,
      pages: withSeoDescriptions(pages, text(draft.description), facts.name),
      menus,
      sampleData: catalogue,
      // v32 (plan Phase 2e): the page templates the draft wrote, completed
      // and bounded by the renderer's own normaliser so the contract's strict
      // report has nothing to object to. A pre-v32 draft carries none, and
      // the storefront then composes the pages its layout implies.
      ...(isRec(draft.templates)
        ? {
            templates: normalizeTemplates(
              draft.templates,
              defaultTemplates(design?.layout),
            ),
          }
        : {}),
      // v33: the same templates written as a JSON string, checked and
      // completed by the same normaliser in prepareDraft.
      ...(templatesFromJson ? { templates: templatesFromJson } : {}),
      // v32: the announcement bar, or nothing when the draft wrote text "".
      ...(normalizeAnnouncement(draft.announcement)
        ? { announcement: normalizeAnnouncement(draft.announcement) }
        : {}),
    },
  };

  const candidate: ThemePackageV2 = {
    schemaVersion: THEME_PACKAGE_SCHEMA_VERSION,
    definition,
    renderer: { minVersion: engine.version, viewports: THEME_STUDIO_VIEWPORTS },
    declaredCapabilities: { features, surfaces },
    assets,
    provenance: {
      origin: "generated",
      modelKey: facts.modelKey,
      promptVersion: facts.promptVersion,
      referenceDigests: facts.referenceDigests,
    },
    capabilityGaps: normalizeGaps(draft.capabilityGaps),
  };

  const validated = validateThemePackageV2(candidate);
  if (!validated.ok) issues.push(...validated.issues);
  // ★ The production content floors run HERE, not only at acceptance. Every
  // one of them is something the model controls (catalogue size, homepage
  // variety, contrast, links), so a shortfall caught now becomes a repair
  // turn; caught at acceptance it becomes a failed candidate the operator
  // has to revise by hand — one more prompt for a fix the model could make.
  // Asset rules stay at acceptance: images are placeholders until then.
  if (validated.ok) issues.push(...contentFloorIssues(validated.value));
  return {
    package: issues.length === 0 && validated.ok ? validated.value : null,
    slots: [...slotAssets.keys()],
    issues,
  };
}

/** The model-controlled production floors, as repair sentences. */
export function contentFloorIssues(pkg: ThemePackageV2): string[] {
  const theme = pkg.definition;
  return [
    ...validateThemePages(theme),
    ...validateThemeHomepage(theme),
    ...validateThemeSampleData(theme),
    ...validateThemeLinks(theme),
    ...validateStudioDesign(theme),
    ...validateThemeCopy(theme),
  ].map((finding) => finding.message);
}

/** Normalize a Stage A intent: the schema's explicit nulls become omissions,
 * which is what validateThemeIntent expects for an optional field. */
export function normalizeIntent(raw: unknown): unknown {
  if (!isRec(raw)) return raw;
  return { ...raw, capabilityGaps: normalizeGaps(raw.capabilityGaps) };
}
