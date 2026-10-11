import type { StoreBrand } from "@/lib/store/brand";

// escapeHtml moved to lib/email/shell.ts (the bottom of the email layer, so the
// shell can use it without importing a specific email type). Re-exported here
// because plenty of callers already import it from this module.
export { escapeHtml } from "./shell";
import {
  EMAIL_FONT,
  EMAIL_MONO,
  EMAIL_THEME,
  composeEmail,
  emailParagraph,
  emailSignoff,
  escapeHtml,
  plainTextPreview,
} from "./shell";

/**
 * Merge per-recipient tokens into a subject or body string. Plain text in,
 * plain text out: the caller escapes for HTML (see bodyParagraphs). The name
 * goes in through a replacer function, never as a replacement string, so a
 * name containing "$&" or "$`" is inserted as typed instead of being read as
 * a substitution pattern.
 */
export function mergeTokens(text: string, firstName: string): string {
  const name = firstName.trim() || "there";
  return text.replace(/\{\{\s*(first_name|name)\s*\}\}/gi, () => name);
}

// withoutLongDashes moved to lib/text/long-dashes.ts so every AI copy feature
// (lib/ai/gemini.ts) can use it without importing the email layer. Re-exported
// here because the coupon draft and Mink's draft tools already import it from
// this module.
export { withoutLongDashes } from "@/lib/text/long-dashes";

export type CouponEmailContent = {
  /** AI- or hand-written body. Plain text; blank lines separate paragraphs.
   *  May contain the {{first_name}} merge tag. */
  body: string;
  /** Recipient's first name used to resolve {{first_name}}. */
  firstName: string;
  code: string;
  discountLabel: string;
  validUntilLabel?: string | null;
  brand: StoreBrand;
};

/**
 * The dashed edge of the coupon card. A touch darker than EMAIL_THEME.border:
 * a dash in the standard border colour is so faint against the white card that
 * it reads as a solid line, and the dashes are what say "this is a coupon".
 */
const COUPON_DASH = "#c2bcad";

// Turn the body into safe HTML: escape the copy AND the recipient's name (the
// name is whatever the shopper typed at signup, so it is untrusted too), merge
// them, then split blank-line-separated blocks into paragraphs with <br /> for
// single newlines. Escaping the copy alone is not enough: the name is spliced
// in after, and emailParagraph styles any tag it finds, so an unescaped name
// holding an <a> would render as a real, styled link.
function bodyParagraphs(body: string, firstName: string): string[] {
  const merged = mergeTokens(escapeHtml(body), escapeHtml(firstName));
  return merged
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => emailParagraph(para.replace(/\n/g, "<br />")));
}

// The shared coupon card: the discount as a small label, the code large and
// monospaced, and (optionally) the expiry. Rendered by us so every campaign
// looks consistent regardless of what the copy says.
function couponBox(
  code: string,
  discountLabel: string,
  validUntilLabel?: string | null,
): string {
  const label = discountLabel.trim();
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin:12px 0 20px;">
  <tr>
    <td align="center" bgcolor="${EMAIL_THEME.card}" style="background-color:${EMAIL_THEME.card}; border:1.5px dashed ${COUPON_DASH}; border-radius:12px; padding:${label ? "20px" : "26px"} 18px 24px;">
      ${
        label
          ? `<div style="margin:0 0 10px; font-family:${EMAIL_FONT}; font-size:12px; line-height:1.4; font-weight:600; letter-spacing:1.2px; text-transform:uppercase; color:${EMAIL_THEME.muted};">${escapeHtml(label)}</div>`
          : ""
      }
      <div class="sm-mono" style="font-family:${EMAIL_MONO}; font-size:30px; line-height:1.2; font-weight:600; letter-spacing:4px; color:${EMAIL_THEME.ink}; word-break:break-all;">${escapeHtml(code)}</div>
      ${
        validUntilLabel
          ? `<div style="margin:12px 0 0; font-family:${EMAIL_FONT}; font-size:13px; line-height:1.5; color:${EMAIL_THEME.muted};">Valid until ${escapeHtml(validUntilLabel)}</div>`
          : ""
      }
    </td>
  </tr>
</table>`;
}

/**
 * The headline. Every discount label the product writes has one of two shapes,
 * "25% off" (percentage coupons) or "₹100 off" (fixed amount), from the
 * coupon email form and Mink's campaign actions alike, and "<label>, just for
 * you" reads naturally for both. An empty label (not produced today; the column
 * is NOT NULL but a blank string would pass) gets no headline rather than a
 * sentence that starts with a comma.
 */
function couponHeading(discountLabel: string): string {
  const label = discountLabel.trim();
  return label ? `${label}, just for you` : "";
}

function couponBlocks(content: CouponEmailContent): string[] {
  return [
    ...bodyParagraphs(content.body, content.firstName),
    couponBox(content.code, content.discountLabel, content.validUntilLabel),
    emailSignoff(content.brand.name, "Warm regards,"),
  ];
}

/** Inner body HTML (greeting copy + coupon card + sign-off), before framing. */
export function renderCouponEmailBody(content: CouponEmailContent): string {
  return couponBlocks(content).join("\n");
}

/** Full, send-ready HTML document for one recipient. */
export function renderCouponEmail(content: CouponEmailContent): string {
  const paragraphs = bodyParagraphs(content.body, content.firstName).join(" ");
  return composeEmail({
    brand: content.brand,
    heading: couponHeading(content.discountLabel),
    blocks: couponBlocks(content),
    // The opening of the merchant's own copy, so the inbox line says what the
    // message says instead of whatever markup comes first.
    preheader: plainTextPreview(paragraphs, 140) || undefined,
    footerReasonHtml: `You're receiving this because you're a customer of ${escapeHtml(content.brand.name)}.`,
  });
}
