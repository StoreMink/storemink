"use server";

// ---------------------------------------------------------------------------
// The WhatsApp automatic replies a store sends (Inbox → Automatic replies):
// the welcome message, the away message with its business hours, and
// answering "where is my order?". Read with Inbox: view, saved with Inbox:
// manage, because they are how the inbox's conversations are handled. The
// store comes from the host and the session, never from the browser.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import { getActingStoreId, getViewerAccess } from "@/app/dashboard/lib/access";
import { logError } from "@/lib/observability/logger";
import { getStoreAnalyticsTimeZone } from "@/lib/analytics/settings";
import { analyticsTimeZoneLabel } from "@/lib/analytics/range";
import {
  loadAutoReplies,
  saveAutoReplies,
} from "@/lib/whatsapp/auto-reply-store";
import {
  validateAutoReplySettings,
  type WhatsAppAutoReplySettings,
} from "@/lib/whatsapp/auto-reply-settings";

export interface AutoRepliesView {
  settings: WhatsAppAutoReplySettings;
  /** False until the first save: every reply is still off. */
  saved: boolean;
  canManage: boolean;
  /** The zone the business hours are read in, as Settings names it. */
  timeZoneLabel: string;
  /** Whether this viewer can change that zone (Settings: manage). */
  canChangeTimeZone: boolean;
}

export async function getWhatsAppAutoReplies(): Promise<
  { ok: true; view: AutoRepliesView } | { ok: false; error: string }
> {
  const access = await getViewerAccess();
  if (!access || !access.can("inbox", "view")) {
    return {
      ok: false,
      error: "You don't have permission to view the inbox.",
    };
  }
  const storeId = await getActingStoreId();
  try {
    const [stored, timeZone] = await Promise.all([
      withService((db) => loadAutoReplies(db, storeId)),
      getStoreAnalyticsTimeZone(storeId),
    ]);
    return {
      ok: true,
      view: {
        settings: stored.settings,
        saved: stored.saved,
        canManage: access.can("inbox", "manage"),
        timeZoneLabel: analyticsTimeZoneLabel(timeZone),
        canChangeTimeZone: access.can("settings", "manage"),
      },
    };
  } catch (err) {
    logError("whatsapp auto-replies: read failed", err, { storeId });
    return {
      ok: false,
      error: "Couldn't load your automatic replies. Please try again.",
    };
  }
}

export async function saveWhatsAppAutoReplies(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const access = await getViewerAccess();
  if (!access || !access.can("inbox", "manage")) {
    return {
      ok: false,
      error: "You don't have permission to change automatic replies.",
    };
  }
  // ★ The form checks the same rules first; this is the check that counts.
  const checked = validateAutoReplySettings(input);
  if (!checked.ok) return checked;

  const storeId = await getActingStoreId();
  try {
    await withService((db) =>
      saveAutoReplies(db, {
        storeId,
        settings: checked.settings,
        updatedBy: access.userId,
      }),
    );
  } catch (err) {
    logError("whatsapp auto-replies: save failed", err, { storeId });
    return {
      ok: false,
      error: "Couldn't save your automatic replies. Please try again.",
    };
  }
  revalidatePath("/dashboard/inbox/settings");
  return { ok: true };
}
