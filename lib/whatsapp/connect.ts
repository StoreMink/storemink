import "server-only";

import crypto from "crypto";
import { and, eq, ne } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { isUniqueViolation, pgConstraint } from "@/lib/db/errors";
import { storeWhatsappAccounts, whatsappNumberPins } from "@/drizzle/schema";
import { decryptSecret, encryptSecret } from "@/lib/payments/crypto";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import {
  debugToken,
  exchangeEmbeddedSignupCode,
  getPhoneNumber,
  getWaba,
  isTokenError,
  listWabaPhoneNumbers,
  registerPhoneNumber,
  subscribeAppToWaba,
  unsubscribeAppFromWaba,
  type GraphResult,
} from "./graph";
import { resetTemplatesForWaba } from "./templates";

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
//   3. find the number: the one the popup named, or, when the Coexistence
//      popup named only the WABA, the WABA's one number as Meta lists it;
//   4. read the WABA and the number (display phone, name status, tier), and
//      refuse a number another store already holds;
//   5. ★★ SUBSCRIBE OUR APP TO THE WABA — the step Phase 0 found missing,
//      without which the merchant's inbox is silent with nothing failing;
//   6. register the number with the PIN we hold for it (not for Coexistence:
//      the WhatsApp Business app already registered it);
//   7. store it all, token and PIN encrypted, and reset any templates the
//      store holds from another WABA.
//
// Everything after step 1 is idempotent at Meta, so a merchant who retries
// after a network blip is not refused for a WABA that is "already subscribed"
// or a number that is "already registered" (same PIN, below).
// ---------------------------------------------------------------------------

export interface ConnectInput {
  storeId: string;
  code: string;
  wabaId: string;
  /** Meta's id for the number. EMPTY when the Coexistence popup finished with
   *  the WABA alone (embedded-signup.ts); the number is then read from Meta
   *  under the proven token. */
  phoneNumberId: string;
  coexistence: boolean;
}

export type ConnectResult =
  | { ok: true; displayPhone: string; verifiedName: string | null }
  | { ok: false; error: string };

const META_ID = /^\d{5,32}$/;

/** The unique key that makes `phone_number_id` the webhook routing key. */
const PHONE_NUMBER_KEY = "store_whatsapp_accounts_phone_number_id_key";

const NUMBER_HELD_ELSEWHERE =
  "That WhatsApp number is already connected to another StoreMink store. Disconnect it there first.";

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

/**
 * The WABA's one number, for the Coexistence finish that names only the WABA.
 *
 * ★ ONE, OR NOTHING IS SAVED. Meta lists the numbers under the token already
 * proved against the WABA, so the id is Meta's word, not the page's. With
 * none there is nothing to connect, and with several there is no telling
 * which one the merchant just onboarded; guessing would connect the wrong
 * number to the store's inbox and order updates.
 */
async function onlyNumberOnWaba(
  token: string,
  wabaId: string,
): Promise<{ ok: true; phoneNumberId: string } | { ok: false; error: string }> {
  const listed = await listWabaPhoneNumbers(token, wabaId);
  if (!listed.ok) {
    return { ok: false, error: friendly("finding your phone number", listed) };
  }
  const numbers = listed.data.data;
  if (numbers.length === 0) {
    return {
      ok: false,
      error:
        "Meta finished without a phone number on that WhatsApp Business account, so nothing was saved. Connect again and finish adding the number you use on the WhatsApp Business app.",
    };
  }
  if (numbers.length > 1 || listed.data.more) {
    return {
      ok: false,
      error:
        "That WhatsApp Business account holds more than one phone number, and Meta didn't say which one you connected, so nothing was saved. Connect again and choose a WhatsApp Business account that holds only this number (Meta's window lets you create a new one).",
    };
  }
  const phoneNumberId = String(numbers[0]?.id ?? "").trim();
  if (!META_ID.test(phoneNumberId)) {
    return { ok: false, error: "Meta returned a number it didn't identify." };
  }
  return { ok: true, phoneNumberId };
}

/**
 * Does another store already hold this number?
 *
 * ★ ASKED BEFORE ANYTHING CHANGES AT META, so a number another store holds is
 * neither re-registered nor has its PIN row moved to this store. The unique
 * key on the account row stays the authority (two connects can race past
 * this read); a failed read lets the connect carry on to it.
 */
async function numberHeldByAnotherStore(
  storeId: string,
  phoneNumberId: string,
): Promise<boolean> {
  try {
    const rows = await withService((db) =>
      db
        .select({ storeId: storeWhatsappAccounts.storeId })
        .from(storeWhatsappAccounts)
        .where(
          and(
            eq(storeWhatsappAccounts.phoneNumberId, phoneNumberId),
            ne(storeWhatsappAccounts.storeId, storeId),
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  } catch (err) {
    logWarn("whatsapp connect: couldn't check who holds the number", {
      storeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * The two-step verification PIN to register this number with, claimed for
 * this store BEFORE register is called.
 *
 * ★ META KEEPS ONE PIN PER NUMBER, AND REFUSES ANY OTHER. Every connect used
 * to register with a freshly generated PIN that nothing read back, so
 * Disconnect then Connect (the only recovery the card offers for
 * needs_reauth), or a retry after a register that timed out but landed,
 * failed with Meta's PIN mismatch until the merchant switched two-step
 * verification off. `whatsapp_number_pins` holds the number's PIN apart from
 * the account row, which Disconnect deletes; a PIN is generated only for a
 * number that has none.
 *
 * ★ STORED FIRST, THEN REGISTERED. A register whose answer is lost may still
 * have set the PIN at Meta; persisting it beforehand is what lets the retry
 * present the same one.
 *
 * ★ THE UPSERT NEVER REPLACES A PIN. It moves `store_id` to this store and
 * returns the PIN in force, so two connects racing on one number register
 * with the same PIN whichever inserted first.
 */
async function pinForNumber(
  storeId: string,
  phoneNumberId: string,
): Promise<
  { ok: true; pin: string; pinEnc: string } | { ok: false; error: string }
> {
  let pinEnc: string | undefined;
  try {
    pinEnc = await withService(async (db) => {
      const held = await db
        .select({ pinEnc: whatsappNumberPins.pinEnc })
        .from(whatsappNumberPins)
        .where(eq(whatsappNumberPins.phoneNumberId, phoneNumberId))
        .limit(1);
      const candidate = held[0]?.pinEnc ?? encryptSecret(generatePin());
      const now = new Date().toISOString();
      const rows = await db
        .insert(whatsappNumberPins)
        .values({ phoneNumberId, storeId, pinEnc: candidate, updatedAt: now })
        .onConflictDoUpdate({
          target: whatsappNumberPins.phoneNumberId,
          set: { storeId, updatedAt: now },
        })
        .returning({ pinEnc: whatsappNumberPins.pinEnc });
      return rows[0]?.pinEnc;
    });
  } catch (err) {
    logError("whatsapp connect: PIN store failed", err, { storeId });
    return {
      ok: false,
      error:
        "Couldn't prepare your number for registration. Nothing was saved - try again in a minute.",
    };
  }
  let pin = "";
  try {
    pin = pinEnc ? decryptSecret(pinEnc) : "";
  } catch (err) {
    logError("whatsapp connect: PIN decrypt failed", err, { storeId });
  }
  if (!pinEnc || !/^\d{6}$/.test(pin)) {
    return {
      ok: false,
      error:
        "The PIN stored for this number can't be read, so nothing was saved. Contact StoreMink support.",
    };
  }
  return { ok: true, pin, pinEnc };
}

export async function connectWhatsAppAccount(
  input: ConnectInput,
): Promise<ConnectResult> {
  const wabaId = input.wabaId.trim();
  const namedNumber = input.phoneNumberId.trim();
  // An empty number is accepted only from Coexistence, the one flow whose
  // finish names the WABA alone; anything else from the page must be ids.
  const numberOk = namedNumber ? META_ID.test(namedNumber) : input.coexistence;
  if (!META_ID.test(wabaId) || !numberOk) {
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

  // 3. The number, as the popup named it or as Meta lists it on the WABA.
  let phoneNumberId = namedNumber;
  if (!phoneNumberId) {
    const found = await onlyNumberOnWaba(token, wabaId);
    if (!found.ok) return found;
    phoneNumberId = found.phoneNumberId;
  }

  // 4. Read the WABA and the number.
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
  if (await numberHeldByAnotherStore(input.storeId, phoneNumberId)) {
    return { ok: false, error: NUMBER_HELD_ELSEWHERE };
  }

  // 5. Subscribe our app to the WABA. ★ Refused rather than deferred: a
  //    connection that cannot receive is not a connection (plan §9).
  const sub = await subscribeAppToWaba(token, wabaId);
  if (!sub.ok) {
    return { ok: false, error: friendly("subscribing to your account", sub) };
  }

  // 6. Register the number (not under Coexistence).
  let registeredAt: string | null = null;
  let pinEnc: string;
  if (input.coexistence) {
    // The WhatsApp Business app registered the number and owns its PIN; the
    // account row's PIN column is NOT NULL, so it holds one that is never
    // presented, and the number's PIN row is left alone.
    pinEnc = encryptSecret(generatePin());
  } else {
    const held = await pinForNumber(input.storeId, phoneNumberId);
    if (!held.ok) return held;
    const reg = await registerPhoneNumber(token, phoneNumberId, held.pin);
    if (!reg.ok) {
      // A number already registered with a DIFFERENT PIN (by another
      // provider, or changed in WhatsApp Manager) is the one case a merchant
      // has to resolve in WhatsApp Manager; say so rather than "refused".
      return {
        ok: false,
        error:
          reg.outcome === "rejected"
            ? `Meta refused to register the number: ${reg.error} If this number was set up before, turn off two-step verification in WhatsApp Manager and try again.`
            : friendly("registering your number", reg),
      };
    }
    registeredAt = new Date().toISOString();
    pinEnc = held.pinEnc;
  }

  // 7. Store. One row per store; a reconnect replaces it. The unique index on
  //    phone_number_id refuses a number another store already holds.
  const now = new Date().toISOString();
  const fields = {
    wabaId,
    phoneNumberId,
    displayPhone,
    verifiedName: phone.data.verified_name ?? null,
    nameStatus: phone.data.name_status ?? null,
    businessTokenEnc: encryptSecret(token),
    // The same value as the number's PIN row (whatsapp_number_pins), which
    // is the copy a later connect reads.
    twoFaPinEnc: pinEnc,
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

  let moved = 0;
  try {
    moved = await withService(async (db) => {
      await db
        .insert(storeWhatsappAccounts)
        .values({ storeId: input.storeId, ...fields })
        .onConflictDoUpdate({
          target: storeWhatsappAccounts.storeId,
          set: fields,
        });
      // ★ In the same commit that moves the account: from the moment it
      // names this WABA, no template row may claim an answer another WABA
      // gave (lib/whatsapp/templates.ts).
      return resetTemplatesForWaba(db, input.storeId, wabaId, now);
    });
  } catch (err) {
    // ★ The constraint is on the pg error, which Drizzle keeps on `cause`;
    // the wrapper's own message names the SQL, not the constraint. A unique
    // violation naming no constraint can only be this key: the upsert
    // resolves the primary key itself.
    if (
      isUniqueViolation(err) &&
      (pgConstraint(err) ?? PHONE_NUMBER_KEY) === PHONE_NUMBER_KEY
    ) {
      return { ok: false, error: NUMBER_HELD_ELSEWHERE };
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
    ...(moved > 0 ? { templatesReset: moved } : {}),
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
 * May our app be unsubscribed from this WABA when `storeId` lets go of it?
 *
 * ★ ONLY WHEN NO OTHER STORE'S ROW NAMES THE WABA. Nothing stops two stores
 * connecting numbers on one WABA (only `phone_number_id` is unique), and the
 * subscription is per WABA: unsubscribing for one would silence every
 * webhook of the other (messages, delivery statuses, COD taps, so its COD
 * orders would be auto-cancelled as unconfirmed). ★ A failed read keeps the
 * subscription: an extra webhook nobody routes costs nothing, a silenced
 * store costs orders.
 */
async function wabaFreeToUnsubscribe(
  storeId: string,
  wabaId: string,
): Promise<boolean> {
  try {
    const others = await withService((db) =>
      db
        .select({ storeId: storeWhatsappAccounts.storeId })
        .from(storeWhatsappAccounts)
        .where(
          and(
            eq(storeWhatsappAccounts.wabaId, wabaId),
            ne(storeWhatsappAccounts.storeId, storeId),
          ),
        )
        .limit(1),
    );
    if (others.length > 0) {
      logInfo("whatsapp disconnect: WABA kept subscribed for another store", {
        storeId,
      });
      return false;
    }
    return true;
  } catch (err) {
    logWarn("whatsapp disconnect: couldn't check the WABA's other stores", {
      storeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Forget the connection. Best-effort unsubscribe first, so Meta stops posting
 * a WABA we no longer hold a row for; the delete proceeds whether or not Meta
 * answers, because a merchant disconnecting must always be able to.
 *
 * ★ The number's PIN row (whatsapp_number_pins) is NOT deleted: Meta still
 * holds that PIN, and the next connect of the number has to present it.
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
  if (row && (await wabaFreeToUnsubscribe(storeId, row.wabaId))) {
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
