"use server";

// Dashboard bell operations stay independent of notification configuration,
// templates, POS locations and email delivery. Recipient/host filters and RLS
// remain the same as the administrative notification actions.
import { headers } from "next/headers";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { withUser, type UserIdentity } from "@/lib/db/client";
import { notifications } from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { isPlatformHost } from "@/lib/store/host";
import { logError } from "@/lib/observability/logger";

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  url: string | null;
  severity: string;
  read_at: string | null;
  created_at: string;
}

export interface InboxResult {
  notifications: NotificationRow[];
  unread: number;
  error?: string;
}

/** The bell's poll answer (takedown design 5.7, plan A14). */
export interface UnreadCounts {
  /** Every unread notification in this scope: the bell's number. */
  total: number;
  /**
   * The unread notices from StoreMink about a block on this store: the badge
   * on Settings, Notices from StoreMink. Never more than `total`.
   */
  storemink: number;
}

/**
 * The bell events the Notices badge counts: a new block and StoreMink's reply
 * about one. "Block lifted" is news, not something to act on, so it rings the
 * bell and leaves the badge alone (design 5.7).
 */
const STOREMINK_NOTICE_TYPES = [
  "store.content_blocked",
  "store.content_block_reply",
];

/** The ids this viewer's notifications can be addressed to (uid, or an
 *  operator's email). Null when signed out. */
async function currentRecipient(): Promise<{
  identity: UserIdentity;
  ids: string[];
} | null> {
  const user = await getServerUser();
  if (!user) return null;
  const ids = [user.id];
  if (user.email) ids.push(user.email.toLowerCase());
  return { identity: { uid: user.id, email: user.email ?? null }, ids };
}

/** Store scope for this request, or null on the platform host. */
async function currentScope(): Promise<{ storeId: string | null }> {
  const headersList = await headers();
  const host =
    headersList.get("x-forwarded-host") || headersList.get("host") || "";
  if (isPlatformHost(host)) return { storeId: null };
  return { storeId: await getCurrentStoreId() };
}

function scopeFilter(storeId: string | null) {
  return storeId
    ? eq(notifications.storeId, storeId)
    : isNull(notifications.storeId);
}

const INBOX_PAGE_SIZE = 20;

/**
 * The bell's dropdown: this viewer's latest live notifications in the current
 * scope, plus the unread count for the badge.
 */
export async function getMyNotifications(
  limit = INBOX_PAGE_SIZE,
): Promise<InboxResult> {
  const me = await currentRecipient();
  if (!me) return { notifications: [], unread: 0 };
  const { storeId } = await currentScope();
  const take = Math.min(Math.max(1, limit), 50);

  try {
    return await withUser(me.identity, async (db) => {
      const base = and(
        inArray(notifications.recipientId, me.ids),
        scopeFilter(storeId),
        isNull(notifications.archivedAt),
      );

      // Sequential: one pooled connection per scoped transaction serves one
      // query at a time (see order-actions.ts for the full note).
      const rows = await db
        .select({
          id: notifications.id,
          type: notifications.type,
          title: notifications.title,
          body: notifications.body,
          url: notifications.url,
          severity: notifications.severity,
          read_at: notifications.readAt,
          created_at: notifications.createdAt,
        })
        .from(notifications)
        .where(base)
        .orderBy(desc(notifications.createdAt))
        .limit(take);
      const unreadRows = await db
        .select({ n: count() })
        .from(notifications)
        .where(and(base, isNull(notifications.readAt)));

      return { notifications: rows, unread: unreadRows[0]?.n ?? 0 };
    });
  } catch (error) {
    // The bell must never take the page down with it.
    logError("notifications: inbox read failed", error);
    return {
      notifications: [],
      unread: 0,
      error: "Couldn't load notifications.",
    };
  }
}

/** A count as a whole number of zero or more (pg sends bigint as text). */
function countOf(value: unknown): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Just the badges: what the bell polls. Cheap: hits the partial unread index.
 *
 * ★ ONE QUERY GIVES BOTH NUMBERS. The StoreMink count is a FILTER on the same
 * unread rows, so the Notices badge costs no read of its own and the
 * dashboard layout gains none: the bell already polls this, and hands both
 * numbers to the sidebar through `unread-counts-context.tsx`. A failed read is
 * zero for both, so a blip hides the badges rather than breaking the page.
 */
export async function getUnreadNotificationCount(): Promise<UnreadCounts> {
  const me = await currentRecipient();
  if (!me) return { total: 0, storemink: 0 };
  const { storeId } = await currentScope();

  try {
    return await withUser(me.identity, async (db) => {
      const rows = await db
        .select({
          total: count(),
          storemink: sql<number>`count(*) filter (where ${inArray(
            notifications.type,
            STOREMINK_NOTICE_TYPES,
          )})`.mapWith(Number),
        })
        .from(notifications)
        .where(
          and(
            inArray(notifications.recipientId, me.ids),
            scopeFilter(storeId),
            isNull(notifications.archivedAt),
            isNull(notifications.readAt),
          ),
        );
      const total = countOf(rows[0]?.total);
      return { total, storemink: Math.min(total, countOf(rows[0]?.storemink)) };
    });
  } catch (error) {
    logError("notifications: unread count failed", error);
    return { total: 0, storemink: 0 };
  }
}

/** Mark one notification read. Ownership is enforced by the recipient filter
 *  AND by RLS — a guessed id from another inbox updates zero rows. */
export async function markNotificationRead(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const me = await currentRecipient();
  if (!me) return { error: "Not signed in." };
  if (!id) return { error: "Missing notification." };

  try {
    await withUser(me.identity, (db) =>
      db
        .update(notifications)
        .set({ readAt: sql`NOW()` })
        .where(
          and(
            eq(notifications.id, id),
            inArray(notifications.recipientId, me.ids),
            isNull(notifications.readAt),
          ),
        ),
    );
    return { success: true };
  } catch (error) {
    logError("notifications: mark read failed", error);
    return { error: "Couldn't update that notification." };
  }
}

export async function markAllNotificationsRead(): Promise<{
  success?: boolean;
  error?: string;
}> {
  const me = await currentRecipient();
  if (!me) return { error: "Not signed in." };
  const { storeId } = await currentScope();

  try {
    await withUser(me.identity, (db) =>
      db
        .update(notifications)
        .set({ readAt: sql`NOW()` })
        .where(
          and(
            inArray(notifications.recipientId, me.ids),
            scopeFilter(storeId),
            isNull(notifications.readAt),
          ),
        ),
    );
    return { success: true };
  } catch (error) {
    logError("notifications: mark all read failed", error);
    return { error: "Couldn't update your notifications." };
  }
}

/** Dismiss a notification from the inbox (kept in the DB for the audit trail). */
export async function archiveNotification(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const me = await currentRecipient();
  if (!me) return { error: "Not signed in." };

  try {
    await withUser(me.identity, (db) =>
      db
        .update(notifications)
        .set({ archivedAt: sql`NOW()`, readAt: sql`COALESCE(read_at, NOW())` })
        .where(
          and(
            eq(notifications.id, id),
            inArray(notifications.recipientId, me.ids),
          ),
        ),
    );
    return { success: true };
  } catch (error) {
    logError("notifications: archive failed", error);
    return { error: "Couldn't dismiss that notification." };
  }
}
