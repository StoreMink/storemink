import "server-only";

import { eq, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { stores, whatsappAutoReplies } from "@/drizzle/schema";
import { normalizeAnalyticsTimeZone } from "@/lib/analytics/range";
import { logError, logInfo } from "@/lib/observability/logger";
import { storeOrigin } from "@/lib/site";
import { isStorefrontGated, isThemePending } from "@/lib/store/launch-state";
import { loadWhatsAppSender } from "./channel";
import { replyInChat } from "./auto-reply";
import {
  AWAY_AFTER_HUMAN_REPLY_HOURS,
  WELCOME_QUIET_DAYS,
  autoReplySettingsFromRow,
  type WhatsAppAutoReplySettings,
} from "./auto-reply-settings";
import { isOpenAt, openedBetween } from "./business-hours";
import type { InboxMessageKind } from "./inbox-parse";
import { lookupOrdersForPhone, orderStatusAnswer } from "./order-status-reply";

// ---------------------------------------------------------------------------
// The automatic replies a customer's message can get (docs/whatsapp-commerce-
// plan.md §4 Automation; stories WA-5.x): the merchant's welcome message, their
// away message outside business hours, and the answer to "where is my order?".
// Called by inbound.ts once the message is filed; a COD tap and a STOP/START
// have their own answers and never come here.
//
// ★ ONE MESSAGE, NOT THREE. Whatever applies is joined into a single reply,
// welcome first and away last, so a new customer writing at night reads one
// friendly paragraph rather than a burst of notifications.
//
// ★★ EACH IS CLAIMED BEFORE IT IS SENT, so nothing loops and nothing repeats.
// The welcome goes once per WELCOME_QUIET_DAYS, the away message once until the
// store has opened again, each by a conditional UPDATE on the conversation, so
// two messages arriving together get one reply. Two businesses whose away
// messages answer each other stop after one round.
//
// ★ A WELCOME OR AN AWAY MESSAGE DOES NOT ANSWER THE CUSTOMER. The conversation
// stays in Needs reply with the bell rung, because a person still has to read
// it. Only "where is my order?", answered with a real order, is resolved by the
// system; it goes to a person when nothing was found, when the lookup failed,
// when a delivery is in trouble, or when the answer could not be sent.
//
// ★ NOTHING IS CLAIMED WHEN NOTHING CAN BE SENT. A paused number or a lapsed
// plan returns before any claim, so a customer who wrote while the number was
// paused still gets the welcome once it is back.
// ---------------------------------------------------------------------------

export interface AnswerInput {
  storeId: string;
  conversationId: string;
  /** The customer's phone, E.164, as stored on the contact. */
  phone: string;
  /** The account on this store whose phone matched the contact, if any. */
  userId: string | null;
  kind: InboxMessageKind | null;
  /** Filed as "where is my order?" for a store that answers it. */
  orderQuestion: boolean;
  /** First message, or the first after WELCOME_QUIET_DAYS of silence. */
  welcomeEligible: boolean;
  now?: Date;
}

export interface AnswerResult {
  /** The conversation must wait for a person (the order question was not
   *  answered); the caller marks it needs-reply and rings the bell. */
  handOver: boolean;
  /** What was sent, for the logs and the tests. */
  sent: Array<"welcome" | "order_status" | "away">;
}

/** A reaction to one of our messages is not somebody starting a chat. */
const NO_GREETING_KINDS: ReadonlySet<InboxMessageKind> = new Set([
  "reaction",
  "template",
]);

interface Config {
  settings: WhatsAppAutoReplySettings;
  storeName: string | null;
  timeZone: string;
  ordersUrl: string | null;
}

async function loadConfig(storeId: string): Promise<Config | null> {
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
        welcomeEnabled: whatsappAutoReplies.welcomeEnabled,
        welcomeText: whatsappAutoReplies.welcomeText,
        awayEnabled: whatsappAutoReplies.awayEnabled,
        awayText: whatsappAutoReplies.awayText,
        businessHours: whatsappAutoReplies.businessHours,
        orderStatusEnabled: whatsappAutoReplies.orderStatusEnabled,
        savedAt: whatsappAutoReplies.updatedAt,
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
  // The order page, only where the public can open it.
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
    settings: autoReplySettingsFromRow(
      row.savedAt
        ? {
            welcomeEnabled: row.welcomeEnabled === true,
            welcomeText: row.welcomeText ?? "",
            awayEnabled: row.awayEnabled === true,
            awayText: row.awayText ?? "",
            businessHours: row.businessHours,
            orderStatusEnabled: row.orderStatusEnabled === true,
          }
        : null,
      row.name,
    ),
    storeName: row.name,
    timeZone: normalizeAnalyticsTimeZone(business.timeZone),
    ordersUrl,
  };
}

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

/** Claim this conversation's welcome. True when this call won it. */
async function claimWelcome(
  storeId: string,
  conversationId: string,
): Promise<boolean> {
  const rows = asRows(
    await withService((db) =>
      db.execute(sql`
        update public.whatsapp_conversations set welcome_sent_at = now()
         where id = ${conversationId}::uuid
           and store_id = ${storeId}::uuid
           and (welcome_sent_at is null
                or welcome_sent_at < now() - make_interval(days => ${WELCOME_QUIET_DAYS}))
        returning id
      `),
    ),
  );
  return rows.length > 0;
}

/**
 * Claim this conversation's away message. Not while a person on the team has
 * replied in the last AWAY_AFTER_HUMAN_REPLY_HOURS; not again until the store
 * has opened since the last one. The read and the compare-and-set are two
 * statements; the second only matches the value the first saw, so a message
 * that arrived in between cannot claim it twice.
 */
async function claimAway(
  storeId: string,
  conversationId: string,
  config: Config,
  now: Date,
): Promise<boolean> {
  const rows = asRows<{ away_sent_at: string | null; human_recent: boolean }>(
    await withService((db) =>
      db.execute(sql`
        select c.away_sent_at,
               exists(
                 select 1 from public.whatsapp_messages m
                  where m.store_id = c.store_id
                    and m.conversation_id = c.id
                    and m.direction = 'out'
                    and m.source in ('dashboard', 'phone_app')
                    and m.sent_at > now() - make_interval(hours => ${AWAY_AFTER_HUMAN_REPLY_HOURS})
               ) as human_recent
          from public.whatsapp_conversations c
         where c.id = ${conversationId}::uuid and c.store_id = ${storeId}::uuid
      `),
    ),
  );
  const row = rows[0];
  if (!row || row.human_recent) return false;
  const last = row.away_sent_at ? new Date(row.away_sent_at) : null;
  if (
    last &&
    !Number.isNaN(last.getTime()) &&
    !openedBetween(config.settings.hours, config.timeZone, last, now)
  ) {
    return false;
  }
  const claimed = asRows(
    await withService((db) =>
      db.execute(sql`
        update public.whatsapp_conversations set away_sent_at = ${now.toISOString()}::timestamptz
         where id = ${conversationId}::uuid
           and store_id = ${storeId}::uuid
           and away_sent_at is not distinct from ${row.away_sent_at}::timestamptz
        returning id
      `),
    ),
  );
  return claimed.length > 0;
}

/** Answer one customer message automatically, where the store asked us to. */
export async function answerAutomatically(
  input: AnswerInput,
): Promise<AnswerResult> {
  const { storeId, conversationId, orderQuestion } = input;
  const now = input.now ?? new Date();
  const nothing: AnswerResult = { handOver: orderQuestion, sent: [] };

  if (!orderQuestion && input.kind && NO_GREETING_KINDS.has(input.kind)) {
    return { handOver: false, sent: [] };
  }

  let config: Config | null;
  try {
    config = await loadConfig(storeId);
  } catch (err) {
    logError("whatsapp auto-replies: settings unreadable", err, { storeId });
    return nothing;
  }
  if (!config) return nothing;
  const { settings } = config;
  if (!orderQuestion && !settings.welcomeEnabled && !settings.awayEnabled) {
    return { handOver: false, sent: [] };
  }

  // ★ Before any claim: with no number to answer from, nothing is spent.
  const sender = await withService((db) =>
    loadWhatsAppSender(db, storeId),
  ).catch(() => null);
  if (!sender) {
    logInfo("whatsapp auto-replies: not sent, no sender", { storeId });
    return nothing;
  }

  const parts: string[] = [];
  const sent: AnswerResult["sent"] = [];
  let handOver = false;
  let answered = false;

  if (orderQuestion) {
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
    parts.push(answer.body);
    sent.push("order_status");
    handOver = answer.needsHuman;
    answered = answer.answered;
  }

  // A question we answered with the customer's own order needs no greeting and
  // no "we're closed": both would only be noise beside the answer.
  if (!answered) {
    try {
      if (
        settings.welcomeEnabled &&
        input.welcomeEligible &&
        (await claimWelcome(storeId, conversationId))
      ) {
        parts.unshift(settings.welcomeText);
        sent.unshift("welcome");
      }
      if (
        settings.awayEnabled &&
        !isOpenAt(settings.hours, config.timeZone, now) &&
        (await claimAway(storeId, conversationId, config, now))
      ) {
        parts.push(settings.awayText);
        sent.push("away");
      }
    } catch (err) {
      // A claim that failed is a reply not sent, never a lost message.
      logError("whatsapp auto-replies: claim failed", err, { storeId });
    }
  }

  if (parts.length === 0) return { handOver, sent: [] };

  const delivered = await replyInChat({
    storeId,
    conversationId,
    to: input.phone,
    body: parts.join("\n\n"),
    reason: `auto:${sent.join("+")}`,
    sender,
  });
  // The customer asked and heard nothing: a person has to answer.
  if (orderQuestion && !delivered) handOver = true;
  return { handOver, sent: delivered ? sent : [] };
}
