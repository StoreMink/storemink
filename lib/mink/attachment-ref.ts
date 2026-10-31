// ---------------------------------------------------------------------------
// The address of a Mink chat attachment, and how it is found and rewritten.
//
// A picture attached to a Mink chat is kept PRIVATELY (lib/mink/attachments.ts,
// the private bucket) and reaches the chat, the model and the tools only as
// `/api/mink/attachments/{id}`. This module is the client-safe vocabulary for
// that address (no server imports: the composer, the chat bubble, the tool
// registry and the contract all read it), the lib/logs/failure-types.ts split.
//
// ★ IDS ARE MATCHED WHOLE. The model may hand an address back with a host in
// front of it ("https://echoss.storemink.com/api/mink/attachments/<id>"), so
// a reference is the path with any host, and the id is a complete UUID: a
// longer hex run is never cut down to one, because the id is what a tool
// promotes and a wrong id is somebody else's picture.
//
// ★★ WHAT COUNTS AS AN ADDRESS IS STRICT, AND EVERYTHING ELSE FAILS CLOSED
// (review R7 and S6). An address is `/api/mink/attachments/<uuid>`, any case,
// with or without `http(s)://host[:port]` in front, anywhere inside a string.
// `scanMinkAttachmentValue` reads every string and every object key of a tool's
// arguments, and a string that is a JSON object or array is parsed and read as
// JSON. It reports a PROBLEM, which `minkAttachmentIdsInValue` turns into the
// refusal `MINK_ATTACHMENT_ONLY_AS_A_PICTURE`, never a pass:
//   - "disguised": the same address hidden by a decoding a later step might
//     apply (percent-encoding, JSON or JavaScript escapes, HTML character
//     references, a backslash for a slash, doubled slashes, a missing leading
//     slash), so a tool that decodes its argument after the registry's check
//     can never hold an address the check did not see;
//   - "key": an address used as an object key (nothing rewrites keys);
//   - "limit": the walk stopped (deeper than 8, more than 2,000 strings) and
//     the whole value, read as text, still holds an address in any form.
// Not covered: encodings no tool applies (base64, look-alike slash characters).
//
// ★ THE REWRITE NEVER MUTATES ITS INPUT. The orchestrator's memo and the run
// log keep the model's own arguments, so `rewriteMinkAttachmentRefs` returns a
// NEW value and leaves the original as it was.
// ---------------------------------------------------------------------------

import { MinkToolInputError } from "./errors";

/**
 * The registry's refusal (design 5.7): an address outside a picture argument,
 * in a tool with none, or in a form the scan cannot vouch for.
 * lib/mink/attachments.ts re-exports it under the same name.
 */
export const MINK_ATTACHMENT_ONLY_AS_A_PICTURE =
  "An attached image can be used only as a picture in the store, such as a product photo, a page section, a category image or a blog cover. Leave its address out of this request.";

/** The path every attachment address starts with, host or no host. */
export const MINK_ATTACHMENT_PATH = "/api/mink/attachments/";

/** How deep `scanMinkAttachmentValue` and the rewrite walk an argument. */
export const MINK_ATTACHMENT_WALK_DEPTH = 8;

/** How many strings (and keys) those walks read before they stop. */
export const MINK_ATTACHMENT_WALK_STRINGS = 2_000;

const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

// The model may add a host; ids are matched whole (a hex character or a dash
// right after the id means a longer run, not an id).
const REF_SOURCE = `(?:https?://[a-z0-9.-]+(?::\\d+)?)?${MINK_ATTACHMENT_PATH}(${UUID})(?![0-9a-f-])`;

/** A fresh global matcher per call: a shared one would carry `lastIndex`. */
function refMatcher(): RegExp {
  return new RegExp(REF_SOURCE, "gi");
}

const WHOLE_REF = new RegExp(`^${REF_SOURCE}$`, "i");

/** The address of one attachment: "/api/mink/attachments/<id>". */
export function minkAttachmentUrl(id: string): string {
  return `${MINK_ATTACHMENT_PATH}${id}`;
}

/**
 * The id when the WHOLE value is an attachment address (the bare path, or the
 * path with any host), lower-cased; null for anything else, a longer value
 * with an address inside it included.
 */
export function minkAttachmentIdOf(value: string): string | null {
  if (typeof value !== "string") return null;
  const match = WHOLE_REF.exec(value);
  return match ? match[1].toLowerCase() : null;
}

/** Every attachment id in a text, unique and lower-cased, at most `max`. */
export function minkAttachmentIdsIn(text: string, max = 20): string[] {
  const ids: string[] = [];
  if (typeof text !== "string" || max < 1) return ids;
  const seen = new Set<string>();
  for (const match of text.matchAll(refMatcher())) {
    const id = match[1].toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= max) break;
  }
  return ids;
}

interface Walk {
  /** Strings read so far, across the whole walk. */
  strings: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ---------------------------------------------------------------------------
// The fail-closed scan (review R7 and S6; the header says what it accepts)
// ---------------------------------------------------------------------------

/** On normalised text: the path with or without its leading slash, no host. */
const HIDDEN_SOURCE = `api/mink/attachments/${UUID}`;

/** A string without one of these characters holds no address in any form. */
const MAY_HOLD_ADDRESS = /[/\\%&]/;

/** A value whose walk stopped is read whole as text, at most this long. */
const PROBE_MAX_CHARS = 1_000_000;

/** How many times nested encodings (`%252F`) are undone. */
const DECODE_ROUNDS = 4;

function codePoint(code: number, whole: string): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : whole;
}

/**
 * The text with every encoding a later step might undo undone (percent,
 * JavaScript and JSON escapes, HTML character references), backslashes read
 * as slashes and runs of slashes as one. Only ever used to FIND an address,
 * never as a value anything receives.
 */
function decodedForScan(text: string): string {
  let out = text;
  for (let round = 0; round < DECODE_ROUNDS; round += 1) {
    const next = out
      .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (whole, hex: string) =>
        codePoint(parseInt(hex, 16), whole),
      )
      .replace(/\\u([0-9a-f]{4})/gi, (whole, hex: string) =>
        codePoint(parseInt(hex, 16), whole),
      )
      .replace(/\\x([0-9a-f]{2})/gi, (whole, hex: string) =>
        codePoint(parseInt(hex, 16), whole),
      )
      .replace(/%([0-9a-f]{2})/gi, (whole, hex: string) =>
        codePoint(parseInt(hex, 16), whole),
      )
      .replace(/&#x([0-9a-f]{1,6});?/gi, (whole, hex: string) =>
        codePoint(parseInt(hex, 16), whole),
      )
      .replace(/&#([0-9]{1,7});?/g, (whole, dec: string) =>
        codePoint(parseInt(dec, 10), whole),
      )
      .replace(/&sol;/gi, "/");
    if (next === out) break;
    out = next;
  }
  return out.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

/** How many addresses a text holds in ANY form (the decoded count). */
function addressesInAnyForm(text: string): number {
  if (!MAY_HOLD_ADDRESS.test(text)) return 0;
  return [...decodedForScan(text).matchAll(new RegExp(HIDDEN_SOURCE, "gi"))]
    .length;
}

/** Every address in its strict form, one entry per occurrence, lower-cased. */
function strictOccurrences(text: string): string[] {
  return [...text.matchAll(refMatcher())].map((match) =>
    match[1].toLowerCase(),
  );
}

/** A string that is a JSON object or array, parsed; undefined otherwise. */
function jsonContainer(text: string): unknown {
  const trimmed = text.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === "{" && last === "}") || (first === "[" && last === "]")))
    return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) || isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A value whose walk stopped early: does its whole text hold an address? */
function holdsAddressAnywhere(value: unknown): boolean {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    // A value no walk or text can read is refused, never trusted.
    return true;
  }
  if (text === undefined) return false;
  if (text.length > PROBE_MAX_CHARS) return true;
  return addressesInAnyForm(text) > 0;
}

/** Why a scan cannot vouch for a value (the header says what each means). */
export type MinkAttachmentScanProblem = "disguised" | "key" | "limit";

export interface MinkAttachmentScan {
  /** Every id in its strict form: unique, lower-cased, at most `max`. */
  ids: string[];
  /** Null when every address in the value was found in its strict form. */
  problem: MinkAttachmentScanProblem | null;
}

/**
 * Every attachment id inside a value (a tool's arguments): strings, arrays,
 * plain objects and their keys, nested at most 8 deep, at most 2,000 strings
 * and keys read, a JSON object or array inside a string parsed and read too.
 * ★ It never stops early on `max`: the rest of the value is still read for a
 * problem, and `ids` simply stops growing. A caller that accepts N ids passes
 * N + 1 and refuses when it gets N + 1 back.
 */
export function scanMinkAttachmentValue(
  value: unknown,
  max = 20,
): MinkAttachmentScan {
  const ids: string[] = [];
  const seen = new Set<string>();
  let problem: MinkAttachmentScanProblem | null = null;
  let strings = 0;
  let truncated = false;

  const note = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    if (ids.length < max) ids.push(id);
  };

  const readText = (text: string, depth: number, isKey: boolean): void => {
    if (strings >= MINK_ATTACHMENT_WALK_STRINGS) {
      truncated = true;
      return;
    }
    strings += 1;
    if (!MAY_HOLD_ADDRESS.test(text)) return;
    if (!isKey) {
      const parsed = jsonContainer(text);
      if (parsed !== undefined) {
        visit(parsed, depth + 1);
        return;
      }
    }
    const strict = strictOccurrences(text);
    const anyForm = addressesInAnyForm(text);
    if (isKey) {
      if (anyForm > 0) problem = "key";
      return;
    }
    if (anyForm > strict.length) {
      problem = "disguised";
      return;
    }
    for (const id of strict) note(id);
  };

  const visit = (node: unknown, depth: number): void => {
    if (problem || truncated) return;
    if (typeof node === "string") {
      readText(node, depth, false);
      return;
    }
    if (Array.isArray(node)) {
      if (node.length === 0) return;
      if (depth >= MINK_ATTACHMENT_WALK_DEPTH) {
        truncated = true;
        return;
      }
      for (const item of node) {
        visit(item, depth + 1);
        if (problem || truncated) return;
      }
      return;
    }
    if (isPlainObject(node)) {
      const keys = Object.keys(node);
      if (keys.length === 0) return;
      if (depth >= MINK_ATTACHMENT_WALK_DEPTH) {
        truncated = true;
        return;
      }
      for (const key of keys) {
        readText(key, depth, true);
        if (problem || truncated) return;
        visit(node[key], depth + 1);
        if (problem || truncated) return;
      }
    }
  };

  visit(value, 0);
  if (!problem && truncated && holdsAddressAnywhere(value)) problem = "limit";
  return { ids, problem };
}

/**
 * The ids `scanMinkAttachmentValue` finds, or the refusal: ★ a value the scan
 * cannot vouch for (a disguised address, an address as a key, an address past
 * the walk's limits) throws `MinkToolInputError` with
 * `MINK_ATTACHMENT_ONLY_AS_A_PICTURE`, so the registry and the promotion fail
 * closed instead of passing an address through unseen.
 */
export function minkAttachmentIdsInValue(value: unknown, max = 20): string[] {
  const scan = scanMinkAttachmentValue(value, Math.max(0, max));
  if (scan.problem)
    throw new MinkToolInputError(MINK_ATTACHMENT_ONLY_AS_A_PICTURE);
  return scan.ids;
}

/**
 * The same value with every attachment address whose id is in `urlFor`
 * replaced by that id's URL, inside every string, nested at most 8 deep and
 * at most 2,000 strings read; an id the map does not name is left as it is.
 *
 * ★ A NEW VALUE, NEVER THE INPUT CHANGED: arrays and plain objects within
 * reach are rebuilt, strings are replaced, and anything past the walk's
 * limits (or that is not JSON-shaped) is returned as it was. The caller's
 * original is untouched either way.
 */
export function rewriteMinkAttachmentRefs(
  value: unknown,
  urlFor: Map<string, string>,
): unknown {
  const walk: Walk = { strings: 0 };
  const rewrite = (node: unknown, depth: number): unknown => {
    if (typeof node === "string") {
      if (walk.strings >= MINK_ATTACHMENT_WALK_STRINGS) return node;
      walk.strings += 1;
      if (urlFor.size === 0) return node;
      return node.replace(refMatcher(), (whole, id: string) => {
        const url = urlFor.get(id.toLowerCase());
        return url === undefined ? whole : url;
      });
    }
    if (depth >= MINK_ATTACHMENT_WALK_DEPTH) return node;
    if (Array.isArray(node)) {
      return node.map((item) => rewrite(item, depth + 1));
    }
    if (isPlainObject(node)) {
      const next: Record<string, unknown> = {};
      for (const key of Object.keys(node))
        next[key] = rewrite(node[key], depth + 1);
      return next;
    }
    return node;
  };
  return rewrite(value, 0);
}
