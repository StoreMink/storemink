import "server-only";

import { composeEmail, emailCode, emailNote, emailParagraph } from "./shell";
import { platformEmailBrand } from "./platform-brand";
import { PLATFORM_EMAIL_DOMAIN } from "./sender";
import { emailConfigured, logEmail, sendEmail } from "./send";

/** RFC-reserved domains are safe dummy identities and never have real inboxes. */
function isReservedTestAddress(email: string): boolean {
  const domain = email.split("@").at(-1)?.toLowerCase();
  if (!domain) return false;
  return (
    domain === "example.com" ||
    domain === "example.net" ||
    domain === "example.org" ||
    domain.endsWith(".test") ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".localhost")
  );
}

export interface SignupOtpDelivery {
  sent: boolean;
  /** The code exists only in the operator log because this is a dummy address. */
  operatorLogOnly: boolean;
  /** The code was printed to the server console because mail is unconfigured. */
  devConsoleOnly: boolean;
  error?: string;
}

/**
 * The signup verification code email, as a pure value: no DB, no network.
 *
 * The code leads the subject because the inbox list shows the subject, so a
 * merchant mid-signup can read it without opening the mail.
 */
export function buildSignupOtpEmail(code: string): {
  subject: string;
  html: string;
} {
  const html = composeEmail({
    brand: platformEmailBrand(),
    heading: "Verify your email",
    preheader:
      "Enter it to continue creating your store. It expires in 10 minutes.",
    blocks: [
      emailParagraph(
        "Use this code to confirm your email address and continue creating your StoreMink store.",
        { lead: true },
      ),
      emailCode(code, { hint: "Enter it on the signup screen." }),
      emailNote(
        "This code expires in 10 minutes. If you didn't start a StoreMink signup, you can safely ignore this email.",
      ),
    ],
    footerReasonHtml:
      "You're receiving this because this address was used to start a StoreMink signup.",
  });
  return { subject: `${code} is your StoreMink verification code`, html };
}

/** Send a merchant signup code and always record it as platform mail. */
export async function sendSignupOtpEmail(
  to: string,
  code: string,
): Promise<SignupOtpDelivery> {
  const { subject, html: body } = buildSignupOtpEmail(code);

  // Reserved example domains are specifically for documentation/testing and
  // cannot receive mail. Recording instead of calling Resend makes dummy-store
  // creation deterministic while keeping the code behind the operator gate.
  if (isReservedTestAddress(to)) {
    await logEmail({
      to,
      from: `StoreMink <security@${PLATFORM_EMAIL_DOMAIN}>`,
      subject,
      html: body,
      mailer: "signup_test_otp",
      status: "skipped",
      error: "Reserved test address: retrieve the code from the operator log",
    });
    return { sent: false, operatorLogOnly: true, devConsoleOnly: false };
  }

  // Local development has no RESEND_API_KEY, so sendEmail skips and reports
  // `sent: false`, and the caller only sets the code cookie on a delivery that
  // got somewhere, so the verify step becomes unpassable. The signup then dead
  // ends on its very first stage with no way forward. Print the code instead,
  // exactly as the POS staff mailer does for its invitation links.
  //
  // Gated to NON-production deliberately, unlike that mailer. Staging and prod
  // both run NODE_ENV=production and both take RESEND_API_KEY from Secret
  // Manager, so this can only fire locally. If a deployed environment ever did
  // lose the key, printing live codes into Cloud Logging while telling the
  // merchant "we've emailed you" is far worse than failing loudly.
  if (!emailConfigured() && process.env.NODE_ENV !== "production") {
    console.log("\n" + "=".repeat(60));
    console.log(`StoreMink signup code for ${to}: ${code}`);
    console.log("No RESEND_API_KEY, so no email was sent. Expires in 10 min.");
    console.log("=".repeat(60) + "\n");
    // Rule 2 of the send choke point: the log is written either way.
    await logEmail({
      to,
      from: `StoreMink <security@${PLATFORM_EMAIL_DOMAIN}>`,
      subject,
      html: body,
      mailer: "signup_otp",
      status: "skipped",
      error: "RESEND_API_KEY not configured: code printed to the dev console",
    });
    return { sent: false, operatorLogOnly: false, devConsoleOnly: true };
  }

  const result = await sendEmail({
    to,
    from: `StoreMink <security@${PLATFORM_EMAIL_DOMAIN}>`,
    subject,
    html: body,
    mailer: "signup_otp",
    ignoreSuppression: true,
  });
  return {
    sent: result.sent,
    operatorLogOnly: false,
    devConsoleOnly: false,
    error: result.error,
  };
}
