"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Image from "next/image";
import {
  signInWithPhoneNumber,
  type ConfirmationResult,
  type RecaptchaVerifier,
} from "firebase/auth";
import {
  getFirebaseAuth,
  establishSession,
  firebaseAuthErrorCode,
  firebaseAuthErrorMessage,
} from "@/lib/auth/firebase-client";
import { freshInvisibleVerifier } from "@/lib/auth/recaptcha";
import {
  PHONE_SEND_COOLDOWN_MS,
  checkPhoneSend,
  phoneSendErrorMessage,
  recordPhoneSend,
  recordPhoneSendFailure,
  type PhoneSendCheck,
} from "@/lib/auth/phone-send-guard";
import {
  updateCustomerProfile,
  getMyCustomer,
} from "@/app/actions/customer-profile";
import { useAuth } from "./AuthProvider";
import { useBrand } from "@/app/(storefront)/components/brand-provider";
import {
  PolicyConsent,
  usePolicyLinks,
} from "@/app/(storefront)/components/policy-consent";
import styles from "./AuthModal.module.css";
import PhoneInput from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { customPhoneLabels } from "@/lib/phone-labels";
import { CountrySelect } from "@/components/ui/phone-country-select";
import { MAX_VERIFY_ATTEMPTS, useOtpThrottle } from "@/lib/use-otp-throttle";

type Step = "phone" | "otp" | "profile";

const OTP_LENGTH = 6;
const RESEND_COOLDOWN = 30;

/**
 * The code most recently texted by this sign-in, and the number it went to.
 *
 * ★ MODULE SCOPE, NOT A REF: AuthModalLoader unmounts this component when the
 * modal closes, so a ref would forget a code that is still on the shopper's
 * phone, and reopening inside the send guard's cooldown would leave them with
 * nothing to type it into. `failedVerifies` travels with the code so a resumed
 * code keeps its wrong-attempt count (Back/Edit reset the throttle hook).
 */
type PendingCode = {
  phone: string;
  confirmation: ConfirmationResult;
  sentAt: number;
  /** When the send STARTED, from `lastSendSeq`. */
  seq: number;
  failedVerifies: number;
};
let pendingCode: PendingCode | null = null;
let lastSendSeq = 0;

/**
 * ★ A send started before another never replaces that one's code. The
 * in-flight ref is per modal, so a send left hanging in a closed modal can land
 * after the reopened modal has texted a corrected number.
 */
function keepPendingCode(code: PendingCode) {
  if (!pendingCode || pendingCode.seq < code.seq) pendingCode = code;
}

/**
 * Whether a refused send can go back to the code step instead: the cooldown
 * was started by OUR last send to this number (no other flow has texted it
 * since, so ours is the newest code) and that code is not locked out.
 */
function resumableCode(number: string, check: PhoneSendCheck) {
  if (check.ok || check.reason !== "cooldown") return null;
  const pending = pendingCode;
  if (!pending || pending.phone !== number) return null;
  if (pending.sentAt < check.retryAt - PHONE_SEND_COOLDOWN_MS) return null;
  if (pending.failedVerifies >= MAX_VERIFY_ATTEMPTS) return null;
  return pending;
}

function secondsUntil(at: number): number {
  return Math.max(1, Math.ceil((at - Date.now()) / 1000));
}

export default function AuthModal() {
  const { isAuthModalOpen, closeAuthModal, refreshCustomer } = useAuth();
  const brand = useBrand();

  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState<string | undefined>("");
  const [otp, setOtp] = useState<string[]>(Array(OTP_LENGTH).fill(""));
  // Consent to the STORE's own policies. The box only appears when the store
  // has published some — see PolicyConsent for why naming an unreadable
  // policy would be worse than naming none.
  const { links: policyLinks, required: policyRequired } =
    usePolicyLinks("all");
  const [policyAgreed, setPolicyAgreed] = useState(false);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resendTimer, setResendTimer] = useState(0);

  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);
  const phoneInputRef = useRef<HTMLInputElement | null>(null);

  // Firebase phone auth: an invisible reCAPTCHA (required by Identity Platform).
  // The ConfirmationResult it produces lives in `pendingCode` (module scope).
  const recaptchaRef = useRef<HTMLDivElement | null>(null);
  const verifierRef = useRef<RecaptchaVerifier | null>(null);
  // ★ The code the OTP step is showing, which is what a typed code is checked
  // against. `pendingCode` can move on underneath it when a closed modal's
  // late send lands, and the screen must not then verify another number.
  const shownCodeRef = useRef<PendingCode | null>(null);
  // ★ Set synchronously before any await: the phone field's Enter handler
  // bypasses the disabled Continue button, so key-repeat or a second Enter
  // would otherwise start a second Firebase send while the first is in flight.
  const sendingRef = useRef(false);

  /**
   * A FRESH reCAPTCHA verifier for every send attempt, in a fresh element.
   *
   * ★ The element matters as much as the verifier. An invisible widget stays in
   * the element it rendered into, so creating the next verifier on the same
   * element made every Continue or Resend after a first failure end in
   * "Something went wrong" without reaching Firebase (lib/auth/recaptcha.ts).
   */
  const getVerifier = useCallback((): RecaptchaVerifier => {
    verifierRef.current = freshInvisibleVerifier(
      getFirebaseAuth(),
      recaptchaRef.current!,
      verifierRef.current,
    );
    return verifierRef.current;
  }, []);

  // Client-side caps on wrong-code submissions and resends (see hook).
  const {
    verifyBlocked,
    resendBlocked,
    registerFailedVerify,
    registerResend,
    reset: resetOtpThrottle,
  } = useOtpThrottle();

  // Reset state when modal closes
  useEffect(() => {
    if (!isAuthModalOpen) {
      // Small delay so the close animation finishes
      const t = setTimeout(() => {
        setStep("phone");
        setPhone("");
        setOtp(Array(OTP_LENGTH).fill(""));
        setFirstName("");
        setLastName("");
        setEmail("");
        setError("");
        setLoading(false);
        setResendTimer(0);
        resetOtpThrottle();
        // Tear down the reCAPTCHA so the next open starts clean (the verifier is
        // bound to the DOM container and can't be reused once solved). The
        // pending code is kept: reopening for the same number inside the send
        // cooldown resumes it rather than texting another.
        verifierRef.current?.clear();
        verifierRef.current = null;
      }, 400);
      return () => clearTimeout(t);
    }
  }, [isAuthModalOpen, resetOtpThrottle]);

  // Focus phone input on open
  useEffect(() => {
    if (isAuthModalOpen && step === "phone") {
      setTimeout(() => phoneInputRef.current?.focus(), 400);
    }
  }, [isAuthModalOpen, step]);

  // Resend timer countdown
  useEffect(() => {
    if (resendTimer <= 0) return;
    const interval = setInterval(() => {
      setResendTimer((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [resendTimer]);

  // Lock body scroll when modal is open
  useEffect(() => {
    if (isAuthModalOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isAuthModalOpen]);

  const fullPhone = phone || "";

  // A send the guard refused, for a number whose code we can still use: show
  // the code step instead of an error, with Resend held until the guard
  // would allow it. From the phone step the throttle hook was reset (Back,
  // Edit or a remount), so the code's wrong attempts are counted back in.
  const resumeCode = (pending: PendingCode, retryAt: number) => {
    shownCodeRef.current = pending;
    setError("");
    setResendTimer((t) => Math.max(t, secondsUntil(retryAt)));
    if (step === "otp") return;
    setStep("otp");
    for (let i = 0; i < pending.failedVerifies; i++) registerFailedVerify();
    setTimeout(() => otpRefs.current[0]?.focus(), 100);
  };

  // ---- Step 1: Send OTP ----
  const handleSendOtp = async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      if (!phone || phone.length < 10) {
        setError("Please enter a valid phone number.");
        return;
      }

      const number = fullPhone;
      // ★ Ask the shared guard BEFORE reCAPTCHA or Firebase: a refused request
      // still extends Firebase's block on this number (lib/auth/phone-send-guard).
      const check = checkPhoneSend(number);
      if (!check.ok) {
        const pending = resumableCode(number, check);
        if (pending) resumeCode(pending, check.retryAt);
        else setError(check.message);
        return;
      }

      setError("");
      setLoading(true);
      const seq = ++lastSendSeq;

      try {
        // Identity Platform sends the SMS after solving the invisible reCAPTCHA;
        // the returned ConfirmationResult carries the code verifier.
        const confirmation = await signInWithPhoneNumber(
          getFirebaseAuth(),
          number,
          getVerifier(),
        );
        const sentAt = Date.now();
        recordPhoneSend(number, sentAt);
        const code = {
          phone: number,
          confirmation,
          sentAt,
          seq,
          failedVerifies: 0,
        };
        keepPendingCode(code);
        shownCodeRef.current = code;

        setStep("otp");
        setResendTimer(RESEND_COOLDOWN);
        setLoading(false);

        // Focus first OTP input
        setTimeout(() => otpRefs.current[0]?.focus(), 100);
      } catch (err) {
        console.warn("Sign-in code not sent:", firebaseAuthErrorCode(err));
        recordPhoneSendFailure(number, err);
        setError(phoneSendErrorMessage(number, err));
        setLoading(false);
      }
    } finally {
      sendingRef.current = false;
    }
  };

  // ---- Resend OTP ----
  const handleResendOtp = async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      if (resendBlocked) {
        setError("Too many code requests. Please try again later.");
        return;
      }

      const number = fullPhone;
      const check = checkPhoneSend(number);
      if (!check.ok) {
        const pending = resumableCode(number, check);
        if (pending) resumeCode(pending, check.retryAt);
        else setError(check.message);
        return;
      }

      setError("");
      setLoading(true);
      const seq = ++lastSendSeq;

      try {
        const confirmation = await signInWithPhoneNumber(
          getFirebaseAuth(),
          number,
          getVerifier(),
        );
        const sentAt = Date.now();
        recordPhoneSend(number, sentAt);
        const code = {
          phone: number,
          confirmation,
          sentAt,
          seq,
          failedVerifies: 0,
        };
        keepPendingCode(code);
        shownCodeRef.current = code;
        registerResend();
        setResendTimer(RESEND_COOLDOWN);
        setOtp(Array(OTP_LENGTH).fill(""));
        setTimeout(() => otpRefs.current[0]?.focus(), 100);
      } catch (err) {
        console.warn("Sign-in code not resent:", firebaseAuthErrorCode(err));
        recordPhoneSendFailure(number, err);
        setError(phoneSendErrorMessage(number, err) || "Failed to resend OTP.");
      }
      setLoading(false);
    } finally {
      sendingRef.current = false;
    }
  };

  // ---- Step 2: Verify OTP ----
  const handleVerifyOtp = useCallback(
    async (otpValue: string) => {
      if (verifyBlocked) return;
      const pending = shownCodeRef.current;
      if (!pending) {
        setError("Please request a code first.");
        return;
      }
      setError("");
      setLoading(true);

      try {
        // Confirm the code (signs the user in on the client), then exchange the
        // fresh ID token for the httpOnly server session cookie so the server
        // actions below resolve identity.
        await pending.confirmation.confirm(otpValue);
        // The code is spent: never resume it on a later open.
        if (pendingCode === pending) pendingCode = null;
        const sessErr = await establishSession();
        if (sessErr) {
          setError(sessErr);
          setLoading(false);
          return;
        }

        // Check if a customer profile exists for this (now-authenticated) user.
        const existingCustomer = await getMyCustomer();
        if (existingCustomer) {
          // Returning user — done!
          await refreshCustomer();
          setLoading(false);
          closeAuthModal();
        } else {
          // New user — show profile completion
          setStep("profile");
          setLoading(false);
        }
      } catch (err) {
        registerFailedVerify();
        pending.failedVerifies += 1;
        setError(
          firebaseAuthErrorMessage(err) ||
            "Verification failed. Please try again.",
        );
        setLoading(false);
      }
    },
    [refreshCustomer, closeAuthModal, verifyBlocked, registerFailedVerify],
  );

  // ---- OTP input handlers ----
  const handleOtpChange = (index: number, value: string) => {
    // Only allow digits
    const digit = value.replace(/\D/g, "").slice(-1);
    const newOtp = [...otp];
    newOtp[index] = digit;
    setOtp(newOtp);

    if (digit && index < OTP_LENGTH - 1) {
      otpRefs.current[index + 1]?.focus();
    }

    // Auto-verify when all digits filled
    const fullOtp = newOtp.join("");
    if (fullOtp.length === OTP_LENGTH) {
      handleVerifyOtp(fullOtp);
    }
  };

  const handleOtpKeyDown = (
    index: number,
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "");
    if (pasted.length === OTP_LENGTH) {
      const newOtp = pasted.split("");
      setOtp(newOtp);
      handleVerifyOtp(pasted);
    }
  };

  // ---- Step 3: Save profile ----
  const handleSaveProfile = async () => {
    if (!firstName.trim()) {
      setError("First name is required.");
      return;
    }
    // The real record is written server-side in upsertCustomerProfile; this
    // just stops someone submitting without having been asked.
    if (policyRequired && !policyAgreed) {
      setError("Please accept the store policies to continue.");
      return;
    }

    setError("");
    setLoading(true);

    try {
      const formData = new FormData();
      formData.set("firstName", firstName);
      formData.set("lastName", lastName);
      formData.set("email", email);

      const result = await updateCustomerProfile(formData);

      if (result.error) {
        setError(result.error);
        setLoading(false);
        return;
      }

      await refreshCustomer();
      setLoading(false);
      closeAuthModal();
    } catch {
      setError("Failed to save profile. Please try again.");
      setLoading(false);
    }
  };

  // ---- Render steps ----
  const renderPhoneStep = () => (
    <div className={styles.step} key="phone">
      <h2 className={styles.title}>Welcome to {brand.name}</h2>
      <p className={styles.subtitle}>
        Enter your mobile number to sign in or create an account
      </p>

      <div className={styles.phoneRow}>
        <PhoneInput
          defaultCountry="IN"
          countrySelectComponent={CountrySelect}
          labels={customPhoneLabels}
          value={phone}
          onChange={setPhone}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) =>
            e.key === "Enter" && handleSendOtp()
          }
          className="flex-1 flex gap-2 [&>.PhoneInputCountry]:h-[48px] [&>.PhoneInputCountry]:rounded-xl [&>.PhoneInputCountry]:border [&>.PhoneInputCountry]:border-gray-300 [&>.PhoneInputCountry]:bg-[#f9f9f9] [&>.PhoneInputCountry]:p-0"
          numberInputProps={{
            ref: phoneInputRef,
            className: styles.phoneInput,
            autoComplete: "tel-national",
            id: "auth-phone-input",
            "aria-label": "Mobile number",
          }}
        />
      </div>

      <button
        className={styles.primaryBtn}
        onClick={handleSendOtp}
        disabled={loading || !phone || phone.length < 10}
        id="auth-send-otp-btn"
      >
        {loading ? (
          <>
            <span className={styles.spinner} />
            Sending OTP…
          </>
        ) : (
          "Continue"
        )}
      </button>

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );

  const renderOtpStep = () => (
    <div className={styles.step} key="otp">
      <button
        className={styles.backBtn}
        onClick={() => {
          setStep("phone");
          setOtp(Array(OTP_LENGTH).fill(""));
          setError("");
          resetOtpThrottle();
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back
      </button>

      <h2 className={styles.title}>Verify your number</h2>
      <p className={styles.phoneDisplay}>
        OTP sent to <span className={styles.phoneNumber}>{fullPhone}</span>
        <button
          className={styles.editPhone}
          onClick={() => {
            setStep("phone");
            setOtp(Array(OTP_LENGTH).fill(""));
            setError("");
            resetOtpThrottle();
          }}
        >
          Edit
        </button>
      </p>

      <div className={styles.otpGrid} onPaste={handleOtpPaste}>
        {otp.map((digit, i) => (
          <input
            key={i}
            ref={(el) => {
              otpRefs.current[i] = el;
            }}
            className={styles.otpInput}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={digit}
            placeholder="·"
            disabled={verifyBlocked}
            onChange={(e) => handleOtpChange(i, e.target.value)}
            onKeyDown={(e) => handleOtpKeyDown(i, e)}
            id={`auth-otp-input-${i}`}
          />
        ))}
      </div>

      {loading && (
        <div style={{ textAlign: "center", marginBottom: 12 }}>
          <span
            className={styles.spinner}
            style={{
              borderTopColor: "#1a1a1a",
              borderColor: "rgba(26,26,26,0.15)",
            }}
          />
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {verifyBlocked && !resendBlocked && (
        <p className={styles.error}>
          Too many incorrect attempts. Request a new code to try again.
        </p>
      )}

      <div className={styles.secondaryAction}>
        {resendBlocked ? (
          <span>Too many code requests. Please try again later.</span>
        ) : resendTimer > 0 ? (
          <span>Resend OTP in {resendTimer}s</span>
        ) : (
          <button
            className={styles.resendBtn}
            onClick={handleResendOtp}
            disabled={loading}
          >
            Resend OTP
          </button>
        )}
      </div>
    </div>
  );

  const renderProfileStep = () => (
    <div className={styles.step} key="profile">
      <div className={styles.successCheck}>
        <div className={styles.checkCircle}>
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
      </div>

      <h2 className={styles.title}>Almost there</h2>
      <p className={styles.subtitle}>Complete your profile to get started</p>

      <div className={styles.inputGroup}>
        <label className={styles.label} htmlFor="auth-first-name">
          First name<span className={styles.requiredDot}>*</span>
        </label>
        <input
          id="auth-first-name"
          className={styles.textInput}
          type="text"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          autoFocus
          autoComplete="given-name"
        />
      </div>

      <div className={styles.inputGroup}>
        <label className={styles.label} htmlFor="auth-last-name">
          Last name (optional)
        </label>
        <input
          id="auth-last-name"
          className={styles.textInput}
          type="text"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          autoComplete="family-name"
        />
      </div>

      <div className={styles.inputGroup}>
        <label className={styles.label} htmlFor="auth-email">
          Email (optional)
        </label>
        <input
          id="auth-email"
          className={styles.textInput}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
      </div>

      <PolicyConsent
        links={policyLinks}
        checked={policyAgreed}
        onChange={setPolicyAgreed}
        className={styles.policyConsent}
      />

      <button
        className={styles.primaryBtn}
        onClick={handleSaveProfile}
        disabled={
          loading || !firstName.trim() || (policyRequired && !policyAgreed)
        }
        id="auth-save-profile-btn"
      >
        {loading ? (
          <>
            <span className={styles.spinner} />
            Saving…
          </>
        ) : (
          "Get Started"
        )}
      </button>

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );

  return (
    <div
      className={`${styles.overlay} ${isAuthModalOpen ? styles.overlayVisible : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeAuthModal();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`Sign in to ${brand.name}`}
      data-sm="account-dialog"
    >
      <div className={styles.modal}>
        <button
          className={styles.closeBtn}
          onClick={closeAuthModal}
          aria-label="Close"
          id="auth-modal-close-btn"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className={styles.content}>
          <div className={styles.branding}>
            {brand.logoUrl ? (
              <Image
                src={brand.logoUrl}
                alt={brand.name}
                width={120}
                height={44}
                className={styles.brandLogo}
                priority
              />
            ) : (
              <span className={styles.brandLogo}>{brand.name}</span>
            )}
          </div>

          <div className={styles.stepContainer}>
            {step === "phone" && renderPhoneStep()}
            {step === "otp" && renderOtpStep()}
            {step === "profile" && renderProfileStep()}
          </div>
        </div>

        {/* Anchor for the invisible reCAPTCHA that Identity Platform runs
            before sending the phone OTP. Never displays anything in invisible
            mode. */}
        <div ref={recaptchaRef} />
      </div>
    </div>
  );
}
