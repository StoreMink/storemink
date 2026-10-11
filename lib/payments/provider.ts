import "server-only";

import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { storePaymentProviders, stores } from "@/drizzle/schema";
import { decryptSecret } from "./crypto";
import { effectivePlan, limitsFor } from "@/lib/plans";
import { logError } from "@/lib/observability/logger";
import type { RazorpayCreds } from "./razorpay";

// Loaders for payment credentials. Two entirely separate accounts:
//   • a STORE's BYO Razorpay gateway (store_payment_providers — order money
//     settles with the merchant), and
//   • the PLATFORM's own Razorpay account (env — StoreMink billing and AI
//     credit purchases).
// Neither ever reaches a client component; secrets stay server-side.

export interface StoreGateway {
  creds: RazorpayCreds;
  enabled: boolean;
}

/**
 * The store's gateway, saying WHY there is none.
 *
 * ★ "Not connected" and "could not read it" are different facts, and the
 * pending-payment reaper must not treat them alike: a merchant who
 * disconnected Razorpay has nothing to check, but a database blip or a
 * rotated decryption key says nothing about whether a shopper paid, and
 * cancelling on it turned paid orders into cancelled ones.
 */
export type StoreGatewayLookup =
  | { status: "connected"; gateway: StoreGateway }
  | { status: "none" }
  | { status: "error" };

export async function lookupStoreGateway(
  storeId: string,
): Promise<StoreGatewayLookup> {
  let data:
    | { key_id: string; key_secret_enc: string; enabled: boolean }
    | undefined;
  try {
    const rows = await withService((db) =>
      db
        .select({
          key_id: storePaymentProviders.keyId,
          key_secret_enc: storePaymentProviders.keySecretEnc,
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
    );
    data = rows[0];
  } catch (err) {
    logError("payments.gateway_load", err, { storeId });
    return { status: "error" };
  }
  if (!data) return { status: "none" };
  try {
    return {
      status: "connected",
      gateway: {
        creds: {
          keyId: data.key_id,
          keySecret: decryptSecret(data.key_secret_enc),
        },
        enabled: !!data.enabled,
      },
    };
  } catch (err) {
    logError("payments.gateway_decrypt", err, { storeId });
    return { status: "error" };
  }
}

/** The store's decrypted BYO Razorpay credentials, or null when not
 *  connected (or the stored secret fails to decrypt).
 *
 * ★ Both failures here silently revert a store to COD — the merchant sees
 * online payments stop working with no error anywhere — so lookupStoreGateway
 * logs them as structured errors: exactly what should reach Cloud Error
 * Reporting. A wrong or rotated PAYMENT_CRED_KEY is the one an operator most
 * needs alerting on: nothing else in the system will ever mention it. */
export async function getStoreGateway(
  storeId: string,
): Promise<StoreGateway | null> {
  const found = await lookupStoreGateway(storeId);
  return found.status === "connected" ? found.gateway : null;
}

/**
 * The store's USABLE online gateway, or null.
 *
 * Three server-side conditions, re-checked on EVERY call and never trusted from
 * the client: credentials are connected, the merchant has the channel enabled,
 * and the store's EFFECTIVE plan includes online payments — a lapsed plan
 * silently reverts to offline-only without touching the stored credentials.
 *
 * ★ ONE IMPLEMENTATION, TWO COUNTERS. This was private to checkout-actions.ts
 * until the till started taking gateway payments too (§18 Step 12). A second
 * hand-written copy is how one counter keeps charging cards for a store whose
 * plan lapsed — the same reasoning that put the tender allowlist in
 * lib/pos/tenders.ts and the refund mechanism in lib/payments/issue-refund.ts.
 */
export async function getLiveStoreGateway(
  storeId: string,
): Promise<RazorpayCreds | null> {
  const [gateway, storeRows] = await Promise.all([
    getStoreGateway(storeId),
    withService((db) =>
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
    ).catch((err) => {
      // Fails CLOSED, unlike getViewerLocations. An unreadable plan must not
      // be treated as an entitlement to charge cards.
      logError("payments.gateway_plan_load", err, { storeId });
      return [] as {
        plan: unknown;
        plan_expires_at: string | null;
        comp_plan: string | null;
        comp_expires_at: string | null;
      }[];
    }),
  ]);
  const store = storeRows[0];
  if (!store) return null;
  if (!gateway?.enabled) return null;
  if (!limitsFor(effectivePlan(store)).onlinePayments) return null;
  return gateway.creds;
}

/** The platform's own Razorpay account (AI-credit purchases). Null until the
 *  RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET env vars are set. */
export function getPlatformRazorpayCreds(): RazorpayCreds | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}
