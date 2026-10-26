/**
 * ★ POS, NEVER "REGISTER" OR "TILL" (owner's rule, 26 Oct 2026).
 *
 * The in-person selling feature is "POS" in everything a merchant, their staff
 * or a shopper reads: dashboard, POS screens, storefront, emails, Mink and the
 * Help Centre. One word list, shared by the two guards so they cannot drift:
 *
 *   - app/pos-wording-coverage.test.ts (text in the product's own code)
 *   - the pos-wording rule in scripts/help-content-lint.mjs (Help migrations)
 *     and scripts/help-content-audit.mjs (the Help rows a database serves)
 *
 * BANNED BY DEFAULT. Every whole word "register", "registers", "till" or
 * "tills", in any case, is the old name for POS, unless it is one of the other
 * meanings the owner kept, each spelled out below:
 *
 *   - registering something: "register its own entity, sender header and
 *     message templates" (DLT), "register the number" (WhatsApp), "register it
 *     with search engines", "register your business for GST";
 *   - signing up: "sign in or register", "register for an account";
 *   - "till" meaning until, before a date or time: "valid till 31 March",
 *     "till 5pm", "(till {date})";
 *   - "registered" and "registration" (customers, office, GST, DLT), which are
 *     other words and never match;
 *   - a path, file, class or identifier: "/pos/register", "./register-client",
 *     "posx-register-ui".
 *
 * A listing of phrase shapes to ban let 22 of the 171 removed sentences pass
 * when replayed ("Sell · Register", "Open register", "</strong> register."),
 * which is why the rule bans the words and lists the exceptions instead.
 *
 * "Point of Sale" is matched too, except as the one introduction "POS (point of
 * sale)" and the /point-of-sale/ URL; the marketing site keeps the name, so the
 * product guard applies that pattern outside it only. "counter" stays for the
 * physical shop counter and is matched only as the feature's name.
 */

// Joined to what comes before by a hyphen, slash or dot, the word is part of a
// class, path or file name ("posx-register-ui", "./register-client"). A
// hyphen AFTER it still reads as prose ("a till-created profile").
const NOT_IN_A_WORD_BEFORE = String.raw`(?<![\w\-/.@#])`;
const NOT_IN_A_WORD_AFTER = String.raw`(?!\w|\.\w)`;

const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;

const DETERMINER = String.raw`(?:a|an|the|this|that|its|their|your|our|each|every)\s+`;
const QUALIFIERS = String.raw`(?:(?:own|exact|new|business|phone|mobile|WhatsApp|SMS|DLT|\d+-character)\s+)*`;

/** What follows "register" when it means registering something, or signing up. */
const REGISTERING = [
  // register its own entity / a Principal Entity / a 6-character sender
  // header / your business / the domain / message templates
  String.raw`\s+(?:${DETERMINER})?${QUALIFIERS}(?:principal\s+entit(?:y|ies)|entit(?:y|ies)|sender|message\s+(?:bod(?:y|ies)|templates?)|(?:DLT|SMS|WhatsApp)\s+templates?|domains?|business(?:es)?|compan(?:y|ies)|trademarks?|GSTIN|PAN)\b`,
  // the number / this exact message body / the SMS wording / a template: only
  // with a determiner, since "register number" or "register template" is POS
  String.raw`\s+${DETERMINER}${QUALIFIERS}(?:numbers?|templates?|messages?|wording)\b`,
  // register it with search engines / them on the DLT portal / it as a
  // template; "does not register or change the portal template"; "StoreMink
  // registers one for each order update" (WhatsApp templates)
  String.raw`\s+(?:it|them)\s+(?:with|on|as)\b`,
  String.raw`\s+or\s+(?:change|edit|update|delete)\b`,
  String.raw`\s+one\s+(?:for|per)\b`,
  String.raw`\s+(?:with|on|for)\s+(?:the\s+)?(?:DLT|GST|TRAI|MCA|Meta|WhatsApp|search\s+engines?)\b`,
  // signing up
  String.raw`\s+for\s+(?:an?\s+|your\s+)?account\b`,
  String.raw`\s+(?:an?|your|their)\s+account\b`,
  String.raw`\s+with\s+(?:your\s+)?(?:email|phone|mobile|Google)\b`,
  String.raw`\s*(?:\bor\b|\band\b|\/)\s*(?:sign|log)\s*(?:in|up)\b`,
].join("|");

/** "sign in or register", "log in / register": signing up. */
const SIGNING_UP_BEFORE = String.raw`(?<!\b(?:sign|log)\s*(?:in|up)\s*(?:or|and|\/|,)\s*)`;

/** What follows "till" when it means until: a date, a time, a moment. */
const UNTIL = [
  // {date} is what the product guard writes for a date expression in a
  // template or JSX: `(till ${formatDate(plan_expires_at)})`
  String.raw`\{date\}`,
  String.raw`\d{1,2}(?:st|nd|rd|th)?\s+${MONTH}`,
  String.raw`${MONTH}\s+\d{1,2}\b`,
  String.raw`\d{4}-\d{2}-\d{2}\b`,
  String.raw`\d{1,2}(?::\d{2})?\s*(?:am|pm)\b`,
  String.raw`\d{1,2}:\d{2}\b`,
  String.raw`(?:now|then|today|tomorrow|tonight|midnight|noon|late|later)\b`,
  String.raw`(?:the\s+)?(?:end|next|last|day|date|time|expiry|deadline)\b`,
  String.raw`(?:you|they|we|it|he|she|someone)\b`,
]
  .map((when) => String.raw`:?\s+${when}`)
  .join("|");

/**
 * A whole word "register(s)" or "till(s)" that names POS: every one that is
 * not a kept meaning. Global and case-insensitive; use with matchAll.
 */
export const OLD_POS_WORD = new RegExp(
  NOT_IN_A_WORD_BEFORE +
    "(?:" +
    [
      SIGNING_UP_BEFORE +
        String.raw`registers?` +
        NOT_IN_A_WORD_AFTER +
        `(?!${REGISTERING})`,
      String.raw`tills` + NOT_IN_A_WORD_AFTER,
      String.raw`till` + NOT_IN_A_WORD_AFTER + `(?!${UNTIL})`,
    ].join("|") +
    ")",
  "gi",
);

/**
 * The full product name, also as "point-of-sale". "POS (point of sale)" may
 * introduce it once; a URL slug ("/help/point-of-sale/...") is an address.
 */
export const POINT_OF_SALE = /(?<![(/])\bpoint[\s-]+of[\s-]+sale\b/gi;

/** "counter" as the feature's name. "at the counter" is the shop counter. */
export const COUNTER_AS_FEATURE =
  /\bcounter\s+(?:sales?|purchases?|logins?)\b|\bwebsite\s*\+\s*counter\b/gi;

/**
 * Every place `text` uses old POS wording, in order.
 *
 * @param {string} text
 * @param {{ pointOfSale?: boolean, counter?: boolean }} [which]
 *   pointOfSale: false for the marketing site, which keeps the name.
 * @returns {{ index: number, words: string, kind: "old-word" | "point-of-sale" | "counter" }[]}
 */
export function findOldPosWording(
  text,
  { pointOfSale = true, counter = true } = {},
) {
  const hits = [];
  for (const m of text.matchAll(OLD_POS_WORD))
    hits.push({ index: m.index, words: m[0], kind: "old-word" });
  if (pointOfSale)
    for (const m of text.matchAll(POINT_OF_SALE))
      hits.push({ index: m.index, words: m[0], kind: "point-of-sale" });
  if (counter)
    for (const m of text.matchAll(COUNTER_AS_FEATURE))
      hits.push({ index: m.index, words: m[0], kind: "counter" });
  return hits.sort((a, b) => a.index - b.index);
}

/** The words around a hit, for a readable failure message. */
export function sampleAround(text, index, length, radius = 40) {
  return text
    .slice(Math.max(0, index - radius), index + length + radius)
    .replace(/\s+/g, " ")
    .trim();
}
