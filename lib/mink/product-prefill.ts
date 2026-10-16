/**
 * A product form filled in by Mink, carried across one client navigation.
 *
 * ★ SESSION STORAGE, NOT THE URL. A description runs to thousands of
 * characters, which has no business in an address bar, and the fields never
 * leave this browser tab: Mink writes them when it opens the product form
 * and the form consumes and clears them on its first render. Nothing here is
 * trusted: the form validates every field as if the merchant typed it, and
 * the save goes through the ordinary product action.
 *
 * ★ CLIENT-SAFE AND PURE apart from the two storage helpers, which degrade
 * to a no-op where storage is unavailable (a private window, a kiosk).
 */
export const MINK_PRODUCT_PREFILL_KEY = "storemink:mink-prefill:product";
export const MINK_PRODUCT_PREFILL_PARAM = "prefill";
export const MINK_PRODUCT_PREFILL_VALUE = "mink";

export interface MinkProductPrefill {
  name?: string;
  description?: string;
  seoTitle?: string;
  seoDescription?: string;
  basePrice?: number;
  sellingPrice?: number;
}

const LIMITS = {
  name: 200,
  description: 3_000,
  seoTitle: 70,
  seoDescription: 180,
} as const;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function money(value: unknown): number | undefined {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(number) || number < 0 || number > 10_000_000) {
    return undefined;
  }
  return Math.round(number * 100) / 100;
}

/** Keep only the fields the form has, each bounded; null when none survive. */
export function readMinkProductPrefill(
  value: unknown,
): MinkProductPrefill | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const prefill: MinkProductPrefill = {};
  const name = text(row.name, LIMITS.name);
  const description = text(row.description, LIMITS.description);
  const seoTitle = text(row.seoTitle ?? row.seo_title, LIMITS.seoTitle);
  const seoDescription = text(
    row.seoDescription ?? row.seo_description,
    LIMITS.seoDescription,
  );
  const basePrice = money(row.basePrice ?? row.base_price);
  const sellingPrice = money(row.sellingPrice ?? row.selling_price);
  if (name) prefill.name = name;
  if (description) prefill.description = description;
  if (seoTitle) prefill.seoTitle = seoTitle;
  if (seoDescription) prefill.seoDescription = seoDescription;
  if (basePrice !== undefined) prefill.basePrice = basePrice;
  if (sellingPrice !== undefined) prefill.sellingPrice = sellingPrice;
  return Object.keys(prefill).length ? prefill : null;
}

/** The path the form opens at when a prefill is waiting. */
export function minkProductPrefillPath(): string {
  return `/dashboard/products/new?${MINK_PRODUCT_PREFILL_PARAM}=${MINK_PRODUCT_PREFILL_VALUE}`;
}

export function storeMinkProductPrefill(prefill: MinkProductPrefill): boolean {
  try {
    window.sessionStorage.setItem(
      MINK_PRODUCT_PREFILL_KEY,
      JSON.stringify(prefill),
    );
    return true;
  } catch {
    return false;
  }
}

/** Read AND clear, so a reload of the form starts blank like any other. */
export function takeMinkProductPrefill(): MinkProductPrefill | null {
  try {
    const raw = window.sessionStorage.getItem(MINK_PRODUCT_PREFILL_KEY);
    if (raw === null) return null;
    window.sessionStorage.removeItem(MINK_PRODUCT_PREFILL_KEY);
    return readMinkProductPrefill(JSON.parse(raw));
  } catch {
    return null;
  }
}
