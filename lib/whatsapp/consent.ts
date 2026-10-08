import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { textablePhone } from "@/lib/phone";
import {
  WHATSAPP_MARKETING_CONSENT,
  WHATSAPP_UPDATES_CONSENT,
  type WhatsAppConsentInput,
} from "./consent-copy";
import { storeCanSendWhatsApp } from "./channel";

// ---------------------------------------------------------------------------
// Recording what a shopper agreed to (docs/whatsapp-commerce-plan.md §10).
//
// ★ A TICK IS A UI AFFORDANCE; THE ROW IS THE RECORD — §25's rule. The words
// are snapshotted beside the timestamp, so a later change to the checkout
// label does not rewrite what anyone agreed to. An untick records an opt-out
// only when there was an earlier opt-in to withdraw, so an order placed with
// the box unticked by somebody who never opted in writes nothing: there is no
// consent to record and no consent to revoke.
//
// ★ NOTHING IS WRITTEN FOR A STORE THAT CANNOT DELIVER (plan §19.2). The
// checkout only shows the boxes when the store is connected, and this
// re-checks, so a forged form field cannot create consent records for a
// channel the merchant never set up.
// ---------------------------------------------------------------------------

export async function recordWhatsAppConsent(input: {
  storeId: string;
  phone: string | null | undefined;
  userId: string | null;
  consent: WhatsAppConsentInput;
}): Promise<void> {
  const phone = textablePhone(input.phone);
  if (!phone) return;
  // Both unticked and nothing to withdraw is the common "shopper ignored the
  // boxes" case — but we cannot know whether there is anything to withdraw
  // without reading, so the gate is the connection check, which is cheap.
  if (!(await storeCanSendWhatsApp(input.storeId))) return;

  const now = new Date().toISOString();
  const updatesIn = input.consent.updates ? now : null;
  const marketingIn = input.consent.marketing ? now : null;

  try {
    await withService((db) =>
      db.execute(sql`
        insert into public.whatsapp_contacts
          (store_id, phone, user_id,
           updates_opt_in_at, updates_consent_text,
           marketing_opt_in_at, marketing_consent_text)
        values
          (${input.storeId}::uuid, ${phone},
           -- The FK to users.id would refuse a shopper with no row in THIS
           -- store (an admin ordering on their own storefront); the consent
           -- still stands, against the phone.
           (select u.id from public.users u where u.id = ${input.userId}),
           ${updatesIn}::timestamptz,
           ${input.consent.updates ? WHATSAPP_UPDATES_CONSENT : null},
           ${marketingIn}::timestamptz,
           ${input.consent.marketing ? WHATSAPP_MARKETING_CONSENT : null})
        on conflict (store_id, phone) do update set
          -- A ticked box always refreshes the opt-in; an unticked one withdraws
          -- only an opt-in that is currently in force.
          user_id = coalesce(excluded.user_id, public.whatsapp_contacts.user_id),
          updates_opt_in_at = case
            when excluded.updates_opt_in_at is not null then excluded.updates_opt_in_at
            else public.whatsapp_contacts.updates_opt_in_at end,
          updates_consent_text = case
            when excluded.updates_opt_in_at is not null then excluded.updates_consent_text
            else public.whatsapp_contacts.updates_consent_text end,
          updates_opt_out_at = case
            when excluded.updates_opt_in_at is not null then null
            when public.whatsapp_contacts.updates_opt_in_at is not null
                 and (public.whatsapp_contacts.updates_opt_out_at is null
                      or public.whatsapp_contacts.updates_opt_out_at < public.whatsapp_contacts.updates_opt_in_at)
              then now()
            else public.whatsapp_contacts.updates_opt_out_at end,
          marketing_opt_in_at = case
            when excluded.marketing_opt_in_at is not null then excluded.marketing_opt_in_at
            else public.whatsapp_contacts.marketing_opt_in_at end,
          marketing_consent_text = case
            when excluded.marketing_opt_in_at is not null then excluded.marketing_consent_text
            else public.whatsapp_contacts.marketing_consent_text end,
          marketing_opt_out_at = case
            when excluded.marketing_opt_in_at is not null then null
            when public.whatsapp_contacts.marketing_opt_in_at is not null
                 and (public.whatsapp_contacts.marketing_opt_out_at is null
                      or public.whatsapp_contacts.marketing_opt_out_at < public.whatsapp_contacts.marketing_opt_in_at)
              then now()
            else public.whatsapp_contacts.marketing_opt_out_at end,
          updated_at = now()
      `),
    );
  } catch (err) {
    // Best-effort, like every other bookkeeping write after an order: a
    // consent write must never fail the sale it rode in on.
    logError("whatsapp: consent write failed", err, { storeId: input.storeId });
  }
}
