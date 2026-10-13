// ---------------------------------------------------------------------------
// What did a WhatsApp message MEAN — STOP, START, a question about an order,
// or an ordinary message?
//
// Pure and client-safe. The SMS classifier (lib/sms/suppression.ts) answers
// the same question for carriers' vocabulary; this one is separate because the
// two vocabularies differ in a way that matters:
//
// ★ "CANCEL" IS NOT AN OPT-OUT HERE. On SMS it is a carrier keyword. On
// WhatsApp a customer replying "cancel" to "Your order is confirmed" is asking
// to cancel the ORDER — reading it as "stop messaging me" would silently end
// their offers over a question about a parcel. Only words that can mean nothing
// but opt-out are here.
//
// ★ HINDI, in both scripts (docs/whatsapp-commerce-plan.md §10). Most of this
// platform's customers write in Hindi or Hinglish, and an opt-out vocabulary
// that only knows English honours STOP from the minority who type it that way.
//
// ★ SHORT MESSAGES ONLY. "please stop" is an opt-out; "stop sending the wrong
// size" is a complaint. Up to three words after a courtesy word is stripped,
// and anything longer is `other`: a missed opt-out is a line a human reads in
// the inbox, a wrongly inferred one silently ends somebody's offers.
//
// ★ "WHERE IS MY ORDER" IS RECOGNISED BY ITS PARTS, NOT A PHRASE LIST, because
// people ask it a dozen ways ("order kab aayega", "status of my parcel",
// "मेरा ऑर्डर कहाँ है"). A short message that names an order AND asks where or
// when it is counts; "where can I order" (no "my", nothing about arrival) and
// anything with a complaint word in it ("not delivered", "wrong", "refund") do
// not. A miss costs nothing: the message waits for a person as it always did.
// ---------------------------------------------------------------------------

export type WhatsAppInboundIntent = "stop" | "start" | "order_status" | "other";

const STOP_PHRASES = new Set([
  "stop",
  "stopall",
  "stop all",
  "unsubscribe",
  "unsubscribe me",
  "optout",
  "opt out",
  "stop messages",
  "stop promotions",
  "stop offers",
  "no more messages",
  "no offers",
  // Hinglish
  "band",
  "band karo",
  "bandh",
  "bandh karo",
  "band kar do",
  "mat bhejo",
  "message mat bhejo",
  "offers mat bhejo",
  // Devanagari
  "बंद",
  "बंद करो",
  "बंद कर दो",
  "रोको",
  "मत भेजो",
  "मैसेज मत भेजो",
]);

const START_PHRASES = new Set([
  "start",
  "unstop",
  "subscribe",
  "optin",
  "opt in",
  "send offers",
  // Hinglish
  "chalu karo",
  "shuru karo",
  "offers bhejo",
  // Devanagari
  "शुरू",
  "शुरू करो",
  "चालू करो",
]);

const COURTESY = new Set([
  "please",
  "pls",
  "plz",
  "kindly",
  "thanks",
  "thank",
  "you",
  "kripya",
  "कृपया",
]);

/** Letters in Latin and Devanagari, digits and spaces survive; everything
 *  else (punctuation, emoji, zero-width marks) is dropped. */
function normalise(body: string): string[] {
  return (body ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-ॿ\s-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function classifyWhatsAppInbound(body: string): WhatsAppInboundIntent {
  const words = normalise(body).filter((w) => !COURTESY.has(w));
  if (words.length === 0) return "other";
  if (words.length <= 3) {
    const phrase = words.join(" ");
    if (STOP_PHRASES.has(phrase)) return "stop";
    if (START_PHRASES.has(phrase)) return "start";
  }
  return isOrderStatusQuestion(words) ? "order_status" : "other";
}

// ── "Where is my order?" ────────────────────────────────────────────────────

/** Asked on its own, these mean "how is my order doing". */
const ORDER_STATUS_ALONE = new Set([
  "status",
  "track",
  "tracking",
  "tracking id",
  "tracking number",
  "tracking link",
  "track order",
  "order status",
  "order tracking",
  "order update",
]);

const ORDER_NOUNS = new Set([
  "order",
  "orders",
  "parcel",
  "package",
  "delivery",
  "shipment",
  "courier",
  "ऑर्डर",
  "आर्डर",
  "ऑडर",
  "पार्सल",
  "डिलीवरी",
]);

/** Words that are about arrival or progress on their own. */
const PROGRESS_CUES = new Set([
  "status",
  "track",
  "tracking",
  "update",
  "updates",
  "arrive",
  "arriving",
  "arrival",
  "eta",
  "deliver",
  "delivered",
  "dispatched",
  "shipped",
  "kab",
  "aayega",
  "ayega",
  "aaega",
  "aega",
  "aayegi",
  "ayegi",
  "milega",
  "milegi",
  "pahunchega",
  "pohchega",
  "स्टेटस",
  "ट्रैक",
  "कब",
  "आएगा",
  "आयेगा",
  "आएगी",
  "मिलेगा",
  "मिलेगी",
  "पहुंचेगा",
  "पहुँचेगा",
]);

/** "Where" and "when", which need "my" too: "where can I order?" is not it. */
const WHERE_CUES = new Set([
  "where",
  "wheres",
  "when",
  "kahan",
  "kaha",
  "kidhar",
  "कहाँ",
  "कहां",
  "कहा",
  "किधर",
]);

const POSSESSIVE = new Set([
  "my",
  "mera",
  "meri",
  "mere",
  "mujhe",
  "मेरा",
  "मेरी",
  "मेरे",
  "मुझे",
]);

/**
 * A complaint or an action, which a person must handle: answering "not
 * delivered" or "cancel my order" with a status update would dismiss it.
 */
const NEEDS_A_PERSON = new Set([
  "cancel",
  "return",
  "refund",
  "exchange",
  "replace",
  "replacement",
  "wrong",
  "damaged",
  "broken",
  "change",
  "address",
  "not",
  "didnt",
  "didn",
  "never",
  "missing",
  "late",
  "delay",
  "delayed",
  "complaint",
  "problem",
  "issue",
  "nahi",
  "nahin",
  "nhi",
  "galat",
  "नहीं",
  "नही",
  "गलत",
]);

/** Openers that change nothing about the question. */
const GREETINGS = new Set([
  "hi",
  "hii",
  "hello",
  "helo",
  "hlo",
  "hey",
  "sir",
  "maam",
  "madam",
  "mam",
  "ji",
  "bhai",
  "bhaiya",
  "dear",
  "team",
  "namaste",
  "good",
  "morning",
  "afternoon",
  "evening",
  "नमस्ते",
]);

/** Past this, a message is a story about an order, which a person should read. */
const ORDER_QUESTION_MAX_WORDS = 8;

function isOrderStatusQuestion(allWords: string[]): boolean {
  const words = allWords.filter((w) => !GREETINGS.has(w));
  if (words.length === 0 || words.length > ORDER_QUESTION_MAX_WORDS) {
    return false;
  }
  if (words.some((w) => NEEDS_A_PERSON.has(w))) return false;
  if (ORDER_STATUS_ALONE.has(words.join(" "))) return true;
  if (!words.some((w) => ORDER_NOUNS.has(w))) return false;
  if (words.some((w) => PROGRESS_CUES.has(w))) return true;
  return (
    words.some((w) => WHERE_CUES.has(w)) && words.some((w) => POSSESSIVE.has(w))
  );
}
