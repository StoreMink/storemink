import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { gcsConfigured, gcsDeletePrefix } from "@/lib/storage/gcs";
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
// ★ MEDIA FIRST, ROWS SECOND. The bucket is public by URL, so a photo that
// outlived its chat would be a customer's picture nobody can find to delete.
// A conversation whose media could not be removed keeps its rows and is tried
// again on the next run; the rest of the batch goes ahead.
// ---------------------------------------------------------------------------

export const CLOSED_CONVERSATION_RETENTION_DAYS = 730;

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
       order by coalesce(c.last_message_at, c.updated_at)
       limit ${limit}
    `);
    return rows.rows;
  });
  if (doomed.length === 0) return 0;

  const deletable: string[] = [];
  for (const conversation of doomed) {
    if (conversation.has_media && gcsConfigured) {
      const res = await gcsDeletePrefix(
        conversationMediaPrefix(conversation.store_id, conversation.id),
      );
      if (res.error || res.failed > 0) {
        logWarn("whatsapp retention: media kept, conversation kept", {
          storeId: conversation.store_id,
          failed: res.failed,
        });
        continue;
      }
    }
    deletable.push(conversation.id);
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
