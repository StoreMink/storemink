"use server";

// Channels → Digital payments: a merchant connects their OWN Razorpay account
// (BYO gateway — order money settles directly with them). Credentials live in
// store_payment_providers (service-only);
// the key secret is app-layer encrypted (lib/payments/crypto.ts) and is
// WRITE-ONLY: no action ever returns it to a client.
//
// Plan gate: online payments are a paid feature (PLAN_LIMITS.onlinePayments,
// basic+). Enforced server-side here on save/enable AND again at checkout
// time (getCheckoutConfig / placeOrder) so a lapsed plan turns the gateway
// off without touching the merchant's stored credentials.

import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { storePaymentProviders, stores } from "@/drizzle/schema";
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
import { effectivePlan, limitsFor } from "@/lib/plans";
import { encryptSecret } from "@/lib/payments/crypto";
import { validateCredentials } from "@/lib/payments/razorpay";
import {
  paymentWebhookStatus,
  paymentWebhookUrl,
  rotatePaymentWebhookSecret,
} from "@/lib/payments/store-webhook";
import { getCurrentStore } from "@/lib/store/resolve";
import { IS_PRODUCTION_PLATFORM } from "@/lib/store/host";
import { lookupStoreGateway } from "@/lib/payments/provider";
import type { RazorpayCreds } from "@/lib/payments/razorpay";
import { settleBeforeGatewayChange } from "@/lib/orders/pending-payments";

export interface ChannelState {
  connected: boolean;
  /** The public key id (shown for recognition; the secret never leaves the server). */
  keyId: string | null;
  enabled: boolean;
  /** Whether the store's plan includes online payments at all. */
  planAllowsOnlinePayments: boolean;
  /** Whether a webhook signing secret has been generated. NEVER the secret. */
  webhookConfigured: boolean;
  /**
   * When Razorpay last delivered an event signed with that secret, or null if
   * none has arrived. A secret alone proves nothing: the merchant still has to
   * paste it into Razorpay, and only a delivery shows they did.
   */
  webhookLastEventAt: string | null;
  /** The address the merchant registers with Razorpay. Not a secret. */
  webhookUrl: string | null;
}

async function planAllowsPayments(storeId: string): Promise<boolean> {
  try {
    const rows = await withService((db) =>
      db
        .select({
          plan: stores.plan,
          plan_expires_at: stores.planExpiresAt,
          comp_plan: stores.compPlan,
          comp_expires_at: stores.compExpiresAt,
        })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1),
    );
    return limitsFor(effectivePlan(rows[0] ?? {})).onlinePayments;
  } catch (err) {
    console.error(
      "planAllowsPayments:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

export async function getChannelState(): Promise<ChannelState> {
  const storeId = await getActingStoreId();
  const [row, planOk] = await Promise.all([
    withService((db) =>
      db
        // Deliberately NEVER selects the encrypted secret column.
        .select({
          key_id: storePaymentProviders.keyId,
          enabled: storePaymentProviders.enabled,
        })
        .from(storePaymentProviders)
        .where(
          and(
            eq(storePaymentProviders.storeId, storeId),
            eq(storePaymentProviders.provider, "razorpay"),
          ),
        )
        .limit(1),
    ).then(
      (rows) => rows[0],
      () => undefined,
    ),
    planAllowsPayments(storeId),
  ]);
  // Only meaningful once a gateway is connected — there is nothing to attach a
  // webhook to otherwise, and showing a URL for it would invite the merchant to
  // register one that can never verify.
  const NO_WEBHOOK = { configured: false, lastEventAt: null };
  const [webhook, store] = row
    ? await Promise.all([
        paymentWebhookStatus(storeId).catch(() => NO_WEBHOOK),
        getCurrentStore().catch(() => null),
      ])
    : [NO_WEBHOOK, null];
  return {
    connected: !!row,
    keyId: row?.key_id ?? null,
    enabled: !!row?.enabled,
    planAllowsOnlinePayments: planOk,
    webhookConfigured: webhook.configured,
    webhookLastEventAt: webhook.lastEventAt,
    webhookUrl: store ? paymentWebhookUrl(store as never) : null,
  };
}

/**
 * Mint a webhook signing secret and return it ONCE.
 *
 * ★★ THE ONLY TIME THE SECRET IS EVER READABLE. It is stored encrypted and
 * `getChannelState` reports only whether one exists, the same write-only
 * treatment the API key secret gets. A merchant who loses it generates another
 * — which is also the rotation path, so there is only one flow to get right.
 *
 * ★ Gated on `channels` like every other action here: this value lets whoever
 * holds it forge "payment captured" for this store, so it belongs with the
 * people trusted to connect the gateway in the first place.
 */
export async function generateWebhookSecret(): Promise<
  { success: true; secret: string; url: string } | { error: string }
> {
  const userId = await getManagerUserId("channels");
  if (!userId) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();

  const secret = await rotatePaymentWebhookSecret(storeId);
  if (!secret) {
    return { error: "Connect your Razorpay account before adding a webhook." };
  }
  const store = await getCurrentStore().catch(() => null);
  return {
    success: true,
    secret,
    url: store ? paymentWebhookUrl(store as never) : "",
  };
}

export interface ChannelActionResult {
  success?: boolean;
  error?: string;
}

/** "3:45 pm IST", for telling a merchant when to try again. */
function istTime(iso: string): string {
  const time = new Date(iso).toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
  return `${time} IST`;
}

/** Set the gateway's switch, best-effort. Returns whether a row moved. */
async function writeEnabled(
  storeId: string,
  enabled: boolean,
): Promise<boolean> {
  try {
    const rows = await withService((db) =>
      db
        .update(storePaymentProviders)
        .set({ enabled, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(storePaymentProviders.storeId, storeId),
            eq(storePaymentProviders.provider, "razorpay"),
          ),
        )
        .returning({ store_id: storePaymentProviders.storeId }),
    );
    return rows.length > 0;
  } catch (err) {
    console.error("writeEnabled:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * May this store's connected Razorpay account be disconnected, or replaced
 * with `replacement`, right now? Null means yes; otherwise the message to
 * show, and nothing has been changed.
 *
 * ★★ THE KEYS ON FILE ARE THE ONLY ONES THAT CAN SAY WHETHER A WAITING ORDER
 * WAS PAID (21 Nov 2026). Removing them used to be unconditional: the reaper
 * then cancelled a waiting order without asking Razorpay, so a captured
 * payment ended up on a cancelled order, and after a switch to another
 * account every read failed and the order and its stock stayed held. Every
 * waiting order is now settled with the current keys first
 * (`settleBeforeGatewayChange`): paid ones are confirmed, dead ones are
 * cancelled, and one still inside its payment window blocks the change until
 * that window closes. New keys on the SAME Razorpay account read the same
 * orders, so rotating a key never waits.
 *
 * ★ PAUSED WHILE IT CHECKS, so no new online order can start between the
 * check and the change. A refusal puts the switch back exactly as it was.
 *
 * A connection that cannot be read at all (a stored secret that no longer
 * decrypts) protects nothing, so it never blocks its own replacement.
 */
async function gatewayChangeBlocked(
  storeId: string,
  replacement: RazorpayCreds | null,
): Promise<string | null> {
  const lookup = await lookupStoreGateway(storeId);
  if (lookup.status !== "connected") return null;

  const wasEnabled = lookup.gateway.enabled;
  if (wasEnabled) await writeEnabled(storeId, false);

  const check = await settleBeforeGatewayChange(
    storeId,
    lookup.gateway.creds,
    replacement,
  );
  if (check.ok) return null;

  if (wasEnabled) await writeEnabled(storeId, true);

  if (check.waiting > 0) {
    const count =
      check.waiting === 1
        ? "1 online payment is"
        : `${check.waiting} online payments are`;
    const until = check.clearBy ? ` after ${istTime(check.clearBy)}` : " later";
    return replacement
      ? `${count} still in progress on the Razorpay account connected now, and a different account can't confirm them. Pause online payments so no new ones start, then connect the new keys${until}. Nothing was changed.`
      : `${count} still in progress on this Razorpay account, and disconnecting now would lose them. Pause online payments so no new ones start, then disconnect${until}. Nothing was changed.`;
  }
  return "We couldn't check your in-progress payments with Razorpay just now, so nothing was changed. Please try again in a minute.";
}

export async function saveRazorpayCredentials(
  keyId: string,
  keySecret: string,
): Promise<ChannelActionResult> {
  const userId = await getManagerUserId("channels");
  if (!userId) return { error: "You don't have permission to do this." };

  const storeId = await getActingStoreId();
  if (!(await planAllowsPayments(storeId))) {
    return {
      error:
        "Online payments are available on the Basic plan and above. Upgrade to connect your gateway.",
    };
  }

  const id = (keyId ?? "").trim();
  const secret = (keySecret ?? "").trim();
  // Razorpay key ids look like rzp_test_xxxx / rzp_live_xxxx — a cheap shape
  // check before we spend an API call on obviously wrong input.
  if (!/^rzp_(test|live)_[A-Za-z0-9]{6,}$/.test(id)) {
    return { error: "That doesn't look like a Razorpay Key ID (rzp_…)." };
  }
  // ★★ TEST KEYS NEVER TAKE REAL ORDERS. Razorpay's test mode accepts test
  // cards and moves no money, so a live store connected with test keys marks
  // orders paid that nobody paid for, ships the goods, and "refunds" money
  // that never arrived. Refused on the production platform only, so dev and
  // local can still be exercised end to end with test cards.
  if (IS_PRODUCTION_PLATFORM && id.startsWith("rzp_test_")) {
    return {
      error:
        "That's a test-mode key, which can't take real payments. In Razorpay, switch to Live mode and create a key that starts with rzp_live_.",
    };
  }
  if (secret.length < 8 || secret.length > 200) {
    return { error: "That doesn't look like a Razorpay Key Secret." };
  }

  // Prove the pair actually works before storing it — a typo'd secret must
  // fail HERE, not at a customer's checkout.
  const check = await validateCredentials({ keyId: id, keySecret: secret });
  if (!check.ok) {
    return {
      error: `Razorpay rejected these credentials: ${check.error}`,
    };
  }

  // ★ Settle what is waiting on the account connected NOW before its keys
  // are overwritten (see gatewayChangeBlocked). Saving the same account's
  // keys again, or a rotated key, passes straight through.
  const blocked = await gatewayChangeBlocked(storeId, {
    keyId: id,
    keySecret: secret,
  });
  if (blocked) return { error: blocked };

  const updateFields = {
    provider: "razorpay",
    keyId: id,
    keySecretEnc: encryptSecret(secret),
    // Connecting (or re-keying) enables the gateway — the merchant just
    // proved intent by pasting working credentials.
    enabled: true,
    updatedAt: new Date().toISOString(),
  };
  try {
    await withService((db) =>
      db
        .insert(storePaymentProviders)
        .values({ storeId, ...updateFields })
        .onConflictDoUpdate({
          target: storePaymentProviders.storeId,
          set: updateFields,
        }),
    );
  } catch (err) {
    console.error(
      "saveRazorpayCredentials:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Failed to save credentials. Please try again." };
  }
  return { success: true };
}

export async function setRazorpayEnabled(
  enabled: boolean,
): Promise<ChannelActionResult> {
  const userId = await getManagerUserId("channels");
  if (!userId) return { error: "You don't have permission to do this." };

  const storeId = await getActingStoreId();
  if (enabled && !(await planAllowsPayments(storeId))) {
    return {
      error:
        "Online payments are available on the Basic plan and above. Upgrade to enable your gateway.",
    };
  }

  let updated: { store_id: string }[];
  try {
    updated = await withService((db) =>
      db
        .update(storePaymentProviders)
        .set({ enabled: !!enabled, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(storePaymentProviders.storeId, storeId),
            eq(storePaymentProviders.provider, "razorpay"),
          ),
        )
        .returning({ store_id: storePaymentProviders.storeId }),
    );
  } catch (err) {
    console.error(
      "setRazorpayEnabled:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Failed to update the gateway. Please try again." };
  }
  if (!updated.length) return { error: "Connect Razorpay first." };
  return { success: true };
}

export async function disconnectRazorpay(): Promise<ChannelActionResult> {
  const userId = await getManagerUserId("channels");
  if (!userId) return { error: "You don't have permission to do this." };

  const storeId = await getActingStoreId();

  // ★ Never while an order is still waiting on this account: its payment
  // could only be confirmed with these keys (see gatewayChangeBlocked).
  const blocked = await gatewayChangeBlocked(storeId, null);
  if (blocked) return { error: blocked };

  try {
    await withService((db) =>
      db
        .delete(storePaymentProviders)
        .where(
          and(
            eq(storePaymentProviders.storeId, storeId),
            eq(storePaymentProviders.provider, "razorpay"),
          ),
        ),
    );
  } catch (err) {
    console.error(
      "disconnectRazorpay:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Failed to disconnect. Please try again." };
  }
  return { success: true };
}
