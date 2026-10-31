import "server-only";

/**
 * The picture a blocked image becomes (takedown design 3.3 step 2, decision
 * D7): a 1200 x 1200 light grey WebP reading "Image not available", served by
 * the app itself from `public/moderation/`, so its own address is never a
 * storage address and a block can never catch it.
 *
 * Three readers share these bytes: every storefront read swaps a blocked
 * address for `PLACEHOLDER_URL_PATH`, the proxy answers a blocked optimizer
 * request with the bytes themselves (`Cache-Control: no-store`), and the
 * every-minute follow-up overwrites a blocked object in the public bucket
 * with them (storage.ts). The file is read once per server bundle and kept;
 * every call gets its own copy, so no caller can change what the next one
 * sends.
 *
 * The asset was rendered once with sharp from an inline SVG (light grey
 * #ECECEC, a slashed picture and the words in #5F5F5F, everything inside the
 * middle band so a wide banner crop, a portrait card crop and a round tile
 * all keep it). It is under 30 KB and has no alpha channel.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** The address pages show instead of a blocked image. */
export const PLACEHOLDER_URL_PATH = "/moderation/image-unavailable.webp";

/** The placeholder's content type. */
export const PLACEHOLDER_CONTENT_TYPE = "image/webp";

/** The placeholder's width and height, in pixels. */
export const PLACEHOLDER_SIZE_PX = 1200;

/** Where the placeholder sits on disk: the app's own `public/` copy. */
export function placeholderFilePath(): string {
  return path.join(
    process.cwd(),
    "public",
    ...PLACEHOLDER_URL_PATH.split("/").filter(Boolean),
  );
}

let reading: Promise<Uint8Array> | null = null;

function loadOnce(): Promise<Uint8Array> {
  if (!reading) {
    const attempt = readFile(placeholderFilePath()).then(
      (buffer) => new Uint8Array(buffer),
    );
    reading = attempt;
    // A failed read is not kept: the next call reads the file again.
    attempt.catch(() => {
      if (reading === attempt) reading = null;
    });
  }
  return reading;
}

/** The placeholder's bytes (a fresh copy on every call). */
export async function placeholderWebp(): Promise<Uint8Array> {
  return new Uint8Array(await loadOnce());
}

/** The placeholder's MD5 in Google's base64 form, as an object's `md5Hash`. */
export async function placeholderMd5(): Promise<string> {
  return createHash("md5")
    .update(await loadOnce())
    .digest("base64");
}
