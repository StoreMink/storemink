/**
 * A dashboard form filled in by Mink, carried across one client navigation.
 *
 * ★ SESSION STORAGE, NOT THE URL. A description runs to thousands of
 * characters, which has no business in an address bar, and the fields never
 * leave this browser tab: Mink writes them when it opens the page and the
 * form consumes and clears them on its first render. Nothing here is
 * trusted: every form validates each field as if the merchant typed it, and
 * the save goes through the ordinary server action.
 *
 * ★ ONE CONTRACT FOR EVERY FORM. The navigation tool, the artifact parser,
 * the artifact card and each editor all read the same `readMinkPrefill`, so
 * a field the tool may send is a field the form knows how to fill, and a
 * bound applied here applies everywhere. Keys are accepted in camelCase and
 * snake_case because the model writes snake_case and the forms camelCase.
 *
 * ★ CLIENT-SAFE AND PURE apart from the storage helpers, which degrade to a
 * no-op where storage is unavailable (a private window, a kiosk).
 */
export const MINK_PREFILL_PARAM = "prefill";
export const MINK_PREFILL_VALUE = "mink";
/** A prefill older than this is stale: the merchant navigated elsewhere. */
export const MINK_PREFILL_TTL_MS = 10 * 60 * 1_000;

export const MINK_PREFILL_KINDS = [
  "product",
  "offer",
  "category",
  "blog",
  "shipping",
] as const;
export type MinkPrefillKind = (typeof MINK_PREFILL_KINDS)[number];

export interface MinkProductPrefill {
  name?: string;
  description?: string;
  seoTitle?: string;
  seoDescription?: string;
  basePrice?: number;
  sellingPrice?: number;
}

export interface MinkOfferPrefill {
  name?: string;
  description?: string;
  rewardType?: "percent_off" | "amount_off" | "free_shipping";
  rewardValue?: number;
  minSubtotal?: number;
  delivery?: "automatic" | "code";
  code?: string;
  budget?: number;
  /** A calendar date, YYYY-MM-DD, in the store's own timezone. */
  validUntil?: string;
}

export interface MinkCategoryPrefill {
  name?: string;
  slug?: string;
  description?: string;
  status?: "active" | "hidden";
}

export interface MinkBlogPrefill {
  title?: string;
  excerpt?: string;
  /** Plain text or Markdown; the editor turns it into paragraphs. */
  body?: string;
  category?: string;
  tags?: string[];
  seoTitle?: string;
  seoDescription?: string;
}

export interface MinkShippingPrefill {
  mode?: "free" | "flat" | "shiprocket";
  flatRate?: number;
  /** Null clears the threshold. */
  freeAbove?: number | null;
  manualMinDays?: number;
  manualMaxDays?: number;
  handlingDays?: number;
}

export type MinkPrefillFields = {
  product: MinkProductPrefill;
  offer: MinkOfferPrefill;
  category: MinkCategoryPrefill;
  blog: MinkBlogPrefill;
  shipping: MinkShippingPrefill;
};

export type MinkFormPrefill = {
  [K in MinkPrefillKind]: { kind: K; fields: MinkPrefillFields[K] };
}[MinkPrefillKind];

/** Where each form lives; the page reads `?prefill=mink` and takes the fields. */
export const MINK_PREFILL_PATHS: Record<MinkPrefillKind, string> = {
  product: "/dashboard/products/new",
  offer: "/dashboard/offers/new",
  category: "/dashboard/categories",
  blog: "/dashboard/blogs",
  shipping: "/dashboard/settings/shipping",
};

export const MINK_PREFILL_LABELS: Record<MinkPrefillKind, string> = {
  product: "the new product form",
  offer: "the new offer form",
  category: "the new category form",
  blog: "the new blog post",
  shipping: "Shipping & delivery settings",
};

export function isMinkPrefillKind(value: unknown): value is MinkPrefillKind {
  return MINK_PREFILL_KINDS.includes(value as MinkPrefillKind);
}

export function minkPrefillPath(kind: MinkPrefillKind): string {
  return `${MINK_PREFILL_PATHS[kind]}?${MINK_PREFILL_PARAM}=${MINK_PREFILL_VALUE}`;
}

export function minkPrefillKey(kind: MinkPrefillKind): string {
  return `storemink:mink-prefill:${kind}`;
}

/** True when the current URL asks a form to take a waiting prefill. */
export function hasMinkPrefillParam(search: string | URLSearchParams): boolean {
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  return params.get(MINK_PREFILL_PARAM) === MINK_PREFILL_VALUE;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function money(value: unknown, max = 10_000_000): number | undefined {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(number) || number < 0 || number > max) return undefined;
  return Math.round(number * 100) / 100;
}

function integer(value: unknown, min: number, max: number): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number < min ||
    number > max
  ) {
    return undefined;
  }
  return number;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  return typeof value === "string" && allowed.includes(value)
    ? (value as T[number])
    : undefined;
}

/**
 * The camelCase key wins when present, even when it holds null: for a
 * nullable field such as shipping's `freeAbove`, null means "clear the
 * threshold", and `??` would drop that on the storage round trip.
 */
function pick(row: Record<string, unknown>, camel: string, snake: string) {
  return camel in row ? row[camel] : row[snake];
}

function defined<T extends object>(fields: T): T | null {
  for (const key of Object.keys(fields) as Array<keyof T>) {
    if (fields[key] === undefined) delete fields[key];
  }
  return Object.keys(fields).length ? fields : null;
}

/** Keep only the fields the form has, each bounded; null when none survive. */
export function readMinkPrefill<K extends MinkPrefillKind>(
  kind: K,
  value: unknown,
): MinkPrefillFields[K] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  switch (kind) {
    case "product":
      return defined<MinkProductPrefill>({
        name: text(row.name, 200),
        description: text(row.description, 3_000),
        seoTitle: text(pick(row, "seoTitle", "seo_title"), 70),
        seoDescription: text(
          pick(row, "seoDescription", "seo_description"),
          180,
        ),
        basePrice: money(pick(row, "basePrice", "base_price")),
        sellingPrice: money(pick(row, "sellingPrice", "selling_price")),
      }) as MinkPrefillFields[K] | null;
    case "offer": {
      const code = text(row.code, 100);
      return defined<MinkOfferPrefill>({
        name: text(row.name, 120),
        description: text(row.description, 500),
        rewardType: oneOf(pick(row, "rewardType", "reward_type"), [
          "percent_off",
          "amount_off",
          "free_shipping",
        ] as const),
        rewardValue: money(pick(row, "rewardValue", "reward_value")),
        minSubtotal: money(pick(row, "minSubtotal", "min_subtotal")),
        delivery: oneOf(row.delivery, ["automatic", "code"] as const),
        code: code ? code.toUpperCase().replace(/\s+/g, "") : undefined,
        budget: money(row.budget),
        validUntil: (() => {
          const raw = text(pick(row, "validUntil", "valid_until"), 10);
          return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
        })(),
      }) as MinkPrefillFields[K] | null;
    }
    case "category":
      return defined<MinkCategoryPrefill>({
        name: text(row.name, 120),
        slug: text(row.slug, 200),
        description: text(row.description, 1_000),
        status: oneOf(row.status, ["active", "hidden"] as const),
      }) as MinkPrefillFields[K] | null;
    case "blog": {
      const rawTags = row.tags;
      const tags = Array.isArray(rawTags)
        ? rawTags
            .map((tag) => text(tag, 40))
            .filter((tag): tag is string => Boolean(tag))
            .slice(0, 10)
        : undefined;
      return defined<MinkBlogPrefill>({
        title: text(row.title, 200),
        excerpt: text(row.excerpt, 500),
        body: text(row.body, 20_000),
        category: text(row.category, 60),
        tags: tags && tags.length ? tags : undefined,
        seoTitle: text(pick(row, "seoTitle", "seo_title"), 70),
        seoDescription: text(
          pick(row, "seoDescription", "seo_description"),
          180,
        ),
      }) as MinkPrefillFields[K] | null;
    }
    case "shipping": {
      const rawFreeAbove = pick(row, "freeAbove", "free_above");
      return defined<MinkShippingPrefill>({
        mode: oneOf(row.mode, ["free", "flat", "shiprocket"] as const),
        flatRate: money(pick(row, "flatRate", "flat_rate"), 100_000),
        freeAbove:
          rawFreeAbove === null ? null : money(rawFreeAbove, 10_000_000),
        manualMinDays: integer(
          pick(row, "manualMinDays", "manual_min_days"),
          0,
          60,
        ),
        manualMaxDays: integer(
          pick(row, "manualMaxDays", "manual_max_days"),
          0,
          60,
        ),
        handlingDays: integer(
          pick(row, "handlingDays", "handling_days"),
          0,
          30,
        ),
      }) as MinkPrefillFields[K] | null;
    }
  }
  return null;
}

/** A `{kind, fields}` pair off the wire, or null. */
export function readMinkFormPrefill(value: unknown): MinkFormPrefill | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!isMinkPrefillKind(row.kind)) return null;
  const fields = readMinkPrefill(row.kind, row.fields);
  return fields ? ({ kind: row.kind, fields } as MinkFormPrefill) : null;
}

export function storeMinkPrefill(prefill: MinkFormPrefill): boolean {
  try {
    window.sessionStorage.setItem(
      minkPrefillKey(prefill.kind),
      JSON.stringify({ savedAt: Date.now(), fields: prefill.fields }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Read AND clear, so a reload of the form starts blank like any other. */
export function takeMinkPrefill<K extends MinkPrefillKind>(
  kind: K,
  now = Date.now(),
): MinkPrefillFields[K] | null {
  try {
    const key = minkPrefillKey(kind);
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return null;
    window.sessionStorage.removeItem(key);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const { savedAt, fields } = parsed as {
      savedAt?: unknown;
      fields?: unknown;
    };
    if (typeof savedAt === "number" && now - savedAt > MINK_PREFILL_TTL_MS) {
      return null;
    }
    // A product prefill stored by the older helper has no envelope.
    return readMinkPrefill(kind, fields === undefined ? parsed : fields);
  } catch {
    return null;
  }
}
