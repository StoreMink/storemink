/**
 * The storefront revamp tools' arguments, read once into a `RevampRequest`.
 *
 * ★ PURE: no database and no server-only import, so the tools and their tests
 *   read a request the same way. Ownership of photos, permissions, the plan's
 *   product cap and credits need the store, so the tools check those; every
 *   mistake a model can make on its own is caught here.
 * ★ EVERY ISSUE AT ONCE, each a plain sentence naming the argument to fix, so
 *   one retry can repair all of them instead of finding them one call at a time.
 * ★ The output is exactly what `createRevampJob` reads back (camelCase, `kind`
 *   on the request), so a request accepted here is never refused there as
 *   unreadable.
 * ★ Category changes go through the v1 personalisation reader, so "only what
 *   the merchant confirmed" is one rule in one place for both features.
 */
import {
  readPersonalizationRequest,
  type PersonalizationCategoryChange,
} from "../storefront-personalization-contract";
import {
  REVAMP_LIMITS,
  REVAMP_SKIPPED_SLUGS,
  type RevampBrief,
  type RevampKind,
  type RevampProductInput,
  type RevampProductSize,
  type RevampRefineScope,
  type RevampRequest,
} from "./contract";

export const REVAMP_REQUEST_LIMITS = {
  business: 600,
  look: 400,
  audience: 300,
  fact: 200,
  facts: 15,
  avoid: 300,
  language: 40,
  productName: 120,
  productDescription: 600,
  sizeLabel: 40,
  /** Rupees; a price or MRP above this is a typing slip, not a product. */
  maxPrice: 10_000_000,
  photoUrl: 2_048,
  categorySlug: 80,
  pageSlug: 60,
  shotId: 80,
  instructionMin: 3,
  instructionMax: 600,
} as const;

export type RevampRequestRead =
  | { ok: true; value: RevampRequest }
  | { ok: false; issues: string[] };

const L = REVAMP_REQUEST_LIMITS;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Read the tool arguments (snake_case, as the model sends them) for a full
 * redesign or a refinement. A refinement also needs `instruction` and
 * `refine_scope`; a full redesign ignores both.
 */
export function readRevampRequest(
  input: Record<string, unknown>,
  kind: RevampKind,
): RevampRequestRead {
  const issues: string[] = [];
  const brief = readBrief(input.brief, issues);
  const products = readProducts(input.products, issues);
  const categories = readCategories(input.categories, issues);
  const pages = readPageList(input.pages, "pages", issues);
  let instruction: string | null = null;
  let refineScope: RevampRefineScope | null = null;
  if (kind === "refine") {
    instruction = text(
      input.instruction,
      "instruction (the merchant's own words)",
      L.instructionMax,
      issues,
      L.instructionMin,
    );
    refineScope = readRefineScope(input.refine_scope, issues);
  }
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    value: {
      kind,
      brief,
      products,
      categories,
      pages,
      instruction,
      refineScope,
    },
  };
}

/**
 * A stored request back in the shape the model sends, so a refinement can be
 * composed from its parent and read again by `readRevampRequest`. ★ Round
 * tripping keeps product keys: the parent's products come first and keys are
 * given by position.
 */
export function revampRequestToWire(
  request: RevampRequest,
): Record<string, unknown> {
  return {
    brief: {
      business: request.brief.business,
      look: request.brief.look,
      audience: request.brief.audience,
      facts: [...request.brief.facts],
      avoid: request.brief.avoid,
      language: request.brief.language,
    },
    products: request.products.map((product) => ({
      name: product.name,
      description: product.description,
      sizes: product.sizes.map((size) => ({
        label: size.label,
        price: size.price,
        mrp: size.mrp,
      })),
      photo_url: product.photoUrl,
      category_slug: product.categorySlug,
    })),
    categories: request.categories.map(categoryToWire),
    pages: request.pages ? [...request.pages] : null,
  };
}

/**
 * A refinement's products keyed against its parent's. The first `carried`
 * products are the parent's own and keep the keys they had; a product the
 * merchant adds now gets a key the parent never used.
 *
 * ★ Keys from `readRevampRequest` are positions, which line up with the
 *   parent's only while every parent product is carried. A refinement of an
 *   applied parent carries none (they are on the store already), and the
 *   compiler copies the previous plan's product copy BY KEY, so a new product
 *   keyed `p1` would be given the parent's first product's description.
 * ★ `reservedKeys` are the keys every version of the redesign ever used
 *   (`revampChainCarry`): a version further up may come back into the carry
 *   when it is undone, and a new product sharing its key would then be two
 *   products under one key.
 */
export function keyRefinementProducts(
  request: RevampRequest,
  parentProducts: ReadonlyArray<Pick<RevampProductInput, "key">>,
  carried: number,
  reservedKeys: readonly string[] = [],
): RevampRequest {
  let next =
    Math.max(
      parentProducts.length,
      ...parentProducts.map((product) => keyIndex(product.key)),
      ...reservedKeys.map(keyIndex),
    ) + 1;
  return {
    ...request,
    products: request.products.map((product, index) => {
      const own = index < carried ? parentProducts[index] : undefined;
      return { ...product, key: own ? own.key : `p${next++}` };
    }),
  };
}

function keyIndex(key: string): number {
  const match = /^p(\d+)$/.exec(key);
  return match ? Number(match[1]) : 0;
}

// ---------------------------------------------------------------------------
// The versions of one redesign.
// ---------------------------------------------------------------------------

/** What one version of a redesign asked for, and whether it is on the store. */
export interface RevampChainVersion<
  P extends Pick<RevampProductInput, "key" | "name">,
  C extends RevampCategoryChangeLike,
> {
  products: readonly P[];
  categories: readonly C[];
  /** Applied and not undone: what it asked for is on the store now. */
  live: boolean;
}

/** A category change as stored or as read: only what identifies it. */
export interface RevampCategoryChangeLike {
  action: string;
  slug?: string | null;
  name?: string | null;
  description?: string | null;
  newPhoto?: boolean;
}

/** A product's name as the store compares names: case and spacing aside. */
export function revampProductNameKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * One category change by everything it does: the action, the category and
 * the words. ★ The words count here (unlike the charge's key): renaming a
 * category an applied version renamed already is a new change, not the old
 * one carried again.
 */
export function revampCategoryContentKey(
  change: RevampCategoryChangeLike,
): string {
  return JSON.stringify([
    change.action,
    change.slug ?? null,
    change.name ?? null,
    change.description ?? null,
    change.newPhoto === true,
  ]);
}

/**
 * What the next refinement of a redesign carries: every product and category
 * change any version of it asked for that no live version (applied, not
 * undone) has put on the store. `chain` is the version the refinement builds
 * on first, then its parent, up to the full redesign.
 *
 * ★★ THE WHOLE CHAIN, NOT THE PARENT ALONE. A version decides what it carries
 *    when it is asked for, but an earlier version can still be applied or
 *    undone after that: applied, its products are on the store and a version
 *    carrying them makes Apply create them twice (refused, for ever, since
 *    each refinement carried the same); undone, they are gone and a version
 *    that left them out (they were on the store then) would drop them. So the
 *    carry is worked out again from every version, each by its state now.
 * ★ Products are one by their name, the store's own rule; the first version
 *   that asked for one keeps its key, and a key two different products came
 *   to share is replaced, so a carry never holds two products under one key.
 */
export function revampChainCarry<
  P extends Pick<RevampProductInput, "key" | "name">,
  C extends RevampCategoryChangeLike,
>(
  chain: ReadonlyArray<RevampChainVersion<P, C>>,
): { products: P[]; categories: C[]; usedKeys: string[] } {
  const liveNames = new Set<string>();
  const liveChanges = new Set<string>();
  for (const version of chain) {
    if (!version.live) continue;
    for (const product of version.products) {
      liveNames.add(revampProductNameKey(product.name));
    }
    for (const change of version.categories) {
      liveChanges.add(revampCategoryContentKey(change));
    }
  }
  const usedKeys: string[] = [];
  const products: P[] = [];
  const names = new Set<string>();
  const categories: C[] = [];
  const changes = new Set<string>();
  // ★ Oldest first: a version lists what it carries before its own, so this
  //   is the order the versions themselves list them in.
  for (const version of [...chain].reverse()) {
    for (const product of version.products) {
      usedKeys.push(product.key);
      const name = revampProductNameKey(product.name);
      if (names.has(name) || liveNames.has(name)) continue;
      names.add(name);
      products.push(product);
    }
    for (const change of version.categories) {
      const key = revampCategoryContentKey(change);
      if (changes.has(key) || liveChanges.has(key)) continue;
      changes.add(key);
      categories.push(change);
    }
  }
  const taken = new Set<string>();
  let next = Math.max(0, ...usedKeys.map(keyIndex)) + 1;
  const distinct = products.map((product) => {
    if (!taken.has(product.key)) {
      taken.add(product.key);
      return product;
    }
    const key = `p${next++}`;
    taken.add(key);
    usedKeys.push(key);
    return { ...product, key };
  });
  return { products: distinct, categories, usedKeys };
}

/** Why a refinement no longer fits the store, or null when it does. */
export type RevampRefinementStale = "applied" | "undone";

/**
 * Whether a refinement still carries exactly what its earlier versions have
 * not put on the store (`revampChainCarry`, worked out now): "applied" when
 * it carries something an earlier version has since put on the store,
 * "undone" when it leaves out something an earlier version has since taken
 * back off. ★ The refinement's own additions are in no earlier version, so
 * they never count either way, and a product it carries is one of an earlier
 * version's only under the same key AND name (a product the merchant added
 * again under the same name is a new one, keyed anew).
 */
export function revampRefinementStale<
  P extends Pick<RevampProductInput, "key" | "name">,
  C extends RevampCategoryChangeLike,
>(
  own: { products: readonly P[]; categories: readonly C[] },
  chain: ReadonlyArray<RevampChainVersion<P, C>>,
): RevampRefinementStale | null {
  const identity = (product: P) =>
    JSON.stringify([product.key, revampProductNameKey(product.name)]);
  const liveProducts = new Set<string>();
  const liveChanges = new Set<string>();
  for (const version of chain) {
    if (!version.live) continue;
    for (const product of version.products) liveProducts.add(identity(product));
    for (const change of version.categories) {
      liveChanges.add(revampCategoryContentKey(change));
    }
  }
  if (
    own.products.some((product) => liveProducts.has(identity(product))) ||
    own.categories.some((change) =>
      liveChanges.has(revampCategoryContentKey(change)),
    )
  ) {
    return "applied";
  }
  const expected = revampChainCarry(chain);
  const names = new Set(
    own.products.map((product) => revampProductNameKey(product.name)),
  );
  const changes = new Set(own.categories.map(revampCategoryContentKey));
  if (
    expected.products.some(
      (product) => !names.has(revampProductNameKey(product.name)),
    ) ||
    expected.categories.some(
      (change) => !changes.has(revampCategoryContentKey(change)),
    )
  ) {
    return "undone";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pieces.
// ---------------------------------------------------------------------------

function readBrief(raw: unknown, issues: string[]): RevampBrief {
  const row = asRecord(raw);
  if (!row) {
    issues.push(
      "brief is required: give brief.business, what the store sells and who buys it, in the merchant's words.",
    );
  }
  const brief = row ?? {};
  const business = text(
    brief.business,
    "brief.business (what the store sells and who buys it)",
    L.business,
    row ? issues : [],
    3,
  );
  return {
    business,
    look: text(brief.look, "brief.look", L.look, issues),
    audience: text(brief.audience, "brief.audience", L.audience, issues),
    facts: readFacts(brief.facts, issues),
    avoid: text(brief.avoid, "brief.avoid", L.avoid, issues),
    language:
      text(brief.language, "brief.language", L.language, issues) || "English",
  };
}

function readFacts(raw: unknown, issues: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push("brief.facts must be a list of short true statements.");
    return [];
  }
  const facts: string[] = [];
  raw.forEach((fact, index) => {
    if (typeof fact !== "string") {
      issues.push(`brief.facts[${index}] must be text.`);
      return;
    }
    const clean = fact.normalize("NFKC").trim();
    if (!clean) return;
    if (clean.length > L.fact) {
      issues.push(
        `brief.facts[${index}] must be ${L.fact} characters or fewer.`,
      );
    }
    facts.push(clean.slice(0, L.fact));
  });
  if (facts.length > L.facts) {
    issues.push(`brief.facts holds at most ${L.facts} statements.`);
  }
  return facts.slice(0, L.facts);
}

function readProducts(raw: unknown, issues: string[]): RevampProductInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push(
      "products must be a list of the merchant's own products, or left out.",
    );
    return [];
  }
  if (raw.length > REVAMP_LIMITS.maxProducts) {
    issues.push(
      `products holds at most ${REVAMP_LIMITS.maxProducts} products in one redesign: add the rest later.`,
    );
  }
  const products = raw
    .slice(0, REVAMP_LIMITS.maxProducts)
    .map((entry, index) => readProduct(entry, index, issues));
  const seen = new Map<string, number>();
  products.forEach((product, index) => {
    const name = product.name.toLowerCase();
    if (!name) return;
    const first = seen.get(name);
    if (first !== undefined) {
      issues.push(
        `products[${index}].name repeats products[${first}]: each product needs its own name.`,
      );
    } else {
      seen.set(name, index);
    }
  });
  return products;
}

function readProduct(
  raw: unknown,
  index: number,
  issues: string[],
): RevampProductInput {
  const label = `products[${index}]`;
  const key = `p${index + 1}`;
  const row = asRecord(raw);
  if (!row) {
    issues.push(`${label} must be a product with a name and its sizes.`);
    return {
      key,
      name: "",
      description: "",
      sizes: [],
      photoUrl: null,
      categorySlug: null,
    };
  }
  return {
    key,
    name: text(row.name, `${label}.name`, L.productName, issues, 1),
    description: text(
      row.description,
      `${label}.description`,
      L.productDescription,
      issues,
    ),
    sizes: readSizes(row.sizes, label, issues),
    photoUrl: readPhotoUrl(row.photo_url, `${label}.photo_url`, issues),
    categorySlug: readCategorySlug(
      row.category_slug,
      `${label}.category_slug`,
      issues,
    ),
  };
}

function readSizes(
  raw: unknown,
  label: string,
  issues: string[],
): RevampProductSize[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push(
      `${label}.sizes needs at least one size with its price: ask the merchant for the price.`,
    );
    return [];
  }
  if (raw.length > REVAMP_LIMITS.maxSizes) {
    issues.push(
      `${label}.sizes holds at most ${REVAMP_LIMITS.maxSizes} sizes.`,
    );
  }
  const sizes = raw
    .slice(0, REVAMP_LIMITS.maxSizes)
    .map((entry, index) => readSize(entry, `${label}.sizes[${index}]`, issues));
  if (sizes.length > 1) {
    // ★ One size may go unnamed (a product sold one way); with two or more,
    //   an empty or repeated label would make two variants nobody can tell apart.
    const seen = new Set<string>();
    sizes.forEach((size, index) => {
      const name = size.label.toLowerCase();
      if (!name) {
        issues.push(
          `${label}.sizes[${index}].label is required when a product has more than one size.`,
        );
        return;
      }
      if (seen.has(name)) {
        issues.push(
          `${label}.sizes[${index}].label repeats another size: each size needs its own label.`,
        );
      }
      seen.add(name);
    });
  }
  return sizes;
}

function readSize(
  raw: unknown,
  label: string,
  issues: string[],
): RevampProductSize {
  const row = asRecord(raw);
  if (!row) {
    issues.push(`${label} must be a size with a label and a price.`);
    return { label: "", price: 0, mrp: null };
  }
  const sizeLabel = text(row.label, `${label}.label`, L.sizeLabel, issues);
  const price = readMoney(row.price, `${label}.price`, issues);
  const mrp =
    row.mrp === undefined || row.mrp === null
      ? null
      : readMoney(row.mrp, `${label}.mrp`, issues);
  if (price !== null && mrp !== null && mrp < price) {
    issues.push(`${label}.mrp must be at least the price, or left out.`);
  }
  return { label: sizeLabel, price: price ?? 0, mrp };
}

function readMoney(
  value: unknown,
  label: string,
  issues: string[],
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${label} must be a number of rupees, such as 499.`);
    return null;
  }
  if (value <= 0) {
    issues.push(`${label} must be more than 0.`);
    return null;
  }
  if (value > L.maxPrice) {
    issues.push(`${label} must be ${rupees(L.maxPrice)} or less.`);
    return null;
  }
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    issues.push(`${label} can have at most two decimal places.`);
    return null;
  }
  return value;
}

function readPhotoUrl(
  value: unknown,
  label: string,
  issues: string[],
): string | null {
  if (value === undefined || value === null) return null;
  const message = `${label} must be the https address of a photo the merchant attached in this chat, or null.`;
  if (typeof value !== "string") {
    issues.push(message);
    return null;
  }
  const url = value.trim();
  if (!url) return null;
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (
    !parsed ||
    url.length > L.photoUrl ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password
  ) {
    issues.push(message);
    return null;
  }
  return url;
}

function readCategorySlug(
  value: unknown,
  label: string,
  issues: string[],
): string | null {
  if (value === undefined || value === null) return null;
  const message = `${label} must be a category slug such as "mens-shoes", or null.`;
  if (typeof value !== "string") {
    issues.push(message);
    return null;
  }
  const slug = value.normalize("NFKC").trim().toLowerCase();
  if (!slug) return null;
  if (slug.length > L.categorySlug || !SLUG.test(slug)) {
    issues.push(message);
    return null;
  }
  return slug;
}

/**
 * ★ The v1 reader holds the category rules (confirmed changes only, real
 *   slugs, a create needs a name), so it is asked with a placeholder brief
 *   that passes on its own: every issue it reports is about the categories.
 */
const CATEGORY_PLACEHOLDER = {
  brief: { what_you_sell: "the store", look_and_feel: "the look" },
  explanation: "category changes",
  unpublish_sample_products: false,
} as const;

function readCategories(
  raw: unknown,
  issues: string[],
): PersonalizationCategoryChange[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push(
      "categories must be a list of the changes the merchant agreed to, or left out.",
    );
    return [];
  }
  if (raw.length > REVAMP_LIMITS.maxCategoryChanges) {
    issues.push(
      `categories holds at most ${REVAMP_LIMITS.maxCategoryChanges} changes.`,
    );
    return [];
  }
  const read = readPersonalizationRequest({
    ...CATEGORY_PLACEHOLDER,
    categories: raw,
  });
  if (!read.ok) {
    issues.push(...read.issues);
    return [];
  }
  return read.value.categories;
}

function categoryToWire(
  change: PersonalizationCategoryChange,
): Record<string, unknown> {
  // ★ The parent's changes were confirmed when it was asked for, so they are
  //   carried as confirmed; a refinement never invents a new one.
  if (change.action === "hide") {
    return { action: "hide", slug: change.slug, merchant_confirmed: true };
  }
  return {
    action: change.action,
    ...(change.slug ? { slug: change.slug } : {}),
    ...(change.name ? { name: change.name } : {}),
    ...(change.description ? { description: change.description } : {}),
    new_photo: change.newPhoto,
    merchant_confirmed: true,
  };
}

function readPageList(
  raw: unknown,
  label: string,
  issues: string[],
): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    issues.push(
      `${label} must be a list of page slugs, or null for the default set.`,
    );
    return null;
  }
  const pages: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== "string") {
      issues.push(`${label}[${index}] must be a page slug.`);
      return;
    }
    // ★ "" (or "/") is the homepage, the same sentinel the Website Builder uses.
    const slug = entry
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/^\/+|\/+$/g, "");
    if (slug && (slug.length > L.pageSlug || !SLUG.test(slug))) {
      issues.push(
        `${label}[${index}] is not a page slug: use one from the store context, such as "about".`,
      );
      return;
    }
    if (REVAMP_SKIPPED_SLUGS.has(slug)) {
      issues.push(
        `${label}[${index}] is the merchant's legal text, which a redesign never changes: leave it out.`,
      );
      return;
    }
    if (!pages.includes(slug)) pages.push(slug);
  });
  if (raw.length === 0) {
    issues.push(
      `${label} must name at least one page, or be null for the default set.`,
    );
  }
  if (pages.length > REVAMP_LIMITS.maxPages) {
    issues.push(`${label} lists at most ${REVAMP_LIMITS.maxPages} pages.`);
  }
  return pages.slice(0, REVAMP_LIMITS.maxPages);
}

const EMPTY_SCOPE: RevampRefineScope = {
  design: false,
  copy: false,
  layout: false,
  photos: null,
  pages: null,
  products: false,
};

function readRefineScope(raw: unknown, issues: string[]): RevampRefineScope {
  const row = asRecord(raw);
  if (!row) {
    issues.push(
      "refine_scope is required: say what may change (design, copy, layout, photos or products).",
    );
    return { ...EMPTY_SCOPE };
  }
  const flag = (key: string): boolean => {
    const value = row[key];
    if (value === undefined || value === null) return false;
    if (typeof value !== "boolean") {
      issues.push(`refine_scope.${key} must be true or false.`);
      return false;
    }
    return value;
  };
  const scope: RevampRefineScope = {
    design: flag("design"),
    copy: flag("copy"),
    layout: flag("layout"),
    photos: readPhotoScope(row.photos, issues),
    pages: readPageList(row.pages, "refine_scope.pages", issues),
    products: flag("products"),
  };
  if (
    !scope.design &&
    !scope.copy &&
    !scope.layout &&
    !scope.products &&
    scope.photos === null
  ) {
    issues.push(
      "refine_scope must change something: set design, copy, layout or products to true, or name the photos to redraw.",
    );
  }
  return scope;
}

function readPhotoScope(
  raw: unknown,
  issues: string[],
): string[] | "all" | null {
  if (raw === undefined || raw === null) return null;
  const message = `refine_scope.photos must be "all", a list of photo ids from the redesign card, or null.`;
  if (typeof raw === "string") {
    if (raw.trim().toLowerCase() === "all") return "all";
    issues.push(message);
    return null;
  }
  if (!Array.isArray(raw)) {
    issues.push(message);
    return null;
  }
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      issues.push(message);
      return null;
    }
    const id = entry.normalize("NFKC").trim();
    if (!id) continue;
    if (id.toLowerCase() === "all") return "all";
    if (id.length > L.shotId) {
      issues.push(message);
      return null;
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > REVAMP_LIMITS.maxShots) {
    issues.push(
      `refine_scope.photos names at most ${REVAMP_LIMITS.maxShots} photos.`,
    );
    return null;
  }
  return ids.length ? ids : null;
}

/**
 * NFKC, trimmed, bounded. `min` above 0 makes the field required; the issue
 * then asks the model to find out rather than to guess.
 */
function text(
  value: unknown,
  label: string,
  max: number,
  issues: string[],
  min = 0,
): string {
  if (value !== undefined && value !== null && typeof value !== "string") {
    issues.push(`${label} must be text.`);
    return "";
  }
  const clean = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (min > 0 && clean.length === 0) {
    issues.push(`${label} is required: ask the merchant if you do not know.`);
  } else if (clean.length < min) {
    issues.push(`${label} must be at least ${min} characters.`);
  }
  if (clean.length > max) {
    issues.push(`${label} must be ${max} characters or fewer.`);
  }
  return clean.slice(0, max);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rupees(value: number): string {
  return `₹${new Intl.NumberFormat("en-IN").format(value)}`;
}
