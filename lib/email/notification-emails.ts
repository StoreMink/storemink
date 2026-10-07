// ---------------------------------------------------------------------------
// Notification email templates: the second delivery channel for the event
// spine (CODEBASE.md §24).
//
// ══ ONE STANDARD DESIGN ═══════════════════════════════════════════════════
// Every notification composes through `composeEmail` (lib/email/shell.ts), the
// same frame every other StoreMink email uses: the store's logo or serif
// wordmark, a serif headline, the copy, an order summary when there is one, and
// one near-black button. Identity comes from the logo and the name, never from
// a recoloured button.
//
// Bodies are HTML written by the merchant (or our default), with {{tokens}}
// substituted and every value escaped: they are DB-derived names going into
// markup. `inlineEmailStyles` then inlines styles for the small tag vocabulary
// we support, because email clients ignore <style> blocks.
// ---------------------------------------------------------------------------

import type { StoreBrand } from "@/lib/store/brand";
import { platformEmailBrand } from "@/lib/email/platform-brand";
import {
  EMAIL_FONT,
  EMAIL_THEME,
  composeEmail,
  emailButton,
  emailParagraph,
  escapeHtml,
  inlineEmailStyles,
  plainTextPreview,
} from "@/lib/email/shell";

// Re-exported: lib/notifications/template.test.ts and callers reach for it here.
export { inlineEmailStyles } from "@/lib/email/shell";
import {
  getEventDef,
  isPlatformVoiceEvent,
  type Digest,
} from "@/lib/notifications/events";
import {
  renderOrderSummary,
  type EmailOrderSummary,
} from "@/lib/email/line-items";

export interface NotificationEmailItem {
  /** Event key drives the action label; optional for legacy queue fixtures. */
  eventKey?: string | null;
  title: string;
  /** HTML body (already substituted), or plain text for legacy callers. */
  body: string | null;
  /** App-relative path ("/dashboard/orders?q=…"), absolutised against baseUrl. */
  url: string | null;
  severity: string;
  createdAt?: string | null;
  /** Order summary, when the event carried one. Renderer chrome — see
   *  lib/email/line-items.ts for why it can't come through the template. */
  summary?: EmailOrderSummary | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  /**
   * Who is speaking. "platform" = StoreMink writing to a merchant about their
   * account (PLATFORM_VOICE_EVENTS): the header wears StoreMink's lockup and
   * the caller must send it FROM StoreMink too. "store" = the store's own mail.
   */
  voice: "store" | "platform";
}

/** Brand for PLATFORM-level mail (operator notifications), which belongs to no
 *  store: StoreMink's mark and wordmark (lib/email/platform-brand.ts). */
export function platformBrand(): StoreBrand {
  return platformEmailBrand();
}

/** Make an app-relative notification link absolute. Anything already absolute
 *  is passed through; anything that isn't a plain path is dropped, so a bad
 *  stored value can't become a link to somewhere else entirely. */
export function absoluteUrl(
  path: string | null | undefined,
  baseUrl: string,
): string | null {
  if (!path) return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!trimmed.startsWith("/")) return null;
  return `${baseUrl.replace(/\/+$/, "")}${trimmed}`;
}

/**
 * The "why am I getting this" line.
 *
 * Shopper mail is transactional: there is nothing to switch off, so no link.
 * Team mail links to the preferences page ONLY when at least one event in the
 * message can actually be switched off there; offering "change what you get
 * emailed about" on an event marked `configurable: false` (a welcome, a domain
 * that stopped working) is a link that does nothing.
 */
function footerReason(
  storeName: string,
  baseUrl: string,
  opts: { isTeam: boolean; platformVoice: boolean; switchable: boolean },
): string {
  if (!opts.isTeam) {
    return `You're receiving this because of your order with ${escapeHtml(storeName)}.`;
  }
  const href = `${baseUrl.replace(/\/+$/, "")}/dashboard/settings/notifications`;
  const link = opts.switchable
    ? ` <a href="${escapeHtml(href)}">Change what you get emailed about</a>.`
    : "";
  return opts.platformVoice
    ? `You're receiving this because you run ${escapeHtml(storeName)} on StoreMink.${link}`
    : `You're receiving this because you have notifications turned on for ${escapeHtml(storeName)}.${link}`;
}

/** Can the merchant switch this event's email off? Unknown keys: yes. */
function isSwitchable(eventKey: string | null | undefined): boolean {
  return getEventDef(eventKey ?? "")?.configurable !== false;
}

const CUSTOMER_ACTIONS: Record<string, string> = {
  "order.ready_for_pickup": "View collection details",
  "order.pickup_expiring": "View collection details",
  "order.return_approved": "View return",
  "order.return_rejected": "View return",
  "order.exchange_ready": "Track replacement order",
  "blog.approved": "Read your post",
  "blog.rejected": "View your submissions",
};

const TEAM_ACTIONS: Record<string, string> = {
  "order.cancellation_requested": "Review cancellation",
  "order.payment_failed": "Review payment",
  "order.return_requested": "Review return",
  "inventory.low_stock": "Manage inventory",
  "inventory.out_of_stock": "Manage inventory",
  "enquiry.received": "Read enquiry",
  "blog.submitted": "Review post",
  "subscription.payment_failed": "Update billing",
};

function actionLabel(item: NotificationEmailItem, isTeam: boolean): string {
  const key = item.eventKey ?? "";
  if (isTeam) return TEAM_ACTIONS[key] ?? "View in dashboard";
  if (CUSTOMER_ACTIONS[key]) return CUSTOMER_ACTIONS[key];
  return key.startsWith("order.") || item.url?.startsWith("/orders")
    ? "View your order"
    : "View details";
}

/**
 * One event, one email: the "instant" digest setting.
 *
 * `item.body` is HTML (our default template or the merchant's). Values were
 * already escaped during substitution; the template itself is sanitised at save.
 */
export function renderNotificationEmail(opts: {
  item: NotificationEmailItem;
  brand: StoreBrand;
  baseUrl: string;
  /** Team mail gets the preferences link in its footer; customer mail doesn't. */
  isTeam?: boolean;
}): RenderedEmail {
  const { item, brand, baseUrl, isTeam = true } = opts;
  const href = absoluteUrl(item.url, baseUrl);
  const platformVoice = isTeam && isPlatformVoiceEvent(item.eventKey);

  // Order: what happened, then what was bought, then what to do about it. The
  // summary sits above the button because the button is the exit, not the
  // content.
  return {
    subject: item.title,
    voice: platformVoice ? "platform" : "store",
    html: composeEmail({
      brand: platformVoice ? platformEmailBrand() : brand,
      heading: item.title,
      blocks: [
        bodyBlock(item.body),
        renderOrderSummary(item.summary ?? null),
        href ? emailButton(href, actionLabel(item, isTeam)) : "",
      ],
      footerReasonHtml: footerReason(brand.name, baseUrl, {
        isTeam,
        platformVoice,
        switchable: isSwitchable(item.eventKey),
      }),
      // First line of the body, stripped: what an inbox shows next to the
      // subject. Without it clients grab whatever markup comes first.
      preheader: plainTextPreview(item.body ?? ""),
    }),
  };
}

/**
 * The message body as styled HTML. Template copy is HTML and is inlined; a
 * plain-text body (an operator's in-app line, a legacy row) has no block
 * markup, so it is set as a standard paragraph instead of bare text.
 */
function bodyBlock(body: string | null | undefined): string {
  const text = body?.trim() ?? "";
  if (!text) return "";
  return /<(p|ul|ol|h[1-4]|table|div|blockquote)[\s>]/i.test(text)
    ? inlineEmailStyles(text)
    : emailParagraph(
        escapeHtml(text.replace(/<[^>]+>/g, "")).replace(/\n/g, "<br />"),
      );
}

/**
 * A digest lists at most this many updates. Gmail clips a message past about
 * 102 KB and hides the rest, the button and the footer behind "[Message
 * clipped]"; the full list is one click away in the activity log.
 */
const DIGEST_MAX_ROWS = 30;

/** "3 updates" / "1 update" — used in the digest subject and heading. */
function countLabel(n: number): string {
  return `${n} update${n === 1 ? "" : "s"}`;
}

/**
 * Everything from one digest window, in one email. Items arrive newest-first
 * and are rendered as a compact list, each linking to its own destination.
 */
export function renderNotificationDigest(opts: {
  items: NotificationEmailItem[];
  brand: StoreBrand;
  baseUrl: string;
  digest: Digest;
  isTeam?: boolean;
}): RenderedEmail {
  const { items, brand, baseUrl, digest, isTeam = true } = opts;

  const shown = items.slice(0, DIGEST_MAX_ROWS);
  const hidden = items.length - shown.length;
  const rows = shown
    .map((item, index) => {
      const href = absoluteUrl(item.url, baseUrl);
      const title = escapeHtml(item.title);
      // One line of context per item: a digest is a list, not a stack of
      // full emails.
      const summary = plainTextPreview(item.body ?? "", 110);
      const rule =
        index === shown.length - 1 && hidden === 0
          ? ""
          : `border-bottom:1px solid ${EMAIL_THEME.hairline};`;

      return `<tr>
  <td style="padding:16px 22px; ${rule}">
    <div style="font-family:${EMAIL_FONT}; font-size:16px; line-height:1.45; font-weight:600; color:${EMAIL_THEME.ink};">
      ${href ? `<a href="${escapeHtml(href)}" style="color:${EMAIL_THEME.ink}; text-decoration:none;">${title}&nbsp;&rarr;</a>` : title}
    </div>
    ${
      summary
        ? `<div style="margin-top:4px; font-family:${EMAIL_FONT}; font-size:14px; line-height:1.55; color:${EMAIL_THEME.muted};">${escapeHtml(summary)}</div>`
        : ""
    }
  </td>
</tr>`;
    })
    .join("\n");

  const window = digest === "hourly" ? "in the last hour" : "since yesterday";
  const dashboardUrl = `${baseUrl.replace(/\/+$/, "")}/dashboard/logs`;
  const more =
    hidden > 0
      ? `<tr><td style="padding:14px 22px; font-family:${EMAIL_FONT}; font-size:14px; line-height:1.5; color:${EMAIL_THEME.muted};">And ${hidden} more update${hidden === 1 ? "" : "s"} in your <a href="${escapeHtml(dashboardUrl)}" style="color:${EMAIL_THEME.muted}; text-decoration:underline;">activity log</a>.</td></tr>`
      : "";

  const list = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin:4px 0 0;">
  <tr>
    <td bgcolor="${EMAIL_THEME.card}" style="background-color:${EMAIL_THEME.card}; border:1px solid ${EMAIL_THEME.border}; border-radius:12px; padding:4px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
${rows}
${more}
      </table>
    </td>
  </tr>
</table>`;

  // StoreMink's voice only when EVERY item is StoreMink speaking; one order
  // alert in the batch makes it the store's own round-up.
  const platformVoice =
    isTeam &&
    items.length > 0 &&
    items.every((item) => isPlatformVoiceEvent(item.eventKey));

  return {
    subject: platformVoice
      ? `${countLabel(items.length)} from StoreMink`
      : `${countLabel(items.length)} from ${brand.name}`,
    voice: platformVoice ? "platform" : "store",
    html: composeEmail({
      brand: platformVoice ? platformEmailBrand() : brand,
      heading: `${countLabel(items.length)} ${window}`,
      blocks: [
        emailParagraph(
          platformVoice
            ? `Here's what's new with ${escapeHtml(brand.name)} on StoreMink.`
            : `Here's what happened in ${escapeHtml(brand.name)}.`,
          { lead: true },
        ),
        list,
        emailButton(dashboardUrl, "Open dashboard"),
      ],
      footerReasonHtml: footerReason(brand.name, baseUrl, {
        isTeam,
        platformVoice,
        switchable: items.some((item) => isSwitchable(item.eventKey)),
      }),
      preheader: `${countLabel(items.length)} ${window}`,
    }),
  };
}
