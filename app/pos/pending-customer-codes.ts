import type { ConfirmationResult } from "firebase/auth";

/**
 * Counter-side memory for the customer phone check, kept OUTSIDE the dialog.
 *
 * ★ The dialog is mounted only while it is open, so anything held in its refs
 * died with a mis-tapped Close: reopening inside the send guard's cooldown
 * could neither text the customer again nor accept the code already on their
 * phone. Module scope, like lib/auth/phone-send-guard.ts, and for the same
 * reason not localStorage: a till is shared, and a number must not outlive the
 * page on it.
 *
 * ★ Keyed by purpose AND order, because the server's proof is bound to both: a
 * code sent for a pickup must never resume a return.
 */

export type PendingCustomerCode = {
  /** The E.164 number the code went to. Resume only when it still matches. */
  phone: string;
  maskedPhone: string;
  confirmation: ConfirmationResult;
  /** When Firebase accepted the send (epoch ms). */
  sentAt: number;
};

const pendingCodes = new Map<string, PendingCustomerCode>();
const sendsInFlight = new Map<string, Promise<void>>();

/** How long a reopened dialog waits for a send started by its closed copy. */
export const EARLIER_SEND_WAIT_MS = 20_000;

export function pendingCodeKey(orderId: string, purpose: string): string {
  return `${purpose}:${orderId}`;
}

/**
 * The code this order can still confirm with, but only if it is the send the
 * guard's cooldown is counting from. An older code for the same number (a
 * visit for another order has texted it since) is not the one on the phone.
 */
export function resumablePendingCode(
  key: string,
  phone: string,
  cooldownStartedAt: number,
): PendingCustomerCode | undefined {
  const live = pendingCodes.get(key);
  return live && live.phone === phone && live.sentAt >= cooldownStartedAt
    ? live
    : undefined;
}

export function rememberPendingCode(
  key: string,
  code: PendingCustomerCode,
): void {
  pendingCodes.set(key, code);
}

/** The code was used (a confirm succeeded), so it can never confirm again. */
export function forgetPendingCode(
  key: string,
  confirmation: ConfirmationResult,
): void {
  if (pendingCodes.get(key)?.confirmation === confirmation) {
    pendingCodes.delete(key);
  }
}

/**
 * Mark a send as in the air until the returned function is called. Call it
 * AFTER the guard has been told how the send ended, so whoever was waiting
 * reads the outcome rather than racing it.
 */
export function trackSend(key: string): () => void {
  let release!: () => void;
  const landed = new Promise<void>((resolve) => (release = resolve));
  sendsInFlight.set(key, landed);
  return () => {
    if (sendsInFlight.get(key) === landed) sendsInFlight.delete(key);
    release();
  };
}

/**
 * Wait for a send another copy of the dialog started for this order.
 *
 * ★ Bounded: that copy's reCAPTCHA was rendered inside the dialog it was
 * closed with, and a verifier whose element left the page can wait for a
 * token for ever. A send that never settles must not make every later attempt
 * for the order wait too, so it is dropped once the bound passes.
 */
export async function waitForEarlierSend(
  key: string,
  timeoutMs: number = EARLIER_SEND_WAIT_MS,
): Promise<void> {
  const earlier = sendsInFlight.get(key);
  if (!earlier) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    earlier.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (timedOut && sendsInFlight.get(key) === earlier) {
    sendsInFlight.delete(key);
  }
}

/** Tests only: forget every pending code and in-flight send. */
export function resetPendingCustomerCodes(): void {
  pendingCodes.clear();
  sendsInFlight.clear();
}
