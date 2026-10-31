/**
 * One key per media address (takedown design 5.1 and 3.2, amendment A2), so
 * every spelling of the same picture is checked against one block.
 *
 * - An object in this environment's public bucket is `bucket`, keyed by its
 *   object name decoded exactly once, as Google decodes it: `a%2Eb.jpg`,
 *   `a.b.jpg` and the same name under `%2F` instead of `/` are one key, while
 *   `%252E` (encoded twice) is another. Path-style, virtual-hosted and JSON
 *   API addresses of the bucket give the same key.
 * - A path under `/themes/` is `bundled` (an image built into the app).
 * - Any other `https` address is `external`, keyed by the address without its
 *   query or fragment: the host in lower case, the default port dropped and
 *   the path normalised the RFC 3986 way (unreserved escapes decoded, other
 *   escapes in upper case). Another bucket on Google's storage host is
 *   external too: it is not ours to replace, but a page can still stop
 *   showing it.
 * - `http` and protocol-relative addresses are read as `https`, because a
 *   browser upgrades an image on an `https` page and loads the same picture.
 * - One `/_next/image?url=` or `/api/og-image?url=` wrapper is unwrapped (on
 *   a relative path or any host); a wrapper inside a wrapper is refused.
 * - `{ invalid: true }` for an address that cannot be read safely: a
 *   malformed `%` escape, a `.` or `..` segment (before or after decoding), a
 *   backslash, user information, or a control character in an object name.
 *   Callers refuse it (the image proxy answers 400) rather than pass it on.
 * - `null` for anything that is not a media address at all.
 *
 * The three sources' keys never overlap: a bucket key never starts with `/`
 * or `http:/` / `https:/` (migration 0269's target check), a bundled key
 * always starts with `/themes/`, an external key always starts with
 * `https://`. So a set of keys can be looked up without the source.
 *
 * PURE and client-safe: the bucket comes in as config, nothing is imported
 * from the server, nothing is fetched.
 */

import type { FileSource } from "./kinds";

/** Which bucket counts as this environment's (`GCS_BUCKET` on the server). */
export type MediaKeyConfig = { bucket: string | null | undefined };

/** A media address in normal form. */
export type MediaKey = { source: FileSource; key: string };

/** An address that cannot be read safely; refuse it, never pass it on. */
export type InvalidMediaAddress = { invalid: true };

export type MediaKeyResult = MediaKey | InvalidMediaAddress | null;

export function isMediaKey(value: unknown): value is MediaKey {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as MediaKey).source === "string" &&
    typeof (value as MediaKey).key === "string"
  );
}

export function isInvalidMediaAddress(
  value: unknown,
): value is InvalidMediaAddress {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as InvalidMediaAddress).invalid === true
  );
}

/** The bundled-image rule of migration 0269's target check. */
const BUNDLED_PATH = /^\/themes\/[A-Za-z0-9._/-]+$/;

/** The optimiser and the share-image route: each takes the picture as `url`. */
const WRAPPER_PATHS = new Set(["/_next/image", "/api/og-image"]);

/** Hosts that serve `/<bucket>/<object>`. */
const PATH_STYLE_HOSTS = new Set([
  "storage.googleapis.com",
  "commondatastorage.googleapis.com",
  "storage.cloud.google.com",
]);

/** Hosts that serve the JSON API's `/storage/v1/b/<bucket>/o/<object>`. */
const JSON_API_HOSTS = new Set([
  "storage.googleapis.com",
  "www.googleapis.com",
]);

const JSON_API_PATH = /^\/(?:download\/)?storage\/v1\/b\/([^/]+)\/o\/(.+)$/;

/** Hosts that serve `<bucket>.<host>/<object>`. */
const VIRTUAL_HOST_SUFFIXES = [
  ".storage.googleapis.com",
  ".commondatastorage.googleapis.com",
];

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const ABSOLUTE =
  /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const PATH_CHAR = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/]$/;
const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;

function invalid(): InvalidMediaAddress {
  return { invalid: true };
}

/** Whether a path has a `.` or `..` segment. */
function hasDotSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

function decodeOnce(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** The configured bucket in the form a host or path compares with, or null. */
function bucketName(config: MediaKeyConfig): string | null {
  const name = (config.bucket ?? "").trim().toLowerCase();
  return name ? name : null;
}

/**
 * The normal form of a media address (see the module comment). Anything that
 * is not a string gives null.
 */
export function mediaKeyFromUrl(
  url: unknown,
  config: MediaKeyConfig,
): MediaKeyResult {
  return resolve(url, config, false);
}

function resolve(
  url: unknown,
  config: MediaKeyConfig,
  insideWrapper: boolean,
): MediaKeyResult {
  if (typeof url !== "string") return null;
  // A browser drops tabs and line breaks anywhere in an address.
  const text = url.replace(/[\t\n\r]/g, "").trim();
  if (!text) return null;
  // A browser reads a backslash as a slash: an address that relies on that
  // is a second spelling of another path.
  if (text.includes("\\")) return invalid();

  if (text.startsWith("/") && !text.startsWith("//")) {
    return resolveRelative(text, config, insideWrapper);
  }

  const scheme = SCHEME.exec(text);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name !== "https" && name !== "http") return null;
    if (!text.slice(scheme[0].length).startsWith("//")) return invalid();
  } else if (!text.startsWith("//")) {
    return null;
  }
  const plainHttp = scheme?.[1].toLowerCase() === "http";
  return resolveAbsolute(text, plainHttp, config, insideWrapper);
}

function resolveRelative(
  text: string,
  config: MediaKeyConfig,
  insideWrapper: boolean,
): MediaKeyResult {
  const end = text.search(/[?#]/);
  const path = end === -1 ? text : text.slice(0, end);
  if (WRAPPER_PATHS.has(path)) {
    const query = queryOf(text);
    return unwrap(query, config, insideWrapper);
  }
  if (path.startsWith("/themes/")) return bundledKey(path);
  return null;
}

function queryOf(text: string): string {
  const start = text.indexOf("?");
  if (start === -1) return "";
  const hash = text.indexOf("#", start);
  return text.slice(start + 1, hash === -1 ? undefined : hash);
}

function unwrap(
  query: string,
  config: MediaKeyConfig,
  insideWrapper: boolean,
): MediaKeyResult {
  if (insideWrapper) return invalid();
  // `&amp;` is how an HTML attribute writes `&`.
  const params = new URLSearchParams(query.replace(/&amp;/gi, "&"));
  const inner = params.get("url");
  if (inner === null) return null;
  return resolve(inner, config, true);
}

function bundledKey(rawPath: string): MediaKeyResult {
  if (hasDotSegment(rawPath)) return invalid();
  const decoded = decodeOnce(rawPath);
  if (decoded === null) return invalid();
  if (hasDotSegment(decoded) || decoded.includes("//")) return invalid();
  if (CONTROL.test(decoded)) return invalid();
  return BUNDLED_PATH.test(decoded)
    ? { source: "bundled", key: decoded }
    : null;
}

function resolveAbsolute(
  text: string,
  plainHttp: boolean,
  config: MediaKeyConfig,
  insideWrapper: boolean,
): MediaKeyResult {
  const match = ABSOLUTE.exec(text);
  if (!match) return invalid();
  const authority = match[1];
  const rawPath = match[2] || "/";
  const query = match[3] ?? "";
  if (!authority || authority.includes("@")) return invalid();

  let host: string;
  let port: string;
  try {
    const parsed = new URL(`https://${authority}/`);
    host = parsed.hostname.replace(/\.$/, "");
    port = parsed.port;
  } catch {
    return invalid();
  }
  if (!host) return invalid();
  // `https://host:443` and `http://host:80` are the host itself.
  if (port === "443" || (plainHttp && port === "80")) port = "";

  if (WRAPPER_PATHS.has(rawPath)) return unwrap(query, config, insideWrapper);

  if (!port) {
    const own = bucketName(config);
    const storage = storageAddress(host, rawPath);
    if (storage) {
      const bucket = decodeOnce(storage.bucket);
      if (bucket === null) return invalid();
      if (own && bucket.toLowerCase() === own) {
        return bucketKey(storage.object);
      }
    } else if (own && isOwnVirtualHost(host, own)) {
      return bucketKey(rawPath.slice(1));
    }
  }

  return externalKey(host, port, rawPath);
}

/** `{ bucket, object }` (both still encoded) for a path-style or JSON API address. */
function storageAddress(
  host: string,
  rawPath: string,
): { bucket: string; object: string } | null {
  if (JSON_API_HOSTS.has(host)) {
    const api = JSON_API_PATH.exec(rawPath);
    if (api) return { bucket: api[1], object: api[2] };
  }
  if (PATH_STYLE_HOSTS.has(host)) {
    const path = /^\/([^/]+)\/(.*)$/.exec(rawPath);
    if (path) return { bucket: path[1], object: path[2] };
  }
  return null;
}

function isOwnVirtualHost(host: string, bucket: string): boolean {
  return VIRTUAL_HOST_SUFFIXES.some((suffix) => host === `${bucket}${suffix}`);
}

function bucketKey(rawObject: string): MediaKeyResult {
  if (!rawObject) return null;
  if (hasDotSegment(rawObject)) return invalid();
  const decoded = decodeOnce(rawObject);
  if (decoded === null) return invalid();
  if (!decoded) return null;
  if (CONTROL.test(decoded) || hasDotSegment(decoded)) return invalid();
  // Migration 0269 refuses a bucket key that reads as a path or an address.
  if (/^(https?:)?\//i.test(decoded)) return invalid();
  return { source: "bucket", key: decoded };
}

function externalKey(
  host: string,
  port: string,
  rawPath: string,
): MediaKeyResult {
  const path = normalisePath(rawPath);
  if (path === null) return invalid();
  return {
    source: "external",
    key: `https://${host}${port ? `:${port}` : ""}${path}`,
  };
}

/**
 * The RFC 3986 normal form of a path: unreserved escapes decoded, other
 * escapes in upper case, anything else that is not a path character encoded
 * as UTF-8. Null for a malformed escape, a lone surrogate or a dot segment.
 */
function normalisePath(raw: string): string | null {
  let out = "";
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char === "%") {
      const hex = raw.slice(index + 1, index + 3);
      if (!HEX_PAIR.test(hex)) return null;
      const decoded = String.fromCharCode(parseInt(hex, 16));
      out += UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
      index += 3;
      continue;
    }
    const codePoint = raw.codePointAt(index) as number;
    const symbol = String.fromCodePoint(codePoint);
    if (PATH_CHAR.test(symbol)) {
      out += symbol;
    } else {
      try {
        out += encodeURIComponent(symbol);
      } catch {
        return null;
      }
    }
    index += symbol.length;
  }
  if (!out) out = "/";
  return hasDotSegment(out) ? null : out;
}
