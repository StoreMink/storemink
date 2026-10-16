// ---------------------------------------------------------------------------
// The link that opens a chat with a store's WhatsApp number — client-safe, so
// the Channels card can draw the QR from the same string the storefront's
// chat button links to.
//
// `wa.me/<digits>` is Meta's own click-to-chat scheme: digits only, country
// code first, no plus. `?text=` prefills the first message, which is what
// turns "a number" into "a conversation that starts itself" — and, because
// the customer sends it, it opens the 24-hour service window.
// ---------------------------------------------------------------------------

/** Digits only, country code first. Null when there is no number to link. */
export function whatsAppDigits(
  displayPhone: string | null | undefined,
): string {
  return (displayPhone ?? "").replace(/\D/g, "");
}

export function whatsAppChatLink(
  displayPhone: string | null | undefined,
  storeName?: string | null,
): string | null {
  const digits = whatsAppDigits(displayPhone);
  if (digits.length < 8) return null;
  const greeting = storeName?.trim()
    ? `Hi ${storeName.trim()}, I have a question.`
    : "Hi, I have a question.";
  return `https://wa.me/${digits}?text=${encodeURIComponent(greeting)}`;
}
