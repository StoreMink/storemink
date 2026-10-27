import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import { logError, logInfo } from "@/lib/observability/logger";
import { MINK_CONVERSATION_RETENTION_DAYS } from "./chat-session";
import { buildingRevampOfConversation } from "./conversation-history";
import {
  retireMinkConversation,
  stripOrphanedRedesignsQuery,
} from "./conversation-retire";

// ---------------------------------------------------------------------------
// ★★ THE 90-DAY SWEEP OF MINK AI CHATS (owner's decision, 25 Oct 2026), run
// nightly by prune-logs (lib/retention/prune.ts): a chat is retired 90 days
// after it was last used, through the same function as the merchant's delete
// (conversation-retire.ts), so a chat holding the record of an approved or
// published change is REDUCED and the record stays while the store exists.
// The shape of lib/whatsapp/retention.ts.
//
// ★ TWO CLOCKS, BECAUSE THE REVISION BEING REPLACED MOVES ONLY ONE. A use
//   moves `expires_at` (last use + 90 days) in this revision, but the one
//   being replaced (and any rollback) writes `last_message_at` alone. So:
//   - a chat is a candidate only when BOTH `expires_at` has passed AND its
//     last message is 90 days old: no revision's message is lost;
//   - each batch first HEALS chats about to expire whose expiry is earlier
//     than last message + 90 days (the 0248 backfill, repeated nightly for
//     the chats it concerns), so a chat that revision used is never hidden.
//   An OPEN served by that revision is not recorded; its messages are.
// ★ Never a chat with a reply running or a redesign still being made: it is
//   retired a later night. A chat that could not be retired is marked
//   (`retention_failed_at`) and left out for 7 days, so it cannot stall the
//   batch, and logged with ids only.
// ★ Each batch also strips redesigns nobody applied whose chat was deleted
//   before this change, or by the revision being replaced
//   (`stripOrphanedRedesignsQuery`, conversation-retire.ts).
// ---------------------------------------------------------------------------

/** How long a chat whose retirement failed is left out of the sweep. */
export const MINK_RETENTION_RETRY_FAILED_AFTER_DAYS = 7;

/** Chats about to expire within this window are healed (twice the sweep's interval). */
const HEAL_WINDOW = sql.raw(`interval '2 days'`);

/**
 * ★ How far an expiry may sit below last message + 90 days and still be this
 * revision's own: a run start sets the expiry from the database's clock a
 * moment before the answer moves the last message, so every answered chat is
 * short by the length of its reply. Only an expiry short by more than this
 * was left behind by a revision that moved the last message alone; the open
 * bump uses the same hour.
 */
const HEAL_TOLERANCE = sql.raw(`interval '1 hour'`);

/**
 * At most this many heal statements a batch: after a long rollback many chats
 * may need it, and each statement heals at most a batch of them.
 */
export const MINK_RETENTION_MAX_HEAL_ROUNDS = 10;

const RETENTION_DAYS = sql.raw(
  String(Math.trunc(MINK_CONVERSATION_RETENTION_DAYS)),
);
const RETRY_DAYS = sql.raw(
  String(Math.trunc(MINK_RETENTION_RETRY_FAILED_AFTER_DAYS)),
);

const CHAT_SAVEPOINT = "mink_retention_chat";

/** The conditions that make chat `c` retirable now (`floorIso`: 90 days ago). */
function retirable(floorIso: string): SQL {
  return sql`c.status = 'active'
    and c.expires_at <= now()
    and c.last_message_at <= ${floorIso}::timestamptz
    and not exists (
      select 1 from public.mink_runs r
       where r.store_id = c.store_id and r.conversation_id = c.id
         and r.status = 'running'
    )
    and not exists (${buildingRevampOfConversation(sql.raw("c.store_id"), sql.raw("c.id"))})`;
}

/** A listed chat whose expiry sits more than the tolerance below last message + 90 days. */
function leftBehind(alias: "c" | "c2"): SQL {
  const r = sql.raw(alias);
  return sql`${r}.status = 'active'
    and ${r}.expires_at < ${r}.last_message_at + make_interval(days => ${RETENTION_DAYS}) - ${HEAL_TOLERANCE}`;
}

/**
 * Each batch's heal: listed chats about to expire, left behind by a revision
 * that moved only their last message. ★ The condition is repeated on the row
 * being updated: an open that moved the expiry while this ran is then left
 * alone (Postgres re-checks only the outer condition on a row changed
 * meanwhile, never the inner list).
 */
export function healExpiringChatsQuery(limit: number): SQL {
  return sql`
    update public.mink_conversations c
       set expires_at = c.last_message_at + make_interval(days => ${RETENTION_DAYS})
     where c.id in (
       select c2.id from public.mink_conversations c2
        where ${leftBehind("c2")}
          and c2.expires_at <= now() + ${HEAL_WINDOW}
        order by c2.expires_at, c2.id
        limit ${limit}
     )
       and ${leftBehind("c")}
    returning c.id
  `;
}

/** The oldest retirable chats, on mink_conversations_retention_idx. */
export function retirableChatsQuery(floorIso: string, limit: number): SQL {
  return sql`
    select c.id, c.store_id
      from public.mink_conversations c
     where ${retirable(floorIso)}
       and (c.retention_failed_at is null
            or c.retention_failed_at < now() - make_interval(days => ${RETRY_DAYS}))
     order by c.expires_at, c.id
     limit ${limit}
  `;
}

/**
 * Retires up to `limit` chats unused since `floorIso` (90 days ago). Returns
 * how many were retired, deleted or reduced: a short batch ends the night.
 */
export async function pruneIdleMinkConversations(
  floorIso: string,
  limit: number,
): Promise<number> {
  // ★ Scopes one after the other, never one inside another
  //   (lib/db/nested-scope-coverage.test.ts): the heal (a round while a
  //   round heals a full batch), the strip of redesigns without a chat, the
  //   candidates, then the batch, which is one transaction (the registry's
  //   rule).
  let healed = 0;
  for (let round = 0; round < MINK_RETENTION_MAX_HEAL_ROUNDS; round += 1) {
    const healedNow = await withService(async (db) => {
      const result = await db.execute(healExpiringChatsQuery(limit));
      return result.rows.length;
    });
    healed += healedNow;
    if (healedNow < limit) break;
  }
  const stripped = await withService(async (db) => {
    const result = await db.execute(stripOrphanedRedesignsQuery(limit));
    return result.rows.length;
  });
  const candidates = await withService(async (db) => {
    const result = await db.execute(retirableChatsQuery(floorIso, limit));
    return result.rows as { id: string; store_id: string }[];
  });

  const counts = {
    healed,
    stripped,
    deleted: 0,
    reduced: 0,
    skipped: 0,
    failed: 0,
  };
  if (candidates.length > 0) {
    await withService(async (db) => {
      for (const chat of candidates) {
        await db.execute(sql.raw(`SAVEPOINT ${CHAT_SAVEPOINT}`));
        try {
          // The key startMinkRun and the merchant's delete take: busy, skip.
          const lock = await db.execute(
            sql`select pg_try_advisory_xact_lock(hashtextextended(${`mink-conversation:${chat.id}`}, 0)) as locked`,
          );
          const locked =
            (lock.rows[0] as { locked?: unknown } | undefined)?.locked === true;
          // ★ Re-read under the row lock: a chat used, deleted or busy since
          //   the candidates were read is skipped.
          const still = locked
            ? await db.execute(sql`
                select c.id
                  from public.mink_conversations c
                 where c.id = ${chat.id} and c.store_id = ${chat.store_id}
                   and ${retirable(floorIso)}
                   for update
              `)
            : null;
          if (!still?.rows[0]) {
            counts.skipped += 1;
          } else {
            const outcome = await retireMinkConversation(db, {
              storeId: chat.store_id,
              conversationId: chat.id,
            });
            counts[outcome] += 1;
          }
          await db.execute(sql.raw(`RELEASE SAVEPOINT ${CHAT_SAVEPOINT}`));
        } catch (error) {
          await db.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${CHAT_SAVEPOINT}`));
          await db.execute(sql.raw(`RELEASE SAVEPOINT ${CHAT_SAVEPOINT}`));
          counts.failed += 1;
          await db.execute(sql`
            update public.mink_conversations
               set retention_failed_at = now()
             where id = ${chat.id} and store_id = ${chat.store_id}
          `);
          // Content-free: ids only.
          logError("mink.retention: chat not retired", loggableError(error), {
            storeId: chat.store_id,
            conversationId: chat.id,
          });
        }
      }
    });
  }
  // One content-free line per batch.
  logInfo("mink.retention: batch", counts);
  return counts.deleted + counts.reduced;
}
