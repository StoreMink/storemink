/**
 * A random (v4) UUID that works on every page, secure or not.
 *
 * `crypto.randomUUID()` exists only in a secure context (https, or plain
 * `localhost`). Local development runs stores on `http://{slug}.localtest.me`,
 * which is not one, so calling it there throws "crypto.randomUUID is not a
 * function" and takes the page down. `getRandomValues` exists everywhere, so
 * this falls back to building the same v4 UUID from it.
 *
 * Browser code calls this, never `crypto.randomUUID()` directly
 * (random-uuid-coverage.test.ts). Server code may call either: Node always
 * has `crypto.randomUUID`.
 *
 * Pure and client-safe: no imports.
 */
export function randomUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
