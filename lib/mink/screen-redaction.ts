// ---------------------------------------------------------------------------
// ★★ CONTACT DETAILS NEVER LEAVE THE PAGE IN WHAT MINK READS OFF THE SCREEN.
//
// Owner's decision, 25 Oct 2026. Mink's screen reading (`readMinkScreen`,
// app/dashboard/mink-screen.ts) sends the page title, headings, the address
// bar's filters, an open dialog's title, a notice, table rows and form values
// with every message. On Customers, Orders and Enquiries that carried
// customers' email addresses, phone numbers and postal addresses to Google as
// written, while the Privacy Policy (section 5) says contact details are
// masked before AI sees them. Every one of those strings now passes through
// here first: an email becomes "[email hidden]", a phone number
// "[phone hidden]" and a postal address "[address hidden]". Names, order
// references, SKUs, prices, dates and statuses are left alone, so Mink still
// knows which customer and which order "this" is.
//
// ★ ONE MODULE, BOTH ENDS. The browser masks before anything is sent, and
// `normalizeMinkScreenContext` / `normalizeMinkPageContext`
// (lib/mink/page-context.ts) mask again on the server, because a tab opened
// before this shipped, or a hand-written request, sends the screen unmasked.
// Masking is idempotent: one pass hides everything a second pass would
// (numbers and addresses joined to each other included), so the server's pass
// changes nothing the browser's made. Pure and client-safe: no imports.
//
// ★ MASK, THEN CUT. Every caller masks a whole string before bounding it to
// its length: a cut through an email or a phone number leaves a fragment no
// rule can recognise.
//
// ⚠ THESE ARE PATTERNS, NOT A GUARANTEE. They are tuned to leave order data
// alone, so a few contact details written unusually still pass (each rule
// names its own); a rule that hid order data would cost Mink the page.
// ---------------------------------------------------------------------------

export const EMAIL_HIDDEN = "[email hidden]";
export const PHONE_HIDDEN = "[phone hidden]";
export const ADDRESS_HIDDEN = "[address hidden]";

/** What readMinkScreen puts between a table row's cells. */
export const SCREEN_CELL_SEPARATOR = " · ";

const PLACEHOLDERS = /\[(?:email|phone|address) hidden\]/g;

/** A hyphen, and the dashes a keyboard or word processor puts in its place. */
const DASHES = `-${String.fromCharCode(0x2010, 0x2011, 0x2012, 0x2013, 0x2212)}`;

// ---------------------------------------------------------------------------
// Digits
// ---------------------------------------------------------------------------

/**
 * The zero of each script's digits a shopper may type a number in:
 * Arabic-Indic, Persian, Devanagari, Bengali, Gurmukhi, Gujarati, Odia,
 * Tamil, Telugu, Kannada, Malayalam and full-width. `\d` matches only 0 to 9,
 * so a phone number typed in Devanagari digits passed every rule.
 */
const DIGIT_ZEROS = [
  0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66,
  0x0ce6, 0x0d66, 0xff10,
];
const OTHER_DIGIT = new RegExp(
  `[${DIGIT_ZEROS.map((zero) => `${String.fromCharCode(zero)}-${String.fromCharCode(zero + 9)}`).join("")}]`,
  "g",
);

/**
 * The text with every digit written as 0 to 9. Each of those digits is one
 * UTF-16 unit, so every index still points at the same character: the phone
 * and address rules read this copy, and what they keep is the original.
 */
function asciiDigits(text: string): string {
  return text.replace(OTHER_DIGIT, (digit) => {
    const code = digit.charCodeAt(0);
    const zero =
      DIGIT_ZEROS.find((first) => code >= first && code <= first + 9) ?? code;
    return String(code - zero);
  });
}

// ---------------------------------------------------------------------------
// Email addresses
// ---------------------------------------------------------------------------

const EMAIL_CHAR = String.raw`[\p{L}\p{M}\p{N}._%+'-]`;

/**
 * A local part, "@", then a domain with a letter in it. The top-level domain
 * is optional, so an address an older tab cut short ("priya@examplecorp") is
 * still hidden, and so is a local part with nothing after its "@" yet (a
 * search still being typed, "priya.sharma@", or one cut there, "priya@…");
 * "@storemink" (no local part) and "2@₹99" (no domain) are not addresses. A
 * UPI id ("9876543210@paytm") is one, and it carries the phone. A vowel sign
 * counts as part of a word, so a name in Devanagari is a local part. It
 * starts only at the beginning of a word, which keeps the scan linear.
 */
const EMAIL_BODY = String.raw`${EMAIL_CHAR}+@(?:(?=[\p{N}.-]*\p{L})[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)*|(?=…|$))`;
const EMAIL = new RegExp(`(?<!${EMAIL_CHAR})${EMAIL_BODY}`, "gu");
/** An address starting exactly where the one before it ended. */
const EMAIL_AFTER = new RegExp(EMAIL_BODY, "uy");

function hideEmails(text: string): string {
  if (!text.includes("@")) return text;
  let out = "";
  let cursor = 0;
  EMAIL.lastIndex = 0;
  for (let match = EMAIL.exec(text); match; match = EMAIL.exec(text)) {
    out += text.slice(cursor, match.index) + EMAIL_HIDDEN;
    cursor = match.index + match[0].length;
    // ★ An address joined to the one before it ("a@b.com+c@d.com") does not
    // start a word, so the scan skips it; the server's second pass would
    // find it after the placeholder's "]". It is hidden here instead, and
    // the scan goes on from its end.
    EMAIL_AFTER.lastIndex = cursor;
    while (EMAIL_AFTER.test(text)) {
      out += EMAIL_HIDDEN;
      cursor = EMAIL_AFTER.lastIndex;
    }
    EMAIL.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/**
 * A run of digit groups joined by a space, a dot, a dash (spaced or not) or
 * brackets, optionally opened by "+": "+91 98765 43210", "098765-43210",
 * "98765 - 43210", "(022) 2345 6789", "+1 415 555 0100". Every separator
 * consumes a character and every group is all its digits, so the match
 * cannot backtrack on long input. Whether a run (or part of one) is a phone
 * is decided in `runPhones`.
 */
const NUMBER_RUN = new RegExp(
  String.raw`(?:\+ ?)?\(?\d+(?:(?: ?[${DASHES}] ?|[ .]|\) ?|[${DASHES} .]?\()\d+)*\)?`,
  "g",
);
const DASH = new RegExp(`^[${DASHES}]$`);
const DASH_OR_DOT = new RegExp(`^[${DASHES}.]$`);

/**
 * Digits in a phone number. With "+" the number carries its country code, so
 * 10 to 15 (every country the register offers is 10 to 13). Without it, 10
 * to 12: a mobile, a mobile with its 0 or 91 prefix, or a landline with its
 * STD code.
 *
 * ★ A BARE RUN OF 10 TO 12 DIGITS IS HIDDEN AS A PHONE, deliberately. On
 * Customers and Orders it nearly always is one ("9876543210",
 * "919876543210"), and nothing Mink needs to tell orders or products apart is
 * a bare run of that length: orders are ORD…, SKUs and courier waybills mixed
 * with letters keep their digits (a run joined to a letter is never a phone),
 * money carries "₹" and commas, dates and times carry "/" and ":". The cost:
 * an all-digit waybill or barcode of 10 to 12 digits is hidden too; 13 digits
 * and longer (an EAN-13 barcode) is kept.
 */
const PLUS_DIGITS = { min: 10, max: 15 };
const BARE_DIGITS = { min: 10, max: 12 };

/**
 * A first group that is a country code, with or without "00", joined by a
 * dash to a national number of 8 digits or more: "977-9812345678",
 * "0091-9876543210". The number counts as one written with "+", so it may
 * hold the 13 or 14 digits a bare run may not. A short second group keeps a
 * hyphenated ISBN ("978-81-...") a book's.
 * ⚠ "00" with no separator ("00919876543210") is read as a bare run of 14
 * digits, which is kept.
 */
const COUNTRY_CODE = /^(?:00)?[1-9]\d{0,2}$/;

/**
 * A word that says a phone number follows, glued to it or joined by "-",
 * "#", ":" or ".": "Mob9876543210", "Ph-9876543210", "Ph#9876543210".
 */
const CONTACT_WORD =
  /(?<![\p{L}\p{N}])(?:mob(?:ile)?|ph(?:one)?|tel|cell|contact|call|whats ?app|wa)[-#:.]?$/iu;

/**
 * The text a phone rule reads at an index. A pass sees each phone it has
 * already hidden as the placeholder's "]", the character a second pass would
 * find there.
 */
type CharAt = (index: number) => string;

function contactWordBefore(charAt: CharAt, at: number): boolean {
  let before = "";
  for (let index = Math.max(0, at - 12); index < at; index += 1) {
    before += charAt(index);
  }
  return CONTACT_WORD.test(before);
}

/**
 * Whether a run's first group may begin a phone. A run joined to a word is a
 * code ("SKU100100015", "ORD10011027", a waybill), a run after "₹" or "#" is
 * an amount or a reference, and one after "-" or "/" joined to a word or
 * number is part of a code, a path or a UUID ("DEL-000042",
 * "INV/2026/…", "…-a45f-426614174000"). After a digit and ":" or "." it is a
 * time or a decimal. A contact word overrides all of that ("Mob-98765…").
 * "+" and "(" only refuse a number directly before them, because a name an
 * older tab glued to the number ("Sharma+919876543210") is still in front of
 * a phone.
 * ⚠ So a phone typed straight after any other word ("Number9876543210") is
 * not hidden.
 */
function runStartsFree(charAt: CharAt, at: number): boolean {
  const lead = charAt(at);
  const prev = charAt(at - 1);
  const prev2 = charAt(at - 2);
  if (lead === "+" || lead === "(") return !/[\p{N}+]/u.test(prev);
  if (/[\p{L}#.:-]/u.test(prev) && contactWordBefore(charAt, at)) return true;
  if (/[\p{L}\p{N}_@#%+₹$€£]/u.test(prev)) return false;
  if (prev === "-" || prev === "/") return !/[\p{L}\p{N}]/u.test(prev2);
  if (prev === "." || prev === ":") return !/\p{N}/u.test(prev2);
  return true;
}

/**
 * Whether a run's last group may end a phone. Joined to a word it is a code
 * ("123456789IN"); "%" makes it a percentage. A short last group followed by
 * ":" or "/" and a digit is a date or a time ("2026-10-25 10:30"); a phone's
 * last group is longer, so "98765-43210/11" is still hidden. ★ A run closed
 * by ")" is never a date or a time: the number after it, once hidden, would
 * stop reading as one, and a second pass would then hide this run too.
 */
function runEndsFree(
  charAt: CharAt,
  end: number,
  lastDigits: number,
  closed: boolean,
): boolean {
  const next = charAt(end);
  const next2 = charAt(end + 1);
  if (/[\p{L}\p{N}_@%]/u.test(next)) return false;
  if (closed) return true;
  return !(/[:/.]/.test(next) && /\p{N}/u.test(next2) && lastDigits <= 4);
}

/**
 * Report every phone inside one run as offsets into the text. The run may
 * hold other numbers too, joined to the phone by a space ("Qty 120 98765
 * 43210", "2026 9876543210"), so each start is tried in turn and the
 * shortest stretch of whole groups with a phone's digit count is hidden.
 * Stretches that overlap are hidden together: in "Receipt 123456 98765
 * 43210" both "123456 98765" and "98765 43210" have a phone's length, and
 * hiding only the first left half the phone. A stretch begins and ends at a
 * space, never inside "2026-10-25", or at a dash or dot between two groups
 * that are each a phone's length ("9876543210-9123456789"); a last group of
 * one or two digits after a dot is a fraction ("1234567890.50" is an amount,
 * not a phone).
 */
function runPhones(
  charAt: CharAt,
  at: number,
  run: string,
  hide: (from: number, to: number) => void,
): void {
  const groups = Array.from(run.matchAll(/\d+/g), (match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    digits: match[0].length,
  }));
  const count = groups.length;
  const between = (left: number) =>
    run.slice(groups[left].end, groups[left + 1].start);
  const splits = (left: number) =>
    /\s/.test(between(left)) ||
    (DASH_OR_DOT.test(between(left)) &&
      groups[left].digits >= 10 &&
      groups[left + 1].digits >= 10);
  const fraction =
    count > 1 && between(count - 2) === "." && groups[count - 1].digits <= 2;
  const international =
    run.startsWith("+") ||
    (count > 1 &&
      DASH.test(between(0)) &&
      COUNTRY_CODE.test(run.slice(groups[0].start, groups[0].end)) &&
      groups[1].digits >= 8);
  const canStart = (index: number) =>
    index === 0 ? runStartsFree(charAt, at) : splits(index - 1);
  const canEnd = (index: number) =>
    index === count - 1
      ? !fraction &&
        runEndsFree(
          charAt,
          at + run.length,
          groups[index].digits,
          run.endsWith(")"),
        )
      : splits(index);

  // The stretch being built: groups `open` to `close`, or none.
  let open = -1;
  let close = -1;
  const flush = () => {
    if (open < 0) return;
    // The whole run's opening "+" or "(" and closing ")" go with it.
    const from =
      open === 0
        ? 0
        : run[groups[open].start - 1] === "("
          ? groups[open].start - 1
          : groups[open].start;
    const to =
      close === count - 1
        ? run.length
        : run[groups[close].end] === ")"
          ? groups[close].end + 1
          : groups[close].end;
    hide(at + from, at + to);
  };
  for (let first = 0; first < count; first += 1) {
    if (!canStart(first)) continue;
    const { min, max } =
      first === 0 && international ? PLUS_DIGITS : BARE_DIGITS;
    let digits = 0;
    for (let last = first; last < count; last += 1) {
      digits += groups[last].digits;
      if (digits > max) break;
      if (digits < min || !canEnd(last)) continue;
      if (open >= 0 && first <= close) {
        close = Math.max(close, last);
      } else {
        flush();
        open = first;
        close = last;
      }
      break;
    }
  }
  flush();
}

function hidePhones(text: string): string {
  const digits = asciiDigits(text);
  // ★ ONE PASS HIDES WHAT A SECOND WOULD. The phone this pass hid last reads
  // as its placeholder's "]", which is what the server's second pass sees
  // there, so "9876543210/9123456789" loses both numbers now, not one per
  // pass. Only the last one matters: a run looks back two characters.
  let hiddenFrom = -1;
  let hiddenTo = -1;
  const charAt: CharAt = (index) =>
    index >= hiddenFrom && index < hiddenTo ? "]" : (digits[index] ?? "");
  let out = "";
  let cursor = 0;
  for (const match of digits.matchAll(NUMBER_RUN)) {
    runPhones(charAt, match.index ?? 0, match[0], (from, to) => {
      out += text.slice(cursor, from) + PHONE_HIDDEN;
      cursor = to;
      hiddenFrom = from;
      hiddenTo = to;
    });
  }
  return out + text.slice(cursor);
}

// ---------------------------------------------------------------------------
// Postal addresses
// ---------------------------------------------------------------------------

/**
 * Words a six-digit number counts, prices or names when it stands right
 * after them ("Order 100234", "Invoice No. 100045", "Total 125000") or before
 * them ("123456 views"): never a PIN code. After a contact word it is the
 * start of a phone ("Mob 987654 3210").
 */
const NOT_PIN_WORD =
  /^(?:orders?|invoices?|inv|bills?|receipts?|ref|sku|hsn|sac|qty|quantity|units?|pcs|stock|total|subtotal|amount|rs|inr|mrp|price|views?|visitors?|sessions?|clicks?|impressions?|followers?|likes?|points?|credits?|mob|mobile|ph|phone|tel|cell|contact|call|whatsapp|wa)$/i;
const WORD_BEFORE = /(\p{L}+)(?:[\s:#-]+no\.?)?[\s:#-]*$/iu;
const WORD_AFTER = /^[\s:-]*(\p{L}+)/u;
const LETTER_THEN_GAP = new RegExp(
  String.raw`[\p{L}\p{M}][${DASHES}\s,:]{1,3}$`,
  "u",
);
const GAP_THEN_LETTER = new RegExp(
  String.raw`^[${DASHES}\s,]{1,3}[\p{L}\p{M}]`,
  "u",
);

/**
 * Whether a segment holds an Indian PIN code: six digits, not starting with
 * 0, standing on their own and next to a word ("Bengaluru 560038",
 * "Bengaluru - 560038", "PIN: 560038", "560038, India"). A number joined to
 * a code ("DEL-123456"), a path ("…/100123"), an amount ("₹560038",
 * "560038.50") or a word is not a PIN, nor is one beside a count, price or
 * reference word (`NOT_PIN_WORD`). A vowel sign ends a word as a letter
 * does, so "पुणे 411001" is a PIN too.
 * ⚠ So "Bengaluru-560038" is not caught by this rule alone, and a six-digit
 * number beside any other word is hidden as a PIN ("Batch 100234").
 */
function hasPinCode(segment: string): boolean {
  const text = asciiDigits(segment);
  for (const match of text.matchAll(/\d+/g)) {
    const pin = match[0];
    if (pin.length !== 6 || pin[0] === "0") continue;
    const at = match.index ?? 0;
    const end = at + pin.length;
    const prev = text[at - 1] ?? "";
    const prev2 = text[at - 2] ?? "";
    const next = text[end] ?? "";
    const next2 = text[end + 1] ?? "";
    if (/[\p{L}\p{M}_.#/₹$€£]/u.test(prev)) continue;
    if (prev === "-" && /[\p{L}\p{M}\p{N}]/u.test(prev2)) continue;
    if (/[\p{L}\p{M}_%]/u.test(next)) continue;
    if (/[.,/:]/.test(next) && /\p{N}/u.test(next2)) continue;
    const before = WORD_BEFORE.exec(text.slice(Math.max(0, at - 40), at));
    const after = WORD_AFTER.exec(text.slice(end, end + 40));
    if (NOT_PIN_WORD.test(before?.[1] ?? "")) continue;
    if (NOT_PIN_WORD.test(after?.[1] ?? "")) continue;
    if (
      LETTER_THEN_GAP.test(text.slice(Math.max(0, at - 4), at)) ||
      GAP_THEN_LETTER.test(text.slice(end, end + 4))
    ) {
      return true;
    }
  }
  return false;
}

/** A house, plot or flat number: "12", "4B", "12/3", "12-3-456", "B-204". */
const HOUSE_NUMBER = String.raw`(?:[a-z]-?)?\d+[a-z]?(?:[/-]\d+[a-z]?)*`;
/** A street or locality after its number: "12 MG Road", "45, BTM Layout". */
const PLACE = String.raw`road|rd|street|marg|lane|chowk|highway|\p{L}*nagar|colony|enclave|vihar|apartments?|apts?|layout|society|peth|bazaa?r|gall?i|mohalla`;
/** A part of a building or plot before its number: "Flat 4B", "Plot No. 45". */
const UNIT = String.raw`sector|plot|flat|apt|apartment|h\.? ?no|house ?no|d\.? ?no|door ?no|gall?i|ward|block|tower|floor|building|bldg|road ?no|street ?no|lane`;
/** A numbered part of a locality after an ordinal: "3rd Cross", "4th Block". */
const NUMBERED_PART = String.raw`cross|main|block|stage|phase|floor|sector|street|road|lane|avenue`;

/**
 * ★ AN ADDRESS WORD COUNTS NEXT TO ITS NUMBER. "12 MG Road", "12,
 * Rajajinagar", "Flat 4B", "Sector 18", "H.No. 12", "Tower B", "4th Floor"
 * and "2nd A Cross" are addresses; "Street Food Masala, 100 g", "Floor Mat,
 * Pack of 2" and "Road Bike, 21 Speed" are products, whose number sits
 * elsewhere.
 */
const ADDRESS_PART = new RegExp(
  [
    String.raw`\b${HOUSE_NUMBER},?\s+(?:[\p{L}.'-]+\s+){0,2}(?:${PLACE})\b`,
    String.raw`\b(?:${UNIT})\.?\s*(?:no\.?\s*|#\s*|:\s*)?\d+[a-z]?\b`,
    String.raw`\b(?:tower|block|wing)\s+[a-z]\b`,
    String.raw`\b\d+(?:st|nd|rd|th)\s+(?:[a-z]\s+)?(?:${NUMBERED_PART})\b`,
  ].join("|"),
  "iu",
);
/**
 * Words only an address uses: one of them, any number and a comma make a
 * line an address wherever they sit ("Plot 45, Vasant Vihar").
 */
const ADDRESS_WORD =
  /\b(?:nagar|colony|enclave|vihar|marg|chowk|apartments|apts|mohalla)\b/i;
/**
 * A road named at the end of a part of the line: "Shop 12, Green Market, MG
 * Road". "Road Bike" and "street wear" name something else.
 */
const ROAD_NAMED = /\b(?:road|rd|street|lane)\b\.?(?=\s*(?:[,.;)]|$))/i;

/**
 * Whether a line is a postal address by its words: it has a comma, and an
 * address word next to its number (`ADDRESS_PART`), or an address-only word
 * or a road's name with a number anywhere ("12 MG Road, Indiranagar",
 * "Flat 4B, Sunshine Apartments", "#12, 3rd Cross, Koramangala").
 * ⚠ So a line with neither a PIN nor a number ("Near the temple, Station
 * Road") or without a comma ("12 MG Road Bengaluru") is not hidden, and a
 * product or place named like an address with its number ("Sector 18,
 * Noida") is.
 */
function isAddressLine(line: string): boolean {
  const words = asciiDigits(line.replace(PLACEHOLDERS, " "));
  if (!words.includes(",")) return false;
  if (ADDRESS_PART.test(words)) return true;
  return (
    /\d/.test(words) && (ADDRESS_WORD.test(words) || ROAD_NAMED.test(words))
  );
}

/**
 * The longest text judged whole by its words. An address is a short line; a
 * longer text (a note, a message) is judged sentence by sentence, and only a
 * sentence that reads as an address is hidden, so "Flat 4B, Sunshine
 * Apartments, 12 MG Road. Please call first. …" keeps its request.
 */
const ADDRESS_LINE_MAX = 160;

/**
 * Where a long text's sentences end: ".", "!", "?" or ";" and a space, but
 * not before a number ("flat no. 4") or after a capitalised word of up to
 * four letters, which is likely an abbreviation inside an address ("H.No.
 * 12", "MG Rd. Indiranagar", "Opp. City Mall"). "On the sofa. Please" ends a
 * sentence, so the request beside an address stays visible.
 */
const SENTENCE_END = /((?<=[!?;]|(?<!\b\p{Lu}\p{L}{0,3})\.)\s+(?![\s\p{N}]))/u;

/**
 * One segment (one cell, or one " · " part of a string) with its contact
 * details hidden. A segment holding a PIN code is hidden whole.
 */
function redactSegment(segment: string): string {
  const emailed = hideEmails(segment);
  // ★ The PIN code is looked for before phones are hidden: a phone written in
  // groups straight after it ("Bengaluru 560038 98765 43210") read as one
  // phone from the PIN on, which took the PIN with it and left the street.
  if (hasPinCode(emailed)) return ADDRESS_HIDDEN;
  const masked = hidePhones(emailed);
  // And after, as the server's second pass would: "Bengaluru
  // 560038,9876543210" reads as a list of numbers until the phone is hidden.
  if (hasPinCode(masked)) return ADDRESS_HIDDEN;
  if (masked.length <= ADDRESS_LINE_MAX) {
    return isAddressLine(masked) ? ADDRESS_HIDDEN : masked;
  }
  const parts = masked.split(SENTENCE_END);
  for (let index = 0; index < parts.length; index += 2) {
    if (isAddressLine(parts[index])) {
      parts[index] = ADDRESS_HIDDEN + (/[.!?;]$/.exec(parts[index])?.[0] ?? "");
    }
  }
  // What is left is judged whole once it is short, as a second pass would.
  const lines = parts.join("");
  return lines.length <= ADDRESS_LINE_MAX && isAddressLine(lines)
    ? ADDRESS_HIDDEN
    : lines;
}

// ---------------------------------------------------------------------------
// The callers' API
// ---------------------------------------------------------------------------

/**
 * Hide every email address, phone number and postal address in one screen
 * string (a title, heading, row, notice, dialog title, filter or form value).
 * Whitespace is collapsed first, as every caller collapses it. A string is
 * judged segment by segment, split where readMinkScreen joins a row's cells,
 * so an address in one cell hides that cell and not the order beside it.
 */
export function redactScreenText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .split(SCREEN_CELL_SEPARATOR)
    .map(redactSegment)
    .join(SCREEN_CELL_SEPARATOR);
}

/**
 * A form field's label that names part of a postal address. "City" or
 * "State" alone is a coarse location and stays visible; "PIN code" never
 * reaches here (Mink's screen reading drops labels naming a PIN as secrets).
 * An email, web or link address is not a postal one.
 */
const ADDRESS_LABEL =
  /\b(?:address|street|line ?[12]|landmark|locality|pin ?code|postal ?code|post ?code|zip(?: ?code)?|flat|house|building|area)\b/i;
const NOT_POSTAL_LABEL = /\b(?:e-?mail|web|website|ip|url|link)\b/i;

export function isAddressLabel(label: string): boolean {
  return ADDRESS_LABEL.test(label) && !NOT_POSTAL_LABEL.test(label);
}

/**
 * A path, URL or host name: a web address, never a postal one. A path or an
 * anchor is one word: "#12, 3rd Cross" and "/2, Ganesh Peth" are addresses.
 */
const WEB_ADDRESS =
  /^(?:\/[^\s,]*$|#[\w-]*$|https?:\/\/|mailto:|tel:|www\.)|^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i;

/**
 * A form field's value. A field whose label reads as an address has its
 * whole value hidden, unless the value is a web address ("Link 1 address"
 * holding "/our-story") or a checkbox's "on" or "off"; every other value is
 * masked like any screen string.
 */
export function redactScreenField(label: string, value: string): string {
  if (!value || value === "on" || value === "off") return value;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (isAddressLabel(label) && !WEB_ADDRESS.test(collapsed)) {
    return ADDRESS_HIDDEN;
  }
  return redactScreenText(value);
}

/**
 * The dashboard path Mink is told it is on, with its query string masked: a
 * search box writes what was typed into the address bar
 * ("/dashboard/users?q=priya%40example.com"). Values are decoded before they
 * are judged, and a path with nothing to hide comes back exactly as it was.
 */
export function redactScreenPath(path: string): string {
  const mark = path.indexOf("?");
  if (mark < 0) return path;
  let changed = false;
  const query = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(path.slice(mark + 1))) {
    const safeKey = redactScreenText(key);
    const safeValue = redactScreenText(value);
    if (safeKey !== key || safeValue !== value) changed = true;
    query.append(safeKey, safeValue);
  }
  return changed ? `${path.slice(0, mark)}?${query.toString()}` : path;
}
