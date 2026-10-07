import {
  EMAIL_FONT,
  EMAIL_THEME,
  composeEmail,
  emailPanel,
  emailParagraph,
  emailSignoff,
  escapeHtml,
} from "./shell";
import { sendEmail } from "./send";
import type { StoreBrand } from "@/lib/store/brand";

/**
 * The acknowledgement a shopper receives after submitting an enquiry: a short
 * thank-you, when to expect a reply, and a copy of what they sent.
 *
 * Pure: no DB, no network. The send function below calls it, and the email
 * gallery and the long-dash guard render it on its own.
 */
export function buildEnquiryAcknowledgementEmail(opts: {
  name: string;
  subject: string | null;
  message: string;
  brand: StoreBrand;
}): { subject: string; html: string } {
  const trimmedSubject = opts.subject?.trim() || "";
  const subjectLine = trimmedSubject
    ? `We received your enquiry: "${trimmedSubject}"`
    : "We received your enquiry";

  const name = opts.name.trim();
  const greeting = name ? `Hi ${escapeHtml(name)},` : "Hi there,";
  const storeName = escapeHtml(opts.brand.name);

  // The copy of their message, quoted in a panel. The subject reads as the
  // title of the quoted message. The message keeps white-space:pre-wrap, which
  // no component offers, so the line breaks the shopper typed survive into the
  // email; both lines are built from the shell's tokens.
  const quoted = `${
    trimmedSubject
      ? `<p style="margin:0 0 10px; font-family:${EMAIL_FONT}; font-size:15px; line-height:1.5; font-weight:600; color:${EMAIL_THEME.ink};">${escapeHtml(trimmedSubject)}</p>`
      : ""
  }<p style="margin:0; font-family:${EMAIL_FONT}; font-size:15px; line-height:1.65; color:${EMAIL_THEME.inkSoft}; white-space:pre-wrap;">${escapeHtml(opts.message)}</p>`;

  return {
    subject: subjectLine,
    html: composeEmail({
      brand: opts.brand,
      heading: "Thanks for reaching out",
      preheader:
        "We've received your enquiry. We usually reply within 1 to 2 business days.",
      blocks: [
        emailParagraph(greeting),
        emailParagraph(
          `We've received your enquiry, and someone from the ${storeName} team will get back to you as soon as possible, usually within 1 to 2 business days.`,
        ),
        emailParagraph("Here's a copy of what you sent us."),
        emailPanel(quoted),
        // "Warm regards" rather than the default "Thanks": the headline has
        // already said thank you.
        emailSignoff(opts.brand.name, "Warm regards,"),
      ],
      footerReasonHtml: `You're receiving this because you sent an enquiry to ${storeName}.`,
    }),
  };
}

/**
 * Acknowledgement sent to a customer right after they submit an enquiry on the
 * storefront, echoing back what they sent. Best-effort: never throws, so a mail
 * failure can't fail the submission itself.
 */
export async function sendEnquiryAcknowledgementEmail(opts: {
  to: string;
  name: string;
  subject: string | null;
  message: string;
  brand: StoreBrand;
  storeId?: string | null;
}): Promise<void> {
  const { subject, html } = buildEnquiryAcknowledgementEmail({
    name: opts.name,
    subject: opts.subject,
    message: opts.message,
    brand: opts.brand,
  });

  const fromAddress = `${opts.brand.name} <admin@${opts.brand.domain}>`;
  await sendEmail({
    storeId: opts.storeId ?? null,
    to: opts.to,
    from: fromAddress,
    subject,
    mailer: "enquiry_notification",
    html,
  });
}
