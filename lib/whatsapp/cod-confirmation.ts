import "server-only";

import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { orders, stores, users } from "@/drizzle/schema";
import { approveCancellation } from "@/lib/orders/approve-cancellation";
import { logError, logInfo } from "@/lib/observability/logger";
import { textablePhone } from "@/lib/phone";
import { replyInChat } from "./auto-reply";
import type { CodPayload } from "./cod-payload";

// ---------------------------------------------------------------------------
// What a tap on a COD confirmation's Confirm / Cancel button does
// (docs/whatsapp-commerce-plan.md §16 Phase 2; stories WA-4.x).
//
// ★★ THE PAYLOAD NAMES THE ORDER; THE PHONE AUTHORISES THE TAP. A tap acts
// only when the order is in the store the tap arrived for, is cash on
// delivery, and the tapping phone is the order's own (the account phone or
// the delivery phone). Anything else changes nothing and gets NO reply:
// nothing is said about an order to a phone that does not own it.
//
// ★ CANCEL GOES THROUGH THE ONE CANCELLATION (lib/orders/approve-cancellation,
// its fourth caller): stock back where it was reserved, store credit used on
// the order reinstated, the team and the customer told, and no money moved,
// because nothing was paid. A second copy of "cancel an order" here is how
// one path quietly stops restocking.
//
// ★ EVERY OUTCOME IS ANSWERED IN THE CHAT through the choke point and filed
// as an `automation` message, so staff reading Inbox see what was said. The
// answer never decides the action: a reply that fails to send leaves the
// confirmation or cancellation standing.
//
// ★ A REFUSAL, A TAP TOO LATE, OR A FAILURE GOES TO A PERSON (`needsHuman`);
// the caller (inbound.ts afterFiled) then marks the conversation needs-reply
// and rings the bell that recordInboundMessage held back.
//
// ★ AN `undelivered` ORDER IS ANSWERED LIKE A `requested` ONE. Meta can report
// a message failed and still deliver it later, so a tap that does arrive is
// the customer's real answer; nothing below singles that state out.
// ---------------------------------------------------------------------------

export type CodOutcome =
  | "confirmed"
  | "already_confirmed"
  | "cancelled"
  | "already_cancelled"
  | "expired"
  | "too_late"
  | "declined"
  | "failed"
  | "not_allowed";

export interface CodReplyResult {
  outcome: CodOutcome;
  /** Hand the conversation to a person: the tap could not be acted on. */
  needsHuman: boolean;
}

export interface CodReplyInput {
  storeId: string;
  conversationId: string;
  /** The tapping phone, E.164, as stored on the contact. */
  phone: string;
  /** The WhatsApp name or the number, for the cancellation's actor label. */
  contactLabel: string | null;
  reply: CodPayload;
}

const NEEDS_HUMAN: Record<CodOutcome, boolean> = {
  confirmed: false,
  already_confirmed: false,
  cancelled: false,
  already_cancelled: false,
  // A Confirm after the store's automatic cancellation: the customer still
  // wants the goods, and only a person can put the order back.
  expired: true,
  too_late: true,
  // A Cancel after the shop declined a cancellation request: still wants out,
  // and only the shop can change its own decision.
  declined: true,
  failed: true,
  not_allowed: true,
};

/**
 * Statuses a customer can still cancel out of. The same pair approveCancellation
 * claims from; it re-checks inside its own UPDATE, so this copy only chooses
 * the wording when the order has already moved on.
 */
const CANCELLABLE_STATUSES = new Set(["pending", "processing"]);

/**
 * ★★ WHAT A COD ORDER IS STORED AS, which is NOT what checkout calls it.
 * Checkout's choice and the `order.placed` payload say `cod`; placeOrder
 * writes `orders.payment_method = 'cash_on_delivery'` (checkout-actions.ts).
 * Comparing the row against `cod` refused every real tap. `cod` stays in the
 * set only so a row written in the payload's vocabulary is not refused.
 */
const COD_PAYMENT_METHODS = new Set(["cash_on_delivery", "cod"]);

interface CodOrder {
  id: string;
  orderRef: string;
  status: string;
  paymentMethod: string;
  codConfirmation: string | null;
  /** requested / approved / declined: a cancellation request's decision. */
  cancellationStatus: string | null;
  customerId: string | null;
  shippingAddress: unknown;
  customerPhone: string | null;
  storeName: string | null;
}

/**
 * Whether the tapping phone is the order's own: the account's phone or the
 * delivery phone, compared in E.164 so a legacy ten-digit number still
 * matches. ★ Nothing to compare is a refusal, never a pass.
 */
export function tapperOwnsOrder(
  phone: string,
  order: { customerPhone: string | null; shippingAddress: unknown },
): boolean {
  const tapper = textablePhone(phone);
  if (!tapper) return false;
  const delivery =
    order.shippingAddress && typeof order.shippingAddress === "object"
      ? (order.shippingAddress as Record<string, unknown>).phone
      : null;
  return [order.customerPhone, delivery].some(
    (candidate) => textablePhone(candidate) === tapper,
  );
}

/**
 * What the customer is told, or null when they must be told nothing (a tap
 * from a phone that does not own the order, or for an order that is not
 * theirs to act on).
 */
export function codReplyText(
  outcome: CodOutcome,
  orderRef: string,
  storeName: string | null,
): string | null {
  const ref = orderRef.trim();
  const order = ref ? `Order ${ref}` : "Your order";
  const shop = storeName?.trim() || "the shop";
  switch (outcome) {
    case "confirmed":
      return `Thank you. ${order} is confirmed and we will prepare it for delivery.`;
    case "already_confirmed":
      return `${order} is already confirmed. We will prepare it for delivery.`;
    case "cancelled":
      return `${order} has been cancelled. You will not be charged anything for it.`;
    case "already_cancelled":
      return `${order} has already been cancelled.`;
    case "expired":
      return `${order} was cancelled because it was not confirmed in time. Someone from ${shop} will reply to you in this chat.`;
    case "too_late":
      return `${order} has already been sent out, so it can't be cancelled here. Someone from ${shop} will reply to you in this chat.`;
    case "declined":
      return `${order} can't be cancelled here, because ${shop} declined an earlier request to cancel it. Someone from ${shop} will reply to you in this chat.`;
    case "failed":
      return `We couldn't update ${ref ? `order ${ref}` : "your order"} just now. Someone from ${shop} will reply to you in this chat.`;
    case "not_allowed":
      return null;
  }
}

/** Act on one Confirm / Cancel tap and answer it. Never throws. */
export async function handleCodReply(
  input: CodReplyInput,
): Promise<CodReplyResult> {
  const { storeId, reply } = input;

  let order: CodOrder | null;
  try {
    order = await readOrder(storeId, reply.orderId);
  } catch (err) {
    // ★ Unread, so unverified: nothing can be said to this phone about the
    // order, and a person has to look.
    logError("whatsapp cod: order read failed", err, { storeId });
    return result("failed");
  }

  const refusal = !order
    ? "unknown order"
    : !COD_PAYMENT_METHODS.has(order.paymentMethod)
      ? "not cash on delivery"
      : !tapperOwnsOrder(input.phone, order)
        ? "phone does not own the order"
        : null;
  if (!order || refusal) {
    logInfo("whatsapp cod: tap refused", { storeId, reason: refusal });
    return result("not_allowed");
  }

  const outcome =
    reply.action === "confirm"
      ? await confirm(storeId, order)
      : await cancel(input, order);

  await answer(input, order, outcome);
  return result(outcome);
}

function result(outcome: CodOutcome): CodReplyResult {
  return { outcome, needsHuman: NEEDS_HUMAN[outcome] };
}

async function readOrder(
  storeId: string,
  orderId: string,
): Promise<CodOrder | null> {
  const rows = await withService((db) =>
    db
      .select({
        id: orders.id,
        orderRef: orders.orderRef,
        status: orders.status,
        paymentMethod: orders.paymentMethod,
        codConfirmation: orders.codConfirmation,
        cancellationStatus: orders.cancellationStatus,
        customerId: orders.customerId,
        shippingAddress: orders.shippingAddress,
        customerPhone: users.phone,
        storeName: stores.name,
      })
      .from(orders)
      .innerJoin(stores, eq(stores.id, orders.storeId))
      .leftJoin(
        users,
        and(eq(users.id, orders.customerId), eq(users.storeId, orders.storeId)),
      )
      // ★ Scoped to the store the tap arrived for: an order id from another
      // store's message is simply not found.
      .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
      .limit(1),
  );
  return (rows[0] as CodOrder | undefined) ?? null;
}

async function confirm(storeId: string, order: CodOrder): Promise<CodOutcome> {
  if (order.codConfirmation === "expired") return "expired";
  if (order.status === "cancelled" || order.codConfirmation === "cancelled") {
    return "already_cancelled";
  }
  if (order.codConfirmation === "confirmed") return "already_confirmed";
  try {
    // ★ The guard is INSIDE the update, so a Cancel that won a race leaves
    // this matching nothing. A concurrent Confirm still matches, which is why
    // zero rows can only mean the order was cancelled.
    const rows = await withService((db) =>
      db
        .update(orders)
        .set({ codConfirmation: "confirmed", codConfirmationAt: sql`now()` })
        .where(
          and(
            eq(orders.id, order.id),
            eq(orders.storeId, storeId),
            ne(orders.status, "cancelled"),
            sql`${orders.codConfirmation} is distinct from 'cancelled'`,
          ),
        )
        .returning({ id: orders.id }),
    );
    if (rows.length > 0) return "confirmed";
    // Cancelled in between: by the customer's own Cancel, or by the store's
    // automatic cancellation, which wants a different answer.
    const now = await readOrder(storeId, order.id).catch(() => null);
    return now?.codConfirmation === "expired" ? "expired" : "already_cancelled";
  } catch (err) {
    logError("whatsapp cod: confirm failed", err, { storeId });
    return "failed";
  }
}

async function cancel(
  input: CodReplyInput,
  order: CodOrder,
): Promise<CodOutcome> {
  const { storeId } = input;
  if (order.status === "cancelled") return "already_cancelled";
  if (!CANCELLABLE_STATUSES.has(order.status)) return "too_late";
  // ★ A DECLINE IS FINAL (lib/orders/cancellation.ts). The Cancel button is a
  // customer's request like the order page's, so it does not override the
  // shop's "no"; approveCancellation re-checks it inside its claim
  // (`fromRequest`), and this read only chooses the words.
  if (order.cancellationStatus === "declined") return "declined";

  let cancelled = false;
  try {
    const res = await approveCancellation({
      storeId,
      orderId: order.id,
      actorId: order.customerId,
      actorLabel: input.contactLabel,
      customerId: order.customerId,
      // Nothing was paid on a cash-on-delivery order, so nothing moves; the
      // obligation (if any) is recorded and shown on the refund panel.
      refundDestination: "later",
      reasonCode: "customer_changed_mind",
      restock: true,
      notify: true,
      fromRequest: true,
    });
    cancelled = res.success === true;
    if (!cancelled) {
      logInfo("whatsapp cod: cancellation refused", {
        storeId,
        reason: res.error ?? null,
      });
    }
  } catch (err) {
    logError("whatsapp cod: cancellation failed", err, { storeId });
  }

  if (cancelled) {
    // Best effort: the order IS cancelled either way; this only labels how.
    await withService((db) =>
      db
        .update(orders)
        .set({ codConfirmation: "cancelled", codConfirmationAt: sql`now()` })
        .where(and(eq(orders.id, order.id), eq(orders.storeId, storeId))),
    ).catch((err) =>
      logError("whatsapp cod: cancelled label failed", err, { storeId }),
    );
    return "cancelled";
  }

  // ★ A REFUSED CANCELLATION RE-READS THE ORDER, so the customer is told the
  // truth: it shipped in between, someone else cancelled it, the shop
  // declined a request for it in between, or it failed.
  const now = await readOrder(storeId, order.id).catch(() => null);
  if (now?.status === "cancelled") return "already_cancelled";
  if (now && !CANCELLABLE_STATUSES.has(now.status)) return "too_late";
  if (now?.cancellationStatus === "declined") return "declined";
  return "failed";
}

/** Answer the tap in the chat and file the answer in the thread. */
async function answer(
  input: CodReplyInput,
  order: CodOrder,
  outcome: CodOutcome,
): Promise<void> {
  const body = codReplyText(outcome, order.orderRef, order.storeName);
  if (!body) return;
  await replyInChat({
    storeId: input.storeId,
    conversationId: input.conversationId,
    to: input.phone,
    body,
    reason: `cod:${outcome}`,
  });
}

/**
 * Mark an order "awaiting confirmation" once the message with the buttons has
 * really gone (worker.ts). ★ Only over nothing, so a resend never resets an
 * answer, and never on an order already cancelled. Never throws: a label must
 * not turn a sent message into a failed queue row.
 */
export async function markCodConfirmationRequested(
  storeId: string,
  orderId: string,
): Promise<void> {
  try {
    await withService((db) =>
      db
        .update(orders)
        .set({ codConfirmation: "requested", codConfirmationAt: sql`now()` })
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, storeId),
            isNull(orders.codConfirmation),
            ne(orders.status, "cancelled"),
          ),
        ),
    );
  } catch (err) {
    logError("whatsapp cod: requested label failed", err, { storeId });
  }
}
