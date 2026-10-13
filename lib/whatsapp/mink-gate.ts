// ---------------------------------------------------------------------------
// The deterministic gate in front of customer-facing Mink
// (docs/whatsapp-commerce-plan.md §13): which customer messages Mink is even
// asked about. Pure and client-safe; run at FILING (inbox.ts), so a message
// it refuses is filed exactly as it was before Mink existed (Needs reply,
// unread, the bell), with no model call and no delay.
//
// ★ HAND OVER IS THE DEFAULT, AND THIS IS THE HALF THAT NEEDS NO MODEL. A
// complaint, a refund, a cancellation, a damaged parcel, a payment problem,
// an address change, "talk to a person": each is something Mink cannot act
// on, so asking a model whether to hand it over would spend a call to learn
// what the words already say. The vocabulary is deliberately wide and in
// three scripts, because the cost of a false refusal is one message read by
// a person, and the cost of a false answer is a customer told "sorry, no
// refunds" by a bot.
//
// ★ A GREETING IS NOT A QUESTION. "hi" gets the welcome message (or a person),
// never a model answer to nothing.
// ---------------------------------------------------------------------------

/** Longer than this and the message is for a person: a paragraph of history
 *  is not a question Mink can answer from a facts sheet. */
export const MINK_QUESTION_MAX_CHARS = 1000;

export type MinkGateReason =
  | "empty"
  | "too_long"
  | "greeting"
  | "person"
  | "complaint"
  | "order_change"
  | "payment";

export type MinkGateVerdict =
  | { ok: true }
  | { ok: false; reason: MinkGateReason };

const GREETING_WORDS =
  /^(?:hi+|hello+|hey+|hiya|yo|namaste|namaskar|namaskaram|good\s+(?:morning|afternoon|evening|night)|ok(?:ay)?|k|thanks?|thank\s+you|thx|ty|dhanyavad|dhanyawad|shukriya|great|cool|nice|done|yes|no|hmm+|हाय|हेलो|हैलो|नमस्ते|नमस्कार|ठीक\s*है|ओके|धन्यवाद|शुक्रिया)$/i;

/** The customer asked for a person, in so many words. */
const PERSON =
  /\b(?:(?:talk|speak|chat|connect|baat)\b[^.?!]{0,30}\b(?:human|person|agent|someone|somebody|team|executive|representative|staff|owner|manager|insaan|aadmi|banda))|(?:customer\s+(?:care|service|support))|(?:real\s+(?:person|human))|(?:call\s+me)|(?:\bhuman\b)|(?:\bagent\b)|(?:\bexecutive\b)|(?:kisi\s+se\s+baat)|(?:किसी\s+से\s+बात)|(?:इंसान)|(?:कॉल\s+(?:करो|करें|कीजिए))/i;

/** A complaint, or goods that must come back: never a bot's call. */
const COMPLAINT =
  /\b(?:refund|replace(?:ment|d)?|exchange|complain(?:t|ts|ing)?|damaged?|broken|defect(?:ive)?|leak(?:ing|ed)?|expired|spoil(?:ed|t)?|fake|duplicate|missing|wrong\s+(?:item|product|size|order|colou?r|address)|not\s+(?:received|delivered|working|arrived)|never\s+(?:received|arrived|came)|didn'?t\s+(?:get|receive|arrive|come)|haven'?t\s+(?:got|received)|delayed|too\s+late|fraud|scam|cheat(?:ed|ing)?|rude|worst|pathetic|useless|disappointed)\b|(?:wapas|vapas|kharab|toota|tuta|galat|nahi\s+(?:mila|aaya|pahuncha)|nhi\s+(?:mila|aaya))|(?:रिफंड|वापस|खराब|टूटा|गलत|नहीं\s+(?:मिला|आया|पहुंचा)|शिकायत|नकली)/i;

/**
 * A RETURN is two things. "Can I return the cookies if I don't like them?"
 * asks what the policy says, which the facts sheet carries and Mink may
 * answer; "I want to return my order" is a request about goods in hand,
 * which a person handles. The word alone is the question; the word with
 * ownership ("my", "this", "that"), intent ("want to", "need to") or an
 * order is the request.
 */
const RETURN_WORD = /\breturn(?:s|ed|ing)?\b/i;
const RETURN_REQUEST =
  /\b(?:my|this|that|these|those)\b|\b(?:want|need|like|wish|have)\s+to\b|\border\b|\bparcel\b|\bpackage\b/i;

/** A change to an order Mink cannot make. */
const ORDER_CHANGE =
  /\b(?:cancel(?:led|lation|ling)?|change\s+(?:my\s+|the\s+)?(?:address|order|size|colou?r|number|phone|delivery)|update\s+(?:my\s+|the\s+)?(?:address|order|phone)|edit\s+(?:my\s+|the\s+)?(?:address|order)|modify|reschedule|add\s+(?:an?\s+)?item|remove\s+(?:an?\s+)?item)\b|(?:cancel\s+kar|address\s+(?:badal|change|update)|order\s+(?:badal|change))|(?:कैंसिल|रद्द|बदल(?:ो|ना|ें|िए)|पता\s+बदल)/i;

/** Money went somewhere it should not have: a person, always. */
const PAYMENT =
  /\b(?:payment\s+(?:failed|fail|issue|problem|pending|stuck|deducted|debited|gone|error)|money\s+(?:deducted|debited|gone|cut|taken)|charged\s+twice|double\s+(?:charge|payment|deduct)|amount\s+(?:deducted|debited|cut)|not\s+refunded|razorpay|upi\s+(?:failed|fail|issue|problem)|transaction\s+(?:failed|fail|issue|problem)|chargeback|dispute)\b|(?:paise\s+(?:kat|cut|gaye)|paisa\s+(?:kat|cut|gaya))|(?:पैसे\s+(?:कट|कटे|गए)|पेमेंट\s+(?:फेल|नहीं))/i;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * May Mink be asked about this message? Pure. Order matters: the money and
 * complaint checks run before anything else, so "cancel my order, hi" is
 * never read as a greeting.
 */
export function minkGate(text: string | null | undefined): MinkGateVerdict {
  const body = (text ?? "").trim();
  if (!body) return { ok: false, reason: "empty" };
  if (body.length > MINK_QUESTION_MAX_CHARS) {
    return { ok: false, reason: "too_long" };
  }
  if (PAYMENT.test(body)) return { ok: false, reason: "payment" };
  if (COMPLAINT.test(body)) return { ok: false, reason: "complaint" };
  if (RETURN_WORD.test(body) && RETURN_REQUEST.test(body)) {
    return { ok: false, reason: "complaint" };
  }
  if (ORDER_CHANGE.test(body)) return { ok: false, reason: "order_change" };
  if (PERSON.test(body)) return { ok: false, reason: "person" };
  const w = words(body);
  if (w.length <= 3 && GREETING_WORDS.test(w.join(" "))) {
    return { ok: false, reason: "greeting" };
  }
  return { ok: true };
}
