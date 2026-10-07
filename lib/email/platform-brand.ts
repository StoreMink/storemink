import type { StoreBrand } from "@/lib/store/brand";
import { PLATFORM_EMAIL_DOMAIN } from "./sender";

// ---------------------------------------------------------------------------
// StoreMink's own identity for the mail it sends as itself: billing, sign-in
// codes, announcements and operator notifications.
//
// There used to be five hand-written copies of this object (billing, both OTP
// mailers, the announcement action and its worker). One copy means the header
// every platform email wears cannot drift between them.
// ---------------------------------------------------------------------------

/**
 * Where email clients fetch the mark from. Always the production origin: a
 * real inbox cannot load an image from localhost or a preview host, and the
 * versioned asset is identical in every environment.
 */
export const PLATFORM_EMAIL_MARK_URL =
  "https://storemink.com/brand/20260908/storemink-mark.png";

/**
 * The StoreMink lockup, exactly as storemink.com draws it (app/platform/
 * site-header.tsx, homepage.css .smh-logo): the bag mark, then "Store" in ink
 * and "Mink" in the brand purple, in a heavy sans with tight tracking.
 */
export const STOREMINK_INK = "#101018";
export const STOREMINK_PURPLE = "#573cf0";

/** A fresh copy each call, so no caller can mutate another's brand. */
export function platformEmailBrand(): StoreBrand {
  return {
    name: "StoreMink",
    logoUrl: null,
    mark: PLATFORM_EMAIL_MARK_URL,
    // Unused by the email design (one neutral palette, see shell.ts); kept
    // because StoreBrand requires it.
    primaryColor: "#141413",
    tagline: null,
    blurb: null,
    legalName: "StoreMink",
    creditLine: null,
    email: null,
    phone: null,
    hours: null,
    social: { instagram: null, youtube: null, whatsapp: null },
    badges: [],
    domain: PLATFORM_EMAIL_DOMAIN,
  };
}
