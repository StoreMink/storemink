import "server-only";

import {
  composeEmail,
  emailButton,
  emailParagraph,
  escapeHtml,
  inlineEmailStyles,
  plainTextPreview,
  safeEmailUrl,
} from "./shell";
import { sanitizeBlogContent } from "@/lib/sanitize";
import type { StoreBrand } from "@/lib/store/brand";

// ---------------------------------------------------------------------------
// The announcement email.
//
// ── ★ IT IS PLATFORM MAIL, SO IT WEARS STOREMINK'S IDENTITY ───────────────
// Not the merchant's. "Here is a new feature" under the merchant's own logo
// would read as their store mailing them, which is exactly the confusion that
// gets a message reported as spam. Callers pass `platformEmailBrand()`.
//
// ── ★ THE SUBJECT IS THE HEADLINE ─────────────────────────────────────────
// The composer has one Subject field and a free-form Body whose suggested
// shape is "<p>Hello,</p><p>We've just shipped...</p>": the body has no
// headline of its own, so the subject (already written as the one thing that
// happened) becomes the serif headline every StoreMink email opens with. An
// operator who did repeat the subject as a leading <h1>/<h2> in the body would
// now see it twice, so that one exact repeat is dropped in favour of the
// standard headline (`withoutRepeatedHeadline`).
//
// ── ★ THE BODY IS SANITIZED AT RENDER, not only at save ───────────────────
// The blog trust model (§11): an operator writing HTML is trusted-ish, but the
// stored value has to survive being re-rendered years later by code that has
// no idea what validation it passed. `sanitizeBlogContent` is the same
// function the storefront's rich-text section uses. Only THEN are the design
// styles inlined: sanitizing after would strip them again.
//
// ── ★ AND IT ALWAYS CARRIES A REASON LINE ─────────────────────────────────
// "You're getting this because you own a store on StoreMink" is the difference
// between correspondence and spam, and it is what makes an opt-out link
// meaningful. Feature mail additionally links to where the preference lives;
// operational mail says plainly that it is not opt-out-able, rather than
// offering an unsubscribe that would be a lie.
// ---------------------------------------------------------------------------

export interface AnnouncementEmailInput {
  brand: StoreBrand;
  subject: string;
  /** Operator-authored HTML. Sanitized here regardless of what was stored. */
  bodyHtml: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  category: "feature" | "operational";
  /** Where product-update preferences live. */
  preferencesUrl: string;
  recipientName?: string | null;
}

/** Lowercase letters and digits only, so "Meet the register!" and
 *  "Meet the register" count as the same line. */
function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Drop a leading <h1>/<h2> that only repeats the subject, which is already the
 * headline. Anything else the operator wrote is left exactly as it was.
 */
function withoutRepeatedHeadline(bodyHtml: string, subject: string): string {
  const target = comparable(subject);
  if (!target) return bodyHtml;
  const match = bodyHtml.match(/^\s*<(h[12])(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/i);
  if (!match) return bodyHtml;
  return comparable(plainTextPreview(match[2], 500)) === target
    ? bodyHtml.slice(match[0].length)
    : bodyHtml;
}

/** Why this arrived. Trusted markup: every value is escaped here. */
function reasonLine(input: AnnouncementEmailInput): string {
  if (input.category === "operational") {
    // No unsubscribe offered, deliberately: this is service correspondence
    // about an account they hold, and a link that does not switch it off
    // would be a lie.
    return "You're receiving this because you have a StoreMink account. This is a service notice about your store, not marketing.";
  }
  const prefs = safeEmailUrl(input.preferencesUrl);
  const change = prefs
    ? ` <a href="${escapeHtml(prefs)}">Change what you get emailed about</a>.`
    : "";
  return `You're receiving this because you opted in to product updates from StoreMink.${change}`;
}

export function renderAnnouncementEmail(input: AnnouncementEmailInput): {
  subject: string;
  html: string;
} {
  const heading = input.subject.trim();
  const sanitized = sanitizeBlogContent(input.bodyHtml);
  const content = heading
    ? withoutRepeatedHeadline(sanitized, heading)
    : sanitized;

  const name = input.recipientName?.trim();
  const greeting = name
    ? emailParagraph(`Hi ${escapeHtml(name)},`, { lead: true })
    : "";

  const cta = safeEmailUrl(input.ctaUrl);
  const label = input.ctaLabel?.trim();
  const button = cta && label ? emailButton(cta, label) : "";

  const html = composeEmail({
    brand: input.brand,
    eyebrow: input.category === "feature" ? "Product update" : "Service notice",
    heading,
    blocks: [greeting, inlineEmailStyles(content), button],
    // What an inbox shows next to the subject: the opening of the copy, since
    // repeating the subject there would spend the line saying it twice.
    preheader: plainTextPreview(content) || heading,
    footerReasonHtml: reasonLine(input),
  });

  return { subject: input.subject, html };
}
