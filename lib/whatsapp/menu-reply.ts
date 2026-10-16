import "server-only";

import { eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { stores, whatsappAutoReplies } from "@/drizzle/schema";
import { normalizeAnalyticsTimeZone } from "@/lib/analytics/range";
import { logError, logInfo } from "@/lib/observability/logger";
import { storeOrigin } from "@/lib/site";
import { isStorefrontGated, isThemePending } from "@/lib/store/launch-state";
import { loadWhatsAppSender } from "./channel";
import { replyInChat } from "./auto-reply";
import {
  DEFAULT_PERSON_TEXT,
  normalizeMenuButtons,
  type MenuButton,
} from "./auto-reply-settings";
import { lookupOrdersForPhone, orderStatusAnswer } from "./order-status-reply";

// ---------------------------------------------------------------------------
// What a tap on one of the store's menu buttons does (docs/whatsapp-commerce-
// plan.md §4 Automation; stories WA-6.x). The tap is filed as an automated
// message by inbox.ts (no unread, no Needs reply, no bell), and this runs
// after the commit, the cod-confirmation.ts shape.
//
// ★ THE BUTTON IS LOOKED UP IN THE STORE'S CURRENT SETTINGS, not trusted from
// the tap. The reply id names a button (menu-payload.ts) and nothing more; a
// merchant may have changed or removed the button since the message went
// out, and then the tap hands the chat to a person rather than doing what the
// old button used to.
//
// ★ "TALK TO A PERSON" IS THE ONE BUTTON THAT RINGS. It acknowledges the tap
// and hands the conversation over, which is what the customer asked for. The
// other two answer by themselves and hand over only when they cannot: no
// order to report, a delivery in trouble, or a reply Meta would not take.
// ---------------------------------------------------------------------------

export interface MenuReplyInput {
  storeId: string;
  conversationId: string;
  /** The customer's phone, E.164. */
  phone: string;
  /** The account on this store whose phone matched the contact, if any. */
  userId: string | null;
  /** The tapped button's id, as parsed off the reply id. */
  buttonId: string;
  now?: Date;
}

export type MenuReplyOutcome =
  | "order_status"
  | "person"
  | "text"
  | "unknown_button"
  | "no_sender"
  | "failed";

export interface MenuReplyResult {
  outcome: MenuReplyOutcome;
  /** A person has to take it from here: the caller hands the chat over. */
  needsHuman: boolean;
}

interface MenuConfig {
  buttons: MenuButton[];
  menuEnabled: boolean;
  storeName: string | null;
  timeZone: string;
  ordersUrl: string | null;
}

async function loadMenuConfig(storeId: string): Promise<MenuConfig | null> {
  const rows = await withService((db) =>
    db
      .select({
        name: stores.name,
        slug: stores.slug,
        customDomain: stores.customDomain,
        settings: stores.settings,
        plan: stores.plan,
        planExpiresAt: stores.planExpiresAt,
        compPlan: stores.compPlan,
        compExpiresAt: stores.compExpiresAt,
        menuEnabled: whatsappAutoReplies.menuEnabled,
        menuButtons: whatsappAutoReplies.menuButtons,
      })
      .from(stores)
      .leftJoin(whatsappAutoReplies, eq(whatsappAutoReplies.storeId, stores.id))
      .where(eq(stores.id, storeId))
      .limit(1),
  );
  const row = rows[0];
  if (!row) return null;
  const storeSettings = (row.settings as Record<string, unknown>) ?? {};
  const business =
    storeSettings.business && typeof storeSettings.business === "object"
      ? (storeSettings.business as Record<string, unknown>)
      : {};
  const store = { settings: storeSettings };
  const ordersUrl =
    isStorefrontGated(store) || isThemePending(store)
      ? null
      : `${storeOrigin({
          slug: row.slug,
          custom_domain: row.customDomain,
          settings: storeSettings,
          plan: row.plan,
          plan_expires_at: row.planExpiresAt,
          comp_plan: row.compPlan,
          comp_expires_at: row.compExpiresAt,
        })}/orders`;
  return {
    buttons: normalizeMenuButtons(row.menuButtons),
    menuEnabled: row.menuEnabled === true,
    storeName: row.name,
    timeZone: normalizeAnalyticsTimeZone(business.timeZone),
    ordersUrl,
  };
}

/** Act on one tap. Never throws; a failure is reported as `failed`. */
export async function handleMenuReply(
  input: MenuReplyInput,
): Promise<MenuReplyResult> {
  const { storeId, conversationId } = input;
  const now = input.now ?? new Date();

  let config: MenuConfig | null;
  try {
    config = await loadMenuConfig(storeId);
  } catch (err) {
    logError("whatsapp menu: settings unreadable", err, { storeId });
    return { outcome: "failed", needsHuman: true };
  }
  const button = config?.menuEnabled
    ? config.buttons.find((b) => b.id === input.buttonId)
    : undefined;
  if (!config || !button) {
    // The button is gone (or the menu is off): the customer's tap is already
    // in the thread as their words, and a person reads it.
    logInfo("whatsapp menu: tap on a button that no longer exists", {
      storeId,
      buttonId: input.buttonId,
    });
    return { outcome: "unknown_button", needsHuman: true };
  }

  const sender = await withService((db) =>
    loadWhatsAppSender(db, storeId),
  ).catch(() => null);
  if (!sender) {
    // Paused or lapsed: nothing can be said, so somebody has to read it.
    return { outcome: "no_sender", needsHuman: true };
  }

  if (button.action === "order_status") {
    const lookup = await lookupOrdersForPhone({
      storeId,
      phone: input.phone,
      userId: input.userId,
    });
    const answer = orderStatusAnswer({
      lookup,
      storeName: config.storeName,
      timeZone: config.timeZone,
      now,
      ordersUrl: config.ordersUrl,
    });
    const delivered = await replyInChat({
      storeId,
      conversationId,
      to: input.phone,
      body: answer.body,
      reason: "menu:order_status",
      sender,
    });
    return {
      outcome: "order_status",
      needsHuman: answer.needsHuman || !delivered,
    };
  }

  if (button.action === "person") {
    await replyInChat({
      storeId,
      conversationId,
      to: input.phone,
      body: button.text || DEFAULT_PERSON_TEXT,
      reason: "menu:person",
      sender,
    });
    // Whether or not the acknowledgement went, the customer asked for a person.
    return { outcome: "person", needsHuman: true };
  }

  const delivered = await replyInChat({
    storeId,
    conversationId,
    to: input.phone,
    body: button.text,
    reason: "menu:text",
    sender,
  });
  return { outcome: "text", needsHuman: !delivered };
}
