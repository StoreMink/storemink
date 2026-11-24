/**
 * A random (v4) UUID that works on every page, secure or not.
 *
 * `crypto.randomUUID()` exists only in a secure context (https, or plain
 * `localhost`). Local development runs stores on `http://{slug}.localtest.me`,
 * which is not one, so calling it there throws "crypto.randomUUID is not a
 * function" and takes the page down. `getRandomValues` exists everywhere, so
 * this falls back to building the same v4 UUID from it.
 *
 * Where `crypto` is missing altogether (an old embedded WebView, a stubbed
 * test global) the bytes come from `Math.random`, so a caller never throws
 * over an id. That last case is not cryptographically strong, so this is for
 * ids and idempotency keys, where uniqueness is enough. A value that must not
 * be guessable (a token that stops or authenticates something) uses
 * randomUuidStrict(), which throws rather than fall back to `Math.random`.
 *
 * Browser code calls this, never `crypto.randomUUID` in any form
 * (random-uuid-coverage.test.ts). Server code may call either: Node always
 * has `crypto.randomUUID`.
 *
 * Pure and client-safe: no imports.
 */
export function randomUuid(): string {
  return build(false);
}

/**
 * The same v4 UUID, for a value that must not be guessable: it never falls
 * back to `Math.random` and throws where `crypto.getRandomValues` is missing
 * (no browser StoreMink supports lacks it, plain http included).
 */
export function randomUuidStrict(): string {
  return build(true);
}

function build(strict: boolean): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // Some browsers throw here rather than leave it undefined.
    }
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else if (strict) {
    throw new Error("crypto.getRandomValues is unavailable");
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
