import { firebaseAuthErrorMessage } from "@/lib/auth/firebase-client";

/**
 * The client-side rules every phone-code flow applies BEFORE asking Firebase to
 * text a code: the storefront sign-in, the enquiries form, the POS customer
 * check, POS staff registration, set-password, and the shared
 * `usePhoneVerification` hook (dashboard + signup).
 *
 * ★★ WHY THIS EXISTS: FIREBASE'S BLOCK IS SILENT, LONG, AND WE COULD EXTEND IT.
 * Identity Platform answers a burst of `sendVerificationCode` requests for one
 * number or device with `TOO_MANY_ATTEMPTS_TRY_LATER` ("We have blocked all
 * requests from this device due to unusual activity") and states no duration;
 * in practice it lasts tens of minutes to hours. Every request refused during
 * the block still counts as more unusual activity. Before this module, nothing
 * in the app slowed anyone down: Edit/Back/closing the modal reset the resend
 * counter, the FIRST send of each round was never counted at all, pressing
 * Enter could start a second send while one was in flight, and after Firebase
 * said "too many" every further click went straight back to Firebase. A real
 * shopper with a slow SMS could lock their own number out of sign-in for an
 * hour while the screen told them to "wait a moment". (Found on production,
 * 2026-10-10: echoss checkout sign-in.) In production each send can also cost
 * TWO backend requests, because phone reCAPTCHA Enterprise is in AUDIT mode
 * and the SDK falls back to reCAPTCHA v2 when the Enterprise verdict fails.
 *
 * ★ NOT A SECURITY BOUNDARY. It lives in the browser and resets on reload. It
 * stops honest people and the app itself from driving a number into Firebase's
 * block; Firebase's own limits and the server actions remain the boundary.
 *
 * ★ MODULE SCOPE, NOT COMPONENT STATE, so it survives what used to reset it: a
 * closed modal, an Edit/Back to the number step, a remounted form. Deliberately
 * NOT localStorage: a POS till is a shared device, and customers' numbers must
 * not outlive the page on it.
 *
 * ★ KEYED BY NUMBER. Firebase's per-number limit is the one people hit, and a
 * till verifying several customers must not stop serving the next customer
 * because one number was refused.
 */

/** Minimum gap between two codes to the same number. Slightly under the 30s
 * resend timer every flow shows, so a Resend button that has just appeared is
 * never refused by this rule on a timer that ticked a little early. */
export const PHONE_SEND_COOLDOWN_MS = 25_000;
/** Codes per number per rolling window. Firebase documents 10/hour per number;
 * staying well under it means our message shows instead of Firebase's block. */
export const PHONE_SEND_LIMIT = 5;
export const PHONE_SEND_WINDOW_MS = 60 * 60_000;
/** How long to stop asking Firebase after it answered "too many requests". */
export const PHONE_SEND_LOCKOUT_MS = 30 * 60_000;

type Ledger = { sends: number[]; lockedUntil: number };
const ledgers = new Map<string, Ledger>();

/** One key per number however it was typed ("+91 98765 43210" = "+919876543210"). */
function keyFor(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

function ledgerFor(phone: string, now: number): Ledger {
  const key = keyFor(phone);
  let ledger = ledgers.get(key);
  if (!ledger) {
    ledger = { sends: [], lockedUntil: 0 };
    ledgers.set(key, ledger);
  }
  ledger.sends = ledger.sends.filter((t) => now - t < PHONE_SEND_WINDOW_MS);
  return ledger;
}

export type PhoneSendCheck =
  | { ok: true }
  | {
      ok: false;
      /** `cooldown`: a code went out moments ago (a live code may still be
       * usable — a flow holding one should return to its code step instead of
       * showing this). `limit`: our hourly budget. `locked`: Firebase refused. */
      reason: "cooldown" | "limit" | "locked";
      /** Epoch ms when a send for this number is allowed again. */
      retryAt: number;
      message: string;
    };

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** May a code be sent to `phone` now? Call immediately before the Firebase call. */
export function checkPhoneSend(
  phone: string,
  now: number = Date.now(),
): PhoneSendCheck {
  const ledger = ledgerFor(phone, now);
  let blocked: PhoneSendCheck = { ok: true };
  if (ledger.lockedUntil > now) {
    blocked = {
      ok: false,
      reason: "locked",
      retryAt: ledger.lockedUntil,
      message: `Too many codes have been requested for this number. For your security, please try again after ${clockTime(ledger.lockedUntil)}.`,
    };
  } else if (ledger.sends.length >= PHONE_SEND_LIMIT) {
    const retryAt = ledger.sends[0] + PHONE_SEND_WINDOW_MS;
    blocked = {
      ok: false,
      reason: "limit",
      retryAt,
      message: `Too many codes have been requested for this number. Please try again after ${clockTime(retryAt)}.`,
    };
  }
  // ★ THE COOLDOWN IS REPORTED FIRST, even when the hourly limit or a lockout
  // also applies. "cooldown" is what tells a flow that the code it is holding
  // is still the latest one and can be resumed; checking the limit first left
  // the person who had just received their 5th code of the hour stranded on an
  // error after Back/Edit, with nowhere to type it. `retryAt` keeps its
  // cooldown meaning (last send + cooldown), because flows derive the send time
  // from it; the message is the limit's or lockout's when one applies, so a
  // flow with no code to resume still shows the honest time.
  const last = ledger.sends[ledger.sends.length - 1];
  if (last !== undefined && now - last < PHONE_SEND_COOLDOWN_MS) {
    const retryAt = last + PHONE_SEND_COOLDOWN_MS;
    const seconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
    return {
      ok: false,
      reason: "cooldown",
      retryAt,
      message: blocked.ok
        ? `A code was just sent to this number. You can request another in ${seconds}s.`
        : blocked.message,
    };
  }
  return blocked;
}

/** A code was sent to `phone` (Firebase accepted the request). */
export function recordPhoneSend(phone: string, now: number = Date.now()): void {
  ledgerFor(phone, now).sends.push(now);
}

/** Firebase's "slow down" answer to a send, and only that. */
export function isTooManyRequests(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === "auth/too-many-requests"
  );
}

/**
 * A send failed. When Firebase said "too many requests", stop sending to that
 * number for `PHONE_SEND_LOCKOUT_MS`, so further taps don't land on Firebase
 * and extend its block. Any other failure changes nothing: a failed send sent
 * no SMS, so it must not use up the person's budget.
 */
export function recordPhoneSendFailure(
  phone: string,
  err: unknown,
  now: number = Date.now(),
): void {
  if (!isTooManyRequests(err)) return;
  const ledger = ledgerFor(phone, now);
  ledger.lockedUntil = Math.max(
    ledger.lockedUntil,
    now + PHONE_SEND_LOCKOUT_MS,
  );
}

/**
 * The sentence to show when SENDING a code failed. Differs from the shared
 * mapper only for "too many requests", where "wait a moment" was wrong: the
 * block Firebase applies lasts far longer than a moment, and naming a time is
 * the only thing that stops someone tapping Continue until it gets longer.
 * Call `recordPhoneSendFailure` first so the time quoted is the lockout's.
 */
export function phoneSendErrorMessage(
  phone: string,
  err: unknown,
  now: number = Date.now(),
): string {
  if (isTooManyRequests(err)) {
    const check = checkPhoneSend(phone, now);
    if (!check.ok) return check.message;
    return "Too many codes have been requested for this number. For your security, please wait a while and try again.";
  }
  return firebaseAuthErrorMessage(err);
}

/** Tests only: forget every number. */
export function resetPhoneSendGuard(): void {
  ledgers.clear();
}
