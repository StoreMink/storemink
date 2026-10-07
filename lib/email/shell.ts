// ---------------------------------------------------------------------------
// The email design system: ONE look for every email StoreMink sends.
//
// ══ THE LOOK ═════════════════════════════════════════════════════════════
// Editorial and quiet, in the manner of the best product mail: a warm cream
// canvas on a white page, the sender's logo or a serif wordmark at the top, a
// large serif headline, calm sans-serif body copy, and one near-black button.
// Detail cards, codes and receipts are white insets on the cream. There is no
// colour except the logo: a merchant hue pushed into an email has to survive
// colour-managed clients, forced dark mode and a button that must stay legible
// at any shade, and when it fails the customer receives something that looks
// broken. Identity comes from the logo and the name instead.
//
// ══ ONE STRUCTURE ════════════════════════════════════════════════════════
// `composeEmail` is the standard layout every mailer uses: an optional eyebrow,
// the headline, the body blocks, then the footer. The blocks are built from the
// components below (`emailParagraph`, `emailDetails`, `emailButton`,
// `emailChecklist`...), so a new mailer cannot drift from the others without
// writing raw markup on purpose. `emailShell` is the frame underneath it, kept
// public for the two renderers (notification digest, order summary) that lay
// out their own body.
//
// ══ COPY RULE ════════════════════════════════════════════════════════════
// Rendered email never contains a long dash (U+2014) or an en dash (U+2013).
// Use a comma, a colon, a full stop or "to" instead. no-long-dash.test.ts
// renders every mailer and fails if one slips back in.
//
// Everything here is pure string building, so a preview and a real send are the
// same code.
// ---------------------------------------------------------------------------

import type { StoreBrand } from "@/lib/store/brand";
import { STOREMINK_INK, STOREMINK_PURPLE } from "./platform-brand";

/**
 * Escape a value before interpolating it into email HTML.
 *
 * Lives here, at the bottom of the email layer, because everything above needs
 * it. `coupon-campaign` re-exports it so existing callers are unchanged.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The one palette. Deliberately not derived from the store. */
export const EMAIL_THEME = {
  /** Behind everything: plain white, like the inbox around it. */
  page: "#ffffff",
  /** The warm panel the whole message sits on. */
  canvas: "#faf9f5",
  /** Inset surfaces on the canvas: detail cards, codes, receipts. */
  card: "#ffffff",
  border: "#e6e3da",
  hairline: "#efede6",
  /** A quieter inset (a quoted message). */
  panel: "#f4f2ec",
  ink: "#141413",
  inkSoft: "#3d3c38",
  muted: "#6f6d66",
  faint: "#9c9a92",
  button: "#141413",
  buttonText: "#ffffff",
  /** Only for an eyebrow on genuinely urgent mail, never a headline. */
  danger: "#a8361b",
} as const;

/** Body copy. Outlook ignores stacks it cannot resolve, so the head carries an
 *  `mso` override to Arial (see `emailShell`). */
export const EMAIL_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Helvetica, Arial, sans-serif";

/** Headlines and the wordmark. Georgia first: it is installed everywhere
 *  Outlook runs, and Outlook uses only the first family it is given. */
export const EMAIL_SERIF = "Georgia, 'Times New Roman', Times, serif";

/** Codes: sign-in codes, collection codes, coupons, temporary passwords. */
export const EMAIL_MONO =
  "'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";

/** A safe absolute http(s) URL, or null. Links in email must never be
 *  `javascript:` or a relative path a mail client would resolve against itself. */
export function safeEmailUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

// ── Style inlining ─────────────────────────────────────────────────────────
// Email clients strip <style>, so the supported tags get their styles inlined.
// A small vocabulary on purpose: someone editing an email body (a merchant in
// the notification console, an operator writing an announcement) should be
// writing paragraphs, headings, lists and links, not a layout.
const TAG_STYLES: Record<string, string> = {
  h1: `margin:0 0 20px; font-family:${EMAIL_SERIF}; font-size:30px; line-height:1.2; font-weight:400; letter-spacing:-0.4px; color:${EMAIL_THEME.ink}; overflow-wrap:anywhere; word-break:break-word;`,
  h2: `margin:36px 0 14px; font-family:${EMAIL_SERIF}; font-size:23px; line-height:1.3; font-weight:400; letter-spacing:-0.2px; color:${EMAIL_THEME.ink}; overflow-wrap:anywhere; word-break:break-word;`,
  h3: `margin:28px 0 8px; font-family:${EMAIL_FONT}; font-size:15px; line-height:1.4; font-weight:600; color:${EMAIL_THEME.ink};`,
  h4: `margin:24px 0 6px; font-family:${EMAIL_FONT}; font-size:14px; line-height:1.4; font-weight:600; color:${EMAIL_THEME.ink};`,
  p: `margin:0 0 16px; font-family:${EMAIL_FONT}; font-size:16px; line-height:1.65; color:${EMAIL_THEME.inkSoft}; overflow-wrap:anywhere; word-break:break-word;`,
  ul: `margin:0 0 18px 22px; padding:0; font-family:${EMAIL_FONT}; color:${EMAIL_THEME.inkSoft};`,
  ol: `margin:0 0 18px 22px; padding:0; font-family:${EMAIL_FONT}; color:${EMAIL_THEME.inkSoft};`,
  li: `margin:0 0 8px; font-family:${EMAIL_FONT}; font-size:16px; line-height:1.6; color:${EMAIL_THEME.inkSoft}; overflow-wrap:anywhere; word-break:break-word;`,
  blockquote: `margin:0 0 18px; padding:2px 0 2px 18px; border-left:2px solid ${EMAIL_THEME.border}; font-family:${EMAIL_FONT}; color:${EMAIL_THEME.muted};`,
  strong: `color:${EMAIL_THEME.ink}; font-weight:600;`,
  b: `color:${EMAIL_THEME.ink}; font-weight:600;`,
  a: `color:${EMAIL_THEME.ink}; text-decoration:underline;`,
  code: `font-family:${EMAIL_MONO}; font-size:0.92em; color:${EMAIL_THEME.ink};`,
  img: `display:block; max-width:100%; height:auto; border:0; border-radius:8px;`,
  hr: `border:none; border-top:1px solid ${EMAIL_THEME.border}; margin:32px 0;`,
};

/**
 * Class vocabulary for template copy (lib/notifications/default-templates.ts,
 * and merchant templates saved from it). These names are stored in merchants'
 * own templates, so they are a contract: restyle them freely, never rename one.
 */
const CLASS_STYLES: Record<string, string> = {
  "email-lead": `margin:0 0 24px; font-family:${EMAIL_FONT}; font-size:17px; line-height:1.6; color:${EMAIL_THEME.inkSoft}; overflow-wrap:anywhere; word-break:break-word;`,
  // No rules between rows: a hairline under the last row doubles up against
  // the card's own border, and template markup cannot tell which row is last.
  // Spacing alone separates the facts.
  "email-details": `margin:24px 0; padding:12px 0; list-style:none; background-color:${EMAIL_THEME.card}; border:1px solid ${EMAIL_THEME.border}; border-radius:12px;`,
  "email-detail": `margin:0; padding:9px 22px; font-family:${EMAIL_FONT}; font-size:15.5px; line-height:1.5; color:${EMAIL_THEME.ink}; list-style:none; overflow-wrap:anywhere; word-break:break-word;`,
  "email-label": `color:${EMAIL_THEME.muted}; font-family:${EMAIL_FONT}; font-size:12.5px; line-height:1.6; font-weight:500; letter-spacing:0.1px;`,
  "email-code": `margin:4px 0 12px; padding:22px 18px; background-color:${EMAIL_THEME.card}; border:1px solid ${EMAIL_THEME.border}; border-radius:12px; font-family:${EMAIL_MONO}; font-size:30px; line-height:1.2; font-weight:600; letter-spacing:6px; text-align:center; color:${EMAIL_THEME.ink};`,
  "email-note": `margin:20px 0 0; font-family:${EMAIL_FONT}; font-size:14px; line-height:1.6; color:${EMAIL_THEME.muted}; overflow-wrap:anywhere; word-break:break-word;`,
};

/** Re-emit a start tag with a style attribute, keeping a self-closing slash
 *  where one was written (`<img ... />`, `<hr />`). */
function withStyle(tag: string, attrs: string, style: string): string {
  const selfClosing = /\/\s*$/.test(attrs);
  const clean = attrs.replace(/\/\s*$/, "").replace(/\s+$/, "");
  return `<${tag}${clean} style="${style}"${selfClosing ? " /" : ""}>`;
}

/**
 * Inline styles for the supported tags and classes. A tag that already carries
 * a `style` attribute is left alone, so anyone who wants to override something
 * can, and markup this module built itself passes through untouched.
 */
export function inlineEmailStyles(html: string): string {
  let out = expandChecklists(html).replace(
    /<([a-z0-9]+)(\s[^>]*)?>/gi,
    (match, tag: string, attrs: string | undefined) => {
      if (!attrs || /\sstyle\s*=/i.test(attrs)) return match;
      const classes = attrs.match(/\sclass=["']([^"']+)["']/i)?.[1];
      if (!classes) return match;
      const style = classes
        .split(/\s+/)
        .map((name) => CLASS_STYLES[name])
        .filter(Boolean)
        .join(" ");
      return style ? withStyle(tag, attrs, style) : match;
    },
  );
  for (const [tag, style] of Object.entries(TAG_STYLES)) {
    out = out.replace(
      new RegExp(`<${tag}(\\s[^>]*)?>`, "gi"),
      (match, attrs: string | undefined) => {
        if (attrs && /\sstyle\s*=/i.test(attrs)) return match;
        return withStyle(tag, attrs ?? "", style);
      },
    );
  }
  return out;
}

// ── Components ─────────────────────────────────────────────────────────────
// Each returns a self-contained, already-styled HTML fragment. Text arguments
// are ESCAPED; arguments named `html` are trusted markup the caller built (and
// escaped) itself.

/** A small label above the headline ("Action needed", "Receipt"). */
export function emailEyebrow(
  text: string,
  tone: "default" | "danger" = "default",
): string {
  const colour = tone === "danger" ? EMAIL_THEME.danger : EMAIL_THEME.muted;
  return `<p style="margin:0 0 14px; font-family:${EMAIL_FONT}; font-size:12px; line-height:1.4; font-weight:600; letter-spacing:1.2px; text-transform:uppercase; color:${colour};">${escapeHtml(text)}</p>`;
}

/** The headline: a large serif line, the first thing a reader sees. */
export function emailHeading(text: string): string {
  return `<h1 class="sm-email-h1 sm-serif" style="margin:0 0 22px; font-family:${EMAIL_SERIF}; font-size:42px; line-height:1.12; font-weight:400; letter-spacing:-0.8px; color:${EMAIL_THEME.ink}; overflow-wrap:anywhere; word-break:break-word;">${escapeHtml(text)}</h1>`;
}

/** A section heading inside the body ("Your setup checklist"). */
export function emailSection(text: string): string {
  return `<h2 class="sm-serif" style="${TAG_STYLES.h2}">${escapeHtml(text)}</h2>`;
}

/** A paragraph. `html` is trusted markup: escape values before passing them. */
export function emailParagraph(
  html: string,
  opts: { lead?: boolean; muted?: boolean } = {},
): string {
  const style = opts.lead
    ? CLASS_STYLES["email-lead"]
    : opts.muted
      ? CLASS_STYLES["email-note"]
      : TAG_STYLES.p;
  return `<p style="${style}">${inlineEmailStyles(html)}</p>`;
}

/** A quiet closing line under everything else ("This code expires in..."). */
export function emailNote(html: string): string {
  return emailParagraph(html, { muted: true });
}

/** The one call to action. Near-black, whatever the sender's brand colour. */
export function emailButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:32px 0 8px;">
  <tr>
    <td bgcolor="${EMAIL_THEME.button}" style="background-color:${EMAIL_THEME.button}; border-radius:8px; mso-padding-alt:14px 28px;">
      <a href="${escapeHtml(href)}" style="display:inline-block; padding:14px 28px; font-family:${EMAIL_FONT}; font-size:16px; line-height:1.2; font-weight:600; color:${EMAIL_THEME.buttonText}; text-decoration:none; border-radius:8px;">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

/** The plain link under a button, for clients that block the button or
 *  readers who copy links by hand. */
export function emailLinkFallback(href: string): string {
  return `<p style="margin:16px 0 0; font-family:${EMAIL_FONT}; font-size:13px; line-height:1.6; color:${EMAIL_THEME.muted};">Or paste this link into your browser:<br /><a href="${escapeHtml(href)}" style="color:${EMAIL_THEME.muted}; text-decoration:underline; word-break:break-all;">${escapeHtml(href)}</a></p>`;
}

export interface EmailDetail {
  label: string;
  /** Trusted markup: escape values before passing them. */
  valueHtml: string;
}

/**
 * A card of labelled facts (order, amount, when). Emits the same class markup
 * the template copy uses, so a detail list looks identical whether it came from
 * a mailer or from a merchant's saved notification template.
 */
export function emailDetails(rows: EmailDetail[]): string {
  const shown = rows.filter((row) => row.valueHtml.trim() !== "");
  if (shown.length === 0) return "";
  const items = shown
    .map(
      (row) =>
        `<li class="email-detail"><strong class="email-label">${escapeHtml(row.label)}</strong><br />${row.valueHtml}</li>`,
    )
    .join("");
  return inlineEmailStyles(`<ul class="email-details">${items}</ul>`);
}

/**
 * A code to read or type: a sign-in code, a collection code, a temporary
 * password. Large, spaced, monospaced and centred, on a white inset.
 */
export function emailCode(
  code: string,
  opts: { label?: string; hint?: string; compact?: boolean } = {},
): string {
  const size = opts.compact ? "22px" : "34px";
  const spacing = opts.compact ? "2px" : "8px";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin:8px 0 ${opts.hint ? "10px" : "20px"};">
  <tr>
    <td align="center" bgcolor="${EMAIL_THEME.card}" style="background-color:${EMAIL_THEME.card}; border:1px solid ${EMAIL_THEME.border}; border-radius:12px; padding:${opts.label ? "18px" : "24px"} 18px 24px;">
      ${
        opts.label
          ? `<div style="margin:0 0 10px; font-family:${EMAIL_FONT}; font-size:12px; line-height:1.4; font-weight:600; letter-spacing:1.2px; text-transform:uppercase; color:${EMAIL_THEME.muted};">${escapeHtml(opts.label)}</div>`
          : ""
      }
      <div class="sm-mono" style="font-family:${EMAIL_MONO}; font-size:${size}; line-height:1.2; font-weight:600; letter-spacing:${spacing}; color:${EMAIL_THEME.ink}; word-break:break-all;">${escapeHtml(code)}</div>
    </td>
  </tr>
</table>${opts.hint ? `<p style="margin:0 0 20px; font-family:${EMAIL_FONT}; font-size:14px; line-height:1.6; color:${EMAIL_THEME.muted}; text-align:center;">${escapeHtml(opts.hint)}</p>` : ""}`;
}

/** A quiet inset for quoted content, such as a copy of a customer's message.
 *  `html` is trusted markup. */
export function emailPanel(html: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin:8px 0 20px;">
  <tr>
    <td bgcolor="${EMAIL_THEME.card}" style="background-color:${EMAIL_THEME.card}; border:1px solid ${EMAIL_THEME.border}; border-radius:12px; padding:20px 22px; font-family:${EMAIL_FONT}; font-size:15px; line-height:1.65; color:${EMAIL_THEME.inkSoft};">
      ${inlineEmailStyles(html)}
    </td>
  </tr>
</table>`;
}

export interface EmailChecklistItem {
  title: string;
  /** Where the title links. Optional: an item can be a plain statement. */
  href?: string | null;
  /** Trusted markup: escape values before passing them. */
  bodyHtml?: string;
}

const CHECKLIST_TITLE = `font-family:${EMAIL_SERIF}; font-size:20px; line-height:1.35; font-weight:400; color:${EMAIL_THEME.ink}; text-decoration:none;`;

/** The rows of a checklist, from already-built title and body markup. */
function checklistTable(
  rows: { titleHtml: string; bodyHtml: string }[],
): string {
  const body = rows
    .map((row, index) => {
      const top = index === 0 ? "4px" : "26px";
      return `<tr>
    <td width="40" valign="top" style="width:40px; padding:${top} 0 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td width="22" height="22" align="center" valign="middle" style="width:22px; height:22px; border:1.5px solid ${EMAIL_THEME.ink}; border-radius:50%; font-family:${EMAIL_FONT}; font-size:12px; line-height:20px; font-weight:700; color:${EMAIL_THEME.ink};">&#10003;</td>
        </tr>
      </table>
    </td>
    <td valign="top" style="padding:${top} 0 0;">
      ${row.titleHtml}
      ${
        row.bodyHtml.trim()
          ? `<p style="margin:8px 0 0; font-family:${EMAIL_FONT}; font-size:15.5px; line-height:1.6; color:${EMAIL_THEME.inkSoft};">${inlineEmailStyles(row.bodyHtml.trim())}</p>`
          : ""
      }
    </td>
  </tr>`;
    })
    .join("\n");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin:4px 0 8px;">
  ${body}
</table>`;
}

/**
 * Next steps as a checklist: a circled tick, a serif title with an arrow, and a
 * line of explanation under it.
 *
 * The circle is a bordered table cell rather than an image, so it renders with
 * images blocked; Outlook draws it square, which still reads as a checkbox.
 */
export function emailChecklist(items: EmailChecklistItem[]): string {
  return checklistTable(
    items.map((item) => {
      const href = safeEmailUrl(item.href ?? null);
      const title = escapeHtml(item.title);
      return {
        titleHtml: href
          ? `<a class="sm-serif" href="${escapeHtml(href)}" style="${CHECKLIST_TITLE}">${title}&nbsp;&rarr;</a>`
          : `<span class="sm-serif" style="${CHECKLIST_TITLE}">${title}</span>`,
        bodyHtml: item.bodyHtml ?? "",
      };
    }),
  );
}

/**
 * The same checklist, written as TEMPLATE copy:
 *
 *   <ul class="email-checklist">
 *     <li><a href="...">Add your first product</a><br />Why it matters.</li>
 *     <li><strong>Publish your policies</strong><br />Why it matters.</li>
 *   </ul>
 *
 * A circled tick cannot be drawn with inline styles on an <li>, so this list is
 * EXPANDED into the checklist table rather than styled in place. The part before
 * the first <br /> is the title; the rest is the explanation. A list that does
 * not follow the shape still renders, as plain rows.
 */
function expandChecklists(html: string): string {
  return html.replace(
    /<ul\s+class=["']email-checklist["']\s*>([\s\S]*?)<\/ul>/gi,
    (_match, inner: string) => {
      const rows = [...inner.matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/gi)]
        .map((m) => m[1].trim())
        .filter(Boolean)
        .map((content) => {
          const split = content.search(/<br\s*\/?>/i);
          const rawTitle = split === -1 ? content : content.slice(0, split);
          const rawBody =
            split === -1
              ? ""
              : content.slice(split).replace(/^<br\s*\/?>/i, "");
          // ★ The anchor is REBUILT, never copied: only a validated http(s)
          // href survives, and every other attribute the template carried is
          // dropped. Copying attributes through (even with style/class
          // stripped) let a crafted class value smuggle a javascript: href or
          // an event handler past the save-time sanitizer.
          const link = rawTitle.match(/<a(\s[^>]*)?>([\s\S]*?)<\/a>/i);
          const href = link
            ? safeEmailUrl(
                decodeHref(
                  link[1]?.match(/\shref\s*=\s*"([^"]*)"/i)?.[1] ??
                    link[1]?.match(/\shref\s*=\s*'([^']*)'/i)?.[1] ??
                    "",
                ),
              )
            : null;
          const text = stripTags(link ? link[2] : rawTitle);
          const titleHtml = href
            ? `<a class="sm-serif" href="${escapeHtml(href)}" style="${CHECKLIST_TITLE}">${text}&nbsp;&rarr;</a>`
            : `<span class="sm-serif" style="${CHECKLIST_TITLE}">${text}</span>`;
          return { titleHtml, bodyHtml: rawBody };
        });
      return rows.length ? checklistTable(rows) : "";
    },
  );
}

/** Undo the entity escaping a sanitizer applies inside an attribute value. */
function decodeHref(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Text content only: a checklist title is words, never markup. Entities the
 *  template already escaped stay escaped. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

/** A rule between two parts of a message. */
export function emailDivider(): string {
  return `<hr style="${TAG_STYLES.hr}" />`;
}

/** The standard sign-off: "Thanks, The Acme team". */
export function emailSignoff(name: string, greeting = "Thanks,"): string {
  return `<p style="margin:32px 0 0; font-family:${EMAIL_FONT}; font-size:16px; line-height:1.65; color:${EMAIL_THEME.inkSoft};">${escapeHtml(greeting)}<br /><span style="color:${EMAIL_THEME.ink};">The ${escapeHtml(name)} team</span></p>`;
}

// ── The frame ──────────────────────────────────────────────────────────────

/** The sender's identity at the top of the canvas. */
function emailHeader(brand: StoreBrand): string {
  if (brand.logoUrl) {
    return `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" width="128" style="display:block; width:128px; max-width:60%; height:auto; border:0;" />`;
  }
  if (brand.mark) return storeMinkLockup(brand.mark);
  // A store with no logo: its name, set in the serif the headline uses.
  return `<span class="sm-serif" style="font-family:${EMAIL_SERIF}; font-size:25px; line-height:1.2; font-weight:400; letter-spacing:-0.4px; color:${EMAIL_THEME.ink};">${escapeHtml(brand.name)}</span>`;
}

/**
 * StoreMink's own header: the bag mark beside "Store" in ink and "Mink" in the
 * brand purple, the lockup storemink.com uses (lib/email/platform-brand.ts).
 * Text rather than an image of text, so it still reads with images blocked.
 */
function storeMinkLockup(markUrl: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td valign="middle" style="padding:0 9px 0 0;"><img src="${escapeHtml(markUrl)}" alt="" width="30" height="30" style="display:block; width:30px; height:30px; border:0;" /></td>
    <td valign="middle" style="font-family:${EMAIL_FONT}; font-size:21px; line-height:1.2; font-weight:800; letter-spacing:-0.7px; color:${STOREMINK_INK}; white-space:nowrap;">Store<span style="color:${STOREMINK_PURPLE};">Mink</span></td>
  </tr>
</table>`;
}

/**
 * The frame: white page, warm canvas, the sender's identity, the body, and a
 * footer under the canvas.
 *
 * Forces a light colour scheme: the `color-scheme` meta plus `bgcolor`
 * attributes stop most clients inverting the canvas and taking the text with
 * it. (Aggressive forced-dark clients can still override; a known limit of
 * email, not of this code.)
 */
export function emailShell(opts: {
  brand: StoreBrand;
  bodyHtml: string;
  footerHtml?: string;
  /** The line an inbox shows next to the subject. Without it, clients grab
   *  whatever markup comes first. */
  preheader?: string;
  /** The document title, shown by clients that open mail in a browser tab. */
  title?: string;
}): string {
  const { brand, bodyHtml, footerHtml, preheader, title } = opts;
  // Zero-width padding after the preheader stops clients appending the
  // opening of the body to the inbox preview line.
  const preheaderPad = "&#847;&zwnj;&nbsp;".repeat(60);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light only" />
    <title>${escapeHtml(title ?? brand.name)}</title>
    <!--[if mso]>
    <style>
      body, table, td, p, a, li, ul, ol, span, div, strong, b, h3, h4, blockquote { font-family: Arial, Helvetica, sans-serif !important; }
      .sm-serif { font-family: Georgia, 'Times New Roman', serif !important; }
      .sm-mono, .email-code { font-family: Consolas, 'Courier New', monospace !important; }
    </style>
    <![endif]-->
    <style>
      a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
      @media only screen and (max-width: 620px) {
        .sm-email-outer { padding: 0 !important; }
        .sm-email-canvas { padding: 36px 24px 40px !important; }
        .sm-email-header { padding-bottom: 32px !important; }
        .sm-email-footer { padding: 24px 24px 8px !important; }
        .sm-email-h1 { font-size: 31px !important; line-height: 1.18 !important; letter-spacing: -0.5px !important; }
      }
    </style>
  </head>
  <body bgcolor="${EMAIL_THEME.page}" style="margin:0; padding:0; width:100%; background-color:${EMAIL_THEME.page}; -webkit-font-smoothing:antialiased; -webkit-text-size-adjust:100%;">
    ${
      preheader
        ? `<div style="display:none; max-height:0; max-width:0; overflow:hidden; opacity:0; mso-hide:all; font-size:1px; line-height:1px; color:${EMAIL_THEME.page};">${escapeHtml(preheader)}${preheaderPad}</div>`
        : ""
    }
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${EMAIL_THEME.page}" style="width:100%; background-color:${EMAIL_THEME.page};">
      <tr>
        <td class="sm-email-outer" align="center" style="padding:32px 16px 40px;">
          <!--[if mso]><table role="presentation" width="640" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
          <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:640px;">
            <tr>
              <td class="sm-email-canvas" bgcolor="${EMAIL_THEME.canvas}" style="background-color:${EMAIL_THEME.canvas}; padding:52px 56px 56px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
                  <tr>
                    <td class="sm-email-header" style="padding:0 0 44px;">
                      ${emailHeader(brand)}
                    </td>
                  </tr>
                  <tr>
                    <td style="font-family:${EMAIL_FONT}; color:${EMAIL_THEME.inkSoft};">
                      ${bodyHtml}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            ${
              footerHtml
                ? `<tr>
              <td class="sm-email-footer" style="padding:28px 56px 8px;">
                ${footerHtml}
              </td>
            </tr>`
                : ""
            }
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * The standard footer: why this arrived (optional, trusted markup), then the
 * copyright line. Small and muted, under the canvas.
 */
export function emailFooter(brand: StoreBrand, reasonHtml?: string): string {
  const reason = reasonHtml?.trim()
    ? `<p style="margin:0 0 10px; font-family:${EMAIL_FONT}; font-size:12.5px; line-height:1.6; color:${EMAIL_THEME.muted}; overflow-wrap:anywhere; word-break:break-word;">${reasonHtml
        .trim()
        .replace(/<a(\s[^>]*)?>/gi, (match, attrs: string | undefined) =>
          attrs && /\sstyle\s*=/i.test(attrs)
            ? match
            : withStyle(
                "a",
                attrs ?? "",
                `color:${EMAIL_THEME.muted}; text-decoration:underline;`,
              ),
        )}</p>`
    : "";
  return `${reason}<p style="margin:0; font-family:${EMAIL_FONT}; font-size:12.5px; line-height:1.6; color:${EMAIL_THEME.faint};">&copy; ${new Date().getFullYear()} ${escapeHtml(brand.legalName || brand.name)}</p>`;
}

/**
 * THE standard email. Every mailer composes its message through this, so every
 * message has the same structure: [eyebrow] headline, body blocks, footer.
 *
 * `blocks` are fragments from the components above (or `inlineEmailStyles`
 * output for template copy); empty strings are skipped, so callers can write
 * `cond ? emailNote(...) : ""` inline.
 */
export function composeEmail(opts: {
  brand: StoreBrand;
  heading: string;
  blocks: string[];
  eyebrow?: string;
  tone?: "default" | "danger";
  preheader?: string;
  /** Why the reader is getting this. Trusted markup. */
  footerReasonHtml?: string;
}): string {
  const body = [
    opts.eyebrow ? emailEyebrow(opts.eyebrow, opts.tone) : "",
    opts.heading.trim() ? emailHeading(opts.heading) : "",
    ...opts.blocks,
  ]
    .filter((block) => block && block.trim() !== "")
    .join("\n");

  return emailShell({
    brand: opts.brand,
    bodyHtml: body,
    footerHtml: emailFooter(opts.brand, opts.footerReasonHtml),
    preheader: opts.preheader,
    title: opts.heading.trim() || undefined,
  });
}

/** Strip markup to one line of plain text, for a preheader. */
export function plainTextPreview(html: string, max = 120): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
