// ---------------------------------------------------------------------------
// What did a WhatsApp message MEAN — STOP, START, or an ordinary message?
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
// ---------------------------------------------------------------------------

export type WhatsAppInboundIntent = "stop" | "start" | "other";

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
  if (words.length === 0 || words.length > 3) return "other";
  const phrase = words.join(" ");
  if (STOP_PHRASES.has(phrase)) return "stop";
  if (START_PHRASES.has(phrase)) return "start";
  return "other";
}
