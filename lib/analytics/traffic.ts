// Storefront traffic attribution: device, source and approximate location.
//
// Pure module (no server imports) so the collection route, the rollup and the
// dashboard share one definition, and tests can pin it.
//
// ★ Privacy contract (migration 0187, the storefront analytics Help guide):
// only DERIVED values are kept. The user agent becomes a device type and is
// dropped; a referring URL becomes its host name; location is whatever the
// load balancer reports for the connection (country, subdivision, city). No
// IP address is read here or stored anywhere.

export const TRAFFIC_SOURCES = [
  "direct",
  "search",
  "social",
  "email",
  "paid",
  "referral",
] as const;
export type TrafficSource = (typeof TRAFFIC_SOURCES)[number];

export const TRAFFIC_SOURCE_LABELS: Record<TrafficSource, string> = {
  direct: "Direct",
  search: "Search",
  social: "Social",
  email: "Email",
  paid: "Paid",
  referral: "Referral",
};

export type DeviceType = "desktop" | "mobile" | "tablet";

export const DEVICE_LABELS: Record<DeviceType, string> = {
  desktop: "Desktop",
  mobile: "Mobile",
  tablet: "Tablet",
};

/** Tablet before mobile: iPad and Android tablets would otherwise match both. */
export function deviceTypeFromUserAgent(userAgent: string): DeviceType {
  const ua = userAgent.toLowerCase();
  if (
    /ipad|tablet|kindle|silk|playbook|nexus (7|9|10)|sm-t\d/.test(ua) ||
    (/android/.test(ua) && !/mobile/.test(ua))
  ) {
    return "tablet";
  }
  if (/mobi|iphone|ipod|android|windows phone|blackberry|opera mini/.test(ua)) {
    return "mobile";
  }
  return "desktop";
}

function bareHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^(www|m|l|lm|mobile)\./, "");
}

/**
 * The referring site's host, or null when there is none worth keeping: no
 * referrer, not http(s), unparsable, or the store itself (internal navigation
 * and the checkout redirect back are not traffic sources).
 */
export function referrerHostFrom(
  referrer: unknown,
  ownHost: string,
): string | null {
  if (typeof referrer !== "string" || !referrer || referrer.length > 2048) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = bareHost(url.hostname);
  const own = bareHost(ownHost.split(":")[0] ?? "");
  if (!host || host === own) return null;
  return host.slice(0, 255);
}

/** A campaign tag as the merchant typed it, trimmed and bounded. */
export function cleanUtm(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 100);
  return clean || null;
}

const SEARCH_HOSTS =
  /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.[a-z.]+|yandex\.[a-z.]+|baidu\.com|ecosia\.org|search\.brave\.com|startpage\.com|naver\.com|qwant\.com)$/;
const SOCIAL_HOSTS =
  /(^|\.)(instagram\.com|facebook\.com|fb\.com|fb\.me|messenger\.com|t\.co|twitter\.com|x\.com|linkedin\.com|lnkd\.in|pinterest\.[a-z.]+|pin\.it|youtube\.com|youtu\.be|whatsapp\.com|wa\.me|snapchat\.com|reddit\.com|threads\.net|telegram\.org|t\.me|quora\.com|sharechat\.com|tiktok\.com)$/;
const EMAIL_HOSTS =
  /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|mail\.yahoo\.com|mail\.zoho\.[a-z.]+|mail\.proton\.me)$/;
const SOCIAL_UTM =
  /^(instagram|ig|facebook|fb|meta|twitter|x|linkedin|pinterest|youtube|whatsapp|wa|snapchat|reddit|threads|telegram|tiktok)$/i;
const PAID_MEDIUM =
  /^(cpc|ppc|paid|paidsearch|paid_search|paidsocial|paid_social|paid-social|display|cpm|cpv|ads?|banner|retargeting)$/i;

/**
 * Shopify-style channel for a session, from the first event's referrer and
 * campaign tags. Explicit tags win over the referrer, because a merchant
 * tagging a link is telling us what it is.
 */
export function classifyTrafficSource(input: {
  referrerHost: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  paidClickId?: boolean;
}): TrafficSource {
  const medium = input.utmMedium?.toLowerCase() ?? "";
  const source = input.utmSource?.toLowerCase() ?? "";
  if (input.paidClickId || PAID_MEDIUM.test(medium)) return "paid";
  if (medium === "email" || medium === "e-mail" || /newsletter/.test(source)) {
    return "email";
  }
  if (
    medium === "social" ||
    medium === "social-media" ||
    SOCIAL_UTM.test(source)
  ) {
    return "social";
  }
  if (medium === "organic" || /^(google|bing)$/.test(source)) return "search";
  const host = input.referrerHost ?? "";
  if (host) {
    if (EMAIL_HOSTS.test(host)) return "email";
    if (SEARCH_HOSTS.test(host)) return "search";
    if (SOCIAL_HOSTS.test(host)) return "social";
    return "referral";
  }
  if (source || medium) return "referral";
  return "direct";
}

// ---------------------------------------------------------------------------
// Approximate location from the load balancer
// ---------------------------------------------------------------------------
//
// The external Application Load Balancer adds these request headers when the
// backend service is configured with custom request headers (see CODEBASE.md
// "Storefront traffic"). Until then they are absent and location stays null.
// They are only trusted for analytics: a spoofed value can at worst mislabel
// that one visitor's own session.

export const GEO_HEADERS = {
  country: "x-sm-geo-country",
  region: "x-sm-geo-region",
  city: "x-sm-geo-city",
} as const;

export interface TrafficGeo {
  country: string | null;
  region: string | null;
  city: string | null;
}

export function geoFromHeaders(headers: Headers): TrafficGeo {
  const country = headers.get(GEO_HEADERS.country)?.trim().toUpperCase() ?? "";
  const validCountry = /^[A-Z]{2}$/.test(country) && country !== "ZZ";
  // Subdivision arrives as the country code followed by the ISO 3166-2 code
  // (e.g. "INMH"); keep only the subdivision part.
  const rawRegion = headers.get(GEO_HEADERS.region)?.trim().toUpperCase() ?? "";
  const region =
    validCountry && rawRegion.startsWith(country)
      ? rawRegion.slice(country.length)
      : rawRegion;
  let city = headers.get(GEO_HEADERS.city)?.trim() ?? "";
  try {
    city = decodeURIComponent(city);
  } catch {
    // Leave it as sent.
  }
  city = city.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100);
  return {
    country: validCountry ? country : null,
    region: validCountry && /^[A-Z0-9]{1,8}$/.test(region) ? region : null,
    city: validCountry && city && city !== "?" ? city : null,
  };
}

const INDIA_STATES: Record<string, string> = {
  AN: "Andaman and Nicobar Islands",
  AP: "Andhra Pradesh",
  AR: "Arunachal Pradesh",
  AS: "Assam",
  BR: "Bihar",
  CH: "Chandigarh",
  CT: "Chhattisgarh",
  CG: "Chhattisgarh",
  DH: "Dadra and Nagar Haveli and Daman and Diu",
  DN: "Dadra and Nagar Haveli and Daman and Diu",
  DL: "Delhi",
  GA: "Goa",
  GJ: "Gujarat",
  HR: "Haryana",
  HP: "Himachal Pradesh",
  JK: "Jammu and Kashmir",
  JH: "Jharkhand",
  KA: "Karnataka",
  KL: "Kerala",
  LA: "Ladakh",
  LD: "Lakshadweep",
  MP: "Madhya Pradesh",
  MH: "Maharashtra",
  MN: "Manipur",
  ML: "Meghalaya",
  MZ: "Mizoram",
  NL: "Nagaland",
  OR: "Odisha",
  OD: "Odisha",
  PY: "Puducherry",
  PB: "Punjab",
  RJ: "Rajasthan",
  SK: "Sikkim",
  TN: "Tamil Nadu",
  TG: "Telangana",
  TS: "Telangana",
  TR: "Tripura",
  UP: "Uttar Pradesh",
  UT: "Uttarakhand",
  UK: "Uttarakhand",
  WB: "West Bengal",
};

export function countryDisplayName(country: string): string {
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "region" }).of(country) ?? country
    );
  } catch {
    return country;
  }
}

/** "MH" in India reads "Maharashtra"; elsewhere the code plus country. */
export function regionDisplayName(country: string, region: string): string {
  if (country === "IN" && INDIA_STATES[region]) return INDIA_STATES[region];
  return `${region}, ${countryDisplayName(country)}`;
}
