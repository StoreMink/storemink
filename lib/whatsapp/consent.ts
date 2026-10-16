import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { textablePhone } from "@/lib/phone";
import {
  whatsAppConsentCopy,
  type WhatsAppConsentInput,
  type WhatsAppConsentSurface,
} from "./consent-copy";
import { storeCanSendWhatsApp, whatsAppConsentFor } from "./channel";

// ---------------------------------------------------------------------------
// Recording what a shopper agreed to (docs/whatsapp-commerce-plan.md §10).
//
// ★ A TICK IS A UI AFFORDANCE; THE ROW IS THE RECORD — §25's rule. The words
// are snapshotted beside the timestamp, so a later change to the checkout
// label does not rewrite what anyone agreed to. An untick records an opt-out
// only when there was an earlier opt-in to withdraw.
//
// ★ NOTHING IS WRITTEN FOR A STORE THAT CANNOT DELIVER (plan §19.2). The
// checkout only shows the boxes when the store is connected, and this
// re-checks, so a forged form field cannot create consent records for a
// channel the merchant never set up.
//
// ★★ WHOSE NUMBER IS IT? (owner's decision, 2026-10-16: an order's updates go
// to the phone typed at checkout). A shopper may type somebody else's number
// (a gift, a parent's phone). Only a number the shopper has PROVEN is theirs
// (`verified`: their signed-in phone, or the account page) may be linked to
// their account or have its choices changed both ways. A number they merely
// typed gets order updates only if it has never said yes or no before, and is
// never linked: linking it let "where is my order?" from that phone, the inbox
// customer panel and Mink show the shopper's orders and store credit to its
// owner, and let the shopper's boxes undo that person's STOP.
// ---------------------------------------------------------------------------

/** A box's decision: undefined means the box says nothing to record. */
export type WhatsAppConsentChange = Partial<WhatsAppConsentInput>;

export async function recordWhatsAppConsent(input: {
  storeId: string;
  phone: string | null | undefined;
  /** The shopper's account; linked to the contact only when `verified`. */
  userId: string | null;
  /** True when the phone is the shopper's own, proven by their sign-in. */
  verified: boolean;
  consent: WhatsAppConsentChange;
  /** Which words were in front of the person. Defaults to the checkout's. */
  surface?: WhatsAppConsentSurface;
}): Promise<{ ok: boolean }> {
  const phone = textablePhone(input.phone);
  if (!phone) return { ok: false };
  // Both unticked and nothing to withdraw is the common "shopper ignored the
  // boxes" case — but we cannot know whether there is anything to withdraw
  // without reading, so the gate is the connection check, which is cheap.
  if (!(await storeCanSendWhatsApp(input.storeId))) return { ok: false };

  const copy = whatsAppConsentCopy(input.surface ?? "checkout");
  const verified = input.verified;
  const updatesYes = input.consent.updates === true;
  const updatesNo = input.consent.updates === false;
  // Offers are only ever the number's own owner's to give or withdraw.
  const marketingYes = verified && input.consent.marketing === true;
  const marketingNo = verified && input.consent.marketing === false;
  const updatesText = updatesYes ? copy.updates : null;
  const marketingText = marketingYes ? copy.marketing : null;

  // The SET clause per column, chosen here so each rule reads on its own.
  const linkUser = verified
    ? sql`coalesce(excluded.user_id, c.user_id)`
    : sql`c.user_id`;
  // A ticked box refreshes the owner's opt-in; for a typed number it opts in
  // only a number that never answered either way.
  const optInWhen = verified
    ? sql`true`
    : sql`(c.updates_opt_in_at is null and c.updates_opt_out_at is null)`;
  const updatesIn = updatesYes
    ? sql`case when ${optInWhen} then now() else c.updates_opt_in_at end`
    : sql`c.updates_opt_in_at`;
  const updatesWords = updatesYes
    ? sql`case when ${optInWhen} then ${updatesText} else c.updates_consent_text end`
    : sql`c.updates_consent_text`;
  // Only the owner withdraws, and only an opt-in in force.
  const updatesOut =
    updatesYes && verified
      ? sql`null`
      : updatesNo && verified
        ? sql`case when c.updates_opt_in_at is not null
                    and (c.updates_opt_out_at is null
                         or c.updates_opt_out_at < c.updates_opt_in_at)
                   then now() else c.updates_opt_out_at end`
        : sql`c.updates_opt_out_at`;
  const marketingIn = marketingYes ? sql`now()` : sql`c.marketing_opt_in_at`;
  const marketingWords = marketingYes
    ? sql`${marketingText}`
    : sql`c.marketing_consent_text`;
  const marketingOut = marketingYes
    ? sql`null`
    : marketingNo
      ? sql`case when c.marketing_opt_in_at is not null
                  and (c.marketing_opt_out_at is null
                       or c.marketing_opt_out_at < c.marketing_opt_in_at)
                 then now() else c.marketing_opt_out_at end`
      : sql`c.marketing_opt_out_at`;

  try {
    await withService((db) =>
      db.execute(sql`
        insert into public.whatsapp_contacts as c
          (store_id, phone, user_id,
           updates_opt_in_at, updates_consent_text,
           marketing_opt_in_at, marketing_consent_text)
        values
          (${input.storeId}::uuid, ${phone},
           -- The FK to users.id would refuse a shopper with no row in THIS
           -- store (an admin ordering on their own storefront); the consent
           -- still stands, against the phone.
           ${verified ? sql`(select u.id from public.users u where u.id = ${input.userId})` : sql`null`},
           ${updatesYes ? sql`now()` : sql`null`},
           ${updatesText},
           ${marketingYes ? sql`now()` : sql`null`},
           ${marketingText})
        on conflict (store_id, phone) do update set
          user_id = ${linkUser},
          updates_opt_in_at = ${updatesIn},
          updates_consent_text = ${updatesWords},
          updates_opt_out_at = ${updatesOut},
          marketing_opt_in_at = ${marketingIn},
          marketing_consent_text = ${marketingWords},
          marketing_opt_out_at = ${marketingOut},
          updated_at = now()
      `),
    );
    return { ok: true };
  } catch (err) {
    // Best-effort, like every other bookkeeping write after an order: a
    // consent write must never fail the sale it rode in on. The account
    // page reads the result and says so.
    logError("whatsapp: consent write failed", err, { storeId: input.storeId });
    return { ok: false };
  }
}

/**
 * What a number has said, for pre-filling the checkout boxes: null when it
 * has never said anything (the boxes then show their defaults). Without this
 * every repeat order re-ticked updates for somebody who had switched them off
 * on My account, and unticked offers withdrew an opt-in they had given.
 */
export async function storedWhatsAppConsent(
  storeId: string,
  phone: string | null | undefined,
): Promise<WhatsAppConsentInput | null> {
  const e164 = textablePhone(phone);
  if (!e164) return null;
  try {
    const consent = await withService((db) =>
      whatsAppConsentFor(db, storeId, [e164]),
    );
    return consent.get(e164) ?? null;
  } catch {
    return null;
  }
}
