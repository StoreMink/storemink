import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  getAdditionalUserInfo,
  signInWithPhoneNumber,
  type ConfirmationResult,
  type RecaptchaVerifier,
  type User,
} from "firebase/auth";
import {
  formatPhoneNumberIntl,
  isValidPhoneNumber,
} from "react-phone-number-input";
import { confirmVerifiedPhone } from "@/app/actions/account-settings";
import {
  firebaseAuthErrorCode,
  firebaseAuthErrorMessage,
  getSecondaryFirebaseAuth,
} from "@/lib/auth/firebase-client";
import {
  checkPhoneSend,
  phoneSendErrorMessage,
  recordPhoneSend,
  recordPhoneSendFailure,
} from "@/lib/auth/phone-send-guard";
import { freshInvisibleVerifier } from "@/lib/auth/recaptcha";
import { LOCAL_DEV_ROOT } from "@/lib/store/host";
import { useOtpThrottle } from "@/lib/use-otp-throttle";

export const PHONE_CODE_LENGTH = 6;
const RESEND_SECONDS = 30;

export interface PhoneVerification {
  step: "number" | "code";
  phone: string | undefined;
  setPhone: (next: string | undefined) => void;
  /** The number as people read it ("+91 98765 43210"). */
  shownNumber: string;
  code: string;
  /** Feed every change of the code field here; six digits submit themselves. */
  onCodeChange: (value: string) => void;
  sending: boolean;
  verifying: boolean;
  error: string;
  /** Firebase accepted the code but saving failed; retrying reuses the proof. */
  canRetrySave: boolean;
  resendIn: number;
  resendBlocked: boolean;
  verifyBlocked: boolean;
  /** On localhost only: this page on the loopback root Firebase will text. */
  localhostHint: string | null;
  sendCode: (resend?: boolean) => Promise<void>;
  retrySave: () => void;
  changeNumber: () => void;
}

/**
 * The two elements the flow needs, owned by the rendering component so the
 * hook's result stays a plain value: an invisible reCAPTCHA anchor
 * (`<div ref={recaptcha} />`) and the code field, focused once a code is sent.
 */
export interface PhoneVerificationRefs {
  recaptcha: RefObject<HTMLDivElement | null>;
  codeInput: RefObject<HTMLInputElement | null>;
}

/**
 * Prove a mobile number with a texted code and save it, verified, to the
 * signed-in admin's profile. The LOGIC only: Account settings and the go-live
 * checklist render it in dashboard style (`VerifyPhoneForm`), signup in its
 * own calm style, and the rules below cannot differ between them.
 *
 * ★★ THE CODE IS CHECKED ON A SEPARATE, IN-MEMORY FIREBASE APP
 * (`getSecondaryFirebaseAuth`), NEVER BY LINKING THE NUMBER TO THE ADMIN'S
 * LOGIN. Shoppers sign in to StoreMink storefronts by phone in the same
 * Firebase project, so linking refused any merchant whose mobile had ever
 * been used to shop there. Here the sign-in is only a way to deliver the code:
 * the server (`confirmVerifiedPhone`) checks the resulting proof and records
 * the number, and the admin's own session is never touched. The POS counter
 * verifies customers the same way (app/pos/customer-phone-verification.tsx).
 *
 * ★ Every send is checked against `lib/auth/phone-send-guard.ts` first, so
 * Change number, a remount or a repeated tap cannot drive the number into
 * Firebase's undisclosed "too many requests" block.
 */
export function usePhoneVerification(
  onVerified: (phone: string) => void,
  refs: PhoneVerificationRefs,
): PhoneVerification {
  const [phone, setPhoneState] = useState<string | undefined>("");
  const [step, setStep] = useState<"number" | "code">("number");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [canRetrySave, setCanRetrySave] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [localhostHint, setLocalhostHint] = useState<string | null>(null);

  const { recaptcha: recaptchaRef, codeInput: codeInputRef } = refs;
  const verifier = useRef<RecaptchaVerifier | null>(null);
  const confirmation = useRef<ConfirmationResult | null>(null);
  /** The number `confirmation` was texted to: a live code is only resumed for it. */
  const confirmationPhone = useRef<string | null>(null);
  // ★ Synchronous, unlike `sending`: Enter, key-repeat and a double tap all
  // reach sendCode before React re-renders a disabled button.
  const sendInFlight = useRef(false);
  const proof = useRef<string | null>(null);
  const temporaryUser = useRef<User | null>(null);
  const createdAuthUser = useRef(false);
  const throttle = useOtpThrottle();

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setInterval(() => setResendIn((n) => n - 1), 1000);
    return () => clearInterval(timer);
  }, [resendIn]);

  // Firebase refuses to text REAL numbers from a `localhost` page (since July
  // 2024). The same server answers on the loopback dev root, which it accepts.
  useEffect(() => {
    const { hostname, port, pathname, search } = window.location;
    if (hostname !== "localhost" && !hostname.endsWith(".localhost")) return;
    const host = hostname.replace(/localhost$/, LOCAL_DEV_ROOT);
    setLocalhostHint(
      `http://${host}${port ? `:${port}` : ""}${pathname}${search}`,
    );
  }, []);

  useEffect(
    () => () => {
      verifier.current?.clear();
      if (temporaryUser.current) {
        void temporaryUser.current.delete().catch(() => undefined);
      }
      void getSecondaryFirebaseAuth()
        .signOut()
        .catch(() => undefined);
    },
    [],
  );

  const getVerifier = useCallback(() => {
    // A fresh verifier per send, in a fresh element: a second one on the same
    // element failed every resend (lib/auth/recaptcha.ts).
    verifier.current = freshInvisibleVerifier(
      getSecondaryFirebaseAuth(),
      recaptchaRef.current!,
      verifier.current,
    );
    return verifier.current;
  }, [recaptchaRef]);

  const clearTemporarySession = useCallback(async () => {
    const user = temporaryUser.current;
    temporaryUser.current = null;
    createdAuthUser.current = false;
    proof.current = null;
    setCanRetrySave(false);
    if (user) await user.delete().catch(() => undefined);
    await getSecondaryFirebaseAuth()
      .signOut()
      .catch(() => undefined);
  }, []);

  function setPhone(next: string | undefined) {
    setPhoneState(next);
    setError("");
  }

  async function sendCode(resend = false) {
    if (sendInFlight.current) return;
    sendInFlight.current = true;
    try {
      await sendCodeNow(resend);
    } finally {
      sendInFlight.current = false;
    }
  }

  async function sendCodeNow(resend: boolean) {
    if (!phone || !isValidPhoneNumber(phone)) {
      setError("Enter a valid mobile number, including the country code.");
      return;
    }
    if (resend && throttle.resendBlocked) {
      setError("Too many codes requested. Please try again later.");
      return;
    }
    const number = phone;
    // ★ Before the reCAPTCHA verifier and Firebase: a refused tap must not
    // reach Firebase, where it extends the block (lib/auth/phone-send-guard.ts).
    const check = checkPhoneSend(number);
    if (!check.ok) {
      if (
        check.reason === "cooldown" &&
        confirmation.current &&
        confirmationPhone.current &&
        sameNumber(confirmationPhone.current, number)
      ) {
        // The code already on their phone still works: back to it, no send.
        setError("");
        setStep("code");
        setResendIn(
          Math.max(1, Math.ceil((check.retryAt - Date.now()) / 1000)),
        );
        setTimeout(() => codeInputRef.current?.focus(), 50);
        return;
      }
      setError(check.message);
      return;
    }
    setSending(true);
    setError("");
    try {
      await clearTemporarySession();
      const result = await signInWithPhoneNumber(
        getSecondaryFirebaseAuth(),
        number,
        getVerifier(),
      );
      recordPhoneSend(number);
      confirmation.current = result;
      confirmationPhone.current = number;
      // A fresh code starts a clean wrong-code tally. Done here rather than
      // in changeNumber, so returning to a live code keeps its tally.
      if (resend) throttle.registerResend();
      else throttle.reset();
      setCode("");
      setStep("code");
      setResendIn(RESEND_SECONDS);
      setTimeout(() => codeInputRef.current?.focus(), 50);
    } catch (err) {
      console.warn("Mobile code not sent:", firebaseAuthErrorCode(err));
      recordPhoneSendFailure(number, err);
      setError(
        phoneSendErrorMessage(number, err) ||
          "Couldn't send the code. Please try again.",
      );
    } finally {
      setSending(false);
    }
  }

  async function verify(value: string) {
    if (verifying || throttle.verifyBlocked) return;
    if (!confirmation.current && !proof.current) {
      setError("Request a new code and try again.");
      return;
    }
    setVerifying(true);
    setError("");
    try {
      if (!proof.current) {
        try {
          const credential = await confirmation.current!.confirm(value);
          createdAuthUser.current =
            getAdditionalUserInfo(credential)?.isNewUser === true;
          temporaryUser.current = createdAuthUser.current
            ? credential.user
            : null;
          proof.current = await credential.user.getIdToken();
          // A confirmed code is spent: never resume the code step for it.
          confirmation.current = null;
          confirmationPhone.current = null;
        } catch (err) {
          throttle.registerFailedVerify();
          setError(
            firebaseAuthErrorMessage(err) ||
              "That code isn't right. Please check and try again.",
          );
          setCode("");
          setTimeout(() => codeInputRef.current?.focus(), 50);
          return;
        }
      }

      const idToken = proof.current;
      if (!idToken) {
        setError("Request a new code and try again.");
        return;
      }
      let saved: Awaited<ReturnType<typeof confirmVerifiedPhone>>;
      try {
        saved = await confirmVerifiedPhone({
          idToken,
          cleanupCreatedAuthUser: createdAuthUser.current,
        });
      } catch {
        setCanRetrySave(true);
        setError("We couldn't reach StoreMink. Check your connection.");
        return;
      }
      if (!saved.phone) {
        setCanRetrySave(true);
        setError(saved.error ?? "Couldn't save your number. Please try again.");
        return;
      }
      await clearTemporarySession();
      onVerified(saved.phone);
    } finally {
      setVerifying(false);
    }
  }

  function onCodeChange(value: string) {
    const next = value.replace(/\D/g, "").slice(0, PHONE_CODE_LENGTH);
    setCode(next);
    setError("");
    if (next.length === PHONE_CODE_LENGTH) void verify(next);
  }

  function changeNumber() {
    void clearTemporarySession();
    // ★ The live confirmation (and its number) is kept: going back to the
    // same number inside the send cooldown resumes the code step rather than
    // texting again. A successful send to another number replaces it.
    setStep("number");
    setCode("");
    setError("");
    setResendIn(0);
  }

  return {
    step,
    phone,
    setPhone,
    shownNumber: phone ? formatPhoneNumberIntl(phone) || phone : "",
    code,
    onCodeChange,
    sending,
    verifying,
    error,
    canRetrySave,
    resendIn,
    resendBlocked: throttle.resendBlocked,
    verifyBlocked: throttle.verifyBlocked,
    localhostHint,
    sendCode,
    retrySave: () => void verify(code),
    changeNumber,
  };
}

function sameNumber(a: string, b: string): boolean {
  return a.replace(/[^\d+]/g, "") === b.replace(/[^\d+]/g, "");
}
