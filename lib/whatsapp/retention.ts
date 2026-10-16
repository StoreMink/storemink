import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  gcsConfigured,
  gcsDeletePrefix,
  gcsPrivateConfigured,
} from "@/lib/storage/gcs";
import { logWarn } from "@/lib/observability/logger";

// ---------------------------------------------------------------------------
// How long an inbox conversation is kept (owner's decision, 2026-10-13): a
// CLOSED conversation is deleted two years after its last message, with every
// message in it (whatsapp_messages cascades) and every photo or file the
// customer sent (our bucket, stores/{store}/whatsapp/{conversation}/).
//
// ★ ONLY CLOSED. A conversation waiting on the shop (needs_reply) or still
// going (open) is work, whatever its age. And a closed one reopens by itself
// when the customer writes, so "closed and silent for two years" is a chat
// nobody has touched since.
//
// ★ THE CONTACT STAYS. whatsapp_contacts holds the customer's consent and
// opt-out with the exact words they agreed to; that record is evidence, not
// conversation, and deleting it would forget a STOP.
//
// ★ MEDIA FIRST, ROWS SECOND. A photo that outlived its chat would be a
// customer's picture nobody can find to delete. Media lives in the private
// bucket; older chats may still have theirs in the public one (stored before
// the private bucket existed), so both folders are emptied. A conversation
// whose media could not be removed keeps its rows, is marked
// (retention_failed_at), and is left out of the oldest-first batch for
// RETRY_FAILED_AFTER_DAYS, so one stuck chat cannot hold the batch for ever.
// ---------------------------------------------------------------------------

export const CLOSED_CONVERSATION_RETENTION_DAYS = 730;

/** How long a conversation whose media could not be deleted is skipped. */
export const RETRY_FAILED_AFTER_DAYS = 7;

/** The bucket folder holding one conversation's media. */
export function conversationMediaPrefix(
  storeId: string,
  conversationId: string,
): string {
  return `stores/${storeId}/whatsapp/${conversationId}/`;
}

/**
 * Deletes up to `limit` closed conversations whose last message is older
 * than `floorIso`. Returns how many were deleted (a retention batch).
 */
export async function pruneClosedConversations(
  floorIso: string,
  limit: number,
): Promise<number> {
  const doomed = await withService(async (db) => {
    const rows = await db.execute<{
      id: string;
      store_id: string;
      has_media: boolean;
    }>(sql`
      select c.id, c.store_id,
             exists (
               select 1 from public.whatsapp_messages m
                where m.conversation_id = c.id and m.media_path is not null
             ) as has_media
        from public.whatsapp_conversations c
       where c.status = 'closed'
         and coalesce(c.last_message_at, c.updated_at) < ${floorIso}::timestamptz
         and (c.retention_failed_at is null
              or c.retention_failed_at < now() - make_interval(days => ${RETRY_FAILED_AFTER_DAYS}))
       order by coalesce(c.last_message_at, c.updated_at)
       limit ${limit}
    `);
    return rows.rows;
  });
  if (doomed.length === 0) return 0;

  const deletable: string[] = [];
  const stuck: string[] = [];
  for (const conversation of doomed) {
    if (conversation.has_media) {
      const removed = await deleteConversationMedia(
        conversation.store_id,
        conversation.id,
      );
      if (!removed) {
        logWarn("whatsapp retention: media kept, conversation kept", {
          storeId: conversation.store_id,
        });
        stuck.push(conversation.id);
        continue;
      }
    }
    deletable.push(conversation.id);
  }
  if (stuck.length > 0) {
    // Best-effort: an unmarked row is only tried again tomorrow.
    await withService((db) =>
      db.execute(sql`
        update public.whatsapp_conversations
           set retention_failed_at = now()
         where id = any(${sql.param(stuck)}::uuid[])
      `),
    ).catch(() => undefined);
  }
  if (deletable.length === 0) return 0;

  // ★ Re-checked inside the delete: a customer who wrote in between reopened
  // the conversation, and it is no longer the stale chat this run selected.
  // (Its old media is already gone in that race; the new message's is not,
  // since it was stored after the delete. Seconds wide, on a two-year-old
  // chat, and the alternative is media outliving rows.)
  return withService(async (db) => {
    const res = await db.execute(sql`
      delete from public.whatsapp_conversations
       where id = any(${sql.param(deletable)}::uuid[])
         and status = 'closed'
         and coalesce(last_message_at, updated_at) < ${floorIso}::timestamptz
    `);
    return res.rowCount ?? 0;
  });
}

/**
 * Empty one conversation's media folder in every bucket it may be in. True
 * only when nothing could have been left behind.
 */
async function deleteConversationMedia(
  storeId: string,
  conversationId: string,
): Promise<boolean> {
  const prefix = conversationMediaPrefix(storeId, conversationId);
  let ok = true;
  if (gcsPrivateConfigured) {
    const res = await gcsDeletePrefix(prefix, "private");
    if (res.error || res.failed > 0) ok = false;
  }
  // Media stored before the private bucket existed is in the public one.
  if (gcsConfigured) {
    const res = await gcsDeletePrefix(prefix, "public");
    if (res.error || res.failed > 0) ok = false;
  }
  return ok;
}
