import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { isSchemaNotReady } from "@/lib/db/errors";
import { logWarn } from "@/lib/observability/logger";
import type { RefineStopAnswer } from "./refine-stop-types";
import {
  createLiveStopRegistry,
  watchForStop,
  type StopWatch,
} from "./stop-watch";

// ---------------------------------------------------------------------------
// ★★ A REFINE IS STOPPED ON ITS OWN ROW, NOT BY AN ABORTED FETCH (26 Oct
// 2026). Behind Google's load balancer an aborted browser fetch never reaches
// Cloud Run, so a merchant who left mid-refine was still charged for a photo
// nobody waited for. The browser now gives every refine a random stop token
// and sends it to POST /api/mink/image-refine/stop when it leaves; this module
// decides, on mink_refine_requests (migration 0247).
//
// ★★ EXACTLY ONE OF {THE STOP, THE CHARGE} WINS. The stop sets
// `stop_requested_at` only while `charge_claimed_at` is null; the charge
// transaction sets `charge_claimed_at` only while `stop_requested_at` is
// null, as its FIRST statement, before consume_mink_refine_credits. Both take
// the row's lock, and a waiting statement re-reads the newest committed row
// before it decides (READ COMMITTED). 0247's CHECK is the backstop.
//
// ★ The browser's token is never the charge's idempotency key: the ledger
// keeps the server's own refinement id, set on the row when the refine begins.
// A forged or reused token can only stop the caller's own refine (the key
// holds their store and admin) or be refused as a duplicate.
//
// ★ Every function here opens its own `withService` (never inside another
// scope's callback) except `claimRefineCharge`, which is the first statement
// of the caller's charge transaction. Logs carry store, admin and refinement
// ids, never the token.
// ---------------------------------------------------------------------------

/** What both requests know about a refine: the store, the admin, the token. */
export interface RefineStopKey {
  storeId: string;
  adminId: string;
  /** The browser's stop token (a UUID), lower-cased. */
  stopToken: string;
}

/**
 * How a refine began: `fresh` (this request owns the row), `stopped` (a stop
 * for this token arrived first), `duplicate` (the same token is already
 * refining), `unavailable` (the table is missing: local only, before 0247).
 */
export type RefineBegin = "fresh" | "stopped" | "duplicate" | "unavailable";

/**
 * The statements, exported so the local race test runs these exact texts on
 * held connections. `$token::uuid` makes the comparison case-free in SQL; the
 * registry key lower-cases it by hand.
 */
export const refineStopStatements = {
  /** Start a refine's row; no row back means one already exists. */
  begin: (key: RefineStopKey, refinementId: string): SQL => sql`
    insert into public.mink_refine_requests
      (store_id, admin_id, stop_token, refinement_id)
    values (${key.storeId}::uuid, ${key.adminId}, ${key.stopToken}::uuid, ${refinementId}::uuid)
    on conflict (store_id, admin_id, stop_token) do nothing
    returning 1 as begun`,
  /** Whether a stop is recorded on this key's row (no row reads as false). */
  beginRead: (key: RefineStopKey): SQL => sql`
    select (stop_requested_at is not null) as stopped
      from public.mink_refine_requests
     where store_id = ${key.storeId}::uuid and admin_id = ${key.adminId}
       and stop_token = ${key.stopToken}::uuid`,
  /**
   * Record a stop, only while the charge is not claimed. ★ The returned
   * `refinement_id` tells `stopped` (a begun refine) from `recorded` (none
   * has begun), whichever arm ran, so a repeat stop on a stop-first row also
   * answers `recorded`. `coalesce` keeps the first stop's time.
   */
  stop: (key: RefineStopKey): SQL => sql`
    insert into public.mink_refine_requests as r
      (store_id, admin_id, stop_token, stop_requested_at)
    values (${key.storeId}::uuid, ${key.adminId}, ${key.stopToken}::uuid, now())
    on conflict (store_id, admin_id, stop_token) do update
       set stop_requested_at = coalesce(r.stop_requested_at, excluded.stop_requested_at)
     where r.charge_claimed_at is null
    returning r.refinement_id`,
  /** The charged photo's URL, scoped by store and admin through the key. */
  tooLateRead: (key: RefineStopKey): SQL => sql`
    select m.result_url
      from public.mink_refine_requests q
      left join public.mink_image_refinements m
        on m.id = q.refinement_id and m.store_id = q.store_id
     where q.store_id = ${key.storeId}::uuid and q.admin_id = ${key.adminId}
       and q.stop_token = ${key.stopToken}::uuid`,
  /** Claim the charge, only while nobody asked to stop. */
  claim: (key: RefineStopKey, refinementId: string): SQL => sql`
    update public.mink_refine_requests
       set charge_claimed_at = now()
     where store_id = ${key.storeId}::uuid and admin_id = ${key.adminId}
       and stop_token = ${key.stopToken}::uuid
       and refinement_id = ${refinementId}::uuid
       and stop_requested_at is null and charge_claimed_at is null
    returning 1 as claimed`,
  /**
   * Make sure an unclaimed refine can never be charged (the stage sweep's and
   * a failed charge's arbiter). ★ A conditional write, not a read: it waits
   * for a charge transaction still holding the row, then decides on the
   * newest row version.
   */
  abandon: (storeId: string, refinementId: string): SQL => sql`
    update public.mink_refine_requests
       set stop_requested_at = coalesce(stop_requested_at, now())
     where store_id = ${storeId}::uuid and refinement_id = ${refinementId}::uuid
       and charge_claimed_at is null
    returning 1 as abandoned`,
  /** The charged ledger row's public path (the claim and it commit together). */
  chargedRead: (storeId: string, refinementId: string): SQL => sql`
    select result_path
      from public.mink_image_refinements
     where id = ${refinementId}::uuid and store_id = ${storeId}::uuid
       and result_path is not null`,
};

let warnedMissingTable = false;

/**
 * Begin a refine's row with the server's own refinement id. ★ Watch, the
 * pre-send check and the claim run ONLY after `fresh`: a claim on a missing
 * row matches nothing, which would read as "a stop won" after the model was
 * paid for. A missing table (42P01) answers `unavailable` and warns once;
 * any other error is rethrown, so the refine refuses before anything is
 * reserved or sent.
 */
export async function beginRefineRequest(
  key: RefineStopKey,
  refinementId: string,
): Promise<RefineBegin> {
  try {
    return await withService(async (db) => {
      const begun = await db.execute(
        refineStopStatements.begin(key, refinementId),
      );
      if (begun.rows.length > 0) return "fresh";
      const existing = await db.execute(refineStopStatements.beginRead(key));
      const row = existing.rows[0] as { stopped?: boolean } | undefined;
      return row?.stopped === true ? "stopped" : "duplicate";
    });
  } catch (error) {
    if (!isSchemaNotReady(error)) throw error;
    if (!warnedMissingTable) {
      warnedMissingTable = true;
      logWarn("mink.image-refine: stop table missing", {});
    }
    return "unavailable";
  }
}

/**
 * Ask a refine to stop. `stopped` is the only promise that nothing will be
 * charged; `recorded` (no refine has begun with this token) promises nothing;
 * `too_late` carries the charged photo's URL when the ledger has it. ★ A
 * token this admin never used is `recorded`, never "not found": a stop may
 * overtake its own refine, and another admin's token is simply their own row.
 */
export async function requestRefineStop(
  key: RefineStopKey,
): Promise<RefineStopAnswer> {
  return withService(async (db) => {
    const stopped = await db.execute(refineStopStatements.stop(key));
    const row = stopped.rows[0] as
      | { refinement_id?: string | null }
      | undefined;
    if (row) {
      return row.refinement_id
        ? { outcome: "stopped" }
        : { outcome: "recorded" };
    }
    const late = await db.execute(refineStopStatements.tooLateRead(key));
    const url = (late.rows[0] as { result_url?: string | null } | undefined)
      ?.result_url;
    return { outcome: "too_late", url: typeof url === "string" ? url : null };
  });
}

/** Whether a stop is recorded for this refine. One primary-key read. */
export async function isRefineStopRequested(
  key: RefineStopKey,
): Promise<boolean> {
  const result = await withService((db) =>
    db.execute(refineStopStatements.beginRead(key)),
  );
  return (
    (result.rows[0] as { stopped?: boolean } | undefined)?.stopped === true
  );
}

/**
 * Claim the charge, as the FIRST statement of the charge transaction (so the
 * row's lock is held until that transaction commits or rolls back). False
 * means a stop won: the caller must charge nothing.
 */
export async function claimRefineCharge(
  db: Db,
  key: RefineStopKey,
  refinementId: string,
): Promise<boolean> {
  const claimed = await db.execute(
    refineStopStatements.claim(key, refinementId),
  );
  return claimed.rows.length > 0;
}

/**
 * Whether a refine's charge committed, read from the ledger. ★ Only for a
 * refine that began `unavailable` (no row to lock, local only): a read can
 * miss a COMMIT still landing, which is why a guarded refine asks
 * `abandonRefineStage` instead. Throws on a database error.
 */
export async function refineChargeCommitted(
  storeId: string,
  refinementId: string,
): Promise<boolean> {
  const result = await withService((db) =>
    db.execute(refineStopStatements.chargedRead(storeId, refinementId)),
  );
  return result.rows.length > 0;
}

/**
 * Decide a stage nobody is waiting for any more: `discard` when nothing can
 * ever be charged for it, `{ publish: result_path }` when its charge
 * committed. ★ The abandon runs FIRST and is a conditional write, so it waits
 * for a charge transaction still holding the row and can never discard a
 * stage whose charge commits later, nor publish one whose charge did not.
 * No request row and no charged ledger row in this database (the store was
 * deleted, which cascades both, or they were pruned) is `discard` too: the
 * claim needs the request row. Throws on a database error.
 */
export async function abandonRefineStage(
  storeId: string,
  refinementId: string,
): Promise<"discard" | { publish: string }> {
  return withService(async (db) => {
    const abandoned = await db.execute(
      refineStopStatements.abandon(storeId, refinementId),
    );
    if (abandoned.rows.length > 0) return "discard";
    const charged = await db.execute(
      refineStopStatements.chargedRead(storeId, refinementId),
    );
    const path = (
      charged.rows[0] as { result_path?: string | null } | undefined
    )?.result_path;
    return typeof path === "string" && path ? { publish: path } : "discard";
  });
}

/**
 * Watch a refine for a stop asked for on another instance (stop-watch.ts:
 * about every second for 15 s, then every two). The refine closes it and
 * awaits `settled()` right before its charge transaction.
 */
export function watchRefineStop(
  key: RefineStopKey,
  onStop: () => void,
): StopWatch {
  const fields = { storeId: key.storeId, adminId: key.adminId };
  return watchForStop({
    read: () => isRefineStopRequested(key),
    onStop,
    skippedLog: { message: "mink.image-refine: watch read skipped", fields },
    failedLog: { message: "mink.image-refine: watch stop failed", fields },
  });
}

const liveRefines = createLiveStopRegistry(
  "storemink.mink.liveRefines",
  "mink.image-refine: live stop failed",
);

function liveKey(key: RefineStopKey): string {
  return `${key.storeId}:${key.adminId}:${key.stopToken.toLowerCase()}`;
}

/**
 * Note a refine this process is running, so a stop recorded here reaches it
 * at once. Returns the unregister call.
 */
export function registerLiveRefine(
  key: RefineStopKey,
  onStop: () => void,
): () => void {
  return liveRefines.register(liveKey(key), onStop);
}

/** Stop a refine this process is running. One elsewhere is left to its watcher. */
export function stopLiveRefine(key: RefineStopKey): void {
  liveRefines.stop(liveKey(key), {
    storeId: key.storeId,
    adminId: key.adminId,
  });
}
