import "server-only";

// Shared transport for the two POS staff emails (invitation + credential reset).
// Both are branded, best-effort (a send failure must never fail the action), and
// fall back to a console log when Resend isn't configured. Otherwise there is
// no way to obtain the link in local development.
//
// The messages themselves are built by the pure builders in
// lib/email/account-emails.ts, which compose the standard email design; this
// module only fetches the brand and sends what they return, unchanged.
//
// Sends through lib/email/send.ts like everything else, so these land in the
// store's Email Logs. Both mailers are marked SENSITIVE: the link in each is a
// single-use token that by itself grants register access, so the log records
// that it went out without storing the token.

import { getStoreBrandById } from "@/lib/store/brand";
import { fromAddress } from "@/lib/email/sender";
import { getRequestOrigin } from "@/lib/request-url";
import { getStoreUrl } from "@/lib/site";
import { sendEmail } from "@/lib/email/send";
import type { MailerKey } from "@/lib/email/mailers";
import type { StoreBrand } from "@/lib/store/brand";

/**
 * An absolute URL on the host the CURRENT request is being served from, so
 * emailed links are clickable in local dev, staging and production alike.
 * Falls back to the store's canonical origin outside a request scope.
 */
export async function posAbsoluteUrl(path: string): Promise<string> {
  const origin = (await getRequestOrigin()) ?? (await getStoreUrl());
  return `${origin}${path}`;
}

export async function sendPosStaffEmail(opts: {
  storeId: string;
  to: string;
  /** Which kind of POS mail this is — drives the Email Logs entry. */
  mailer: MailerKey;
  /** Built with the store's brand so copy can use the store name. Returns a
   *  complete email document (lib/email/account-emails.ts), sent as-is. */
  build: (brand: StoreBrand) => { subject: string; html: string };
  /** Logged instead when no email provider is configured (dev). */
  devFallback: string;
}): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY;
  const available = resendApiKey && !resendApiKey.includes("placeholder");

  if (!available) {
    console.log("\n" + "=".repeat(60));
    console.log(opts.devFallback);
    console.log("=".repeat(60) + "\n");
    return;
  }

  const brand = await getStoreBrandById(opts.storeId);
  const { subject, html } = opts.build(brand);
  // sendEmail never throws into its caller and records the outcome either way,
  // so there is nothing left for a try/catch to add here.
  await sendEmail({
    storeId: opts.storeId,
    // From/Subject are mail headers, NOT HTML — build the From with the
    // RFC-5322-safe helper and leave the brand name unescaped in both.
    from: fromAddress(brand, { suffix: "POS" }),
    to: opts.to,
    subject,
    html,
    mailer: opts.mailer,
    // Locked-out staff need their reset link; an old bounce must not be what
    // keeps them off the register.
    ignoreSuppression: true,
  });
}
