// ---------------------------------------------------------------------------
// The exact words a shopper agrees to — client-safe, because the checkout and
// the account page render them and the server snapshots them onto the contact
// row (docs/whatsapp-commerce-plan.md §10, §19.2). One copy per surface, so
// what was shown and what was recorded cannot differ.
//
// ★ THREE SURFACES, THREE SNAPSHOTS. A consent record names the words that
// were in front of the person: the checkout box, the account-page switch, or
// — for START after a STOP — the reply they typed. Reusing the checkout
// sentence for a switch on the account page would record a sentence nobody
// saw.
// ---------------------------------------------------------------------------

export const WHATSAPP_UPDATES_CONSENT =
  "Send me order updates on WhatsApp (confirmation, ready to collect, shipped, delivered, refunds).";

export const WHATSAPP_MARKETING_CONSENT =
  "Also send me offers and news on WhatsApp. You can reply STOP at any time.";

/** The account page's switches (My account → WhatsApp). */
export const WHATSAPP_UPDATES_CONSENT_ACCOUNT =
  "Order updates on WhatsApp: confirmation, ready to collect, shipped, delivered and refunds.";

export const WHATSAPP_MARKETING_CONSENT_ACCOUNT =
  "Offers and news on WhatsApp. Reply STOP to any message to turn this off.";

/** Recorded when a customer who had opted in replies START after STOP. */
export const WHATSAPP_MARKETING_CONSENT_REPLY =
  "Replied START on WhatsApp to receive offers and news again.";

export type WhatsAppConsentSurface = "checkout" | "account";

export function whatsAppConsentCopy(surface: WhatsAppConsentSurface): {
  updates: string;
  marketing: string;
} {
  return surface === "account"
    ? {
        updates: WHATSAPP_UPDATES_CONSENT_ACCOUNT,
        marketing: WHATSAPP_MARKETING_CONSENT_ACCOUNT,
      }
    : {
        updates: WHATSAPP_UPDATES_CONSENT,
        marketing: WHATSAPP_MARKETING_CONSENT,
      };
}

export interface WhatsAppConsentInput {
  updates: boolean;
  marketing: boolean;
}

/** The checkout's default: updates on, offers off (plan §19.2). */
export const WHATSAPP_CONSENT_DEFAULT: WhatsAppConsentInput = {
  updates: true,
  marketing: false,
};
