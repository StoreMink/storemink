import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { mediaAssets, minkRevampImages, minkRevamps } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import type { MediaSource } from "@/lib/media/sources";
import { logWarn } from "@/lib/observability/logger";
import {
  gcsConfigured,
  gcsDeletePaths,
  gcsDownloadObject,
  gcsPathFromUrl,
  gcsUploadObject,
} from "@/lib/storage/gcs";
import { isStoreOwnedObjectPath } from "@/lib/storage/paths";
import {
  claimSpendLimits,
  releaseSpendLimits,
  type SpendClaim,
  type SpendLimit,
} from "../spend-limits";
import {
  REVAMP_LIMITS,
  type RevampImageRole,
  type RevampStoredImage,
} from "./contract";

// ---------------------------------------------------------------------------
// Mink storefront revamp: where the shoot's photographs are kept
// (docs/mink-storefront-revamp.md, sections 4.2 and 8).
//
// ★★ EVERY DRAWN PHOTO IS PAID FOR, SO IT IS STORED THE MOMENT IT SETTLES, and
//    storing it is idempotent on (revamp, role, slot). A runner that dies half
//    way, or two runners racing for one job after a lost lease, find the slot
//    already filled and reuse that row instead of keeping a second paid copy:
//    the insert is ON CONFLICT DO NOTHING and the loser is handed the winner's
//    row.
//
// ★ ONE OBJECT PER IMAGE, NAMED BY ITS BYTES:
//    stores/<store>/mink-generated/revamp/<revamp>/<role>-<slot>-<sha8>.<ext>
//    under `mink-generated/`, so every existing check still reads it as a
//    picture Mink drew (`isMinkAiMadePhotoUrl`, the Media Library's source
//    rule, the photo-replacement rule of a later revamp).
//
// ★ A `media_assets` ROW FOR EVERY STORED IMAGE. That row is what makes the
//    URL an image the store OWNS to every later ownership check (the Builder's
//    layout guard, a product save, the next revamp). The table has no alt
//    column, so the alt text names the file, which is what the Library shows
//    and what Mink's filename search reads.
// ★★ FILED HIDDEN FROM THE LIBRARY (`mink_prepared`) UNTIL THE CARD IS APPLIED
//    (ops-1). A revamp that is stopped or fails charges nothing, so the photos
//    it drew are not the merchant's to pick from the Library or the product
//    editor; Apply files the ones its card puts on the store as Mink's own
//    pictures (`mink_generated`, apply-v2.ts `revealRevampPhotos`). A phone
//    crop is the same photograph again at another shape, and stays hidden
//    like Mink's other prepared copies.
//
// ★ THE SHOOT'S LEDGER LIVES HERE TOO: one store-day and one platform-hour
//    allowance, shared by the photos step and the product photos step, claimed
//    before a picture is drawn and given back for pictures that never were.
// ---------------------------------------------------------------------------

/** The folder every revamp photograph lives in, below the store's prefix. */
export const REVAMP_IMAGE_FOLDER = "mink-generated/revamp";

/** A shot's phone crop is stored under the shot id with this suffix. */
export const REVAMP_PHONE_SUFFIX = "~phone";

/**
 * The Media Library source a revamp photo is filed under until its card is
 * applied, and the one Apply reveals it with (ops-1).
 */
export const REVAMP_HIDDEN_MEDIA_SOURCE: MediaSource = "mink_prepared";
export const REVAMP_REVEALED_MEDIA_SOURCE: MediaSource = "mink_generated";

export type RevampImageMediaType = "image/webp" | "image/jpeg" | "image/png";

const EXTENSIONS: Record<RevampImageMediaType, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
};

const ROLES: readonly RevampImageRole[] = ["anchor", "slot", "product"];
const REVIEWS: readonly RevampStoredImage["review"][] = [
  "passed",
  "flagged",
  "unreviewed",
];

/** The table's CHECK: both sides between 1 and 8192 pixels. */
const MAX_DIMENSION = 8192;
/** A prepared WebP is at most 1000 KiB; an unprepared original stays well under this. */
const MAX_STORE_BYTES = 12 * 1024 * 1024;
/** Reading one back: the stored image, never anything larger. */
const MAX_READ_BYTES = 20 * 1024 * 1024;
const MAX_SLOT_ID_CHARS = 160;
const MAX_PROBLEMS = 20;
const MAX_PROBLEM_CHARS = 200;
const SAFE_SLOT_CHARS = 60;
const FILENAME_ALT_CHARS = 60;
/**
 * ★ The name carries the content digest, so the object behind a path never
 *   changes: it can be cached for good.
 */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface StoreRevampImageInput {
  revampId: string;
  storeId: string;
  role: RevampImageRole;
  slotId: string;
  bytes: Uint8Array;
  mediaType: RevampImageMediaType;
  width: number;
  height: number;
  review: RevampStoredImage["review"];
  problems: string[];
  alt: string;
}

/** A stored image with the facts the card does not need. */
export interface RevampImageRecord extends RevampStoredImage {
  /** The reviewer's problem codes, or the recrop marks of a fallback. */
  problems: string[];
  createdAt: string;
}

const IMAGE_COLUMNS = {
  role: minkRevampImages.role,
  slotId: minkRevampImages.slotId,
  url: minkRevampImages.url,
  path: minkRevampImages.path,
  sha256: minkRevampImages.sha256,
  width: minkRevampImages.width,
  height: minkRevampImages.height,
  review: minkRevampImages.review,
  problems: minkRevampImages.problems,
  createdAt: minkRevampImages.createdAt,
};

type ImageRow = {
  role: string;
  slotId: string;
  url: string;
  path: string;
  sha256: string;
  width: number;
  height: number;
  review: string;
  problems: unknown;
  createdAt: string;
};

/** Whether revamp photographs can be stored at all (the media bucket is set). */
export function revampImageStoreConfigured(): boolean {
  return gcsConfigured;
}

/**
 * A slot id as it may appear in an object name: lower case letters, digits
 * and single dashes, bounded. ★ The row keeps the exact slot id; only the
 * file name is folded, and the content digest beside it keeps two slots that
 * fold alike apart unless their pictures are identical.
 */
export function safeRevampSlotId(slotId: string): string {
  return slugPart(slotId, SAFE_SLOT_CHARS) || "image";
}

/** Lower-case letters, digits and single dashes, accents folded, bounded. */
function slugPart(value: string, max: number): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** Where one revamp image is stored. */
export function revampImagePath(input: {
  storeId: string;
  revampId: string;
  role: RevampImageRole;
  slotId: string;
  sha256: string;
  mediaType: RevampImageMediaType;
}): string {
  return `stores/${input.storeId}/${REVAMP_IMAGE_FOLDER}/${input.revampId}/${input.role}-${safeRevampSlotId(input.slotId)}-${input.sha256.slice(0, 8)}.${EXTENSIONS[input.mediaType]}`;
}

/** Whether a path is one this module wrote: a revamp image under a store. */
export function isRevampImagePath(path: string): boolean {
  const parts = path.split("/");
  return (
    parts.length === 6 &&
    parts[0] === "stores" &&
    UUID_RE.test(parts[1]) &&
    `${parts[2]}/${parts[3]}` === REVAMP_IMAGE_FOLDER &&
    UUID_RE.test(parts[4]) &&
    /^[a-z]+-[a-z0-9-]+-[a-f0-9]{8}\.(webp|jpg|png)$/.test(parts[5])
  );
}

/**
 * Store one photograph of a revamp, once.
 *
 * ★ The revamp must be this store's: the image table has no foreign key that
 *   ties an image's store to its revamp's store, so this read is the tenant
 *   guard, and it also names the requester the Media row is filed under.
 * ★ The object is uploaded BEFORE either row is written, so no row ever
 *   points at a missing object, and OUTSIDE the transaction, so a storage
 *   round trip never holds a pooled connection.
 */
export async function storeRevampImage(
  input: StoreRevampImageInput,
): Promise<RevampStoredImage> {
  assertIds(input.revampId, input.storeId);
  const slotId = checkedSlotId(input.slotId);
  assertStorable(input);
  const bytes = input.bytes;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = revampImagePath({
    storeId: input.storeId,
    revampId: input.revampId,
    role: input.role,
    slotId,
    sha256,
    mediaType: input.mediaType,
  });
  const where = slotWhere(input.revampId, input.storeId, input.role, slotId);

  // 1. The revamp is this store's, and the slot may already be filled.
  const before = await withService(async (db) => {
    const [revamp] = await db
      .select({ adminId: minkRevamps.adminId })
      .from(minkRevamps)
      .where(
        and(
          eq(minkRevamps.id, input.revampId),
          eq(minkRevamps.storeId, input.storeId),
        ),
      )
      .limit(1);
    if (!revamp) return null;
    const [existing] = await db
      .select(IMAGE_COLUMNS)
      .from(minkRevampImages)
      .where(where)
      .limit(1);
    return { adminId: revamp.adminId, existing: existing ?? null };
  });
  if (!before) {
    throw new Error("This revamp does not belong to the store.");
  }
  if (before.existing) return toStoredImage(before.existing as ImageRow);

  // 2. The object.
  const url = await gcsUploadObject(
    path,
    bytes,
    input.mediaType,
    CACHE_CONTROL,
  );

  // 3. The rows: the revamp's, and the Media Library's for a slot this call won.
  const recorded = await withService(async (db) => {
    const [inserted] = await db
      .insert(minkRevampImages)
      .values({
        id: randomUUID(),
        revampId: input.revampId,
        storeId: input.storeId,
        role: input.role,
        slotId,
        url,
        path,
        sha256,
        width: input.width,
        height: input.height,
        review: input.review,
        problems: cleanProblems(input.problems),
      })
      .onConflictDoNothing({
        target: [
          minkRevampImages.revampId,
          minkRevampImages.role,
          minkRevampImages.slotId,
        ],
      })
      .returning(IMAGE_COLUMNS);
    if (inserted) {
      const [media] = await db
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.storeId, input.storeId),
            eq(mediaAssets.path, path),
          ),
        )
        .limit(1);
      if (!media) {
        await db.insert(mediaAssets).values({
          storeId: input.storeId,
          url,
          path,
          filename: mediaFilename(
            input.alt,
            input.role,
            slotId,
            sha256,
            input.mediaType,
          ),
          contentType: input.mediaType,
          sizeBytes: bytes.byteLength,
          createdBy: before.adminId,
          // ★★ Hidden until the card is applied (ops-1, see the header).
          source: REVAMP_HIDDEN_MEDIA_SOURCE,
        });
      }
      return { row: inserted as ImageRow, won: true };
    }
    // Another run filled this slot first: its row is the slot's photograph.
    const [existing] = await db
      .select(IMAGE_COLUMNS)
      .from(minkRevampImages)
      .where(where)
      .limit(1);
    return { row: (existing as ImageRow | undefined) ?? null, won: false };
  });
  if (!recorded.row) {
    throw new Error("The stored revamp image could not be read back.");
  }
  if (!recorded.won && recorded.row.path !== path) {
    await discardUnreferenced(path);
  }
  return toStoredImage(recorded.row);
}

/**
 * A refinement keeps one of its parent's photographs: a row for the new
 * revamp pointing at the same object, with no upload and no new Media row
 * (the parent's row already makes the object the store's). The photos step
 * also makes a photo parked for its review its shot's own this way.
 *
 * ★ Only an object under THIS store's prefix, written by this module, whose
 *   URL and path agree, may be adopted: the parent list comes from the table,
 *   and this keeps a corrupted or foreign row from becoming the store's.
 * ★★ `problems` are written on the new row in the same insert (cleaned and
 *   bounded like a stored image's). A photo let in unchecked (photos.ts,
 *   REVAMP_UNCHECKED_PROBLEM) is adopted WITH its marker, so the marker is on
 *   the row from the moment it is the shot's: an adopted row used to carry
 *   none, so such a photo was uploaded and filed a second time instead. A
 *   slot already filled keeps its own row and problems.
 */
export async function adoptRevampImage(input: {
  revampId: string;
  storeId: string;
  image: RevampStoredImage;
  /** The new row's problems; none by default (a carried-over photo). */
  problems?: readonly string[];
}): Promise<RevampStoredImage> {
  assertIds(input.revampId, input.storeId);
  const image = input.image;
  const slotId = checkedSlotId(image.slotId);
  if (!ROLES.includes(image.role)) {
    throw new Error("An adopted revamp image has an unknown role.");
  }
  if (
    !isRevampImagePath(image.path) ||
    !isStoreOwnedObjectPath(image.path, input.storeId) ||
    gcsPathFromUrl(image.url) !== image.path
  ) {
    throw new Error("Only this store's own revamp photographs can be adopted.");
  }
  if (!SHA256_RE.test(image.sha256)) {
    throw new Error("An adopted revamp image has an invalid digest.");
  }
  assertDimensions(image.width, image.height);
  const review = REVIEWS.includes(image.review) ? image.review : "unreviewed";
  const where = slotWhere(input.revampId, input.storeId, image.role, slotId);

  const row = await withService(async (db) => {
    const [revamp] = await db
      .select({ id: minkRevamps.id })
      .from(minkRevamps)
      .where(
        and(
          eq(minkRevamps.id, input.revampId),
          eq(minkRevamps.storeId, input.storeId),
        ),
      )
      .limit(1);
    if (!revamp) return null;
    const [inserted] = await db
      .insert(minkRevampImages)
      .values({
        id: randomUUID(),
        revampId: input.revampId,
        storeId: input.storeId,
        role: image.role,
        slotId,
        url: image.url,
        path: image.path,
        sha256: image.sha256,
        width: image.width,
        height: image.height,
        review,
        problems: cleanProblems(input.problems ?? []),
      })
      .onConflictDoNothing({
        target: [
          minkRevampImages.revampId,
          minkRevampImages.role,
          minkRevampImages.slotId,
        ],
      })
      .returning(IMAGE_COLUMNS);
    if (inserted) return inserted as ImageRow;
    const [existing] = await db
      .select(IMAGE_COLUMNS)
      .from(minkRevampImages)
      .where(where)
      .limit(1);
    return (existing as ImageRow | undefined) ?? null;
  });
  if (!row) {
    throw new Error("The revamp image could not be adopted for this store.");
  }
  return toStoredImage(row);
}

/** Every photograph of a revamp, oldest first. */
export async function listRevampImages(
  revampId: string,
  storeId: string,
): Promise<RevampStoredImage[]> {
  const records = await listRevampImageRecords(revampId, storeId);
  return records.map(stripRecord);
}

/** `listRevampImages` with each row's problems and creation time. */
export async function listRevampImageRecords(
  revampId: string,
  storeId: string,
): Promise<RevampImageRecord[]> {
  assertIds(revampId, storeId);
  const rows = await withService((db) =>
    db
      .select(IMAGE_COLUMNS)
      .from(minkRevampImages)
      .where(
        and(
          eq(minkRevampImages.revampId, revampId),
          eq(minkRevampImages.storeId, storeId),
        ),
      )
      .orderBy(
        asc(minkRevampImages.createdAt),
        asc(minkRevampImages.role),
        asc(minkRevampImages.slotId),
      ),
  );
  const records: RevampImageRecord[] = [];
  for (const row of rows as ImageRow[]) {
    if (!ROLES.includes(row.role as RevampImageRole)) continue;
    records.push({
      ...toStoredImage(row),
      problems: readProblems(row.problems),
      createdAt: String(row.createdAt ?? ""),
    });
  }
  return records;
}

/**
 * The bytes of one stored photograph, or null when they cannot be read.
 *
 * ★ Read from the stored PATH through the authenticated bucket client, never
 *   by fetching its public URL, and only a path this module wrote.
 * ★ THE DIGEST IS CHECKED: an object that is not the bytes the row recorded
 *   is not the photograph the shoot was matched to.
 */
export async function readRevampImageBytes(
  image: RevampStoredImage,
): Promise<Uint8Array | null> {
  if (!isRevampImagePath(image.path) || !SHA256_RE.test(image.sha256)) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = await gcsDownloadObject(image.path, MAX_READ_BYTES);
  } catch (error) {
    logWarn("mink.revamp: image could not be read", {
      role: image.role,
      slotId: image.slotId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== image.sha256) {
    logWarn("mink.revamp: image bytes do not match their digest", {
      role: image.role,
      slotId: image.slotId,
    });
    return null;
  }
  return bytes;
}

/**
 * The bytes of an image the store owns, read from its own object path, or
 * null. For the offline product photos, which re-encode the merchant's own
 * photo; the caller has already checked the store owns the URL.
 */
export async function readStoreOwnedImageBytes(
  url: string,
  storeId: string,
): Promise<Uint8Array | null> {
  const path = gcsPathFromUrl(url);
  if (!path || !isStoreOwnedObjectPath(path, storeId)) return null;
  try {
    return await gcsDownloadObject(path, MAX_READ_BYTES);
  } catch (error) {
    logWarn("mink.revamp: store image could not be read", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ── The shoot's ledger ──────────────────────────────────────────────────────

/**
 * The platform's hourly revamp photo ceiling, shared by every store. ★ Named,
 * because a refusal by it says nothing about the store's own day: it frees up
 * as the hour turns (photos.ts waits it out instead of failing the revamp).
 */
export const REVAMP_PLATFORM_PHOTO_LIMIT_KEY = "mink-revamp-photos-hour";

/**
 * The two photo allowances every revamp photograph counts against: the
 * store's day and the platform's hour (docs/mink-storefront-revamp.md,
 * section 12). One key set for the photos AND the product photos step.
 */
export function revampPhotoLimits(storeId: string, cost: number): SpendLimit[] {
  return [
    {
      key: `mink-revamp-photos-day:${storeId}`,
      max: REVAMP_LIMITS.photosPerStorePerDay,
      windowSeconds: 86_400,
      cost,
    },
    {
      key: REVAMP_PLATFORM_PHOTO_LIMIT_KEY,
      max: REVAMP_LIMITS.platformPhotosPerHour,
      windowSeconds: 3_600,
      cost,
    },
  ];
}

/**
 * Claim `cost` photographs from both allowances, or none (`claimSpendLimits`
 * is all or nothing). A database error throws: nothing paid may be drawn
 * when the allowance cannot be checked.
 */
export async function claimRevampPhotos(
  storeId: string,
  cost: number,
): Promise<SpendClaim> {
  const n = Math.floor(cost);
  if (!(n > 0)) return { ok: true };
  return claimSpendLimits(revampPhotoLimits(storeId, n));
}

/** Give back photographs that were claimed and never drawn. Never throws. */
export async function releaseRevampPhotos(
  storeId: string,
  count: number,
): Promise<void> {
  const n = Math.floor(count);
  if (!(n > 0)) return;
  await releaseSpendLimits(
    revampPhotoLimits(storeId, n).map(({ key, cost }) => ({ key, cost })),
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function slotWhere(
  revampId: string,
  storeId: string,
  role: RevampImageRole,
  slotId: string,
) {
  return and(
    eq(minkRevampImages.revampId, revampId),
    eq(minkRevampImages.storeId, storeId),
    eq(minkRevampImages.role, role),
    eq(minkRevampImages.slotId, slotId),
  );
}

function assertIds(revampId: string, storeId: string): void {
  if (!UUID_RE.test(revampId) || !UUID_RE.test(storeId)) {
    throw new Error("A revamp image needs a revamp id and a store id.");
  }
}

function checkedSlotId(slotId: string): string {
  const id = typeof slotId === "string" ? slotId.trim() : "";
  if (!id || id.length > MAX_SLOT_ID_CHARS) {
    throw new Error("A revamp image needs a slot id.");
  }
  return id;
}

function assertDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION
  ) {
    throw new Error("A revamp image must be between 1 and 8192 pixels a side.");
  }
}

function assertStorable(input: StoreRevampImageInput): void {
  if (!ROLES.includes(input.role)) {
    throw new Error("A revamp image has an unknown role.");
  }
  if (!(input.mediaType in EXTENSIONS)) {
    throw new Error("A revamp image must be WebP, JPEG or PNG.");
  }
  if (!REVIEWS.includes(input.review)) {
    throw new Error("A revamp image has an unknown review state.");
  }
  if (
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > MAX_STORE_BYTES
  ) {
    throw new Error("A revamp image is empty or too large to store.");
  }
  assertDimensions(input.width, input.height);
}

function cleanProblems(problems: readonly unknown[]): string[] {
  return (Array.isArray(problems) ? problems : [])
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .map((p) => p.trim().slice(0, MAX_PROBLEM_CHARS))
    .slice(0, MAX_PROBLEMS);
}

function readProblems(value: unknown): string[] {
  return Array.isArray(value) ? cleanProblems(value) : [];
}

/** A Media Library file name from the alt text, else the slot. */
function mediaFilename(
  alt: string,
  role: RevampImageRole,
  slotId: string,
  sha256: string,
  mediaType: RevampImageMediaType,
): string {
  const words = slugPart(
    typeof alt === "string" ? alt : "",
    FILENAME_ALT_CHARS,
  );
  const stem = words || `revamp-${role}-${safeRevampSlotId(slotId)}`;
  return `${stem}-${sha256.slice(0, 8)}.${EXTENSIONS[mediaType]}`;
}

function toStoredImage(row: ImageRow): RevampStoredImage {
  return {
    role: ROLES.includes(row.role as RevampImageRole)
      ? (row.role as RevampImageRole)
      : "slot",
    slotId: row.slotId,
    url: row.url,
    path: row.path,
    sha256: row.sha256,
    width: Number(row.width),
    height: Number(row.height),
    review: REVIEWS.includes(row.review as RevampStoredImage["review"])
      ? (row.review as RevampStoredImage["review"])
      : "unreviewed",
  };
}

function stripRecord(record: RevampImageRecord): RevampStoredImage {
  return {
    role: record.role,
    slotId: record.slotId,
    url: record.url,
    path: record.path,
    sha256: record.sha256,
    width: record.width,
    height: record.height,
    review: record.review,
  };
}

/**
 * Remove an object this call uploaded and then lost the slot for. ★ Only
 * when no row anywhere still points at it: two slots that fold to the same
 * file name with identical pictures share one object, and deleting it would
 * break the other. Best effort; an orphan under a digest name is harmless.
 */
async function discardUnreferenced(path: string): Promise<void> {
  try {
    const [inUse] = await withService((db) =>
      db
        .select({ path: minkRevampImages.path })
        .from(minkRevampImages)
        .where(eq(minkRevampImages.path, path))
        .limit(1),
    );
    if (inUse) return;
    await gcsDeletePaths([path]);
  } catch (error) {
    logWarn("mink.revamp: an unused image could not be removed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
