// ---------------------------------------------------------------------------
// The inbox's team vocabulary, pure and client-safe: labels, saved replies,
// the search query, and the one rule the editor and the action share.
// Validated here because the dialog is not the boundary; the action runs the
// same function again before it writes.
// ---------------------------------------------------------------------------

export const INBOX_LABEL_COLORS = [
  "grey",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
] as const;
export type InboxLabelColor = (typeof INBOX_LABEL_COLORS)[number];

/** Labels per store. A list nobody can scan is not a filter. */
export const INBOX_LABEL_MAX = 20;
export const INBOX_LABEL_NAME_MAX = 30;

/** Saved replies per store. */
export const INBOX_CANNED_MAX = 50;
export const INBOX_CANNED_TITLE_MAX = 60;
export const INBOX_CANNED_BODY_MAX = 4096;
/** Lowercase letters, digits, `-` and `_`, typed after "/" in the message box. */
const SHORTCUT_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/;

/** A private note on a conversation. */
export const INBOX_NOTE_MAX = 2000;

/** What a photo caption may hold (WhatsApp's own cap). */
export const INBOX_CAPTION_MAX = 1024;

export function isInboxLabelColor(value: unknown): value is InboxLabelColor {
  return (
    typeof value === "string" &&
    (INBOX_LABEL_COLORS as readonly string[]).includes(value)
  );
}

export function validateInboxLabel(input: {
  name: unknown;
  color: unknown;
}):
  | { ok: true; name: string; color: InboxLabelColor }
  | { ok: false; error: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "Give the label a name." };
  if (name.length > INBOX_LABEL_NAME_MAX) {
    return {
      ok: false,
      error: `A label can be at most ${INBOX_LABEL_NAME_MAX} characters.`,
    };
  }
  if (/[\r\n\t]/.test(name)) {
    return { ok: false, error: "A label is one line." };
  }
  const color = isInboxLabelColor(input.color) ? input.color : "grey";
  return { ok: true, name, color };
}

export function validateCannedReply(input: {
  shortcut: unknown;
  title: unknown;
  body: unknown;
}):
  | { ok: true; shortcut: string; title: string; body: string }
  | { ok: false; error: string } {
  const shortcut =
    typeof input.shortcut === "string"
      ? input.shortcut.trim().replace(/^\/+/, "").toLowerCase()
      : "";
  if (!SHORTCUT_RE.test(shortcut)) {
    return {
      ok: false,
      error:
        "A shortcut is 1 to 30 lowercase letters, digits, dashes or underscores, like hours or ship-time.",
    };
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) return { ok: false, error: "Give the reply a title." };
  if (title.length > INBOX_CANNED_TITLE_MAX) {
    return {
      ok: false,
      error: `A title can be at most ${INBOX_CANNED_TITLE_MAX} characters.`,
    };
  }
  const body =
    typeof input.body === "string"
      ? input.body.replace(/\r\n/g, "\n").trim()
      : "";
  if (!body) return { ok: false, error: "Write the reply." };
  if (body.length > INBOX_CANNED_BODY_MAX) {
    return {
      ok: false,
      error: `A reply can be at most ${INBOX_CANNED_BODY_MAX} characters.`,
    };
  }
  return { ok: true, shortcut, title, body };
}

/**
 * A saved reply with the customer filled in. `{{name}}` is the only token:
 * the customer's WhatsApp first name, or nothing (and the space before it)
 * when WhatsApp gave none, so "Hi {{name}}," reads "Hi," rather than
 * "Hi ,". Unknown tokens are left as typed, visibly, rather than silently
 * removed.
 */
export function fillCannedReply(
  body: string,
  customer: { name: string | null },
): string {
  const first = (customer.name ?? "").trim().split(/\s+/)[0] ?? "";
  return body.replace(/ ?\{\{\s*name\s*\}\}/g, first ? ` ${first}` : "");
}

/**
 * The search box's words as a prefix text-search query over the 'simple'
 * configuration, or null when nothing searchable was typed. Each word is
 * reduced to letters, digits and combining marks (any script: a Devanagari
 * virama is a mark, and stripping it turns "ऑर्डर" into a word nobody
 * wrote), so the query can never carry an operator; at most six words, each
 * matched as a prefix, all required.
 */
export function inboxSearchQuery(q: string): string | null {
  const words = q
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}\p{M}]/gu, "").toLowerCase())
    .filter((w) => w.length >= 2)
    .slice(0, 6);
  if (words.length === 0) return null;
  return words.map((w) => `${w}:*`).join(" & ");
}

/** The pieces of a search snippet: `«` and `»` wrap each matched word. */
export function splitSnippet(
  snippet: string,
): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  const re = /«([^»]*)»/g;
  let last = 0;
  for (const m of snippet.matchAll(re)) {
    if (m.index > last)
      out.push({ text: snippet.slice(last, m.index), hit: false });
    out.push({ text: m[1] ?? "", hit: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length)
    out.push({ text: snippet.slice(last), hit: false });
  return out;
}
