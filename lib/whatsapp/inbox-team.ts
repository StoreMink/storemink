import "server-only";

import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  INBOX_CANNED_MAX,
  INBOX_LABEL_MAX,
  INBOX_NOTE_MAX,
  validateCannedReply,
  validateInboxLabel,
} from "./inbox-workspace";

// ---------------------------------------------------------------------------
// The inbox's team writes: assignment, labels, notes, saved replies. Every
// function takes the TRUSTED store id and puts it in every statement; the
// tables are service-only, so that predicate is the tenant boundary, and an
// id from the browser (a label, a note, a person) is a claim checked against
// the store before it changes anything.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
function asRows<T = Rec>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

export type TeamResult<T = null> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: "not_found" | "limit" | "invalid" };

/**
 * Put a person on a conversation, or take them off (null). The assignee must
 * be one of the store's own admins; "assigned to nobody named" is what a
 * stale id would read as, so a foreign id is refused rather than stored.
 * Returns whether the row changed hands, for the notification.
 */
export async function assignConversation(
  db: Db,
  input: {
    storeId: string;
    conversationId: string;
    adminId: string | null;
  },
): Promise<TeamResult<{ changed: boolean; previous: string | null }>> {
  if (input.adminId) {
    const admin = asRows<{ id: string }>(
      await db.execute(sql`
        select id from public.admins
         where store_id = ${input.storeId}::uuid
           and id = ${input.adminId}
           and coalesce(is_suspended, false) = false
         limit 1
      `),
    );
    if (admin.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: "That person is not on this store.",
      };
    }
  }
  const rows = asRows<{ previous: string | null }>(
    await db.execute(sql`
      update public.whatsapp_conversations c
         set assigned_admin_id = ${input.adminId},
             updated_at = now()
        from (select id, assigned_admin_id as previous
                from public.whatsapp_conversations
               where id = ${input.conversationId}::uuid
                 and store_id = ${input.storeId}::uuid
               for update) p
       where c.id = p.id
       returning p.previous
    `),
  );
  if (rows.length === 0) {
    return { ok: false, code: "not_found", error: "Not found." };
  }
  const previous = rows[0]?.previous ?? null;
  return {
    ok: true,
    value: { changed: previous !== input.adminId, previous },
  };
}

/**
 * Put ONE label on a conversation, or take it off, in the caller's
 * transaction, and return the labels it carries afterwards.
 *
 * ★ A CHANGE, NEVER A WHOLE SET. The screen used to send the full set it
 * believed the conversation had, and the write deleted everything else: a
 * second click before the refresh landed, or a teammate's label not yet
 * polled, was silently removed. One label in, one label out, so a stale
 * screen can only ever touch the label that was clicked.
 *
 * The conversation is locked under the store, a label being added must be
 * the store's own (a foreign id is refused, never attached), and a
 * conversation carries at most INBOX_LABEL_MAX labels. Removing is scoped by
 * the store and the conversation, so it can only take off this store's link.
 */
export async function setConversationLabel(
  db: Db,
  input: {
    storeId: string;
    conversationId: string;
    labelId: string;
    on: boolean;
  },
): Promise<TeamResult<{ labelIds: string[] }>> {
  const owned = asRows<{ id: string }>(
    await db.execute(sql`
      select id from public.whatsapp_conversations
       where id = ${input.conversationId}::uuid and store_id = ${input.storeId}::uuid
       for update
    `),
  );
  if (owned.length === 0) {
    return { ok: false, code: "not_found", error: "Not found." };
  }
  if (input.on) {
    // The label is the store's own, and how many OTHER labels the
    // conversation already carries, in one read: no row means not ours.
    const label = asRows<{ others: number }>(
      await db.execute(sql`
        select (select count(*)::int from public.whatsapp_conversation_labels cl
                 where cl.conversation_id = ${input.conversationId}::uuid
                   and cl.store_id = ${input.storeId}::uuid
                   and cl.label_id <> l.id) as others
          from public.whatsapp_labels l
         where l.id = ${input.labelId}::uuid and l.store_id = ${input.storeId}::uuid
      `),
    );
    if (label.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: "That label no longer exists.",
      };
    }
    if (Number(label[0]?.others ?? 0) >= INBOX_LABEL_MAX) {
      return {
        ok: false,
        code: "limit",
        error: `A conversation can carry up to ${INBOX_LABEL_MAX} labels.`,
      };
    }
    await db.execute(sql`
      insert into public.whatsapp_conversation_labels (store_id, conversation_id, label_id)
      values (${input.storeId}::uuid, ${input.conversationId}::uuid, ${input.labelId}::uuid)
      on conflict do nothing
    `);
  } else {
    await db.execute(sql`
      delete from public.whatsapp_conversation_labels
       where conversation_id = ${input.conversationId}::uuid
         and store_id = ${input.storeId}::uuid
         and label_id = ${input.labelId}::uuid
    `);
  }
  const after = asRows<{ label_id: string }>(
    await db.execute(sql`
      select label_id::text as label_id from public.whatsapp_conversation_labels
       where conversation_id = ${input.conversationId}::uuid
         and store_id = ${input.storeId}::uuid
       order by created_at
    `),
  );
  return { ok: true, value: { labelIds: after.map((r) => r.label_id) } };
}

/** Create or rename a label. The count is enforced here, the shape by the
 *  shared validator (the dialog ran it too; this is the boundary). */
export async function saveLabel(
  db: Db,
  input: { storeId: string; id: string | null; name: unknown; color: unknown },
): Promise<TeamResult<{ id: string }>> {
  const v = validateInboxLabel({ name: input.name, color: input.color });
  if (!v.ok) return { ok: false, code: "invalid", error: v.error };
  if (input.id) {
    const rows = asRows<{ id: string }>(
      await db.execute(sql`
        update public.whatsapp_labels
           set name = ${v.name}, color = ${v.color}, updated_at = now()
         where id = ${input.id}::uuid and store_id = ${input.storeId}::uuid
         returning id
      `),
    ).map((r) => r.id);
    const id = rows[0];
    if (!id) return { ok: false, code: "not_found", error: "Not found." };
    return { ok: true, value: { id } };
  }
  // ★ The count is read under the store's own advisory lock, so two people
  // adding the twentieth label at once cannot make twenty-one.
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${"whatsapp-labels:" + input.storeId}))`,
  );
  const count = asRows<{ n: number }>(
    await db.execute(sql`
      select count(*)::int as n from public.whatsapp_labels where store_id = ${input.storeId}::uuid
    `),
  );
  if (Number(count[0]?.n ?? 0) >= INBOX_LABEL_MAX) {
    return {
      ok: false,
      code: "limit",
      error: `A store can have up to ${INBOX_LABEL_MAX} labels. Delete one to add another.`,
    };
  }
  const rows = asRows<{ id: string }>(
    await db.execute(sql`
      insert into public.whatsapp_labels (store_id, name, color, position)
      values (${input.storeId}::uuid, ${v.name}, ${v.color},
              (select coalesce(max(position), 0) + 1 from public.whatsapp_labels where store_id = ${input.storeId}::uuid))
      returning id
    `),
  );
  const id = rows[0]?.id;
  if (!id) return { ok: false, error: "Couldn't save the label." };
  return { ok: true, value: { id } };
}

export async function deleteLabel(
  db: Db,
  input: { storeId: string; id: string },
): Promise<TeamResult> {
  const rows = asRows<{ id: string }>(
    await db.execute(sql`
      delete from public.whatsapp_labels
       where id = ${input.id}::uuid and store_id = ${input.storeId}::uuid
       returning id
    `),
  );
  if (rows.length === 0)
    return { ok: false, code: "not_found", error: "Not found." };
  return { ok: true, value: null };
}

export async function addNote(
  db: Db,
  input: {
    storeId: string;
    conversationId: string;
    adminId: string;
    body: unknown;
  },
): Promise<TeamResult<{ id: string }>> {
  const body =
    typeof input.body === "string"
      ? input.body.replace(/\r\n/g, "\n").trim()
      : "";
  if (!body)
    return { ok: false, code: "invalid", error: "Write the note first." };
  if (body.length > INBOX_NOTE_MAX) {
    return {
      ok: false,
      code: "invalid",
      error: `A note can be at most ${INBOX_NOTE_MAX} characters.`,
    };
  }
  const rows = asRows<{ id: string }>(
    await db.execute(sql`
      insert into public.whatsapp_conversation_notes (store_id, conversation_id, admin_id, body)
      select ${input.storeId}::uuid, c.id, ${input.adminId}, ${body}
        from public.whatsapp_conversations c
       where c.id = ${input.conversationId}::uuid and c.store_id = ${input.storeId}::uuid
      returning id
    `),
  );
  const id = rows[0]?.id;
  if (!id) return { ok: false, code: "not_found", error: "Not found." };
  return { ok: true, value: { id } };
}

export async function deleteNote(
  db: Db,
  input: { storeId: string; id: string },
): Promise<TeamResult> {
  const rows = asRows<{ id: string }>(
    await db.execute(sql`
      delete from public.whatsapp_conversation_notes
       where id = ${input.id}::uuid and store_id = ${input.storeId}::uuid
       returning id
    `),
  );
  if (rows.length === 0)
    return { ok: false, code: "not_found", error: "Not found." };
  return { ok: true, value: null };
}

export async function saveCannedReply(
  db: Db,
  input: {
    storeId: string;
    id: string | null;
    adminId: string;
    shortcut: unknown;
    title: unknown;
    body: unknown;
  },
): Promise<TeamResult<{ id: string }>> {
  const v = validateCannedReply({
    shortcut: input.shortcut,
    title: input.title,
    body: input.body,
  });
  if (!v.ok) return { ok: false, code: "invalid", error: v.error };
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${"whatsapp-canned:" + input.storeId}))`,
  );
  const taken = asRows<{ id: string }>(
    await db.execute(sql`
      select id from public.whatsapp_canned_replies
       where store_id = ${input.storeId}::uuid and shortcut = ${v.shortcut}
         ${input.id ? sql`and id <> ${input.id}::uuid` : sql``}
       limit 1
    `),
  );
  if (taken.length > 0) {
    return {
      ok: false,
      code: "invalid",
      error: `"/${v.shortcut}" is already used by another saved reply.`,
    };
  }
  if (input.id) {
    const rows = asRows<{ id: string }>(
      await db.execute(sql`
        update public.whatsapp_canned_replies
           set shortcut = ${v.shortcut}, title = ${v.title}, body = ${v.body}, updated_at = now()
         where id = ${input.id}::uuid and store_id = ${input.storeId}::uuid
         returning id
      `),
    );
    const id = rows[0]?.id;
    if (!id) return { ok: false, code: "not_found", error: "Not found." };
    return { ok: true, value: { id } };
  }
  const count = asRows<{ n: number }>(
    await db.execute(sql`
      select count(*)::int as n from public.whatsapp_canned_replies where store_id = ${input.storeId}::uuid
    `),
  );
  if (Number(count[0]?.n ?? 0) >= INBOX_CANNED_MAX) {
    return {
      ok: false,
      code: "limit",
      error: `A store can have up to ${INBOX_CANNED_MAX} saved replies. Delete one to add another.`,
    };
  }
  const rows = asRows<{ id: string }>(
    await db.execute(sql`
      insert into public.whatsapp_canned_replies (store_id, shortcut, title, body, position, created_by)
      values (${input.storeId}::uuid, ${v.shortcut}, ${v.title}, ${v.body},
              (select coalesce(max(position), 0) + 1 from public.whatsapp_canned_replies where store_id = ${input.storeId}::uuid),
              ${input.adminId})
      returning id
    `),
  );
  const id = rows[0]?.id;
  if (!id) return { ok: false, error: "Couldn't save the reply." };
  return { ok: true, value: { id } };
}

export async function deleteCannedReply(
  db: Db,
  input: { storeId: string; id: string },
): Promise<TeamResult> {
  const rows = asRows<{ id: string }>(
    await db.execute(sql`
      delete from public.whatsapp_canned_replies
       where id = ${input.id}::uuid and store_id = ${input.storeId}::uuid
       returning id
    `),
  );
  if (rows.length === 0)
    return { ok: false, code: "not_found", error: "Not found." };
  return { ok: true, value: null };
}
