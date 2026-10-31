import "server-only";

/**
 * The store hold (takedown design 3.7): a superadmin keeps a store for an
 * investigation, and while the hold is active nothing deletes the store.
 *
 * The database is the guarantee: `stores_keep_for_investigation` (migration
 * 0269) refuses every DELETE of a held store, or of a store with an archive
 * whose files are not copied yet, from any path. This module sets and
 * releases holds, reads the active one, and gives `deleteStore` (T17) its
 * refusal BEFORE it touches anything, in the same words the trigger's errors
 * map to (`deleteRefusalForError`).
 *
 * The merchant is never told about a hold (decision D14), so nothing here
 * notifies anyone.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import {
  contentBlockArchives,
  grievanceComplaints,
  storeLegalHolds,
  stores,
} from "@/drizzle/schema";
import {
  isSchemaNotReady,
  isUniqueViolation,
  loggableError,
} from "@/lib/db/errors";
import { logError } from "@/lib/observability/logger";
import { parseComplaintRef } from "./kinds";
import { recordModerationEvent } from "./record";
import { storeLabelFor, type ModerationOperator } from "./complaints";

export type StoreHoldRow = typeof storeLegalHolds.$inferSelect;

/** What a hold may hold (`store_legal_holds_reason_check`). */
export const HOLD_LIMITS = {
  reason: 2000,
  authorityRef: 500,
  note: 2000,
} as const;

/** Every sentence the hold functions answer with. */
export const HOLD_ERRORS = {
  setSuperadminOnly: "Only a superadmin can put a store on hold.",
  releaseSuperadminOnly: "Only a superadmin can release a hold.",
  reasonMissing: "Write the reason for the hold.",
  reasonLong: "Keep the reason under 2,000 characters.",
  authorityRefLong: "Keep it under 500 characters.",
  reviewOn: "Pick a review date.",
  storeNotFound: "We could not find that store.",
  complaintNotFound: "We could not find that complaint.",
  alreadyHeld: "This store is already on hold.",
  noteMissing: "Write a note first.",
  noteLong: "Keep the note under 2,000 characters.",
  holdNotFound: "We could not find that hold.",
  alreadyReleased: "This hold is already released.",
  saveFailed: "Could not save it. Please try again.",
} as const;

/**
 * Why a store cannot be deleted (design 3.7), as `deleteStore` says it. The
 * same two sentences answer the trigger's own refusals.
 */
export const STORE_DELETE_REFUSALS = {
  hold: "This store is on hold for an investigation, so it can't be deleted. Release the hold first.",
  archive:
    "StoreMink is still keeping a copy of something blocked on this store. Try again in a few minutes.",
} as const;

/** The trigger's messages (`stores_guard_delete`, migration 0269), without the store id. */
const TRIGGER_MESSAGES = {
  hold: "is on hold for an investigation and cannot be deleted",
  archive: "has a StoreMink archive whose files are not copied yet",
} as const;

export type HoldFailure = { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function fail(error: string): HoldFailure {
  return { ok: false, error };
}

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function actorOf(operator: ModerationOperator): string {
  const email = (operator?.email ?? "").trim();
  if (!email) throw new Error("A hold needs an operator email.");
  return email;
}

/** A calendar date "YYYY-MM-DD" that exists, or null. */
export function reviewDateOf(value: string | null | undefined): string | null {
  const match = DATE_ONLY.exec(text(value));
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
    ? `${y}-${m}-${d}`
    : null;
}

async function complaintIdFor(
  db: Db,
  complaint: string,
): Promise<string | null> {
  const value = complaint.trim();
  if (UUID.test(value)) {
    const rows = await db
      .select({ id: grievanceComplaints.id })
      .from(grievanceComplaints)
      .where(eq(grievanceComplaints.id, value))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  const refNo = parseComplaintRef(value);
  if (refNo === null) return null;
  const rows = await db
    .select({ id: grievanceComplaints.id })
    .from(grievanceComplaints)
    .where(eq(grievanceComplaints.refNo, refNo))
    .limit(1);
  return rows[0]?.id ?? null;
}

export type SetHoldInput = {
  storeId: string;
  reason: string;
  /** Who asked: the authority and its reference. */
  authorityRef?: string | null;
  /** A linked complaint, by id or by its reference ("SM-000123"). */
  complaint?: string | null;
  /** When to look at it again ("YYYY-MM-DD"); the Overview lists it from then. */
  reviewOn?: string | null;
};

export type SetHoldResult = { ok: true; hold: StoreHoldRow } | HoldFailure;

/**
 * Put a store on hold (design 3.7; superadmin only). One active hold per
 * store: a second is refused, by this read and by
 * `store_legal_holds_one_active_key` when two land together. Records
 * `store_hold_set`.
 */
export async function setStoreHold(
  input: SetHoldInput,
  operator: ModerationOperator,
): Promise<SetHoldResult> {
  if (operator?.role !== "superadmin")
    return fail(HOLD_ERRORS.setSuperadminOnly);
  const actor = actorOf(operator);
  const storeId = text(input.storeId);
  if (!UUID.test(storeId)) return fail(HOLD_ERRORS.storeNotFound);
  const reason = text(input.reason);
  if (!reason) return fail(HOLD_ERRORS.reasonMissing);
  if (reason.length > HOLD_LIMITS.reason) return fail(HOLD_ERRORS.reasonLong);
  const authorityRef = text(input.authorityRef);
  if (authorityRef.length > HOLD_LIMITS.authorityRef) {
    return fail(HOLD_ERRORS.authorityRefLong);
  }
  let reviewOn: string | null = null;
  if (text(input.reviewOn)) {
    reviewOn = reviewDateOf(input.reviewOn);
    if (!reviewOn) return fail(HOLD_ERRORS.reviewOn);
  }
  const complaint = text(input.complaint);
  try {
    return await withService(async (db): Promise<SetHoldResult> => {
      const [store] = await db
        .select({ name: stores.name, slug: stores.slug })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      if (!store) return fail(HOLD_ERRORS.storeNotFound);
      let complaintId: string | null = null;
      if (complaint) {
        complaintId = await complaintIdFor(db, complaint);
        if (!complaintId) return fail(HOLD_ERRORS.complaintNotFound);
      }
      const [active] = await db
        .select({ id: storeLegalHolds.id })
        .from(storeLegalHolds)
        .where(
          and(
            eq(storeLegalHolds.storeId, storeId),
            isNull(storeLegalHolds.releasedAt),
          ),
        )
        .limit(1);
      if (active) return fail(HOLD_ERRORS.alreadyHeld);
      const [hold] = await db
        .insert(storeLegalHolds)
        .values({
          storeId,
          storeLabel: storeLabelFor(store),
          reason,
          authorityRef,
          complaintId,
          setBy: actor,
          reviewOn,
        })
        .returning();
      if (!hold) throw new Error("setStoreHold: the insert returned no row.");
      await recordModerationEvent(db, {
        actor,
        action: "store_hold_set",
        holdId: hold.id,
        storeId,
        complaintId,
        detail: { reviewOn },
      });
      return { ok: true, hold };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return fail(HOLD_ERRORS.alreadyHeld);
    logError("moderation.holds: set failed", loggableError(err), { storeId });
    return fail(HOLD_ERRORS.saveFailed);
  }
}

export type ReleaseHoldResult = { ok: true; hold: StoreHoldRow } | HoldFailure;

/**
 * Release a hold (design 3.7; superadmin only, with a note). Records
 * `store_hold_released`; from then the store can be deleted again (unless an
 * archive of it is still being copied).
 */
export async function releaseStoreHold(
  holdId: string,
  note: string,
  operator: ModerationOperator,
): Promise<ReleaseHoldResult> {
  if (operator?.role !== "superadmin") {
    return fail(HOLD_ERRORS.releaseSuperadminOnly);
  }
  const actor = actorOf(operator);
  if (!UUID.test(holdId ?? "")) return fail(HOLD_ERRORS.holdNotFound);
  const releaseNote = text(note);
  if (!releaseNote) return fail(HOLD_ERRORS.noteMissing);
  if (releaseNote.length > HOLD_LIMITS.note) return fail(HOLD_ERRORS.noteLong);
  try {
    return await withService(async (db): Promise<ReleaseHoldResult> => {
      const [hold] = await db
        .update(storeLegalHolds)
        .set({
          releasedAt: sql`now()`,
          releasedBy: actor,
          releaseNote,
        })
        .where(
          and(
            eq(storeLegalHolds.id, holdId),
            isNull(storeLegalHolds.releasedAt),
          ),
        )
        .returning();
      if (!hold) {
        const [row] = await db
          .select({ id: storeLegalHolds.id })
          .from(storeLegalHolds)
          .where(eq(storeLegalHolds.id, holdId))
          .limit(1);
        return fail(
          row ? HOLD_ERRORS.alreadyReleased : HOLD_ERRORS.holdNotFound,
        );
      }
      await recordModerationEvent(db, {
        actor,
        action: "store_hold_released",
        holdId: hold.id,
        storeId: hold.storeId,
        complaintId: hold.complaintId,
      });
      return { ok: true, hold };
    });
  } catch (err) {
    logError("moderation.holds: release failed", loggableError(err), {
      holdId,
    });
    return fail(HOLD_ERRORS.saveFailed);
  }
}

/**
 * The store's active hold, or null. One read. A database without the hold
 * table answers null; any other failure throws, so a caller never reads "not
 * held" from a read that did not happen.
 */
export async function activeStoreHold(
  storeId: string,
): Promise<StoreHoldRow | null> {
  if (!UUID.test(storeId ?? "")) return null;
  try {
    const rows = await withService((db) =>
      db
        .select()
        .from(storeLegalHolds)
        .where(
          and(
            eq(storeLegalHolds.storeId, storeId),
            isNull(storeLegalHolds.releasedAt),
          ),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  } catch (err) {
    if (isSchemaNotReady(err)) return null;
    throw err;
  }
}

export type StoreDeleteRefusal = {
  reason: "hold" | "archive";
  message: string;
  holdId: string | null;
};

/**
 * Why `deleteStore` must not delete this store now (design 3.7, T17), or
 * null: an active hold first, then an archive whose files are still being
 * copied (`files_state` pending or failed, the trigger's own test). One
 * `withService` scope; with `actor`, the refusal is recorded there as
 * `store_delete_refused` (its only write). A database without the takedown
 * tables answers null (and has no trigger either); any other failure throws,
 * so a delete never goes ahead on a read that did not happen.
 */
export async function storeDeleteRefusal(
  storeId: string,
  options: { actor?: string } = {},
): Promise<StoreDeleteRefusal | null> {
  if (!UUID.test(storeId ?? "")) return null;
  const actor = (options.actor ?? "").trim();
  try {
    return await withService(async (db): Promise<StoreDeleteRefusal | null> => {
      const [hold] = await db
        .select({ id: storeLegalHolds.id })
        .from(storeLegalHolds)
        .where(
          and(
            eq(storeLegalHolds.storeId, storeId),
            isNull(storeLegalHolds.releasedAt),
          ),
        )
        .limit(1);
      let refusal: StoreDeleteRefusal | null = null;
      if (hold) {
        refusal = {
          reason: "hold",
          message: STORE_DELETE_REFUSALS.hold,
          holdId: hold.id,
        };
      } else {
        const [archive] = await db
          .select({ id: contentBlockArchives.id })
          .from(contentBlockArchives)
          .where(
            and(
              eq(contentBlockArchives.storeId, storeId),
              inArray(contentBlockArchives.filesState, ["pending", "failed"]),
            ),
          )
          .limit(1);
        if (archive) {
          refusal = {
            reason: "archive",
            message: STORE_DELETE_REFUSALS.archive,
            holdId: null,
          };
        }
      }
      if (refusal && actor) {
        await recordModerationEvent(db, {
          actor,
          action: "store_delete_refused",
          storeId,
          holdId: refusal.holdId,
          detail: { reason: refusal.reason },
        });
      }
      return refusal;
    });
  } catch (err) {
    if (isSchemaNotReady(err)) return null;
    throw err;
  }
}

function errorTexts(err: unknown): string[] {
  if (!err || typeof err !== "object") return [];
  const e = err as { message?: unknown; cause?: { message?: unknown } };
  return [e.cause?.message, e.message].filter(
    (m): m is string => typeof m === "string",
  );
}

/**
 * The sentence for the store delete trigger's refusal (a hold set, or an
 * archive started, between `storeDeleteRefusal` and the DELETE), read from
 * the error or its `cause` (Drizzle wraps it), or null for any other error.
 */
export function deleteRefusalForError(
  err: unknown,
): { reason: "hold" | "archive"; message: string } | null {
  const texts = errorTexts(err);
  if (texts.some((t) => t.includes(TRIGGER_MESSAGES.hold))) {
    return { reason: "hold", message: STORE_DELETE_REFUSALS.hold };
  }
  if (texts.some((t) => t.includes(TRIGGER_MESSAGES.archive))) {
    return { reason: "archive", message: STORE_DELETE_REFUSALS.archive };
  }
  return null;
}
