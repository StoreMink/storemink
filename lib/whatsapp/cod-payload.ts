// ---------------------------------------------------------------------------
// The payloads a COD confirmation's two quick-reply buttons carry.
//
// Pure and client-safe. Written at enqueue (record.ts), sent with the template
// (worker.ts → send.ts → graph.ts), and read back off the inbound tap
// (inbox.ts). One module, so the three cannot disagree about the shape.
//
// ★ THE PAYLOAD NAMES THE ORDER; IT AUTHORISES NOTHING. Anyone holding the
// text could send it back, so what a tap may do is decided in
// cod-confirmation.ts by the store it arrived for, the order's payment method
// and the tapping phone. This module only refuses anything it did not write,
// so a stray button press or free text never reaches the order table.
// ---------------------------------------------------------------------------

export const COD_ACTIONS = ["confirm", "cancel"] as const;
export type CodAction = (typeof COD_ACTIONS)[number];

export interface CodPayload {
  action: CodAction;
  /** The order's uuid, lower-cased so it matches the stored value. */
  orderId: string;
}

// The prefix and action exactly as written; the uuid in either case, because a
// uuid's hex digits mean the same thing upper or lower.
const PAYLOAD =
  /^cod:(confirm|cancel):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** Long enough for any payload this module writes, and no longer. */
const MAX_LENGTH = 64;

/**
 * The two payloads, in the template's button order: Confirm, then Cancel.
 * ★ The order matters: Meta matches a payload to a button by index, so a
 * swapped pair would turn "Confirm order" into a cancellation.
 */
export function codButtonPayloads(orderId: string): string[] {
  const id = orderId.toLowerCase();
  return COD_ACTIONS.map((action) => `cod:${action}:${id}`);
}

/** A tap's payload, or null when it is not one this module wrote. */
export function parseCodPayload(value: unknown): CodPayload | null {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return null;
  const match = PAYLOAD.exec(value);
  if (!match) return null;
  return { action: match[1] as CodAction, orderId: match[2].toLowerCase() };
}

/**
 * The order a queued row's buttons are about, or null for a row without COD
 * buttons. Reads the stored jsonb as it comes back, so anything that is not an
 * array of our payloads answers null.
 */
export function codOrderFromPayloads(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const parsed = parseCodPayload(entry);
    if (parsed) return parsed.orderId;
  }
  return null;
}
