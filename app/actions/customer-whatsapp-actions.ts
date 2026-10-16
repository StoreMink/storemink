"use server";

// ---------------------------------------------------------------------------
// A shopper's own WhatsApp choices, on their account page (plan §10, slice 3).
//
// Scope is server-derived on both axes — the session's phone, the HOST's
// store — the customer-credit rule (§29). The checkout is where consent is
// first given; this is where it is changed, and both write through the same
// `recordWhatsAppConsent`, which snapshots the words that were on screen.
// ---------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";
import { getServerUser } from "@/lib/auth/server-user";
import { withService } from "@/lib/db/client";
import { whatsappContacts } from "@/drizzle/schema";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { textablePhone } from "@/lib/phone";
import { consented, storeCanSendWhatsApp } from "@/lib/whatsapp/channel";
import { recordWhatsAppConsent } from "@/lib/whatsapp/consent";
import {
  whatsAppConsentCopy,
  type WhatsAppConsentInput,
} from "@/lib/whatsapp/consent-copy";

export interface MyWhatsAppPreferences {
  /** False when this store cannot message on WhatsApp, or the shopper has no
   *  textable number — the card renders nothing. */
  available: boolean;
  phoneLabel: string | null;
  updates: boolean;
  marketing: boolean;
  copy: { updates: string; marketing: string };
}

const NONE: MyWhatsAppPreferences = {
  available: false,
  phoneLabel: null,
  updates: false,
  marketing: false,
  copy: whatsAppConsentCopy("account"),
};

export async function getMyWhatsAppPreferences(): Promise<MyWhatsAppPreferences> {
  const user = await getServerUser();
  if (!user) return NONE;
  const store = await getCurrentStoreOrNull();
  if (!store) return NONE;
  const phone = textablePhone(user.phone);
  if (!phone) return NONE;
  if (!(await storeCanSendWhatsApp(store.id))) return NONE;

  try {
    const rows = await withService((db) =>
      db
        .select({
          updatesIn: whatsappContacts.updatesOptInAt,
          updatesOut: whatsappContacts.updatesOptOutAt,
          marketingIn: whatsappContacts.marketingOptInAt,
          marketingOut: whatsappContacts.marketingOptOutAt,
        })
        .from(whatsappContacts)
        .where(
          and(
            eq(whatsappContacts.storeId, store.id),
            eq(whatsappContacts.phone, phone),
          ),
        )
        .limit(1),
    );
    const r = rows[0];
    return {
      available: true,
      phoneLabel: phone,
      updates: r ? consented(r.updatesIn, r.updatesOut) : false,
      marketing: r ? consented(r.marketingIn, r.marketingOut) : false,
      copy: whatsAppConsentCopy("account"),
    };
  } catch {
    return NONE;
  }
}

export async function setMyWhatsAppPreferences(
  input: WhatsAppConsentInput,
): Promise<{ ok: boolean; error?: string }> {
  const user = await getServerUser();
  if (!user) return { ok: false, error: "Please sign in first." };
  const store = await getCurrentStoreOrNull();
  if (!store) return { ok: false, error: "Store not found." };
  const phone = textablePhone(user.phone);
  if (!phone) {
    return { ok: false, error: "Your account has no mobile number." };
  }
  // The session's own phone, so the choices are the owner's to make.
  const saved = await recordWhatsAppConsent({
    storeId: store.id,
    phone,
    userId: user.id,
    verified: true,
    consent: {
      updates: Boolean(input?.updates),
      marketing: Boolean(input?.marketing),
    },
    surface: "account",
  });
  // ★ The real outcome: a store paused since the page loaded, or a failed
  // write, used to answer "Saved." for a change nobody recorded.
  if (!saved.ok) {
    return {
      ok: false,
      error:
        "Couldn't save your WhatsApp choices. The store may have paused WhatsApp; try again later.",
    };
  }
  return { ok: true };
}
