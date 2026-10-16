import "server-only";

import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import {
  stores,
  whatsappAutoReplies,
  whatsappMessages,
  whatsappMinkAnswers,
} from "@/drizzle/schema";
import { normalizeAnalyticsTimeZone } from "@/lib/analytics/range";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import { storeOrigin } from "@/lib/site";
import { isStorefrontGated, isThemePending } from "@/lib/store/launch-state";
import { effectivePlan } from "@/lib/plans";
import { getMinkConfig } from "@/lib/mink/config";
import { readMinkShopperOffers } from "@/lib/mink/offers-read";
import { getPublishedProducts } from "@/lib/storefront/queries";
import { getLivePolicies } from "@/lib/legal/store-consent";
import { estimateProductDelivery } from "@/lib/shipping/product-delivery";
import { isSoldOut } from "@/lib/inventory/status";
import { formatPrice } from "@/lib/pricing";
import { loadWhatsAppSender, type WhatsAppSender } from "./channel";
import { replyInChat } from "./auto-reply";
import {
  MINK_ANSWER_CREDITS,
  normalizeMinkMode,
  type MinkMode,
} from "./auto-reply-settings";
import {
  hasAnyHours,
  isOpenAt,
  normalizeBusinessHours,
} from "./business-hours";
import {
  allowedUrlsIn,
  deliveryCheckVariant,
  factsSummary,
  matchProducts,
  optionLabel,
  parseMinkWhatsAppAnswer,
  pinCodeIn,
  renderHours,
  renderProductFact,
  htmlToText,
  MINK_POLICY_MAX_CHARS,
  MINK_RECENT_MESSAGES,
  type MinkFacts,
  type MinkRecentMessage,
} from "./mink-facts";
import { minkGate } from "./mink-gate";
import {
  chargeMinkAnswer,
  claimMinkDraft,
  markMinkAnswerSent,
  minkChargeContext,
  minkCreditHeadroom,
  personRepliedSince,
  releaseMinkDraftClaim,
} from "./mink-drafts";
import { callMinkWhatsAppModelWithRetry } from "./mink-model";
import {
  lookupOrdersForPhone,
  orderStatusLine,
  ordersToReport,
} from "./order-status-reply";

// ---------------------------------------------------------------------------
// Customer-facing Mink on WhatsApp (docs/whatsapp-commerce-plan.md §13;
// stories WA-8.x). Called by inbound.ts after a customer's message is filed,
// for a store whose Mink mode is `helps` or `drafts` and a message the gate
// (mink-gate.ts) let through.
//
// ★★ ANSWER-ONLY, BY CONSTRUCTION. There is no tool here: the facts are read
// by this module, scoped to the store and to the phone that wrote, and the
// model is given the sheet and the message and asked for a reply. It cannot
// cancel, refund, reprice, apply a code or change an address, because there
// is nothing it could call to do so. Every one of those is a hand-over.
//
// ★★ HAND OVER IS THE DEFAULT OUTCOME, in three layers: the gate refuses the
// vocabulary a person must read before any call; the model is told to hand
// over anything outside the sheet; and the parser turns a reply that breaks
// a rule it cannot be allowed to break (a link not in the facts) into a
// hand-over. A hand-over keeps whatever the model drafted for staff.
//
// ★★ ONE CREDIT PER ANSWER SENT, AND IT FAILS CLOSED. The store's headroom is
// checked BEFORE the model is called (a store with nothing left costs
// nothing and gets a person), and the credit is taken (mink-drafts.ts) just
// before the send; 'insufficient' at that moment leaves a draft for a person.
// A draft (the `drafts` mode, or a `helps` hand-over) costs nothing until a
// person sends it.
//
// ★★ `helps` LOADS THE SENDER BEFORE ANYTHING IS SPENT, as the store's own
// automatic replies do (answer-automatically.ts). A paused number, one that
// needs reconnecting or a plan without WhatsApp cannot send, so the message
// goes to a person with no model call and no credit taken; before, it paid
// for an answer nobody could deliver.
//
// ★★ THE AUTOMATIC SEND TAKES THE SAME LEASE A PERSON'S SEND DOES
// (`claimMinkDraft`), so a Send pressed on the card while Mink is still
// sending cannot send it a second time.
//
// ★ A PERSON WHO ANSWERED FIRST WINS. The model takes seconds; if somebody on
// the team replied meanwhile (the dashboard, the WhatsApp Business app, a
// template), Mink records its answer as discarded and neither sends it nor
// leaves a draft whose Send would answer the customer twice.
//
// ★ NEVER THROWS, NEVER BLOCKS THE FILING. The message is already on disk
// when this runs; whatever fails here is logged and ends as "a person reads
// it", which is where the conversation was before Mink existed.
// ---------------------------------------------------------------------------

export interface MinkAnswerInput {
  storeId: string;
  conversationId: string;
  /** The customer's message row this answers. */
  messageId: string;
  /** The customer's phone, E.164. */
  phone: string;
  /** The account on this store whose phone matched, when there is one. */
  userId: string | null;
  mode: Exclude<MinkMode, "off">;
  /** The customer's words, exactly as filed. */
  text: string;
  now?: Date;
}

export type MinkAnswerOutcome =
  | "sent"
  | "draft"
  | "handed_over"
  | "skipped"
  | "failed";

export interface MinkAnswerResult {
  outcome: MinkAnswerOutcome;
  /** A person must take it from here (helps mode: the caller hands over). */
  needsHuman: boolean;
  answerId: string | null;
  reason: string;
}

/** Per conversation, per store and platform-wide: a chatty customer cannot
 *  drain a store's credits, and a store cannot drain the platform's quota. */
const LIMITS = {
  conversation: { max: 20, windowSeconds: 3600 },
  store: { max: 300, windowSeconds: 3600 },
  global: { max: 3000, windowSeconds: 3600 },
} as const;

interface StoreContext {
  name: string;
  url: string | null;
  email: string | null;
  timeZone: string;
  plan: "free" | "basic" | "pro";
  hours: string | null;
  mode: MinkMode;
}

async function loadStoreContext(
  storeId: string,
  now: Date,
): Promise<StoreContext | null> {
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
        businessHours: whatsappAutoReplies.businessHours,
        minkMode: whatsappAutoReplies.minkMode,
        savedAt: whatsappAutoReplies.updatedAt,
      })
      .from(stores)
      .leftJoin(whatsappAutoReplies, eq(whatsappAutoReplies.storeId, stores.id))
      .where(eq(stores.id, storeId))
      .limit(1),
  );
  const row = rows[0];
  if (!row) return null;
  const settings = (row.settings as Record<string, unknown>) ?? {};
  const business =
    settings.business && typeof settings.business === "object"
      ? (settings.business as Record<string, unknown>)
      : {};
  const brand =
    settings.brand && typeof settings.brand === "object"
      ? (settings.brand as Record<string, unknown>)
      : {};
  const store = { settings };
  const entitlement = {
    plan: row.plan,
    plan_expires_at: row.planExpiresAt,
    comp_plan: row.compPlan,
    comp_expires_at: row.compExpiresAt,
  };
  const timeZone = normalizeAnalyticsTimeZone(business.timeZone);
  const hours = row.savedAt ? normalizeBusinessHours(row.businessHours) : null;
  return {
    name: row.name,
    url:
      isStorefrontGated(store) || isThemePending(store)
        ? null
        : storeOrigin({
            slug: row.slug,
            custom_domain: row.customDomain,
            settings,
            ...entitlement,
          }),
    email: typeof brand.email === "string" && brand.email ? brand.email : null,
    timeZone,
    plan: effectivePlan(entitlement),
    hours:
      hours && hasAnyHours(hours)
        ? renderHours(hours, timeZone, isOpenAt(hours, timeZone, now))
        : null,
    mode: normalizeMinkMode(row.minkMode),
  };
}

/** The last few messages either way, oldest first, the current one excluded. */
async function loadRecent(
  storeId: string,
  conversationId: string,
  messageId: string,
): Promise<MinkRecentMessage[]> {
  const rows = await withService((db) =>
    db
      .select({
        id: whatsappMessages.id,
        direction: whatsappMessages.direction,
        kind: whatsappMessages.kind,
        body: whatsappMessages.body,
      })
      .from(whatsappMessages)
      .where(
        and(
          eq(whatsappMessages.storeId, storeId),
          eq(whatsappMessages.conversationId, conversationId),
        ),
      )
      .orderBy(desc(whatsappMessages.sentAt), desc(whatsappMessages.createdAt))
      .limit(MINK_RECENT_MESSAGES + 1),
  ).catch(() => []);
  return rows
    .filter((r) => r.id !== messageId && r.body)
    .reverse()
    .slice(-MINK_RECENT_MESSAGES)
    .map((r) => ({
      who: r.direction === "in" ? "customer" : "shop",
      text: r.body ?? "",
    }));
}

/** Every fact the model may answer from, read in parallel, each failing to
 *  "nothing known" rather than to a failed answer. A read that failed is
 *  marked as failed on the sheet, never passed off as "none". */
async function buildFacts(
  input: MinkAnswerInput,
  ctx: StoreContext,
  now: Date,
): Promise<MinkFacts> {
  const products = await getPublishedProducts(input.storeId).catch(() => []);
  const matched = matchProducts(input.text, products);
  const pin = pinCodeIn(input.text);
  const product = pin ? matched[0] : undefined;
  // ★ A product with options is checked through one of them (mink-facts.ts):
  // its own row's online stock is not the options' stock.
  const option = product ? deliveryCheckVariant(product) : null;

  const [lookup, offers, policies, recent, delivery] = await Promise.all([
    lookupOrdersForPhone({
      storeId: input.storeId,
      phone: input.phone,
      userId: input.userId,
    }),
    // ★ Only what a visitor to the storefront would be offered (offers-read.ts
    // `readMinkShopperOffers`): never an unpublished code, a group's offer or
    // one that is not running online.
    readMinkShopperOffers(
      { storeId: input.storeId, effectivePlan: ctx.plan },
      { limit: 5, now },
    ).catch((err) => {
      logError("whatsapp mink: offers unreadable", err, {
        storeId: input.storeId,
      });
      return null;
    }),
    getLivePolicies(input.storeId),
    loadRecent(input.storeId, input.conversationId, input.messageId),
    product && pin
      ? estimateProductDelivery(input.storeId, {
          productId: product.id,
          variantId: option?.id ?? null,
          quantity: 1,
          postalCode: pin,
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const orders: string[] = [];
  if (lookup.ok) {
    const { report, moreOpen } = ordersToReport(lookup.orders, now);
    for (const o of report) {
      orders.push(orderStatusLine(o, ctx.timeZone, now).text);
    }
    if (moreOpen > 0) orders.push(`${moreOpen} more open orders not listed.`);
  }

  const offerLines: string[] = [];
  for (const o of offers?.offers ?? []) {
    const how = o.code
      ? `with code ${o.code}`
      : "applied automatically at checkout";
    const on = o.on ? ` on ${o.on}` : "";
    const rules = o.conditions.length > 0 ? `, ${o.conditions.join(", ")}` : "";
    const until = o.validUntil ? ` until ${o.validUntil.slice(0, 10)}` : "";
    offerLines.push(
      `${o.name}: ${o.reward}${on}, ${o.when}${rules}, ${how}${until}`,
    );
  }

  let deliveryLine: string | null = null;
  if (pin && product) {
    // The option is named when the answer is about one of several.
    const name =
      option && product.variants.length > 1 && !isSoldOut(option)
        ? `${product.name} (${optionLabel(option)})`
        : product.name;
    if (!delivery) {
      deliveryLine = `Delivery to ${pin} could not be checked just now.`;
    } else if (!delivery.available) {
      const why = (delivery.error ?? "not available").replace(/\.+$/, "");
      deliveryLine = `${name} to ${pin}: ${why}.`;
    } else if (delivery.kind === "digital") {
      deliveryLine = `${name} needs no delivery.`;
    } else if (delivery.option) {
      const opt = delivery.option;
      const days =
        opt.estimatedDeliveryMinDays != null &&
        opt.estimatedDeliveryMaxDays != null
          ? `, ${opt.estimatedDeliveryMinDays} to ${opt.estimatedDeliveryMaxDays} days`
          : "";
      const charge =
        opt.amount > 0
          ? `delivery ${formatPrice(opt.amount)}`
          : "free delivery";
      deliveryLine = `${name} to ${pin}: available, ${charge}${days}${opt.courierName ? ` by ${opt.courierName}` : ""}.`;
    }
  }

  return {
    store: { name: ctx.name, url: ctx.url, email: ctx.email },
    hours: ctx.hours,
    orders,
    // ★ A failed lookup is not "no orders": the sheet says it could not look,
    // and the model hands an order question over (order-status-reply.ts does
    // the same on the same failure).
    ...(lookup.ok ? {} : { ordersUnavailable: true }),
    products: matched.map((p) => renderProductFact(p, ctx.url)),
    delivery: deliveryLine,
    offers: offerLines,
    ...(offers ? {} : { offersUnavailable: true }),
    policies: policies.map((p) => ({
      title: p.title,
      text: htmlToText(p.html, MINK_POLICY_MAX_CHARS),
    })),
    recent,
  };
}

async function recordAnswer(input: {
  id: string;
  storeId: string;
  conversationId: string;
  messageId: string;
  mode: Exclude<MinkMode, "off">;
  outcome: "draft" | "handed_over" | "failed" | "discarded";
  reason: string;
  answer: string;
  facts: string[];
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  await withService((db) =>
    db.insert(whatsappMinkAnswers).values({
      id: input.id,
      storeId: input.storeId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      mode: input.mode,
      outcome: input.outcome,
      reason: input.reason.slice(0, 200),
      answer: input.answer.slice(0, 4096),
      facts: input.facts,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      resolvedAt: input.outcome === "draft" ? null : new Date().toISOString(),
    }),
  );
}

/**
 * Say on a pending draft why Mink did not send it (the card shows the
 * reason). Only a row still pending: one a person discarded meanwhile stays
 * discarded rather than coming back as a draft.
 */
async function noteDraft(
  db: Db,
  input: { storeId: string; answerId: string; reason: string },
): Promise<void> {
  await db.execute(sql`
    update public.whatsapp_mink_answers
       set reason = ${input.reason.slice(0, 200)}
     where id = ${input.answerId}::uuid
       and store_id = ${input.storeId}::uuid
       and outcome = 'draft'
  `);
}

/** Answer one customer message, or hand it to a person. Never throws. */
export async function answerWithMink(
  input: MinkAnswerInput,
): Promise<MinkAnswerResult> {
  const { storeId, conversationId, mode } = input;
  const now = input.now ?? new Date();
  const skip = (reason: string): MinkAnswerResult => ({
    outcome: "skipped",
    needsHuman: true,
    answerId: null,
    reason,
  });
  try {
    const config = getMinkConfig();
    if (!config.enabled || !config.projectId) return skip("mink_unavailable");

    // The gate ran at filing; run it again so a caller cannot route around it.
    const gate = minkGate(input.text);
    if (!gate.ok) {
      return {
        outcome: "handed_over",
        needsHuman: true,
        answerId: null,
        reason: gate.reason,
      };
    }

    const ctx = await loadStoreContext(storeId, now);
    if (!ctx) return skip("store_missing");
    if (ctx.mode !== mode) {
      // Switched off between filing and now: a person reads it.
      return skip("mode_changed");
    }

    // ★ helps: no number to answer from (paused, needs reconnecting, a plan
    // without WhatsApp) means no model call and no credit, and the message
    // goes to a person. Loaded once, here, and used for the send.
    let sender: WhatsAppSender | null = null;
    if (mode === "helps") {
      sender = await withService((db) => loadWhatsAppSender(db, storeId)).catch(
        () => null,
      );
      if (!sender) {
        logInfo("whatsapp mink: not answered, no sender", { storeId });
        return skip("no_sender");
      }
    }

    const [conv, store, global] = await Promise.all([
      rateLimit(
        `whatsapp-mink:conversation:${conversationId}`,
        LIMITS.conversation,
      ),
      rateLimit(`whatsapp-mink:store:${storeId}`, LIMITS.store),
      rateLimit("whatsapp-mink:global", LIMITS.global),
    ]);
    if (!conv.allowed || !store.allowed || !global.allowed) {
      logInfo("whatsapp mink: rate limited", { storeId, conversationId });
      return skip("rate_limited");
    }

    // ★ Can the store pay for an answer? Asked before the model is called.
    const charge = await minkChargeContext(storeId);
    const headroom = await minkCreditHeadroom(storeId, charge);
    if (headroom !== null && headroom < MINK_ANSWER_CREDITS) {
      logInfo("whatsapp mink: no credits", { storeId });
      return skip("no_credits");
    }

    const facts = await buildFacts(input, ctx, now);
    const allowed = allowedUrlsIn(facts);
    const summary = factsSummary(facts);

    // One attempt, and one more only if the first stalled (mink-model.ts).
    const result = await callMinkWhatsAppModelWithRetry(config, {
      facts,
      message: input.text,
      now,
      timeZone: ctx.timeZone,
    });
    if (result.attempts > 1) {
      logWarn("whatsapp mink: model stalled once, answered on the retry", {
        storeId,
        conversationId,
        attempts: result.attempts,
      });
    }
    const answer =
      result.finishReason === "STOP"
        ? parseMinkWhatsAppAnswer(result.parsed, allowed)
        : null;
    const answerId = crypto.randomUUID();
    const base = {
      id: answerId,
      storeId,
      conversationId,
      messageId: input.messageId,
      mode,
      facts: summary,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };

    // ★ A person answered while the model was thinking (seconds, up to two
    // 25 s attempts): their reply stands. Mink's words are kept on the ledger
    // with what they cost in tokens, and nothing is sent, charged or left as
    // a draft whose Send would answer the customer twice.
    const personReplied = await withService((db) =>
      personRepliedSince(db, {
        storeId,
        conversationId,
        messageId: input.messageId,
      }),
    );
    if (personReplied) {
      await recordAnswer({
        ...base,
        outcome: "discarded",
        reason: "a person replied first",
        answer: answer?.reply ?? "",
      });
      return {
        outcome: "skipped",
        needsHuman: false,
        answerId,
        reason: "person_replied",
      };
    }

    if (!answer) {
      await recordAnswer({
        ...base,
        outcome: "failed",
        reason: `model: ${result.finishReason ?? "no answer"}`,
        answer: "",
      });
      return {
        outcome: "failed",
        needsHuman: true,
        answerId,
        reason: "model_unreadable",
      };
    }

    // The model handed over, or a person approves every reply: a draft when
    // there are words worth reading, a bare hand-over otherwise.
    if (answer.outcome === "hand_over" || mode === "drafts") {
      const draft = answer.reply.length > 0;
      await recordAnswer({
        ...base,
        outcome: draft ? "draft" : "handed_over",
        reason: answer.reason,
        answer: answer.reply,
      });
      return {
        outcome: draft ? "draft" : "handed_over",
        // In drafts mode the message was filed for a person already.
        needsHuman: mode === "helps",
        answerId,
        reason: answer.reason,
      };
    }

    // helps: the row first (the lease and the charge are keyed on it), then
    // the lease, the charge and the send.
    await recordAnswer({
      ...base,
      outcome: "draft",
      reason: answer.reason,
      answer: answer.reply,
    });
    // ★★ THE SAME LEASE A PERSON'S SEND TAKES (mink-drafts.ts), in the same
    // transaction as the charge: a Send pressed on the card from here on finds
    // the draft taken, and a draft somebody took first is not sent by Mink.
    const source = await withService(async (db): Promise<string | null> => {
      const claim = await claimMinkDraft(db, {
        storeId,
        conversationId,
        draftId: answerId,
      });
      if (!claim) return null;
      const charged = await chargeMinkAnswer(db, {
        answerId,
        storeId,
        ctx: charge,
      });
      if (charged === "insufficient") {
        // Nothing was charged and nothing will be sent: the draft goes back,
        // so a person can send it once the store has credits again.
        await releaseMinkDraftClaim(db, { storeId, answerId });
        await noteDraft(db, {
          storeId,
          answerId,
          reason: "no credits left to send",
        });
      }
      return charged;
    });
    if (source === null) {
      // Somebody is sending it, or a person answered in the moment between:
      // either way a person has it, and Mink sends nothing.
      return {
        outcome: "skipped",
        needsHuman: false,
        answerId,
        reason: "draft_taken",
      };
    }
    if (source === "insufficient") {
      return {
        outcome: "draft",
        needsHuman: true,
        answerId,
        reason: "no_credits",
      };
    }

    const delivered = await replyInChat({
      storeId,
      conversationId,
      to: input.phone,
      body: answer.reply,
      reason: "mink:answer",
      sender,
      extraPayload: { mink: true, answerId },
    });
    if (!delivered) {
      // Charged, so the draft says so: a person can send it without paying
      // again (mink-drafts.ts answers an already-charged id with its source).
      // ★ The lease is left to run out rather than released: replyInChat
      // cannot tell a refusal from a send Meta never answered, and a message
      // that may have reached the customer must not be free to send at once.
      await withService((db) =>
        noteDraft(db, { storeId, answerId, reason: "could not be sent" }),
      );
      return {
        outcome: "draft",
        needsHuman: true,
        answerId,
        reason: "send_failed",
      };
    }
    const sentId = await withService((db) =>
      db
        .select({ id: whatsappMessages.id })
        .from(whatsappMessages)
        .where(
          and(
            eq(whatsappMessages.storeId, storeId),
            eq(whatsappMessages.conversationId, conversationId),
            eq(whatsappMessages.direction, "out"),
            sql`${whatsappMessages.payload} ->> 'answerId' = ${answerId}`,
          ),
        )
        .limit(1),
    )
      .then((rows) => rows[0]?.id ?? null)
      .catch(() => null);
    await withService((db) =>
      markMinkAnswerSent(db, {
        storeId,
        answerId,
        answer: answer.reply,
        sentMessageId: sentId,
        sentByAdminId: null,
      }),
    );
    return {
      outcome: "sent",
      needsHuman: false,
      answerId,
      reason: answer.reason,
    };
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "MinkWhatsAppModelStalled" || err.name === "TimeoutError")
    ) {
      logWarn("whatsapp mink: model timed out", {
        storeId,
        conversationId,
        attempts: (err as { attempts?: number }).attempts ?? 1,
      });
      return {
        outcome: "failed",
        needsHuman: true,
        answerId: null,
        reason: "timeout",
      };
    }
    logError("whatsapp mink: answer failed", err, { storeId, conversationId });
    return {
      outcome: "failed",
      needsHuman: true,
      answerId: null,
      reason: "error",
    };
  }
}
