import "server-only";

import crypto from "crypto";
import { eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { storeWhatsappAccounts } from "@/drizzle/schema";
import { decryptSecret, encryptSecret } from "@/lib/payments/crypto";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import {
  debugToken,
  exchangeEmbeddedSignupCode,
  getPhoneNumber,
  getWaba,
  isTokenError,
  registerPhoneNumber,
  subscribeAppToWaba,
  unsubscribeAppFromWaba,
  type GraphResult,
} from "./graph";

// ---------------------------------------------------------------------------
// Connecting a merchant's WhatsApp number — the server half of Embedded
// Signup (docs/whatsapp-commerce-plan.md §5 step 2).
//
// The browser hands us three things from Meta's popup: a short-lived CODE,
// and the WABA id + phone number id the SDK posted to the page. In order:
//
//   1. exchange the code for a business token (app secret, server-side);
//   2. ★ PROVE the token reaches the WABA the browser named — the ids came
//      from a page, and a page can post anything;
//   3. read the WABA and the number (display phone, name status, tier);
//   4. ★★ SUBSCRIBE OUR APP TO THE WABA — the step Phase 0 found missing,
//      without which the merchant's inbox is silent with nothing failing;
//   5. register the number with a PIN we generate (not for Coexistence —
//      the WhatsApp Business app already registered it);
//   6. store it all, token and PIN encrypted.
//
// Everything after step 1 is idempotent at Meta, so a merchant who retries
// after a network blip is not refused for a WABA that is "already subscribed".
// ---------------------------------------------------------------------------

export interface ConnectInput {
  storeId: string;
  code: string;
  wabaId: string;
  phoneNumberId: string;
  coexistence: boolean;
}

export type ConnectResult =
  | { ok: true; displayPhone: string; verifiedName: string | null }
  | { ok: false; error: string };

function friendly<T>(step: string, r: GraphResult<T>): string {
  if (r.ok) return "";
  return r.outcome === "unknown"
    ? `Meta didn't answer while ${step}. Nothing was saved - try again in a minute.`
    : `Meta refused while ${step}: ${r.error}`;
}

/** Six digits, cryptographically random, never "123456". */
export function generatePin(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function connectWhatsAppAccount(
  input: ConnectInput,
): Promise<ConnectResult> {
  const wabaId = input.wabaId.trim();
  const phoneNumberId = input.phoneNumberId.trim();
  if (!/^\d{5,32}$/.test(wabaId) || !/^\d{5,32}$/.test(phoneNumberId)) {
    return { ok: false, error: "Meta's popup didn't return a valid account." };
  }

  // 1. Code → business token.
  const exchanged = await exchangeEmbeddedSignupCode(input.code.trim());
  if (!exchanged.ok) {
    return {
      ok: false,
      error: friendly("signing you in with Meta", exchanged),
    };
  }
  const token = exchanged.data.access_token;
  if (!token) {
    return { ok: false, error: "Meta returned no access token." };
  }

  // 2. The token must reach THIS WABA. `granular_scopes` is the authority;
  //    an older token shape without it falls back to a direct read, which a
  //    foreign WABA refuses.
  const debug = await debugToken(token);
  if (!debug.ok) {
    return { ok: false, error: friendly("checking the connection", debug) };
  }
  const grants = debug.data.data?.granular_scopes;
  if (grants) {
    const allowed = new Set(
      grants
        .filter((g) => g.scope === "whatsapp_business_management")
        .flatMap((g) => g.target_ids ?? []),
    );
    if (allowed.size > 0 && !allowed.has(wabaId)) {
      logWarn("whatsapp connect: WABA not in token grants", {
        storeId: input.storeId,
      });
      return {
        ok: false,
        error:
          "The WhatsApp account Meta returned isn't one this login was granted. Try connecting again and pick the business in the popup.",
      };
    }
  }

  // 3. Read the WABA and the number.
  const [waba, phone] = await Promise.all([
    getWaba(token, wabaId),
    getPhoneNumber(token, phoneNumberId),
  ]);
  if (!waba.ok) {
    return {
      ok: false,
      error: friendly("reading your WhatsApp account", waba),
    };
  }
  if (!phone.ok) {
    return { ok: false, error: friendly("reading your phone number", phone) };
  }
  const displayPhone = phone.data.display_phone_number?.trim();
  if (!displayPhone) {
    return { ok: false, error: "Meta returned a number with no phone number." };
  }

  // 4. Subscribe our app to the WABA. ★ Refused rather than deferred: a
  //    connection that cannot receive is not a connection (plan §9).
  const sub = await subscribeAppToWaba(token, wabaId);
  if (!sub.ok) {
    return { ok: false, error: friendly("subscribing to your account", sub) };
  }

  // 5. Register the number (not under Coexistence).
  const pin = generatePin();
  let registeredAt: string | null = null;
  if (!input.coexistence) {
    const reg = await registerPhoneNumber(token, phoneNumberId, pin);
    if (!reg.ok) {
      // A number already registered with a DIFFERENT PIN is the one case a
      // merchant has to resolve in WhatsApp Manager; say so rather than
      // "refused".
      return {
        ok: false,
        error:
          reg.outcome === "rejected"
            ? `Meta refused to register the number: ${reg.error} If this number was set up before, turn off two-step verification in WhatsApp Manager and try again.`
            : friendly("registering your number", reg),
      };
    }
    registeredAt = new Date().toISOString();
  }

  // 6. Store. One row per store; a reconnect replaces it. The unique index on
  //    phone_number_id refuses a number another store already holds.
  const now = new Date().toISOString();
  const fields = {
    wabaId,
    phoneNumberId,
    displayPhone,
    verifiedName: phone.data.verified_name ?? null,
    nameStatus: phone.data.name_status ?? null,
    businessTokenEnc: encryptSecret(token),
    twoFaPinEnc: encryptSecret(pin),
    coexistence: input.coexistence,
    messagingTier: phone.data.messaging_limit_tier ?? null,
    qualityRating: phone.data.quality_rating ?? null,
    wabaName: waba.data.name ?? null,
    wabaReviewStatus: waba.data.account_review_status ?? null,
    appSubscribedAt: now,
    registeredAt,
    status: "connected",
    enabled: true,
    // Meta caps a Coexistence number well below a Cloud-only one.
    sendRatePerSec: input.coexistence ? 20 : 80,
    lastError: null,
    updatedAt: now,
  };

  try {
    await withService((db) =>
      db
        .insert(storeWhatsappAccounts)
        .values({ storeId: input.storeId, ...fields })
        .onConflictDoUpdate({
          target: storeWhatsappAccounts.storeId,
          set: fields,
        }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/phone_number_id_key/.test(msg)) {
      return {
        ok: false,
        error:
          "That WhatsApp number is already connected to another StoreMink store. Disconnect it there first.",
      };
    }
    logError("whatsapp connect: store failed", err, { storeId: input.storeId });
    return {
      ok: false,
      error: "Couldn't save the connection. Please try again.",
    };
  }

  logInfo("whatsapp connected", {
    storeId: input.storeId,
    coexistence: input.coexistence,
    tier: fields.messagingTier,
  });
  return {
    ok: true,
    displayPhone,
    verifiedName: fields.verifiedName,
  };
}

/**
 * Re-read tier, quality and name status from Meta. Webhooks carry most of
 * these, but a merchant pressing "Refresh" wants the answer now, and a token
 * that has died is discovered here (`needs_reauth`) rather than on the next
 * customer's order confirmation.
 */
export async function refreshWhatsAppAccount(
  storeId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await withService((db) =>
    db
      .select({
        phoneNumberId: storeWhatsappAccounts.phoneNumberId,
        wabaId: storeWhatsappAccounts.wabaId,
        tokenEnc: storeWhatsappAccounts.businessTokenEnc,
      })
      .from(storeWhatsappAccounts)
      .where(eq(storeWhatsappAccounts.storeId, storeId))
      .limit(1),
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "WhatsApp isn't connected." };

  let token: string;
  try {
    token = decryptSecret(row.tokenEnc);
  } catch (err) {
    logError("whatsapp refresh: decrypt failed", err, { storeId });
    return { ok: false, error: "The stored connection can't be read." };
  }

  const [phone, waba] = await Promise.all([
    getPhoneNumber(token, row.phoneNumberId),
    getWaba(token, row.wabaId),
  ]);

  if (isTokenError(phone) || isTokenError(waba)) {
    await withService((db) =>
      db
        .update(storeWhatsappAccounts)
        .set({
          status: "needs_reauth",
          lastError: "Meta no longer accepts the connection; reconnect.",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(storeWhatsappAccounts.storeId, storeId)),
    );
    return {
      ok: false,
      error: "Meta no longer accepts this connection. Reconnect WhatsApp.",
    };
  }
  if (!phone.ok)
    return { ok: false, error: friendly("reading your number", phone) };

  await withService((db) =>
    db
      .update(storeWhatsappAccounts)
      .set({
        displayPhone: phone.data.display_phone_number ?? undefined,
        verifiedName: phone.data.verified_name ?? null,
        nameStatus: phone.data.name_status ?? null,
        messagingTier: phone.data.messaging_limit_tier ?? null,
        qualityRating: phone.data.quality_rating ?? null,
        wabaName: waba.ok ? (waba.data.name ?? null) : undefined,
        wabaReviewStatus: waba.ok
          ? (waba.data.account_review_status ?? null)
          : undefined,
        status: "connected",
        lastError: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(storeWhatsappAccounts.storeId, storeId)),
  );
  return { ok: true };
}

/**
 * Forget the connection. Best-effort unsubscribe first, so Meta stops posting
 * a WABA we no longer hold a row for; the delete proceeds whether or not Meta
 * answers, because a merchant disconnecting must always be able to.
 */
export async function disconnectWhatsAppAccount(
  storeId: string,
): Promise<void> {
  const rows = await withService((db) =>
    db
      .select({
        wabaId: storeWhatsappAccounts.wabaId,
        tokenEnc: storeWhatsappAccounts.businessTokenEnc,
      })
      .from(storeWhatsappAccounts)
      .where(eq(storeWhatsappAccounts.storeId, storeId))
      .limit(1),
  );
  const row = rows[0];
  if (row) {
    try {
      const token = decryptSecret(row.tokenEnc);
      const r = await unsubscribeAppFromWaba(token, row.wabaId);
      if (!r.ok) {
        logWarn("whatsapp disconnect: unsubscribe failed", {
          storeId,
          error: r.error,
        });
      }
    } catch (err) {
      logWarn("whatsapp disconnect: could not unsubscribe", {
        storeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await withService((db) =>
    db
      .delete(storeWhatsappAccounts)
      .where(eq(storeWhatsappAccounts.storeId, storeId)),
  );
}
