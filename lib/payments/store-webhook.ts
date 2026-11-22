import "server-only";

/**
 * The merchant's own Razorpay webhook (CODEBASE §18).
 *
 * ★★ WHY IT EXISTS. A store's gateway had no webhook at all: a payment was
 * learned only when the shopper's success page ran reconcile-on-read, or when
 * the hourly reaper swept. Close the tab on the Razorpay screen and the money
 * is captured at Razorpay while the order sits `pending` for up to an hour —
 * the merchant sees nothing, the shopper is thanked for nothing, and the order
 * is a candidate for cancellation the whole time.
 *
 * ★ IT ADDS NO NEW WAY TO MARK AN ORDER PAID. The route resolves the order and
 * calls `markOrderPaid`, the same conditional pending → paid claim the callback,
 * the reconcile pass and the reaper use. So the webhook is a fourth TRIGGER for
 * one implementation, not a fourth implementation — and a replayed delivery
 * (Razorpay retries) claims zero rows and announces nothing.
 */

import { randomBytes } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { storePaymentProviders } from "@/drizzle/schema";
import { decryptSecret, encryptSecret } from "@/lib/payments/crypto";
import { storeOrigin } from "@/lib/site";

/**
 * A fresh signing secret.
 *
 * Razorpay accepts an arbitrary string here — the merchant pastes the same
 * value into their webhook settings — so it is ours to choose. 32 random bytes,
 * base64url so it survives being copied out of a dashboard field.
 */
export function newPaymentWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The URL the merchant registers with Razorpay.
 *
 * ★ Store-scoped by id in the PATH, because each store has its own Razorpay
 * account and therefore its own secret — one shared endpoint could not know
 * which key to verify against. The id is a LOOKUP key and never authorisation:
 * the HMAC is, exactly as §14 says of every other identifier in this codebase.
 */
export function paymentWebhookUrl(store: {
  id: string;
  slug: string;
  custom_domain?: string | null;
  settings?: Record<string, unknown> | null;
  plan?: string | null;
}): string {
  // storeOrigin applies the verified-domain and plan gates, so the URL we hand
  // a merchant is one their store actually answers on.
  return `${storeOrigin(store as never)}/api/webhooks/payments/${store.id}`;
}

/** Store a new secret, replacing any previous one. Returns it for display ONCE. */
export async function rotatePaymentWebhookSecret(
  storeId: string,
): Promise<string | null> {
  const secret = newPaymentWebhookSecret();
  const updated = await withService((db) =>
    db
      .update(storePaymentProviders)
      // ★ A new secret has not been proved yet: Razorpay still signs with the
      // old one until the merchant pastes this one in.
      .set({
        webhookSecretEnc: encryptSecret(secret),
        webhookLastEventAt: null,
      })
      .where(
        and(
          eq(storePaymentProviders.storeId, storeId),
          eq(storePaymentProviders.provider, "razorpay"),
        ),
      )
      .returning({ storeId: storePaymentProviders.storeId }),
  );
  // No connected gateway ⇒ nothing to attach a webhook to. Creating the row
  // here would leave a provider with a webhook and no credentials.
  return updated.length > 0 ? secret : null;
}

/**
 * The plaintext secret for a store, or null.
 *
 * ★ Never returned to a caller outside this module's route — `getChannelState`
 * exposes only whether one is CONFIGURED, the same write-only treatment
 * `key_secret_enc` gets.
 */
export async function loadPaymentWebhookSecret(
  storeId: string,
): Promise<string | null> {
  try {
    const rows = await withService((db) =>
      db
        .select({ enc: storePaymentProviders.webhookSecretEnc })
        .from(storePaymentProviders)
        .where(
          and(
            eq(storePaymentProviders.storeId, storeId),
            eq(storePaymentProviders.provider, "razorpay"),
            // ★★ A PAUSED GATEWAY'S WEBHOOK IS STILL HONOURED (21 Nov 2026).
            // It used to be refused, on the thought that an order marked paid
            // from a channel the merchant switched off is a surprise. But
            // pausing only stops NEW online checkouts: an order placed while
            // it was on can still be paid, and the money is real. Refusing
            // meant a 503 for every delivery while paused, which left that
            // paid order to the scheduled passes and, kept up, makes Razorpay
            // disable the webhook altogether. The route only ever marks an
            // order this store already has, so nothing new is accepted.
          ),
        )
        .limit(1),
    );
    const enc = rows[0]?.enc;
    return enc ? decryptSecret(enc) : null;
  } catch {
    // A read failure must not be reported to the caller as "bad signature" —
    // the route turns null into a 503 so Razorpay RETRIES rather than giving up
    // on a delivery we simply could not check.
    return null;
  }
}

/** Whether a webhook has been set up, for display. Never the secret itself. */
export async function hasPaymentWebhook(storeId: string): Promise<boolean> {
  const rows = await withService((db) =>
    db
      .select({ enc: storePaymentProviders.webhookSecretEnc })
      .from(storePaymentProviders)
      .where(
        and(
          eq(storePaymentProviders.storeId, storeId),
          eq(storePaymentProviders.provider, "razorpay"),
        ),
      )
      .limit(1),
  );
  return !!rows[0]?.enc;
}

/**
 * What the dashboard may say about the webhook.
 *
 * ★★ "A SECRET EXISTS" IS NOT "IT WORKS" (21 Nov 2026). The panel used to read
 * "active" the moment a secret was generated, although the merchant still had
 * to paste the address and the secret into Razorpay by hand; one who never
 * did was told their orders were being confirmed instantly when nothing was
 * arriving at all. `lastEventAt` is set only by a delivery whose signature
 * verified, so it is proof Razorpay has both.
 */
export interface PaymentWebhookStatus {
  /** A signing secret has been generated. Never the secret itself. */
  configured: boolean;
  /** When Razorpay last delivered a verified event; null if none has yet. */
  lastEventAt: string | null;
}

export async function paymentWebhookStatus(
  storeId: string,
): Promise<PaymentWebhookStatus> {
  const rows = await withService((db) =>
    db
      .select({
        enc: storePaymentProviders.webhookSecretEnc,
        lastEventAt: storePaymentProviders.webhookLastEventAt,
      })
      .from(storePaymentProviders)
      .where(
        and(
          eq(storePaymentProviders.storeId, storeId),
          eq(storePaymentProviders.provider, "razorpay"),
        ),
      )
      .limit(1),
  );
  const row = rows[0];
  return {
    configured: !!row?.enc,
    lastEventAt: row?.enc ? (row.lastEventAt ?? null) : null,
  };
}

/** How often the "last event" time is rewritten for a busy store. */
const WEBHOOK_SEEN_REFRESH_MS = 60 * 60_000;

/**
 * Note that Razorpay has just delivered an event whose signature verified.
 *
 * At most one write an hour per store (the WHERE refuses a fresher stamp), so
 * a busy store's webhook does not turn every payment into an extra UPDATE.
 * Best-effort: it never throws, because a missed stamp costs a status line
 * and must never cost the delivery it rides on.
 */
export async function markPaymentWebhookReceived(
  storeId: string,
  now: Date = new Date(),
): Promise<void> {
  const stale = new Date(now.getTime() - WEBHOOK_SEEN_REFRESH_MS).toISOString();
  try {
    await withService((db) =>
      db
        .update(storePaymentProviders)
        .set({ webhookLastEventAt: now.toISOString() })
        .where(
          and(
            eq(storePaymentProviders.storeId, storeId),
            eq(storePaymentProviders.provider, "razorpay"),
            or(
              isNull(storePaymentProviders.webhookLastEventAt),
              lt(storePaymentProviders.webhookLastEventAt, stale),
            ),
          ),
        ),
    );
  } catch {
    // Deliberately silent: see the docblock.
  }
}
