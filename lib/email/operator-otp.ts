import "server-only";
import { composeEmail, emailCode, emailNote, emailParagraph } from "./shell";
import { platformEmailBrand } from "./platform-brand";
import { PLATFORM_EMAIL_DOMAIN } from "./sender";
import { sendEmail } from "./send";

/**
 * The operator sign-in code email, as a pure value: no DB, no network.
 *
 * The code leads the subject because the inbox list shows the subject, so an
 * operator waiting at the login screen can read it without opening the mail.
 */
export function buildOperatorOtpEmail(code: string): {
  subject: string;
  html: string;
} {
  const html = composeEmail({
    brand: platformEmailBrand(),
    heading: "Your sign-in code",
    preheader: "It expires in 10 minutes. No one can sign in without it.",
    blocks: [
      emailParagraph(
        "Use this code to sign in to the StoreMink admin console.",
        { lead: true },
      ),
      emailCode(code, { hint: "Enter it on the sign-in screen." }),
      emailNote(
        "This code expires in 10 minutes. If you didn't request it, you can safely ignore this email. No one can sign in without it.",
      ),
    ],
    footerReasonHtml:
      "You're receiving this because someone asked to sign in to the StoreMink admin console with this address.",
  });
  return { subject: `${code} is your StoreMink sign-in code`, html };
}

/**
 * Email a 6-digit operator sign-in code through the platform's Resend domain
 * (proper SPF/DKIM, so it lands in the inbox rather than the spam folder the
 * Firebase magic link landed in). Best-effort: when Resend isn't configured it
 * logs the code to the server (so staging can still test the flow) and returns
 * { sent: false }. It never throws, so a mail hiccup can't wedge the login
 * action.
 */
export async function sendOperatorOtpEmail(
  to: string,
  code: string,
): Promise<{ sent: boolean }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.includes("placeholder")) {
    // Dev / not-yet-configured: surface the code in the logs so the flow is
    // testable without email delivery.
    console.log(
      `📨 [operator otp] Resend not configured: code for ${to}: ${code}`,
    );
    return { sent: false };
  }

  const { subject, html } = buildOperatorOtpEmail(code);

  // Platform mail: storeId stays null, so this only ever shows on the
  // storemink.com console, never in a merchant's own email log.
  //
  // The code is stored IN FULL there (owner's decision, see the note on the
  // `operator_otp` entry in lib/email/mailers.ts), so a sign-in that "never
  // arrived" can be checked against the log directly.
  //
  // ignoreSuppression: someone is sitting at a login screen waiting for this;
  // a historic bounce is not a reason to withhold it.
  const result = await sendEmail({
    to,
    from: `StoreMink <security@${PLATFORM_EMAIL_DOMAIN}>`,
    subject,
    html,
    mailer: "operator_otp",
    ignoreSuppression: true,
  });
  return { sent: result.sent };
}
