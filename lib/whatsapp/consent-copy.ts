// ---------------------------------------------------------------------------
// The exact words a shopper agrees to at checkout — client-safe, because the
// checkout renders them and the server snapshots them onto the contact row
// (docs/whatsapp-commerce-plan.md §10, §19.2). One copy, so what was shown and
// what was recorded cannot differ.
// ---------------------------------------------------------------------------

export const WHATSAPP_UPDATES_CONSENT =
  "Send me order updates on WhatsApp (confirmation, ready to collect, shipped, delivered, refunds).";

export const WHATSAPP_MARKETING_CONSENT =
  "Also send me offers and news on WhatsApp. You can reply STOP at any time.";

export interface WhatsAppConsentInput {
  updates: boolean;
  marketing: boolean;
}

/** The checkout's default: updates on, offers off (plan §19.2). */
export const WHATSAPP_CONSENT_DEFAULT: WhatsAppConsentInput = {
  updates: true,
  marketing: false,
};
