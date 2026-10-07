import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// The storefront password grant.
//
// A store that has not opened yet (lib/store/launch-state.ts →
// isStorefrontGated) shows visitors a password page. Entering the right
// password mints this grant into a host-only, httpOnly cookie, and the gate
// (lib/store/storefront-access.ts) accepts the cookie instead of asking again.
//
// ★ BOUND TO ONE STORE AND ONE PASSWORD VERSION. The cookie carries the store
// id and the `password_version` the password had when it was entered;
// regenerating the password bumps the version and every grant minted against
// the old one stops working on the next request. A grant for one store opens
// nothing on another store's host, even though both cookies share a name.
//
// ★ ITS OWN KEY. STOREFRONT_PASSWORD_SECRET when set; otherwise a key DERIVED
// from CRON_SECRET with a purpose label, so a storefront grant can never be
// replayed as anything CRON_SECRET or another derived key authenticates. The
// same construction lib/theme-studio/preview-token.ts uses, for the same
// reason.
//
// ★ A grant is necessary, never sufficient on its own: the gate also re-reads
// the store's current password version, so this file verifies SHAPE and
// SIGNATURE and leaves "is this version still current" to the caller.
// ---------------------------------------------------------------------------

export const STOREFRONT_GRANT_COOKIE = "sm_store_pass";
/** A week: long enough that a merchant's reviewer is not asked every day,
 *  short enough that a leaked cookie on a shared laptop lapses on its own. */
export const STOREFRONT_GRANT_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface StorefrontGrantClaims {
  t: "storefront-pass";
  /** Store id. */
  sid: string;
  /** The password_version the password had when this grant was issued. */
  v: number;
  exp: number;
}

function signingKey(): string | null {
  const explicit = process.env.STOREFRONT_PASSWORD_SECRET;
  if (explicit) return explicit;
  const cron = process.env.CRON_SECRET;
  if (!cron) return null;
  return createHmac("sha256", cron)
    .update("storemink:storefront-password:v1")
    .digest("base64url");
}

export function storefrontGrantsConfigured(): boolean {
  return signingKey() !== null;
}

function mac(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function signStorefrontGrant(
  claims: { storeId: string; version: number },
  now: number = Date.now(),
  ttlSeconds: number = STOREFRONT_GRANT_TTL_SECONDS,
): string {
  const key = signingKey();
  if (!key)
    throw new Error("No storefront password signing key is configured.");
  const body: StorefrontGrantClaims = {
    t: "storefront-pass",
    sid: claims.storeId,
    v: claims.version,
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${mac(payload, key)}`;
}

/** Null on a bad signature, the wrong type, a malformed claim or expiry. */
export function verifyStorefrontGrant(
  token: string | null | undefined,
  now: number = Date.now(),
): StorefrontGrantClaims | null {
  if (!token || typeof token !== "string" || token.length > 1024) return null;
  const key = signingKey();
  if (!key) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(payload, key));
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims || claims.t !== "storefront-pass") return null;
  if (
    typeof claims.sid !== "string" ||
    typeof claims.v !== "number" ||
    !Number.isInteger(claims.v) ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (claims.exp * 1000 <= now) return null;
  return claims as unknown as StorefrontGrantClaims;
}

// Lowercase letters and digits with the look-alikes removed (no 0/o, 1/l/i).
// A password that is read out over the phone or copied off a screen must not
// have two characters that look the same — the Crockford reasoning behind
// collection codes (lib/fulfilment/collection-code.ts), applied here.
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const STOREFRONT_PASSWORD_LENGTH = 8;

/** A fresh storefront password. Cryptographically random, never derived from
 *  anything about the store. */
export function generateStorefrontPassword(): string {
  let out = "";
  for (let i = 0; i < STOREFRONT_PASSWORD_LENGTH; i++) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}

/** Constant-time comparison after the same normalisation the password page
 *  applies to what a visitor typed (trim, lowercase). */
export function storefrontPasswordMatches(
  entered: string | null | undefined,
  stored: string | null | undefined,
): boolean {
  if (!entered || !stored) return false;
  const a = Buffer.from(entered.trim().toLowerCase());
  const b = Buffer.from(stored.trim().toLowerCase());
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
