import "server-only";
import { getFirebaseAdminAuth } from "./firebase-admin";
import type { ServerUser } from "./server-user";

/**
 * Is this signed-in user's email verified NOW?
 *
 * ★★ THE SESSION COOKIE'S `email_verified` IS A SNAPSHOT from when the cookie
 * was minted. Accepting the signup email code marks the ACCOUNT RECORD
 * verified at once (signup-email-otp.ts), but the cookie only learns it when
 * the browser re-mints the session with a fresh ID token, and the browser is
 * not always able to: a reloaded tab, storage the browser will not keep, or a
 * lost reply can each leave it without its Firebase user. Trusting the claim
 * alone then turned a code that had ALREADY worked into a loop: "Send a code"
 * mailed a new one for an address the record said was verified, and the
 * store step refused because the cookie said it was not.
 *
 * So a false claim is checked against the record. That costs one Admin read,
 * and only for a session minted before verification, which in practice means
 * a signup in progress. A record that cannot be read answers false: the claim's
 * own answer, so an outage never verifies anyone.
 */
export async function emailVerifiedNow(
  user: Pick<ServerUser, "id" | "emailConfirmed">,
): Promise<boolean> {
  if (user.emailConfirmed) return true;
  const auth = getFirebaseAdminAuth();
  if (!auth) return false;
  try {
    return (await auth.getUser(user.id)).emailVerified === true;
  } catch {
    return false;
  }
}
