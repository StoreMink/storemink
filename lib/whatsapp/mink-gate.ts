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
// never a model answer to nothing. Nor is a pleasantry ("ok thanks", "thank
// you so much", "hi there") or a message with no words at all (a 👍): each
// is judged WORD BY WORD, so it is a pleasantry only when every word is one,
// and "thanks, where is my order" is still a question.
//
// ★ EVERY PATTERN READS THE MESSAGE AFTER `normalise`: "n't" closed up with
// whatever apostrophe the phone typed (inbox-intent.ts's rule), and a danda
// read as a full stop. A rule written for "wasn't" therefore also catches
// "wasn’t", "was'nt" and "wasnt".
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

/**
 * One word of a greeting, a thank-you or an acknowledgement, or the filler
 * around one ("so much", "a lot", "there", "sir", "ji"). Matched against ONE
 * word at a time. ★ No question word, verb or product word is on this list
 * ("is", "my", "order", "please", "price"), so a message holding any real
 * question always has a word that is not here.
 */
const PLEASANTRY_WORD =
  /^(?:hi+|hey+|hello+|helo+|hlo+|hlw|hiya|yo|namaste|namaskar|namaskaram|good|morning|afternoon|evening|night|gm|gn|ok+|okay+|okey|oki|okie|k+|thanks?|thank|thanku|thankyou|thnx|thanx|thnks|thks|thx|tnx|ty|tq|tysm|tqsm|welcome|you|u|so|very|much|a|lot|lots|all|again|there|everyone|team|sir|madam|mam|maam|ma|am|dear|ji|bhai|bhaiya|bro|buddy|friend|guys|for|the|your|help|too|great|cool|nice|awesome|perfect|fine|done|noted|sure|alright|right|yes|yeah|yep|yup|no|nope|nah|hmm+|hm+|mm+|oh|ah|wow|haha+|hehe+|lol|bye|goodbye|see|later|take|care|tc|dhanyavad|dhanyawad|dhanyavaad|shukriya|theek|thik|hai|accha|acha|achha|achcha|हाय|हेलो|हैलो|नमस्ते|नमस्कार|ठीक|है|ओके|धन्यवाद|शुक्रिया|जी|बहुत)$/i;

/** Longer than this, a message is never read as a pleasantry, whatever its
 *  words: a paragraph is rarely only thanks, and the model may hand it over. */
const PLEASANTRY_MAX_WORDS = 10;

/** A message with no words (an emoji, a "?"), or only pleasantry words. */
function isPleasantry(w: string[]): boolean {
  if (w.length === 0) return true;
  return (
    w.length <= PLEASANTRY_MAX_WORDS && w.every((x) => PLEASANTRY_WORD.test(x))
  );
}

/** The customer asked for a person, in so many words. */
const PERSON =
  /\b(?:(?:talk|speak|chat|connect|baat)\b[^.?!]{0,30}\b(?:human|person|agent|someone|somebody|team|executive|representative|staff|owner|manager|insaan|aadmi|banda))|(?:customer\s+(?:care|service|support))|(?:real\s+(?:person|human))|(?:call\s+me)|(?:\bhuman\b)|(?:\bagent\b)|(?:\bexecutive\b)|(?:kisi\s+se\s+baat)|(?:किसी\s+से\s+बात)|(?:इंसान)|(?:कॉल\s+(?:करो|करें|कीजिए))/i;

/** A complaint, or goods that must come back: never a bot's call. Goods that
 *  did not arrive are `NEGATED_ARRIVAL`, below. */
const COMPLAINT =
  /\b(?:refund|replace(?:ment|d)?|exchange|complain(?:t|ts|ing)?|damaged?|broken|defect(?:ive)?|leak(?:ing|ed)?|expired|spoil(?:ed|t)?|fake|duplicate|missing|wrong\s+(?:item|product|size|order|colou?r|address)|delayed|too\s+late|fraud|scam|cheat(?:ed|ing)?|rude|worst|pathetic|useless|disappointed)\b|(?:wapas|vapas|kharab|toota|tuta|galat)|(?:रिफंड|वापस|खराब|टूटा|गलत|शिकायत|नकली)/i;

/**
 * ★★ GOODS THAT DID NOT COME, WITH EVERY SPELLING OF "NOT". "My order wasn't
 * delivered" is the same complaint as "not delivered", and since
 * inbox-intent.ts stopped answering it as a status question it reaches this
 * gate. Only "not", "never", "didn't" and "haven't" (straight apostrophe
 * only) were known here, so "wasn’t delivered", "hasnt arrived" and
 * "आया नहीं" reached the model as questions. Now any negation (the "n't"
 * forms once `normalise` has closed them up, their stems for "wasn t",
 * "cannot", "never", "nothing", "nobody"), up to three words between
 * ("hasn't my order been"), then a word for getting, arriving, coming,
 * reaching, being delivered or shipped, or working.
 * ★ Hinglish and Hindi put the negation on EITHER side of the verb ("mila
 * nahi" and "nahi mila", "आया नहीं" and "नहीं आया"), with "hi" / "abhi tak"
 * allowed between.
 * ⚠ Left out on purpose, as in inbox-intent.ts: "no" ("order no. 1234") and
 * "can" ("can I return the cookies?" is a policy question; "can't" is here).
 * And "samajh nahi aaya" / "समझ नहीं आया" means "I didn't understand", so the
 * negation-first patterns skip a negation that follows that word.
 * A false hit costs a message read by a person (the trade in the header).
 */
const EN_NEGATION =
  "(?:was|is|has|have|had|does|do|did|were|are|wo|ca|could|would|should|ai)\\s?n\\s?t|cannot|can\\s+not|not|never|nvr|nothing|nobody|no\\s+one|dint|dnt|havnt|hvnt";
/** Words that may sit between the negation and the verb. */
const EN_BETWEEN =
  "i|we|it|they|he|she|you|u|this|that|these|those|my|our|your|the|a|an|any|order|orders|parcel|parcels|package|packages|item|items|product|products|shipment|delivery|courier|stuff|thing|things|has|have|had|is|was|were|are|be|been|being|will|would|even|yet|still|ever|really|actually|already|properly";
const EN_ARRIVAL =
  "get|gets|got|gotten|getting|rec(?:ei|ie)v(?:e|es|ed|ing)|arriv(?:e|es|ed|ing)|come|comes|came|coming|deliver(?:s|ed|ing)?|ship(?:s|ped|ping)?|dispatch(?:es|ed)?|reach(?:es|ed|ing)?|show(?:s|n|ed)?\\s+up|turn(?:s|ed)?\\s+up|work(?:s|ed|ing)?";

const HINGLISH_NEGATION = "nahi|nahin|nahee|nhi|nai";
const HINGLISH_BETWEEN = "hi|bhi|abhi|tak|tk|ab|to|toh|tho|yet|still";
const HINGLISH_ARRIVAL =
  "mil(?:a|i|e|aa)|aa?y(?:a|aa|i|e)|aai|p(?:a|o)h(?:u|o)?n?ch(?:a|i|e)|deliver\\w*|rec(?:ei|ie)v\\w*";
/** Not straight after "samajh (me)": that is "I didn't understand". */
const HINGLISH_NOT_UNDERSTAND =
  "(?<!\\bs(?:a)?m(?:a)?jh?(?:\\s+(?:me|mein|mai|main|m))?\\s+)";

const HINDI_NEGATION = "नहीं|नहीँ|नही";
const HINDI_BETWEEN = "ही|भी|अभी|तक|अब|तो";
const HINDI_ARRIVAL =
  "मिला|मिली|मिले|आया|आयी|आई|आए|आये|पहुंचा|पहुँचा|पहुंची|पहुँची|पहुंचे|पहुँचे|डिलीवर\\S*|डिलिवर\\S*|रिसीव\\S*";
/** Not straight after "समझ (में)": that is "I didn't understand". */
const HINDI_NOT_UNDERSTAND = "(?<!समझ(?:\\s+में)?\\s+)";
/** Devanagari has no `\b`: a word starts and ends where letters do. */
const WORD_START = "(?<![\\p{L}\\p{M}])";
const WORD_END = "(?![\\p{L}\\p{M}])";

const NEGATED_ARRIVAL: readonly RegExp[] = [
  new RegExp(
    `\\b(?:${EN_NEGATION})(?:\\s+(?:${EN_BETWEEN})\\b){0,3}\\s+(?:${EN_ARRIVAL})\\b`,
    "i",
  ),
  // Hinglish, verb first ("mila nahi", "aaya hi nahi") ...
  new RegExp(
    `\\b(?:${HINGLISH_ARRIVAL})(?:\\s+(?:${HINGLISH_BETWEEN})\\b){0,3}\\s+(?:${HINGLISH_NEGATION})\\b`,
    "i",
  ),
  // ... and negation first ("nahi mila", "abhi tak nahi aaya").
  new RegExp(
    `${HINGLISH_NOT_UNDERSTAND}\\b(?:${HINGLISH_NEGATION})\\s+(?:${HINGLISH_ARRIVAL})\\b`,
    "i",
  ),
  // Hindi, verb first ("आया नहीं", "पहुँचा ही नहीं") ...
  new RegExp(
    `${WORD_START}(?:${HINDI_ARRIVAL})(?:\\s+(?:${HINDI_BETWEEN})${WORD_END}){0,3}\\s+(?:${HINDI_NEGATION})${WORD_END}`,
    "u",
  ),
  // ... and negation first ("नहीं मिला", "अभी तक नहीं आया").
  new RegExp(
    `${HINDI_NOT_UNDERSTAND}${WORD_START}(?:${HINDI_NEGATION})\\s+(?:${HINDI_ARRIVAL})${WORD_END}`,
    "u",
  ),
];

function isComplaint(said: string): boolean {
  return COMPLAINT.test(said) || NEGATED_ARRIVAL.some((re) => re.test(said));
}

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

/** Every apostrophe a keyboard types: straight, curly (both), the modifier
 *  letter, a backtick, an acute accent, a prime, the full-width one. The
 *  same set inbox-intent.ts closes up. */
const APOSTROPHES = "'‘’ʼ`´′＇";
const NT_CONTRACTION = new RegExp(`n[${APOSTROPHES}]t\\b`, "gi");
/** The apostrophe typed one letter early: "did'nt", "is'nt", "have'nt". */
const NT_MISPLACED = new RegExp(`([a-z])[${APOSTROPHES}]nt\\b`, "gi");
/** Danda, double danda, abbreviation sign: Devanagari's full stops. */
const DEVANAGARI_STOPS = /[।॥॰]/g;

/**
 * The message as the patterns read it. "N'T" BECOMES PART OF ITS WORD, with
 * any apostrophe ("wasn't", "wasn’t", "was'nt" and "wasnt" are all
 * `wasnt`), and A DANDA IS A FULL STOP, so a pattern never joins two Hindi
 * sentences ("पार्सल मिला। नहीं, …" is "got it. No, …", not "didn't get it").
 */
function normalise(body: string): string {
  return body
    .normalize("NFC")
    .replace(NT_CONTRACTION, "nt")
    .replace(NT_MISPLACED, "$1nt")
    .replace(DEVANAGARI_STOPS, ". ");
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
  const said = normalise(body);
  if (PAYMENT.test(said)) return { ok: false, reason: "payment" };
  if (isComplaint(said)) return { ok: false, reason: "complaint" };
  if (RETURN_WORD.test(said) && RETURN_REQUEST.test(said)) {
    return { ok: false, reason: "complaint" };
  }
  if (ORDER_CHANGE.test(said)) return { ok: false, reason: "order_change" };
  if (PERSON.test(said)) return { ok: false, reason: "person" };
  if (isPleasantry(words(said))) return { ok: false, reason: "greeting" };
  return { ok: true };
}
