import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { decryptSecret } from "@/lib/payments/crypto";
import {
  storeWhatsappAccounts,
  stores,
  whatsappContacts,
  whatsappTemplates,
} from "@/drizzle/schema";
import { effectivePlan, limitsFor } from "@/lib/plans";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { logError } from "@/lib/observability/logger";
import { textablePhone } from "@/lib/phone";

// ---------------------------------------------------------------------------
// Can this store send THIS notification on WhatsApp, to THIS person?
//
// ── ★★ FOUR CONDITIONS, ALL PER STORE OR PER PERSON ────────────────────────
//   1. a CONNECTED and ENABLED number, on a plan that still includes WhatsApp
//      (Basic+; a lapsed plan pauses the channel, never deletes it — §15's
//      soft-downgrade contract);
//   2. the merchant's channel switch for that event and audience;
//   3. an APPROVED template for that event and audience — read at fan-out,
//      not at send (plan §8): a paused or rejected template means the row is
//      never queued, so the log is not filled with failures nobody can act on;
//   4. for a CUSTOMER, their own opt-in to order updates (the checkout box,
//      plan §19.2). Staff need none: a team alert goes to a phone the staff
//      member verified at signup.
//
// The SMS channel (lib/sms/channel.ts) has the first three; the fourth is new
// because Meta requires opt-in for business-initiated messages and a customer
// who never asked for WhatsApp updates reports the first one as spam, which
// lowers the merchant's quality rating for everyone else too.
// ---------------------------------------------------------------------------

export type WhatsAppPrecedence = "whatsapp_first" | "sms_first" | "both";

export interface WhatsAppSender {
  token: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhone: string;
  /** The merchant's rule for a customer reachable on both channels. */
  precedence: WhatsAppPrecedence;
}

/**
 * The store's sender, or null when it cannot send.
 *
 * Null covers never connected, paused, needs-reauth, a plan that lapsed below
 * Basic and a decrypt failure alike — the caller's answer to all of them is
 * the same: queue nothing. The distinction that matters is logged.
 */
export async function loadWhatsAppSender(
  db: Db,
  storeId: string,
): Promise<WhatsAppSender | null> {
  try {
    const rows = await db
      .select({
        enabled: storeWhatsappAccounts.enabled,
        status: storeWhatsappAccounts.status,
        wabaId: storeWhatsappAccounts.wabaId,
        phoneNumberId: storeWhatsappAccounts.phoneNumberId,
        displayPhone: storeWhatsappAccounts.displayPhone,
        tokenEnc: storeWhatsappAccounts.businessTokenEnc,
        plan: stores.plan,
        planExpiresAt: stores.planExpiresAt,
        compPlan: stores.compPlan,
        compExpiresAt: stores.compExpiresAt,
        settings: stores.settings,
      })
      .from(storeWhatsappAccounts)
      .innerJoin(stores, eq(stores.id, storeWhatsappAccounts.storeId))
      .where(eq(storeWhatsappAccounts.storeId, storeId))
      .limit(1);

    const row = rows[0];
    if (!row || !row.enabled || row.status !== "connected") return null;

    const plan = effectivePlan({
      plan: row.plan,
      plan_expires_at: row.planExpiresAt,
      comp_plan: row.compPlan,
      comp_expires_at: row.compExpiresAt,
    });
    if (!limitsFor(plan).whatsapp) return null;

    const settings = resolveStoreSettings(
      (row.settings as Record<string, unknown>) ?? {},
      plan,
    );
    const precedence = settings["whatsapp.updatePrecedence"];

    return {
      token: decryptSecret(row.tokenEnc),
      wabaId: row.wabaId,
      phoneNumberId: row.phoneNumberId,
      displayPhone: row.displayPhone,
      precedence:
        precedence === "sms_first" || precedence === "both"
          ? precedence
          : "whatsapp_first",
    };
  } catch (err) {
    // A decrypt failure means PAYMENT_CRED_KEY rotated without re-encrypting —
    // an error line, because every WhatsApp message for this store stops
    // until it is fixed and nothing else would say so.
    logError("whatsapp: sender load failed", err, { storeId });
    return null;
  }
}

export interface WhatsAppTemplateRow {
  id: string;
  audience: string;
  name: string;
  language: string;
  /** Which named event value fills each `{{n}}`, in order. */
  variables: string[];
  body: string;
}

/** Meta's body text out of a stored components array. */
export function bodyFromComponents(components: unknown): string {
  if (!Array.isArray(components)) return "";
  for (const c of components) {
    if (
      c &&
      typeof c === "object" &&
      (c as { type?: unknown }).type === "BODY" &&
      typeof (c as { text?: unknown }).text === "string"
    ) {
      return (c as { text: string }).text;
    }
  }
  return "";
}

/**
 * The store's APPROVED, enabled templates for one event, keyed by audience.
 *
 * Status is the switch (plan §8). A PENDING template is one Meta has not
 * decided on; a PAUSED one is one Meta stopped; neither is queued, and the
 * notification console says which it is beside the channel switch.
 */
export async function loadWhatsAppTemplates(
  db: Db,
  storeId: string,
  eventKey: string,
): Promise<Map<string, WhatsAppTemplateRow>> {
  const out = new Map<string, WhatsAppTemplateRow>();
  try {
    const rows = await db
      .select({
        id: whatsappTemplates.id,
        audience: whatsappTemplates.audience,
        name: whatsappTemplates.name,
        language: whatsappTemplates.language,
        variables: whatsappTemplates.variables,
        components: whatsappTemplates.components,
      })
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.storeId, storeId),
          eq(whatsappTemplates.eventKey, eventKey),
          eq(whatsappTemplates.status, "APPROVED"),
          eq(whatsappTemplates.enabled, true),
        ),
      );
    for (const r of rows) {
      if (!r.audience) continue;
      out.set(r.audience, {
        id: r.id,
        audience: r.audience,
        name: r.name,
        language: r.language,
        variables: Array.isArray(r.variables) ? (r.variables as string[]) : [],
        body: bodyFromComponents(r.components),
      });
    }
  } catch (err) {
    logError("whatsapp: template load failed", err, { storeId, eventKey });
  }
  return out;
}

export interface WhatsAppConsent {
  updates: boolean;
  marketing: boolean;
}

/**
 * Who, among these numbers, has said yes — keyed by E.164.
 *
 * Absent row = no consent. A row with `updates_opt_out_at` set after its
 * opt-in = withdrawn. Numbers are normalised with `textablePhone` on both
 * sides so a legacy ten-digit `users.phone` still matches the E.164 contact.
 */
export async function whatsAppConsentFor(
  db: Db,
  storeId: string,
  phones: string[],
): Promise<Map<string, WhatsAppConsent>> {
  const out = new Map<string, WhatsAppConsent>();
  const wanted = [
    ...new Set(phones.map(textablePhone).filter(Boolean)),
  ] as string[];
  if (wanted.length === 0) return out;
  try {
    const rows = await db
      .select({
        phone: whatsappContacts.phone,
        updatesIn: whatsappContacts.updatesOptInAt,
        updatesOut: whatsappContacts.updatesOptOutAt,
        marketingIn: whatsappContacts.marketingOptInAt,
        marketingOut: whatsappContacts.marketingOptOutAt,
      })
      .from(whatsappContacts)
      .where(
        and(
          eq(whatsappContacts.storeId, storeId),
          inArray(whatsappContacts.phone, wanted),
        ),
      );
    for (const r of rows) {
      out.set(r.phone, {
        updates: consented(r.updatesIn, r.updatesOut),
        marketing: consented(r.marketingIn, r.marketingOut),
      });
    }
  } catch (err) {
    // ★ FAILS CLOSED: a lookup failure means nobody is messaged, never
    // everybody. The in-app row and the email have already been decided.
    logError("whatsapp: consent lookup failed", err, { storeId });
  }
  return out;
}

/** Opted in, and not opted out since. */
export function consented(
  optInAt: string | null,
  optOutAt: string | null,
): boolean {
  if (!optInAt) return false;
  if (!optOutAt) return true;
  return new Date(optOutAt).getTime() < new Date(optInAt).getTime();
}

/**
 * Can this store send on WhatsApp at all — connected, enabled, on a plan that
 * includes it? A yes/no for a settings gate, so it never touches the token.
 * Own transaction, because its callers are server actions.
 */
export async function storeCanSendWhatsApp(storeId: string): Promise<boolean> {
  try {
    const { withService } = await import("@/lib/db/client");
    const rows = await withService((db) =>
      db
        .select({
          enabled: storeWhatsappAccounts.enabled,
          status: storeWhatsappAccounts.status,
          plan: stores.plan,
          planExpiresAt: stores.planExpiresAt,
          compPlan: stores.compPlan,
          compExpiresAt: stores.compExpiresAt,
        })
        .from(storeWhatsappAccounts)
        .innerJoin(stores, eq(stores.id, storeWhatsappAccounts.storeId))
        .where(eq(storeWhatsappAccounts.storeId, storeId))
        .limit(1),
    );
    const row = rows[0];
    if (!row || !row.enabled || row.status !== "connected") return false;
    return limitsFor(
      effectivePlan({
        plan: row.plan,
        plan_expires_at: row.planExpiresAt,
        comp_plan: row.compPlan,
        comp_expires_at: row.compExpiresAt,
      }),
    ).whatsapp;
  } catch (err) {
    // ★ FAILS CLOSED, for the SMS gate's reason: a false "no" costs a retried
    // settings save; a false "yes" is a switch that looks on and sends nothing.
    logError("whatsapp: connection check failed", err, { storeId });
    return false;
  }
}
