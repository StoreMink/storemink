/**
 * Media addresses inside stored rows (takedown design 5.1): finding them in
 * any text (whole strings, nested JSON, HTML `src` and `srcset`, CSS `url()`)
 * and turning them into keys through `mediaKeyFromUrl`. Used by the block
 * form's image list, the archive's file list and the storefront page swap.
 *
 * `MEDIA_URL_RE` is the store purge's own pattern, moved here from
 * `app/actions/platform.ts` (stage T17 imports it there) exactly as that
 * file has it, comment included.
 *
 * PURE and client-safe: no server import, no network.
 */

import {
  isMediaKey,
  mediaKeyFromUrl,
  type MediaKey,
  type MediaKeyConfig,
} from "./media-key";

// Any media public URL in Google Cloud Storage (storage.googleapis.com/<bucket>/…).
// Historical GCS media was not always store-prefixed, so scrape every URL from
// the store's rows before they cascade; deleteStorageUrls deletes what is in
// our bucket and counts the rest for the operator. A URL ends at a backslash:
// the rows are scanned as JSON, which writes an HTML attribute's quote as \"
// and a newline as \n, and URL parsing would read that backslash as a slash
// and ask to delete `<path>/`, an object that never exists.
export const MEDIA_URL_RE =
  /https?:\/\/[^"'\s)\\]*storage\.googleapis\.com\/[^/"'\s)\\]+\/[^"'\s)\\]+/g;

/** One address found in a text, with where it sits. */
export type FoundAddress = {
  /** The address exactly as written (trailing punctuation trimmed). */
  address: string;
  /** Where it starts in the text. */
  start: number;
  /** Where it ends (exclusive). */
  end: number;
  /**
   * Whether it is the value of an image attribute (`src`, `srcset`,
   * `poster`, `data-src`, `data-srcset`) or of a CSS `url()`.
   */
  inMarkup: boolean;
};

/** What can start an address: a scheme, `//`, or one of three site paths. */
const CANDIDATE_SOURCE =
  /https?:\/\/|\/\/|\/(?:_next\/image\?|api\/og-image\?|themes\/)/.source;

/** What ends an address. */
const ADDRESS_END = /[\s"'<>()\\`{}|^]/;

/** What may come right before a relative or protocol-relative address. */
const TOKEN_START = /[\s"'`=(,>]/;

/** HTML character references that stand for a quote or a bracket. */
const ENTITY_CUT = /&(?:quot|apos|lt|gt|#34|#39|#x22|#x27);/i;

const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

const IMAGE_ATTRIBUTE =
  /\b(?:data-)?(?:srcset|src|poster)\s*=\s*(?:\\?["'][^"'<>]*)?$/i;

const CSS_URL = /url\(\s*(?:\\?["'])?\s*$/i;

/** How far back to look for the attribute an address belongs to. */
const MARKUP_LOOKBACK = 2048;

/**
 * Whether a text could hold a media address at all: a cheap test to run
 * before `findAddresses` on every string of a large row.
 */
export function mightHoldMediaAddress(text: string): boolean {
  return (
    text.includes("//") ||
    text.includes("/themes/") ||
    text.includes("/_next/image") ||
    text.includes("/api/og-image")
  );
}

function startsToken(text: string, index: number): boolean {
  return index === 0 || TOKEN_START.test(text[index - 1]);
}

function inMarkupAt(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - MARKUP_LOOKBACK), start);
  return CSS_URL.test(before) || IMAGE_ATTRIBUTE.test(before);
}

/**
 * Every address in a text, in order: `https://` and `http://` anywhere,
 * `//host` and the site paths `/_next/image?`, `/api/og-image?` and
 * `/themes/` only where a new value starts (the text's start, a space, a
 * quote, `=`, `(`, `,` or `>`). An address ends at a space, a quote, an
 * angle bracket, a parenthesis, a backslash (a JSON escape), a backtick,
 * `{`, `}`, `|` or `^`, and at an HTML reference for a quote or a bracket;
 * trailing `.`, `,`, `;`, `:`, `!` and `?` are not part of it.
 */
export function findAddresses(text: string): FoundAddress[] {
  const found: FoundAddress[] = [];
  if (typeof text !== "string" || !mightHoldMediaAddress(text)) return found;
  const candidates = new RegExp(CANDIDATE_SOURCE, "gi");
  let match: RegExpExecArray | null;
  while ((match = candidates.exec(text)) !== null) {
    const start = match.index;
    const opener = match[0];
    const hasScheme = /^https?:/i.test(opener);
    if (!hasScheme && !startsToken(text, start)) continue;
    let end = start + opener.length;
    while (end < text.length && !ADDRESS_END.test(text[end])) end += 1;
    let address = text.slice(start, end);
    const entity = ENTITY_CUT.exec(address);
    if (entity) address = address.slice(0, entity.index);
    address = address.replace(TRAILING_PUNCTUATION, "");
    end = start + address.length;
    candidates.lastIndex = Math.max(candidates.lastIndex, end);
    if (address.length <= opener.length) continue;
    found.push({ address, start, end, inMarkup: inMarkupAt(text, start) });
  }
  return found;
}

/** File endings that make an outside address a picture, a video or a PDF. */
const MEDIA_ENDING =
  /\.(?:jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?|heic|mp4|webm|mov|pdf)$/i;

/** Outside hosts whose addresses are pictures whatever their path says. */
const IMAGE_HOSTS = ["https://images.unsplash.com/"];

function looksLikeMedia(externalKey: string): boolean {
  return (
    IMAGE_HOSTS.some((prefix) => externalKey.startsWith(prefix)) ||
    MEDIA_ENDING.test(externalKey)
  );
}

/**
 * The media keys a stored row refers to, first-seen order, each once. The row
 * may be any value: objects and arrays are walked (a value met twice is
 * walked once), strings are searched with `findAddresses`. Bucket and bundled
 * addresses always count. An outside (`external`) address counts only where
 * it is clearly media: an image attribute or a CSS `url()`, a path ending in
 * a picture, video or PDF type, or `images.unsplash.com`; a link to someone's
 * shop page is not a picture of the store's. Addresses that cannot be read
 * safely are left out (callers that must refuse them use `findAddresses` and
 * `mediaKeyFromUrl` themselves).
 */
export function referencedMediaKeys(
  row: unknown,
  config: MediaKeyConfig,
): MediaKey[] {
  const keys: MediaKey[] = [];
  const seen = new Set<string>();
  const walked = new WeakSet<object>();
  const stack: unknown[] = [row];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      for (const found of findAddresses(value)) {
        const result = mediaKeyFromUrl(found.address, config);
        if (!isMediaKey(result)) continue;
        if (
          result.source === "external" &&
          !found.inMarkup &&
          !looksLikeMedia(result.key)
        ) {
          continue;
        }
        const id = `${result.source} ${result.key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        keys.push(result);
      }
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    if (walked.has(value)) continue;
    walked.add(value);
    const children = Array.isArray(value) ? value : Object.values(value);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return keys;
}
