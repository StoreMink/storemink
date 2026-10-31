"use server";

import {
  getActingStoreId,
  getManagerIdentity,
  getViewerContext,
} from "@/app/dashboard/lib/access";
import { can } from "@/app/dashboard/lib/permissions";
import { loggableError } from "@/lib/db/errors";
import { NOTICE, NOTICE_REPLY } from "@/lib/moderation/copy";
import { markNoticeSeen, replyToStoreNotice } from "@/lib/moderation/merchant";
import { logError } from "@/lib/observability/logger";

/**
 * The store's two actions on a notice from StoreMink (takedown stage T18a,
 * design 3.4 and 7.1): reply, and mark the notice seen. Every export of a
 * "use server" file is a public endpoint, so each re-derives who is asking
 * and which store from the session and the request host; the browser names
 * only the notice.
 *
 * Reading needs Settings view; replying needs Settings manage (A21), the gate
 * `getManagerIdentity("settings")` answers. A block kept from the store is
 * "not found" here as everywhere (D21): lib/moderation/merchant.ts holds that
 * boundary.
 */

export interface StoreNoticeActionResult {
  ok: boolean;
  /** The sentence to show when `ok` is false. */
  error?: string;
}

/** Send the store's reply on a notice. */
export async function replyToStoreNoticeAction(
  blockId: string,
  body: string,
  asksReview: boolean,
): Promise<StoreNoticeActionResult> {
  try {
    const viewer = await getManagerIdentity("settings");
    if (!viewer) return { ok: false, error: NOTICE_REPLY.errors.noPermission };
    const storeId = await getActingStoreId();
    const result = await replyToStoreNotice(
      storeId,
      {
        blockId: typeof blockId === "string" ? blockId : "",
        body: typeof body === "string" ? body : "",
        asksReview: asksReview === true,
      },
      viewer,
    );
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (err) {
    logError("moderation: store reply action failed", loggableError(err));
    return { ok: false, error: NOTICE_REPLY.failed };
  }
}

/**
 * Someone at the store opened a notice. Needs Settings view, like the page;
 * anything else is "not found", so the answer never says whether a notice
 * the viewer may not read exists.
 */
export async function markStoreNoticeSeenAction(
  blockId: string,
): Promise<StoreNoticeActionResult> {
  try {
    const ctx = await getViewerContext();
    if (
      !ctx?.profile ||
      ctx.dbError ||
      !can(ctx.permissions, "settings", "view", ctx.isSuperadmin)
    ) {
      return { ok: false, error: NOTICE.notFound };
    }
    const seen = await markNoticeSeen(
      ctx.storeId,
      typeof blockId === "string" ? blockId : "",
      { uid: ctx.userId, email: ctx.userEmail },
    );
    return seen ? { ok: true } : { ok: false, error: NOTICE.notFound };
  } catch (err) {
    logError("moderation: notice seen action failed", loggableError(err));
    return { ok: false, error: NOTICE.notFound };
  }
}
