// ---------------------------------------------------------------------------
// The reply ids a store's menu buttons carry.
//
// Pure and client-safe, the cod-payload.ts shape: written when the menu is
// sent (answer-automatically.ts → send.ts → graph.ts) and read back off the
// customer's tap (inbox.ts), from one module so the two cannot disagree.
//
// ★ THE ID NAMES A BUTTON; IT AUTHORISES NOTHING. Anyone holding the text
// could send it back, and a merchant may have changed their menu since the
// message went out, so what a tap DOES is decided in menu-reply.ts from the
// store's CURRENT settings. This module only refuses anything it did not
// write, so a stray reply id from some other interactive message never reads
// as a menu choice.
// ---------------------------------------------------------------------------

/** The settings form generates these: short, lower-case, unique per store. */
export const MENU_BUTTON_ID = /^[a-z0-9_]{1,32}$/;

const PAYLOAD = /^menu:([a-z0-9_]{1,32})$/;

/** Long enough for any id this module writes, and no longer. */
const MAX_LENGTH = 40;

/** The reply id a menu button is sent with. */
export function menuButtonPayload(buttonId: string): string {
  return `menu:${buttonId}`;
}

/** The button a tap names, or null when it is not one this module wrote. */
export function parseMenuPayload(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return null;
  const match = PAYLOAD.exec(value);
  return match ? match[1] : null;
}
