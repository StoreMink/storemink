import "server-only";

/**
 * The blocked-object set and the page swap (takedown design 5.6, plan A2 and
 * A4).
 *
 * One process-wide set holds the key of every live file block (a bucket
 * object, an outside address, a bundled `/themes/` file) and the MD5s of the
 * blocked files, loaded by one query of `content_blocks` (served by
 * `content_blocks_active_file_key`). It lives on `globalThis` under
 * `Symbol.for("storemink.moderation.blockedObjects")`, the pool's pattern, so
 * the proxy bundle and every route bundle of one process share one copy.
 *
 * - `blockedMedia()` answers the set. A set older than 30 seconds, or one
 *   `forgetBlockedObjects()` marked stale, is reloaded and the caller waits
 *   for the reload, at most 2 seconds; one reload runs at a time. After that,
 *   or when the reload fails, the last good set is used and the failure is
 *   logged at most once a minute. A missing table (`isSchemaNotReady`) means
 *   nothing is blocked.
 * - `isBlockedMediaUrl(url)` and `isBlockedUploadBytes(storeId, md5)` are
 *   lookups; they write nothing.
 * - `maskBlockedMedia(value)` returns `value` itself, without walking it,
 *   while nothing is blocked. Otherwise it returns a copy in which every
 *   blocked address inside a string (a whole string, an HTML `src` or
 *   `srcset`, JSON-LD, CSS `url()`) is replaced by the placeholder's own
 *   address. It never changes its input, and parts with nothing to swap are
 *   the same objects as in the input.
 *
 * ★ No host is named here (plan A2): an address counts when its
 *   `mediaKeyFromUrl` key is in the set, so every spelling of a blocked object
 *   (path-style, virtual-hosted, `%2E`, a `/_next/image` wrapper, `http` or
 *   protocol-relative) is swapped too.
 *
 * ★ An address `mediaKeyFromUrl` refuses as unreadable (a dot segment, a
 *   malformed escape, a backslash, user information) is swapped whenever it
 *   could name a blocked object, because a browser normalises those spellings
 *   and would load it: a wrapper (whose inner address could be anything), a
 *   `/themes/` path while a bundled file is blocked, a storage host while a
 *   bucket file is blocked, a host an outside block names, or a host that
 *   cannot be read at all. Any other unreadable address is left alone, so one
 *   block does not hide every odd address on every store.
 *
 * Every function here reads the database through its own `withService` scope
 * when it has to reload, so none of them may be called inside another
 * scope's callback (CODEBASE §5 item 2): read first, close the scope, then
 * mask.
 */

import { and, isNotNull, isNull } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { isSchemaNotReady, loggableError } from "@/lib/db/errors";
import { contentBlocks } from "@/drizzle/schema";
import { logError, logWarn } from "@/lib/observability/logger";
import { GCS_BUCKET_NAME } from "@/lib/storage/gcs";
import { isThemeReleaseObjectPath } from "@/lib/storage/paths";
import { PLACEHOLDER_URL_PATH } from "./placeholder";
import { FILE_SOURCES, isOneOf, kindWord, type FileSource } from "./kinds";
import {
  isInvalidMediaAddress,
  isMediaKey,
  mediaKeyFromUrl,
  type MediaKeyConfig,
} from "./media-key";
import { findAddresses, mightHoldMediaAddress } from "./media-refs";

// ── Timing ─────────────────────────────────────────────────────────────────

/** How old a set may be before a caller waits for a reload. */
export const BLOCKED_SET_MAX_AGE_MS = 30_000;

/** How long a caller waits for a reload before using the last good set. */
export const BLOCKED_SET_RELOAD_WAIT_MS = 2_000;

/**
 * After a failed reload, how long callers use the last good set without
 * starting another one, so a database that is down is not asked again by
 * every request.
 */
export const BLOCKED_SET_FAILURE_BACKOFF_MS = 5_000;

/** A reload failure (or a slow reload) is logged at most this often. */
export const BLOCKED_SET_LOG_INTERVAL_MS = 60_000;

const STATE_KEY = Symbol.for("storemink.moderation.blockedObjects");

// ── The set ────────────────────────────────────────────────────────────────

/** One live file block, as the query reads it. */
export type BlockedObjectRow = {
  id: string;
  objectPath: string | null;
  fileSource: string | null;
  storeId: string | null;
  objectMd5: string | null;
  tellStore: boolean | null;
};

/** What an MD5 match answers about the block it matched. */
export type BlockedBytesEntry = {
  blockId: string;
  storeId: string | null;
  told: boolean;
  /** "image" when the blocked object's name ends in a picture type. */
  guessedKindWord: "image" | "file";
};

/** The answer to "may these bytes be written?" when they may not. */
export type BlockedUploadMatch = {
  blockId: string;
  told: boolean;
  kindWord: string;
};

export type BlockedMediaSet = {
  /** When the query that made it started (milliseconds since the epoch). */
  readonly loadedAt: number;
  /** The bucket the keys were read against (`GCS_BUCKET`). */
  readonly bucket: string | null;
  /** How many live file blocks it holds. */
  readonly size: number;
  /** Every blocked key, all sources in one set (they never overlap). */
  readonly keys: ReadonlySet<string>;
  /** How many blocks of each source. */
  readonly sourceCounts: Readonly<Record<FileSource, number>>;
  /** The host (lower case) of every blocked outside address. */
  readonly externalHosts: ReadonlySet<string>;
  /** Per store (lower-case id), the MD5s (base64) of its blocked files. */
  readonly md5ByStore: ReadonlyMap<
    string,
    ReadonlyMap<string, BlockedBytesEntry>
  >;
  /** The MD5s of blocked theme release images (`theme-releases/`). */
  readonly themeReleaseMd5: ReadonlyMap<string, BlockedBytesEntry>;
  /** The MD5s of every blocked file, whatever its store. */
  readonly anyMd5: ReadonlyMap<string, BlockedBytesEntry>;
};

const IMAGE_ENDING =
  /\.(?:jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?|heic|heif)$/i;

function emptyCounts(): Record<FileSource, number> {
  return { bucket: 0, external: 0, bundled: 0 };
}

/** A set with nothing in it. */
export function emptyBlockedMediaSet(
  loadedAt: number,
  bucket: string | null = GCS_BUCKET_NAME,
): BlockedMediaSet {
  return Object.freeze({
    loadedAt,
    bucket,
    size: 0,
    keys: new Set<string>(),
    sourceCounts: Object.freeze(emptyCounts()),
    externalHosts: new Set<string>(),
    md5ByStore: new Map(),
    themeReleaseMd5: new Map(),
    anyMd5: new Map(),
  });
}

/**
 * The base64 form of an MD5 (what Google's `md5Hash` and `object_md5` hold),
 * or null for anything that is not one. A hex digest is converted, so a row
 * written in the other form still matches.
 */
export function canonicalMd5(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^[0-9a-f]{32}$/i.test(text)) {
    return Buffer.from(text, "hex").toString("base64");
  }
  if (/^[A-Za-z0-9+/]{22}==$/.test(text)) return text;
  return null;
}

function inferSource(path: string): FileSource {
  if (path.startsWith("/themes/")) return "bundled";
  if (/^https?:\/\//i.test(path)) return "external";
  return "bucket";
}

function hostOf(key: string): string | null {
  try {
    return new URL(key).hostname.replace(/\.$/, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Keep the told entry when two blocks name the same bytes (see below). */
function putEntry(
  map: Map<string, BlockedBytesEntry>,
  md5: string,
  entry: BlockedBytesEntry,
) {
  const existing = map.get(md5);
  // A block kept from the store (court or government order) must not be
  // named; but when the same bytes are also blocked by a block the store was
  // told about, naming that one tells the store nothing new.
  if (!existing || (!existing.told && entry.told)) map.set(md5, entry);
}

/**
 * Build the set from the live file blocks. Pure: the same rows always give
 * the same set.
 */
export function buildBlockedMediaSet(
  rows: readonly BlockedObjectRow[],
  options: { bucket: string | null; loadedAt: number },
): BlockedMediaSet {
  const config: MediaKeyConfig = { bucket: options.bucket };
  const keys = new Set<string>();
  const counts = emptyCounts();
  const externalHosts = new Set<string>();
  const md5ByStore = new Map<string, Map<string, BlockedBytesEntry>>();
  const themeReleaseMd5 = new Map<string, BlockedBytesEntry>();
  const anyMd5 = new Map<string, BlockedBytesEntry>();
  let size = 0;

  for (const row of rows) {
    const path = typeof row.objectPath === "string" ? row.objectPath : "";
    if (!path) continue;
    size += 1;
    const source = isOneOf(FILE_SOURCES, row.fileSource)
      ? row.fileSource
      : inferSource(path);
    counts[source] += 1;
    keys.add(path);
    if (source !== "bucket") {
      // The row holds the key T12 wrote; adding its re-normalised form too
      // means a row written before normalisation still matches.
      const normalised = mediaKeyFromUrl(path, config);
      if (isMediaKey(normalised)) keys.add(normalised.key);
      if (source === "external") {
        for (const key of [
          path,
          isMediaKey(normalised) ? normalised.key : "",
        ]) {
          const host = key ? hostOf(key) : null;
          if (host) externalHosts.add(host);
        }
      }
    }

    const md5 = canonicalMd5(row.objectMd5);
    if (!md5) continue;
    const storeId =
      typeof row.storeId === "string" && row.storeId
        ? row.storeId.toLowerCase()
        : null;
    const entry: BlockedBytesEntry = {
      blockId: row.id,
      storeId,
      told: row.tellStore !== false,
      guessedKindWord: IMAGE_ENDING.test(path) ? "image" : "file",
    };
    putEntry(anyMd5, md5, entry);
    if (storeId) {
      let perStore = md5ByStore.get(storeId);
      if (!perStore) {
        perStore = new Map();
        md5ByStore.set(storeId, perStore);
      }
      putEntry(perStore, md5, entry);
    }
    if (source === "bucket" && isThemeReleaseObjectPath(path)) {
      putEntry(themeReleaseMd5, md5, entry);
    }
  }

  return Object.freeze({
    loadedAt: options.loadedAt,
    bucket: options.bucket,
    size,
    keys,
    sourceCounts: Object.freeze(counts),
    externalHosts,
    md5ByStore,
    themeReleaseMd5,
    anyMd5,
  });
}

// ── Address lookups (pure) ─────────────────────────────────────────────────

const WRAPPER_PATHS = ["/_next/image", "/api/og-image"];

/** Google's storage hosts, path-style, virtual-hosted and the JSON API. */
const STORAGE_HOST =
  /(^|\.)(storage|commondatastorage)\.googleapis\.com$|^storage\.cloud\.google\.com$|^www\.googleapis\.com$/;

const ABSOLUTE =
  /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/;

function isWrapperPath(path: string): boolean {
  const lower = path.toLowerCase();
  return WRAPPER_PATHS.some(
    (wrapper) => lower === wrapper || lower.startsWith(`${wrapper}/`),
  );
}

/**
 * An unreadable wrapper address: judge the picture it asks for. A wrapper
 * inside a wrapper, or one whose `url` cannot be read, is swapped.
 */
function wrapperMightNameBlocked(set: BlockedMediaSet, query: string): boolean {
  const inner = new URLSearchParams(query.replace(/&amp;/gi, "&")).get("url");
  if (inner === null) return false;
  const text = inner
    .replace(/[\t\n\r]/g, "")
    .trim()
    .replace(/\\/g, "/");
  const innerPath =
    text.startsWith("/") && !text.startsWith("//")
      ? text.split(/[?#]/)[0]
      : (ABSOLUTE.exec(text)?.[2] ?? "");
  if (isWrapperPath(innerPath)) return true;
  return isBlockedAddressIn(set, inner);
}

function mentionsThemes(path: string): boolean {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape: judge the raw text.
  }
  return /\/themes\//i.test(decoded) || /\/themes\//i.test(path);
}

/**
 * Whether an address `mediaKeyFromUrl` refused as unreadable could still
 * load a blocked object once a browser normalises it (module comment).
 */
function invalidMightNameBlocked(set: BlockedMediaSet, url: string): boolean {
  const text = url
    .replace(/[\t\n\r]/g, "")
    .trim()
    .replace(/\\/g, "/");
  const bundledBlocked = set.sourceCounts.bundled > 0;

  if (text.startsWith("/") && !text.startsWith("//")) {
    const end = text.search(/[?#]/);
    const path = end === -1 ? text : text.slice(0, end);
    if (isWrapperPath(path)) {
      const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : "";
      return wrapperMightNameBlocked(set, query.split("#")[0]);
    }
    return bundledBlocked && mentionsThemes(path);
  }

  const match = ABSOLUTE.exec(text);
  if (!match) return true;
  const authority = match[1].slice(match[1].lastIndexOf("@") + 1);
  const path = match[2] || "/";
  let host: string;
  try {
    host = new URL(`https://${authority}/`).hostname
      .replace(/\.$/, "")
      .toLowerCase();
  } catch {
    return true;
  }
  if (!host) return true;
  if (isWrapperPath(path)) return wrapperMightNameBlocked(set, match[3] ?? "");
  if (bundledBlocked && mentionsThemes(path)) return true;
  if (STORAGE_HOST.test(host) && set.sourceCounts.bucket > 0) return true;
  return set.externalHosts.has(host);
}

/**
 * Whether one address names a blocked object in `set`. Pure: the proxy and
 * the page swap ask it with a set they already hold.
 */
export function isBlockedAddressIn(
  set: BlockedMediaSet,
  url: unknown,
): boolean {
  if (set.keys.size === 0 || typeof url !== "string") return false;
  const result = mediaKeyFromUrl(url, { bucket: set.bucket });
  if (result === null) return false;
  if (isMediaKey(result)) {
    if (set.keys.has(result.key)) return true;
    // An outside address on any host whose path is a bundled file of ours
    // (a store's own domain, absolute): the bundled key decides.
    if (result.source === "external" && set.sourceCounts.bundled > 0) {
      const path = result.key.replace(/^https:\/\/[^/]+/, "");
      if (path.startsWith("/themes/")) {
        const bundled = mediaKeyFromUrl(path, { bucket: set.bucket });
        if (isMediaKey(bundled) && set.keys.has(bundled.key)) return true;
        if (isInvalidMediaAddress(bundled)) return true;
      }
    }
    return false;
  }
  return invalidMightNameBlocked(set, url);
}

/**
 * The upload check, pure: whether bytes with this MD5 may be written to
 * `path` for `storeId`.
 *
 * - The same store's blocked file with these bytes: refused, named or not as
 *   that block says (`tell_store`).
 * - A `theme-releases/` path: refused when any live file block has these
 *   bytes (a blocked file must not come back as a theme's picture), never
 *   named.
 * - A store path: also refused when a blocked theme release image has these
 *   bytes, never named (the block is not this store's).
 */
export function findBlockedUpload(
  set: BlockedMediaSet,
  input: {
    storeId: string | null;
    md5Base64: string;
    path?: string | null;
    contentType?: string | null;
  },
): BlockedUploadMatch | null {
  if (set.size === 0) return null;
  const md5 = canonicalMd5(input.md5Base64);
  if (!md5) return null;
  const storeId = input.storeId ? input.storeId.toLowerCase() : null;
  const themeRelease = input.path
    ? isThemeReleaseObjectPath(input.path)
    : storeId === null;

  const answer = (entry: BlockedBytesEntry, told: boolean) => ({
    blockId: entry.blockId,
    told,
    kindWord: input.contentType?.trim()
      ? kindWord("file", input.contentType)
      : entry.guessedKindWord,
  });

  if (storeId) {
    const own = set.md5ByStore.get(storeId)?.get(md5);
    if (own) return answer(own, own.told);
  }
  const other = themeRelease
    ? set.anyMd5.get(md5)
    : set.themeReleaseMd5.get(md5);
  return other ? answer(other, false) : null;
}

// ── The page swap (pure) ───────────────────────────────────────────────────

/** Replace every blocked address inside one string. */
function maskString(text: string, set: BlockedMediaSet): string {
  let result = text;
  if (mightHoldMediaAddress(text)) {
    const found = findAddresses(text);
    let out = "";
    let last = 0;
    for (const address of found) {
      if (!isBlockedAddressIn(set, address.address)) continue;
      out += text.slice(last, address.start) + PLACEHOLDER_URL_PATH;
      last = address.end;
    }
    if (last > 0) result = out + text.slice(last);
  }
  return maskEscapedSlashes(result, set);
}

/**
 * Text that holds JSON written with escaped slashes (`https:\/\/...`, which
 * some tools write): find the addresses in the unescaped text and swap their
 * escaped spellings.
 */
function maskEscapedSlashes(text: string, set: BlockedMediaSet): string {
  if (!text.includes("\\/")) return text;
  const plain = text.replace(/\\\//g, "/");
  if (!mightHoldMediaAddress(plain)) return text;
  let result = text;
  const placeholder = PLACEHOLDER_URL_PATH.replace(/\//g, "\\/");
  for (const address of findAddresses(plain)) {
    if (!isBlockedAddressIn(set, address.address)) continue;
    const escaped = address.address.replace(/\//g, "\\/");
    if (escaped !== address.address && result.includes(escaped)) {
      result = result.split(escaped).join(placeholder);
    }
  }
  return result;
}

type Container = unknown[] | Record<string, unknown>;

function isWalkable(value: unknown): value is Container {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function shallowCopy(node: Container): Container {
  if (Array.isArray(node)) return node.slice();
  const proto = Object.getPrototypeOf(node);
  return Object.assign(proto === null ? Object.create(null) : {}, node);
}

type Frame = {
  node: Container;
  keys: readonly (string | number)[];
  index: number;
  copy: Container | null;
};

/**
 * The page swap with a set already in hand. Pure. Returns `value` itself
 * when nothing in it is blocked; otherwise a copy that shares every part
 * with nothing to swap. Only arrays, plain objects and strings are walked
 * (a Date, a Map or a class instance is kept as it is); object keys are not
 * changed. A value met twice gives the same result both times, and a cycle
 * is copied as a cycle.
 */
export function maskBlockedMediaWith<T>(value: T, set: BlockedMediaSet): T {
  if (set.keys.size === 0) return value;
  if (typeof value === "string") return maskString(value, set) as T;
  if (!isWalkable(value)) return value;

  const done = new Map<object, unknown>();
  const active = new Set<object>();
  // A child that points back at a node still being walked: the copy must
  // point at that node's copy, which only exists once the node finishes.
  const backReferences: {
    holder: Container;
    key: string | number;
    target: object;
  }[] = [];

  const open = (node: Container): Frame => {
    active.add(node);
    return {
      node,
      keys: Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node),
      index: 0,
      copy: null,
    };
  };
  const put = (frame: Frame, key: string | number, next: unknown) => {
    if (!frame.copy) frame.copy = shallowCopy(frame.node);
    (frame.copy as Record<string | number, unknown>)[key] = next;
  };

  const stack: Frame[] = [open(value)];
  let finished: unknown = value;
  let returning = false;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (returning) {
      returning = false;
      const key = frame.keys[frame.index];
      const original = (frame.node as Record<string | number, unknown>)[key];
      if (finished !== original) put(frame, key, finished);
      frame.index += 1;
    }
    if (frame.index >= frame.keys.length) {
      stack.pop();
      active.delete(frame.node);
      finished = frame.copy ?? frame.node;
      done.set(frame.node, finished);
      returning = true;
      continue;
    }
    const key = frame.keys[frame.index];
    const child = (frame.node as Record<string | number, unknown>)[key];
    if (typeof child === "string") {
      const masked = maskString(child, set);
      if (masked !== child) put(frame, key, masked);
      frame.index += 1;
    } else if (!isWalkable(child)) {
      frame.index += 1;
    } else if (done.has(child)) {
      const result = done.get(child);
      if (result !== child) put(frame, key, result);
      frame.index += 1;
    } else if (active.has(child)) {
      // Copy the holder (and so every node up to the target) and point it
      // at the target's copy once the walk ends.
      put(frame, key, child);
      backReferences.push({
        holder: frame.copy as Container,
        key,
        target: child,
      });
      frame.index += 1;
    } else {
      stack.push(open(child));
    }
  }

  for (const { holder, key, target } of backReferences) {
    (holder as Record<string | number, unknown>)[key] =
      done.get(target) ?? target;
  }
  return finished as T;
}

// ── The process-wide set ───────────────────────────────────────────────────

type State = {
  current: BlockedMediaSet | null;
  /** The generation the current set was loaded for. */
  currentGeneration: number;
  /** Bumped by `forgetBlockedObjects()`. */
  generation: number;
  inflight: { promise: Promise<BlockedMediaSet>; generation: number } | null;
  failedAt: number | null;
  lastFailureLogAt: number | null;
  lastSlowLogAt: number | null;
};

function state(): State {
  const holder = globalThis as typeof globalThis &
    Record<symbol, State | undefined>;
  let existing = holder[STATE_KEY];
  if (!existing) {
    existing = {
      current: null,
      currentGeneration: 0,
      generation: 0,
      inflight: null,
      failedAt: null,
      lastFailureLogAt: null,
      lastSlowLogAt: null,
    };
    holder[STATE_KEY] = existing;
  }
  return existing;
}

function isFresh(s: State, now: number): boolean {
  if (!s.current || s.currentGeneration !== s.generation) return false;
  const age = now - s.current.loadedAt;
  return age >= 0 && age < BLOCKED_SET_MAX_AGE_MS;
}

async function readLiveFileBlocks(): Promise<BlockedObjectRow[]> {
  return withService((db) =>
    db
      .select({
        id: contentBlocks.id,
        objectPath: contentBlocks.objectPath,
        fileSource: contentBlocks.fileSource,
        storeId: contentBlocks.storeId,
        objectMd5: contentBlocks.objectMd5,
        tellStore: contentBlocks.tellStore,
      })
      .from(contentBlocks)
      .where(
        and(
          isNull(contentBlocks.liftedAt),
          isNotNull(contentBlocks.objectPath),
        ),
      ),
  );
}

function keep(s: State, set: BlockedMediaSet, generation: number) {
  if (s.current && generation < s.currentGeneration) return;
  s.current = set;
  s.currentGeneration = generation;
}

async function reload(s: State, generation: number): Promise<BlockedMediaSet> {
  const startedAt = Date.now();
  try {
    const rows = await readLiveFileBlocks();
    const set = buildBlockedMediaSet(rows, {
      bucket: GCS_BUCKET_NAME,
      loadedAt: startedAt,
    });
    keep(s, set, generation);
    s.failedAt = null;
    return set;
  } catch (err) {
    if (isSchemaNotReady(err)) {
      const set = emptyBlockedMediaSet(startedAt);
      keep(s, set, generation);
      s.failedAt = null;
      if (shouldLog(s, "failure")) {
        logWarn("moderation.blocked_objects: table not ready, nothing blocked");
      }
      return set;
    }
    s.failedAt = Date.now();
    if (shouldLog(s, "failure")) {
      logError(
        "moderation.blocked_objects: reload failed",
        loggableError(err),
        {
          usingLastGood: s.current !== null,
          lastGoodAgeMs: s.current ? Date.now() - s.current.loadedAt : null,
        },
      );
    }
    throw err;
  }
}

function shouldLog(s: State, kind: "failure" | "slow"): boolean {
  const now = Date.now();
  const last = kind === "failure" ? s.lastFailureLogAt : s.lastSlowLogAt;
  if (last !== null && now - last < BLOCKED_SET_LOG_INTERVAL_MS) return false;
  if (kind === "failure") s.lastFailureLogAt = now;
  else s.lastSlowLogAt = now;
  return true;
}

/** Start a reload for the current generation, or join the one running. */
function startReload(s: State): Promise<BlockedMediaSet> {
  const generation = s.generation;
  if (s.inflight?.generation === generation) return s.inflight.promise;
  // A reload for an older generation may have read the table before the
  // change that bumped it: run a new one after it, never beside it.
  const before = s.inflight?.promise;
  const promise = before
    ? before.then(
        () => reload(s, generation),
        () => reload(s, generation),
      )
    : reload(s, generation);
  s.inflight = { promise, generation };
  const clear = () => {
    if (s.inflight?.promise === promise) s.inflight = null;
  };
  promise.then(clear, clear);
  return promise;
}

async function waitAtMost<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ value: T } | { timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ value }),
        () => ({ timedOut: false }),
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The set, reloaded first when it is older than 30 seconds or was marked
 * stale (module comment). Never throws.
 */
export async function blockedMedia(): Promise<BlockedMediaSet> {
  const s = state();
  const now = Date.now();
  if (isFresh(s, now)) return s.current as BlockedMediaSet;
  if (
    s.inflight === null &&
    s.failedAt !== null &&
    now - s.failedAt >= 0 &&
    now - s.failedAt < BLOCKED_SET_FAILURE_BACKOFF_MS
  ) {
    return s.current ?? emptyBlockedMediaSet(now);
  }
  const outcome = await waitAtMost(startReload(s), BLOCKED_SET_RELOAD_WAIT_MS);
  if ("value" in outcome) return outcome.value;
  if (outcome.timedOut && shouldLog(s, "slow")) {
    logWarn("moderation.blocked_objects: reload slower than 2 s", {
      usingLastGood: s.current !== null,
    });
  }
  return s.current ?? emptyBlockedMediaSet(Date.now());
}

/**
 * Mark the set stale, so the next caller waits for a reload. Call it after
 * the transaction that creates or lifts a file block commits.
 */
export function forgetBlockedObjects(): void {
  state().generation += 1;
}

/** Whether one address names a blocked object (module comment). */
export async function isBlockedMediaUrl(url: unknown): Promise<boolean> {
  if (typeof url !== "string" || !url.trim()) return false;
  return isBlockedAddressIn(await blockedMedia(), url);
}

/**
 * Whether bytes with this MD5 (base64) may not be written for this store
 * (`findBlockedUpload`). `path` and `contentType` are optional: the path
 * decides whether a `theme-releases/` write is meant (otherwise a null store
 * means one), the content type the word the refusal uses.
 */
export async function isBlockedUploadBytes(
  storeId: string | null,
  md5Base64: string,
  options: { path?: string | null; contentType?: string | null } = {},
): Promise<BlockedUploadMatch | null> {
  return findBlockedUpload(await blockedMedia(), {
    storeId,
    md5Base64,
    path: options.path,
    contentType: options.contentType,
  });
}

/** The page swap (module comment). Never throws, never changes `value`. */
export async function maskBlockedMedia<T>(value: T): Promise<T> {
  return maskBlockedMediaWith(value, await blockedMedia());
}
