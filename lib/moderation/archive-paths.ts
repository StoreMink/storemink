/**
 * Where a block's archive lives in the private bucket (takedown design 3.3, 9;
 * amendment A5): `takedown-archive/<database>/<block id>/`, with one folder per
 * database, because dev, staging and local development share one private
 * bucket. The prefix is outside `stores/<id>/`, so deleting a store never
 * reaches it, and every purge or restore checks that a path is this
 * database's before it touches it.
 *
 * Pure: reads `DB_NAME` on every call and imports nothing. The database rule
 * is a copy of the Refine stages' (`refineStageDatabase`, kept apart there by
 * `attachmentDatabase` too) so this module pulls in no other build's code.
 */

const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,63}$/;
const BLOCK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The archive's root in the private bucket, with its trailing slash. */
export const ARCHIVE_ROOT = "takedown-archive/";

/** The whole-store file's name inside a block's folder (design 3.6). */
export const STORE_CONTENT_FILE = "store-content.jsonl";

/** The longest a file's own name may be inside its archive path. */
export const ARCHIVE_BASENAME_MAX = 100;

/**
 * The database this process archives for: `DB_NAME` when it is a plain name,
 * else "default". Read on every call.
 */
export function archiveDatabase(): string {
  const name = process.env.DB_NAME ?? "";
  return DATABASE_NAME_PATTERN.test(name) ? name : "default";
}

/**
 * `takedown-archive/<database>/`, with the trailing slash, so `storemink`
 * never claims `storemink_staging`'s objects.
 */
export function archivePrefix(): string {
  return `${ARCHIVE_ROOT}${archiveDatabase()}/`;
}

function blockFolder(blockId: string): string {
  if (!BLOCK_ID_PATTERN.test(blockId)) {
    throw new RangeError("A block id must be a UUID.");
  }
  return blockId.toLowerCase();
}

/** One block's folder in this database's archive, with the trailing slash. */
export function archiveBlockPrefix(blockId: string): string {
  return `${archivePrefix()}${blockFolder(blockId)}/`;
}

/**
 * A file's name made safe for a path: letters, digits, `.`, `_` and `-`
 * only (anything else becomes `_`), at most `ARCHIVE_BASENAME_MAX`
 * characters, and never empty, `.` or `..`.
 */
export function archiveBasename(name: string): string {
  const last = (name ?? "").split(/[\\/]/).pop() ?? "";
  let safe = last
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, ARCHIVE_BASENAME_MAX);
  if (safe === "" || safe === "." || safe === "..") safe = "file";
  return safe;
}

/**
 * `takedown-archive/<database>/<block id>/<n>-<file name>` for the `n`th file
 * archived for a block (design 5.3 step 2).
 */
export function archiveObjectPath(
  blockId: string,
  n: number,
  basename: string,
): string {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError("A file's number must be a whole number, 0 or more.");
  }
  return `${archiveBlockPrefix(blockId)}${n}-${archiveBasename(basename)}`;
}

/** The whole-store JSON Lines file of a store block. */
export function archiveStoreContentPath(blockId: string): string {
  return `${archiveBlockPrefix(blockId)}${STORE_CONTENT_FILE}`;
}

/**
 * The database an archive path belongs to, or null when the path is not an
 * archive path at all (wrong root, no database folder, a `.` or `..`
 * segment, an empty segment).
 */
export function archivePathDatabase(path: string): string | null {
  if (typeof path !== "string" || !path.startsWith(ARCHIVE_ROOT)) return null;
  const segments = path.slice(ARCHIVE_ROOT.length).split("/");
  if (segments.length < 2) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  if (segments.slice(0, -1).some((segment) => segment === "")) return null;
  const database = segments[0];
  return DATABASE_NAME_PATTERN.test(database) ? database : null;
}

/**
 * Whether a path is under this database's archive, the check every purge and
 * restore makes before it touches an object (design 9).
 */
export function isThisDatabaseArchivePath(path: string): boolean {
  return archivePathDatabase(path) === archiveDatabase();
}
