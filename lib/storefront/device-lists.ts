// ---------------------------------------------------------------------------
// Product lists kept ON THE SHOPPER'S DEVICE: the wishlist ("Saved items") and
// the products they looked at ("Recently viewed"). Owner, 22 Nov 2026: the
// saved list lives on the device, so saving needs no account and nothing
// about a shopper's browsing is kept on a server. To draw the cards the
// slugs are sent in a request BODY (POST /api/storefront/products), which is
// read once and written to no table and no log.
//
// ★ THE BROWSER'S OWN STORAGE SCOPES IT TO THE STORE. Every store is its own
//   origin (a subdomain or a custom domain) and localStorage is per origin,
//   so one store can never read another's list and no store id is needed.
// ★ A LIST IS PRODUCT SLUGS, nothing else: no name, price or picture is kept,
//   so what a shopper sees is always today's product (or nothing, when it is
//   no longer sold), read through /api/storefront/products.
// ★ STORAGE CAN BE MISSING OR FULL (a private window, blocked site data):
//   every read and write is guarded, and a list that cannot be kept is simply
//   empty. Nothing here ever throws.
// Client-safe: no server import. `useSyncExternalStore` readers get the same
// (frozen) array until the list changes.
// ---------------------------------------------------------------------------

export type DeviceList = "wishlist" | "recent";

export const DEVICE_LIST_MAX: Record<DeviceList, number> = {
  wishlist: 60,
  // Twelve is one more than a row shows after the current product is left out.
  recent: 12,
};

const KEYS: Record<DeviceList, string> = {
  wishlist: "sm:saved-products",
  recent: "sm:recent-products",
};
const CHANGE_EVENT = "sm:device-list";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A product slug as the storefront writes them, or null. */
export function cleanSlug(value: unknown): string | null {
  return typeof value === "string" && value.length <= 120 && SLUG.test(value)
    ? value
    : null;
}

/** A stored value as a list: slugs only, no repeats, bounded. */
export function parseDeviceList(raw: unknown, list: DeviceList): string[] {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const item of parsed) {
    const slug = cleanSlug(item);
    if (slug && !out.includes(slug)) out.push(slug);
    if (out.length >= DEVICE_LIST_MAX[list]) break;
  }
  return out;
}

const EMPTY: readonly string[] = Object.freeze([]);
const cache = new Map<
  DeviceList,
  { raw: string | null; value: readonly string[] }
>();

/** The list as it stands, newest first. The same array until it changes. */
export function readDeviceList(list: DeviceList): readonly string[] {
  if (typeof window === "undefined") return EMPTY;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEYS[list]);
  } catch {
    return EMPTY;
  }
  const cached = cache.get(list);
  if (cached && cached.raw === raw) return cached.value;
  const value = raw ? Object.freeze(parseDeviceList(raw, list)) : EMPTY;
  cache.set(list, { raw, value });
  return value;
}

function writeDeviceList(list: DeviceList, slugs: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    if (slugs.length === 0) window.localStorage.removeItem(KEYS[list]);
    else window.localStorage.setItem(KEYS[list], JSON.stringify(slugs));
  } catch {
    // Storage refused: the list is not kept, and nothing is shown as saved.
    return;
  }
  try {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // An event that cannot be made only costs other open components a refresh.
  }
}

/** Save or remove a product. Returns whether it is saved afterwards. */
export function toggleSaved(slug: string): boolean {
  const clean = cleanSlug(slug);
  if (!clean) return false;
  const current = readDeviceList("wishlist");
  if (current.includes(clean)) {
    writeDeviceList(
      "wishlist",
      current.filter((s) => s !== clean),
    );
    return false;
  }
  writeDeviceList(
    "wishlist",
    [clean, ...current].slice(0, DEVICE_LIST_MAX.wishlist),
  );
  // Read back: storage that refused the write did not save it.
  return readDeviceList("wishlist").includes(clean);
}

/** Note that a product was looked at; it moves to the front. */
export function noteViewed(slug: string): void {
  const clean = cleanSlug(slug);
  if (!clean) return;
  const current = readDeviceList("recent");
  if (current[0] === clean) return;
  writeDeviceList(
    "recent",
    [clean, ...current.filter((s) => s !== clean)].slice(
      0,
      DEVICE_LIST_MAX.recent,
    ),
  );
}

/** Forget a whole list (the saved-items page's "Remove all"). */
export function clearDeviceList(list: DeviceList): void {
  writeDeviceList(list, []);
}

/** For `useSyncExternalStore`: this tab's changes and other tabs' alike. */
export function subscribeDeviceLists(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** What the server renders: nobody's list is known there. */
export function serverDeviceList(): readonly string[] {
  return EMPTY;
}
