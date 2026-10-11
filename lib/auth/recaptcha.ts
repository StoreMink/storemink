import { RecaptchaVerifier, type Auth } from "firebase/auth";

/**
 * A new invisible reCAPTCHA verifier for one phone-code send, rendered into a
 * NEW element inside `host`. Pass the verifier the previous send used so it is
 * cleared first.
 *
 * ★★ NEVER CREATE A SECOND VERIFIER ON THE SAME ELEMENT. An invisible verifier
 * renders straight into the element it is given, and `clear()` removes the
 * widget only for a VISIBLE one (@firebase/auth RecaptchaVerifier.clear), so a
 * new verifier on that element makes reCAPTCHA throw "reCAPTCHA has already
 * been rendered in this element". That error carries no Firebase code: the
 * storefront sign-in, the POS customer check and the shared phone hook showed
 * "Something went wrong" on every retry after a first failed send, and no
 * retry ever reached Firebase. Reproduced in Chrome (2026-10-10) with the send
 * answered by production's INVALID_APP_CREDENTIAL.
 *
 * ★ Reusing ONE verifier also works, because the SDK resets it after every
 * send (the enquiries form, set-password and POS staff registration do that).
 * A fresh one per send is kept here so a widget left in a bad state is never
 * carried into the next attempt.
 */
export function freshInvisibleVerifier(
  auth: Auth,
  host: HTMLElement,
  previous: RecaptchaVerifier | null,
): RecaptchaVerifier {
  try {
    previous?.clear();
  } catch {
    // Already cleared: nothing left to tear down.
  }
  const slot = document.createElement("div");
  host.replaceChildren(slot);
  return new RecaptchaVerifier(auth, slot, { size: "invisible" });
}
