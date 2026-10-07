"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  PhoneAuthProvider,
  RecaptchaVerifier,
  updatePhoneNumber,
} from "firebase/auth";
import {
  getFirebaseAuth,
  establishSession,
  endSession,
  firebaseAuthErrorMessage,
  phoneLinkErrorMessage,
} from "@/lib/auth/firebase-client";
import {
  checkStoreSlugAvailability,
  createStore,
  getSignupResumeInfo,
  type SlugCheck,
} from "@/app/actions/store-signup";
import {
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
  Loader2,
  Eye,
  EyeOff,
  Lock,
  RotateCcw,
} from "lucide-react";
import {
  DEFAULT_THEME_ID,
  canPreviewTheme,
  isThemeSelectable,
  themeCategoriesFor,
  type ThemeIndustry,
} from "@/lib/themes/meta";
import { COUNTRIES, DEFAULT_COUNTRY } from "@/lib/countries";
import PhoneInput, {
  isValidPhoneNumber,
  parsePhoneNumber,
} from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { customPhoneLabels } from "@/lib/phone-labels";
import { CountrySelect } from "@/components/ui/phone-country-select";
import { useSignupThemeCatalog } from "./theme-catalog-context";
import { acceptPlatformPolicies } from "@/app/actions/legal-actions";
import { signupRequiredDocs } from "@/lib/legal/documents";
import {
  requestSignupEmailOtp,
  verifySignupEmailOtp,
} from "@/app/actions/signup-email-otp";

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "storemink.com";
const LOCAL_DEV_ROOT = process.env.NEXT_PUBLIC_LOCAL_DEV_ROOT ?? "localtest.me";

/** The local root this page is being served from, if any — `localhost` or
 *  the loopback dev root (lib/store/host.ts → LOCAL_DEV_ROOT). Store hosts
 *  are `{slug}.<root>:<port>` in both cases. */
function localDevRoot(hostname: string): string | null {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return "localhost";
  }
  if (hostname === LOCAL_DEV_ROOT || hostname.endsWith(`.${LOCAL_DEV_ROOT}`)) {
    return LOCAL_DEV_ROOT;
  }
  return null;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Steps in flow order. "password" and "email-code" are ONE screen (the code
// field appears under the password once the account exists); "store" asks for
// the owner's name and the store name together. Six screens, down from nine:
// the business address moved to the dashboard's go-live checklist, where it is
// first needed (it prints on invoices, and a new store has none yet).
type Step =
  | "email"
  | "password"
  | "email-code"
  | "phone"
  | "store"
  | "theme"
  | "creating";

// Progress stages shown in the stepper (Account folds email+password+code).
const STAGES = ["Account", "Phone", "Store", "Theme"] as const;
function stageOf(step: Step): number {
  switch (step) {
    case "email":
    case "password":
    case "email-code":
      return 0;
    case "phone":
      return 1;
    case "store":
      return 2;
    default:
      return 3; // theme / creating
  }
}

type CheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; result: SlugCheck };

function demoUrl(demoSlug: string): string {
  const { hostname, protocol, port } = window.location;
  const root = localDevRoot(hostname);
  return root
    ? `${protocol}//${demoSlug}.${root}${port ? ":" + port : ""}`
    : `https://${demoSlug}.${ROOT_DOMAIN}`;
}

function dashboardUrl(slug: string): string {
  const { hostname, protocol, port } = window.location;
  const root = localDevRoot(hostname);
  return root
    ? `${protocol}//${slug}.${root}${port ? ":" + port : ""}/dashboard`
    : `https://${slug}.${ROOT_DOMAIN}/dashboard`;
}

// The documents the consent box covers, straight from the registry — the same
// list the server writes acceptance rows for. Adding one to lib/legal/documents
// changes the sentence, the acceptance write and the re-acceptance gate
// together, which is the only way they can't drift apart.
const CONSENT_DOCS = signupRequiredDocs();
/** "the Terms of Service, Privacy Policy and Acceptable Use Policy" */
const CONSENT_DOC_NAMES = CONSENT_DOCS.map((d, i) =>
  i === 0
    ? `the ${d.title}`
    : `${i === CONSENT_DOCS.length - 1 ? " and " : ", "}${d.title}`,
).join("");

export default function SignupPage() {
  const themeCatalog = useSignupThemeCatalog();
  const themeCategories = themeCategoriesFor(themeCatalog);
  const defaultThemeId =
    themeCatalog.find(
      (theme) => theme.id === DEFAULT_THEME_ID && isThemeSelectable(theme),
    )?.id ??
    themeCatalog.find(isThemeSelectable)?.id ??
    DEFAULT_THEME_ID;
  // Firebase phone linking: invisible reCAPTCHA + the verificationId from
  // PhoneAuthProvider, held across the send → verify steps.
  const recaptchaRef = useRef<HTMLDivElement | null>(null);
  const verifierRef = useRef<RecaptchaVerifier | null>(null);
  const verificationIdRef = useRef<string | null>(null);

  const getVerifier = useCallback((): RecaptchaVerifier => {
    if (!verifierRef.current) {
      verifierRef.current = new RecaptchaVerifier(
        getFirebaseAuth(),
        recaptchaRef.current!,
        { size: "invisible" },
      );
    }
    return verifierRef.current;
  }, []);

  const [step, setStepRaw] = useState<Step>("email");
  // Firebase's Auth service stopped accepting verifyPhoneNumber from the
  // hostname `localhost` for REAL numbers in July 2024 (firebase-js-sdk#8387).
  // The error it returns, auth/invalid-app-credential, says nothing about
  // that, so the phone step says it instead — only on localhost, where it is
  // true — and names the loopback dev root that Firebase does accept
  // (lib/store/host.ts → LOCAL_DEV_ROOT).
  const [onLocalhost, setOnLocalhost] = useState(false);
  const [devPort, setDevPort] = useState("");
  useEffect(() => {
    const h = window.location.hostname;
    setOnLocalhost(h === "localhost" || h.endsWith(".localhost"));
    setDevPort(window.location.port);
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recoveryRequired, setRecoveryRequired] = useState(false);

  // ★★ AN ERROR BELONGS TO THE STEP THAT RAISED IT.
  //
  // There is ONE `error` state and ONE banner, rendered above whichever step is
  // showing — so any transition that forgets to clear it carries the last
  // step's failure onto the next one, where it describes nothing. Two of the
  // fourteen transitions forgot: `resumeWizard` (which jumps straight to
  // phone/name from the session cookie) and the theme step's Continue.
  //
  // Clearing at each call site is what produced the bug; the fifteenth site
  // would have forgotten too. Going through here makes it structural — a step
  // change cannot leave a stale error behind. Where an error must SURVIVE a
  // transition (nothing does today), set it after the call.
  const setStep = useCallback((next: Step) => {
    setError("");
    setRecoveryRequired(false);
    setStepRaw(next);
  }, []);

  // Account
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [emailCode, setEmailCode] = useState("");
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [operatorLogOnly, setOperatorLogOnly] = useState(false);
  const [devConsoleOnly, setDevConsoleOnly] = useState(false);

  // Phone
  const [phone, setPhone] = useState<string | undefined>("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneSent, setPhoneSent] = useState(false);

  // You
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  // Store. The country defaults from the verified phone's dial code (see
  // handleVerifyPhoneOtp) and stays editable; the full address is collected
  // later on the dashboard, where the go-live checklist requires it.
  const [name, setName] = useState("");
  const [country, setCountry] = useState(DEFAULT_COUNTRY);
  // Consent. `agreed` gates BOTH signup paths (email and Google) because both
  // start from the same screen; `marketing` is the optional box beneath it and
  // gates nothing.
  const [agreed, setAgreed] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [check, setCheck] = useState<CheckState>({ status: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seq = useRef(0);

  // Theme
  const [template, setTemplate] = useState<string>(defaultThemeId);
  const [themeFilter, setThemeFilter] = useState<ThemeIndustry | "all">("all");

  async function restartSignup() {
    setBusy(true);
    setError("");
    setRecoveryRequired(false);
    await endSession();
    window.location.assign("/signup");
  }

  // Place the wizard at the right step for the current session: an account that
  // already owns a store goes to its dashboard; one with a session but no store
  // jumps to phone (or name, if phone is already verified). Used both on mount
  // (refreshed tab) and right after Google sign-in. Returns true if a session
  // was found.
  const resumeWizard = useCallback(async (): Promise<boolean> => {
    const info = await getSignupResumeInfo();
    if (!info.authenticated) return false;
    if (info.hasStore && info.slug) {
      window.location.href = dashboardUrl(info.slug);
      return true;
    }
    if (info.email) setEmail(info.email);
    if (info.firstName) setFirstName(info.firstName);
    if (info.lastName) setLastName(info.lastName);
    setStep(
      !info.emailConfirmed
        ? "email-code"
        : info.phoneConfirmed
          ? "store"
          : "phone",
    );
    return true;
  }, [setStep]);

  // On mount: resume a refreshed tab from the existing session cookie.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    void resumeWizard();
  }, [resumeWizard]);

  // ── Slug availability (store step) ───────────────────────────────────────
  function onNameChange(value: string) {
    setName(value);
    if (timer.current) clearTimeout(timer.current);
    if (!value.trim()) {
      setCheck({ status: "idle" });
      return;
    }
    setCheck({ status: "checking" });
    const mySeq = ++seq.current;
    timer.current = setTimeout(async () => {
      const result = await checkStoreSlugAvailability(value);
      if (mySeq === seq.current) setCheck({ status: "done", result });
    }, 400);
  }
  const isNameAvailable = check.status === "done" && check.result.available;
  const currentSlug =
    check.status === "done"
      ? check.result.slug
      : name.trim()
        ? name.trim().toLowerCase().replace(/\s+/g, "-")
        : "your-store";
  function slugHint() {
    if (check.status === "idle")
      return { cls: "neutral", text: `your-store.${ROOT_DOMAIN}` };
    if (check.status === "checking")
      return { cls: "neutral", text: "Checking availability…" };
    const r = check.result;
    return r.available
      ? { cls: "ok", text: `${r.slug}.${ROOT_DOMAIN} is available ✓` }
      : { cls: "bad", text: r.reason ?? "Not available" };
  }

  // ── Account ──────────────────────────────────────────────────────────────
  function continueFromEmail() {
    if (!EMAIL_RE.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    // Checked here as well as via the disabled button: `disabled` is a UI
    // affordance, and this is the only client-side gate before an account is
    // created. (The real guarantee is the server-side acceptance write.)
    if (!agreed) {
      setError(`Please accept ${CONSENT_DOC_NAMES} to continue.`);
      return;
    }
    setError("");
    setStep("password");
  }

  async function handleGoogle() {
    if (!agreed) {
      setError(`Please accept ${CONSENT_DOC_NAMES} to continue.`);
      return;
    }
    setGoogleLoading(true);
    setError("");
    try {
      // signInWithPopup keeps everything client-side (no OAuth callback route);
      // establish the session cookie, then resume the wizard at the right step.
      await signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider());
      const sessErr = await establishSession();
      if (sessErr) {
        setGoogleLoading(false);
        setError(sessErr);
        return;
      }
      // The account now exists and a session cookie is set, so the server can
      // observe who is consenting. Before this point there is no identity to
      // attach it to.
      await acceptPlatformPolicies({ marketingOptIn: marketing });
      await resumeWizard();
      setGoogleLoading(false);
    } catch (err) {
      setGoogleLoading(false);
      setError(firebaseAuthErrorMessage(err));
    }
  }

  async function handleCreateAccount() {
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    setError("");
    const auth = getFirebaseAuth();
    try {
      await createUserWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      // The email may already have an account — try signing in with the same
      // credentials to recover a returning owner and resume at the phone step.
      if ((err as { code?: string })?.code === "auth/email-already-in-use") {
        try {
          await signInWithEmailAndPassword(auth, email.trim(), password);
        } catch {
          setBusy(false);
          setError(
            "An account with this email already exists. Log in, or use a different email.",
          );
          return;
        }
      } else {
        setBusy(false);
        setError(firebaseAuthErrorMessage(err));
        return;
      }
    }
    // Exchange the fresh ID token for the session cookie the server reads.
    const sessErr = await establishSession();
    if (sessErr) {
      setBusy(false);
      setError(sessErr);
      return;
    }
    // Same as the Google path: consent is recorded server-side the moment
    // there is an identity to attach it to.
    await acceptPlatformPolicies({ marketingOptIn: marketing });
    const otp = await requestSignupEmailOtp();
    setBusy(false);
    if (otp.alreadyVerified) {
      setStep("phone");
      return;
    }
    setEmailCodeSent(otp.ok);
    setOperatorLogOnly(otp.operatorLogOnly === true);
    setDevConsoleOnly(otp.devConsoleOnly === true);
    setStep("email-code");
    if (otp.error) setError(otp.error);
  }

  async function handleSendEmailOtp() {
    setBusy(true);
    setError("");
    const result = await requestSignupEmailOtp();
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "We couldn't send a verification code.");
      return;
    }
    if (result.alreadyVerified) {
      setStep("phone");
      return;
    }
    setEmailCodeSent(true);
    setOperatorLogOnly(result.operatorLogOnly === true);
    setDevConsoleOnly(result.devConsoleOnly === true);
  }

  async function handleVerifyEmailOtp() {
    setBusy(true);
    setError("");
    setRecoveryRequired(false);
    const result = await verifySignupEmailOtp(emailCode);
    if (!result.ok) {
      if (result.staleSession) {
        // A deleted Firebase user can leave a signature-valid 14-day server
        // cookie behind. Re-exchange the browser's current user; the session
        // route also evicts any legacy host-only cookie shadowing the fresh
        // shared-domain cookie. The old OTP was UID-bound, so issue a new one.
        const sessionError = await establishSession(true);
        if (sessionError) {
          setBusy(false);
          setRecoveryRequired(true);
          setError(
            "Your session expired. Start again with this email, or log in if you already finished creating the account.",
          );
          return;
        }
        const otp = await requestSignupEmailOtp();
        setBusy(false);
        if (!otp.ok) {
          setError(otp.error ?? "We couldn't send a new verification code.");
          return;
        }
        if (otp.alreadyVerified) {
          setStep("phone");
          return;
        }
        setEmailCode("");
        setEmailCodeSent(true);
        setOperatorLogOnly(otp.operatorLogOnly === true);
        setDevConsoleOnly(otp.devConsoleOnly === true);
        setError("Your session was refreshed. Enter the new code we sent.");
        return;
      }
      setBusy(false);
      setError(result.error ?? "That code couldn't be verified.");
      return;
    }

    // The Admin SDK changed the server record. Reload the browser user, then
    // mint a session cookie carrying the new email_verified claim.
    try {
      await getFirebaseAuth().currentUser?.reload();
      const sessionError = await establishSession(true);
      if (sessionError) {
        setBusy(false);
        setError(sessionError);
        return;
      }
    } catch {
      setBusy(false);
      setError(
        "Email verified, but the session couldn't refresh. Please reload.",
      );
      return;
    }
    setBusy(false);
    setStep("phone");
  }

  // ── Phone ────────────────────────────────────────────────────────────────
  async function handleSendPhoneOtp() {
    if (!phone || !isValidPhoneNumber(phone)) {
      setError("Enter a valid phone number.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const provider = new PhoneAuthProvider(getFirebaseAuth());
      verificationIdRef.current = await provider.verifyPhoneNumber(
        phone,
        getVerifier(),
      );
      setPhoneSent(true);
    } catch (err) {
      // The merchant-facing sentence deliberately hides the provider's code;
      // the console keeps it, because "the security check didn't complete"
      // covers three different Firebase failures with three different fixes.
      console.error("signup: phone verification failed", err);
      setError(phoneLinkErrorMessage(err));
    }
    setBusy(false);
  }

  async function handleVerifyPhoneOtp() {
    if (!phone || !verificationIdRef.current) return;
    setBusy(true);
    setError("");
    try {
      const credential = PhoneAuthProvider.credential(
        verificationIdRef.current,
        phoneCode.trim(),
      );
      const user = getFirebaseAuth().currentUser;
      if (!user) throw new Error("Not signed in.");
      await updatePhoneNumber(user, credential);
      // Re-mint the session cookie so it carries the verified phone —
      // createStore enforces phone_confirmed server-side.
      await establishSession(true);
      // The country they sell from is almost always the country of the phone
      // they just verified. A default, not a lock: the store step shows it.
      const dial = parsePhoneNumber(phone)?.country;
      if (dial && COUNTRIES.some((c) => c.code === dial)) setCountry(dial);
      setBusy(false);
      setStep("store");
    } catch (err) {
      setBusy(false);
      setError(phoneLinkErrorMessage(err));
    }
  }

  // ── Finalize ───────────────────────────────────────────────────────────────
  // Signup never asks for money. Every store starts on Free, reaches a working
  // dashboard immediately, and can authorise a paid subscription later from
  // Plans & Billing where payment recovery has a dedicated surface.
  async function finalize() {
    setBusy(true);
    setError("");
    setStep("creating");

    const res = await createStore({
      name,
      template,
      firstName,
      lastName,
      country,
    });
    if (res.error || !res.storeId || !res.slug) {
      setError(res.error ?? "Could not create your store.");
      setBusy(false);
      setStep("theme");
      return;
    }
    window.location.href = dashboardUrl(res.slug);
  }

  const h = slugHint();
  const stage = stageOf(step);

  // Which steps show a Back control (and where it goes).
  const BACK: Partial<Record<Step, Step>> = {
    password: "email",
    theme: "store",
  };

  const width = step === "theme" ? "max-w-5xl" : "max-w-md";

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Invisible reCAPTCHA anchor for Identity Platform phone verification. */}
      <div ref={recaptchaRef} />
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <Link
          href="/"
          className="font-bold text-xl text-gray-900 tracking-tight flex items-center"
        >
          Store<span className="text-primary">Mink</span>
        </Link>
        <div className="flex items-center gap-4 text-sm font-medium">
          {step !== "email" && step !== "password" && step !== "creating" && (
            <button
              type="button"
              onClick={restartSignup}
              disabled={busy}
              className="inline-flex items-center gap-1.5 text-gray-500 hover:text-gray-900 disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Start over
            </button>
          )}
          <p className="text-gray-500">
            {/* The question is decoration on a phone: with Start over beside
                it the header runs out of width at 375px. The link is the
                part that matters. */}
            <span className="hidden sm:inline">Already selling? </span>
            <Link
              href="/platform/login"
              className="text-primary hover:underline"
            >
              Log in
            </Link>
          </p>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center px-4 pt-8 pb-20">
        {/* Progress stepper */}
        {step !== "creating" && (
          <div className="w-full max-w-md mb-8">
            <div className="flex items-center gap-1.5">
              {STAGES.map((label, i) => (
                <div key={label} className="flex-1">
                  <div
                    className={`h-1.5 rounded-full transition-colors ${
                      i <= stage ? "bg-primary" : "bg-gray-200"
                    }`}
                  />
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs font-medium text-gray-500">
              Step {stage + 1} of {STAGES.length} · {STAGES[stage]}
            </p>
          </div>
        )}

        <div className={`w-full ${width}`}>
          {error && (
            <div
              role="alert"
              aria-live="assertive"
              className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700"
            >
              <p>{error}</p>
              {recoveryRequired && (
                <div className="mt-4 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={restartSignup}
                    disabled={busy}
                    className="stq-btn stq-btn-primary inline-flex h-10 items-center gap-2 px-4"
                  >
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4" />
                    )}
                    Start signup again
                  </button>
                  <Link
                    href="/platform/login"
                    className="stq-btn stq-btn-ghost inline-flex h-10 items-center px-4"
                  >
                    Go to login
                  </Link>
                </div>
              )}
            </div>
          )}

          {/* ── Email ─────────────────────────────────────────────── */}
          {step === "email" && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">
                Start your free store
              </h1>
              <p className="text-gray-500 mb-8">
                Enter your email to create your StoreMink account.
              </p>

              <button
                type="button"
                onClick={handleGoogle}
                disabled={googleLoading}
                aria-describedby="signup-consent-help"
                className="w-full h-12 flex items-center justify-center gap-3 rounded-lg border border-gray-300 bg-white font-semibold text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-60"
              >
                {googleLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <GoogleIcon />
                )}
                Continue with Google
              </button>

              <div className="my-6 flex items-center gap-3">
                <div className="h-px flex-1 bg-gray-200" />
                <span className="text-xs font-medium text-gray-400">OR</span>
                <div className="h-px flex-1 bg-gray-200" />
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  continueFromEmail();
                }}
              >
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-semibold text-gray-700">
                    Email address
                  </label>
                  <input
                    type="email"
                    className="stq-input h-12"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoFocus
                    autoComplete="email"
                  />
                </div>
                <button
                  type="submit"
                  aria-describedby="signup-consent-help"
                  className="stq-btn stq-btn-primary w-full h-12 mt-6 flex items-center justify-center gap-2 disabled:opacity-60"
                >
                  Continue <ChevronRight className="w-5 h-5" />
                </button>
              </form>

              {/* Consent remains mandatory for both paths, but an enabled
                  button can explain WHY it cannot continue. A silently greyed
                  Google button looked like an OAuth outage. */}
              <div
                id="signup-consent-help"
                className={`mt-7 flex flex-col gap-3 rounded-xl border p-4 transition-colors ${
                  agreed
                    ? "border-emerald-200 bg-emerald-50/50"
                    : "border-amber-200 bg-amber-50/60"
                }`}
              >
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-indigo-600"
                  />
                  {/* Driven by the REGISTRY, not hardcoded: the same list
                      (signupRequiredDocs) decides what this sentence names,
                      what recordSignupConsent writes a row for, and what the
                      re-acceptance gate checks. Hardcoding it here is how a
                      merchant ends up ticking a box for two documents while
                      the server records three. */}
                  <span className="text-[13px] leading-relaxed text-gray-700">
                    <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-amber-700">
                      Required to create an account
                    </span>
                    I agree to StoreMink&apos;s{" "}
                    {CONSENT_DOCS.map((doc, i) => (
                      <span key={doc.kind}>
                        {i > 0 &&
                          (i === CONSENT_DOCS.length - 1 ? " and " : ", ")}
                        <a
                          href={`/legal/${doc.slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-semibold text-indigo-600 underline"
                        >
                          {doc.title}
                        </a>
                      </span>
                    ))}
                    .
                  </span>
                </label>

                {/* Optional, and visibly so: unticked by default, gating
                    nothing. A pre-ticked marketing box is not consent either. */}
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={marketing}
                    onChange={(e) => setMarketing(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-indigo-600"
                  />
                  <span className="text-[13px] leading-relaxed text-gray-500">
                    Send me product updates and selling tips.{" "}
                    <span className="text-gray-400">(Optional)</span>
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* ── Password + email code — ONE screen ─────────────────
              Continue creates the account and emails the code; the code field
              then appears under the (now fixed) password rather than on a new
              screen. Two steps internally, because the account exists only
              after the first, but one screen to the merchant. */}
          {(step === "password" || step === "email-code") && (
            <div className="animate-in fade-in slide-in-from-right-2 duration-300">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">
                {step === "password" ? "Create a password" : "Check your email"}
              </h1>
              <p className="text-gray-500 mb-8">
                {step === "password" ? (
                  <>
                    Securing the account for{" "}
                    <span className="font-medium text-gray-700">{email}</span>.
                    We&apos;ll email you a six-digit code next.
                  </>
                ) : (
                  <>
                    We sent a six-digit code to{" "}
                    <span className="font-medium text-gray-700">{email}</span>.
                    Enter it below to confirm the address.
                  </>
                )}
              </p>

              {step === "password" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleCreateAccount();
                  }}
                >
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-semibold text-gray-700">
                      Password
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        className="stq-input h-12 pr-11"
                        placeholder="At least 8 characters"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoFocus
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((s) => !s)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        tabIndex={-1}
                        aria-label={
                          showPassword ? "Hide password" : "Show password"
                        }
                      >
                        {showPassword ? (
                          <EyeOff className="w-5 h-5" />
                        ) : (
                          <Eye className="w-5 h-5" />
                        )}
                      </button>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">
                      Use 8 or more characters.
                    </p>
                  </div>

                  <button
                    type="submit"
                    disabled={busy || password.length < 8}
                    className="stq-btn stq-btn-primary w-full h-12 mt-6 flex items-center justify-center gap-2"
                  >
                    {busy ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <>
                        Continue <ChevronRight className="w-5 h-5" />
                      </>
                    )}
                  </button>
                </form>
              )}

              {step === "email-code" && (
                <>
                  {operatorLogOnly && (
                    <div className="mb-5 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-800">
                      This is a reserved test address, so no email was sent. The
                      code is available in Operator dashboard → Email logs.
                    </div>
                  )}

                  {devConsoleOnly && (
                    <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                      Email isn&apos;t configured in this environment, so
                      nothing was sent. The code is printed in your dev server
                      terminal.
                    </div>
                  )}

                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleVerifyEmailOtp();
                    }}
                    className="flex flex-col gap-4"
                  >
                    <div className="flex flex-col gap-1.5">
                      <label className="text-sm font-semibold text-gray-700">
                        Verification code
                      </label>
                      <input
                        type="text"
                        className="stq-input h-12 text-center font-mono text-xl tracking-[0.35em]"
                        placeholder="000000"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        autoFocus
                        value={emailCode}
                        onChange={(event) =>
                          setEmailCode(event.target.value.replace(/\D/g, ""))
                        }
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={busy || emailCode.length !== 6}
                      className="stq-btn stq-btn-primary flex h-12 w-full items-center justify-center gap-2"
                    >
                      {busy ? (
                        <Loader2 className="h-5 w-5 animate-spin" />
                      ) : (
                        <>
                          Verify email <ChevronRight className="h-5 w-5" />
                        </>
                      )}
                    </button>
                  </form>

                  <button
                    type="button"
                    onClick={() => void handleSendEmailOtp()}
                    disabled={busy}
                    className="mt-4 text-sm font-medium text-gray-500 hover:text-primary disabled:opacity-50"
                  >
                    {emailCodeSent ? "Resend code" : "Send verification code"}
                  </button>
                  <p className="mt-2 text-xs text-gray-400">
                    Codes expire after 10 minutes and can only be used in this
                    browser.
                  </p>
                </>
              )}
            </div>
          )}

          {/* ── Phone ─────────────────────────────────────────────── */}
          {step === "phone" && (
            <div className="animate-in fade-in slide-in-from-right-2 duration-300">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">
                Verify your phone
              </h1>
              <p className="text-gray-500 mb-8">
                We&apos;ll text a one-time code to confirm it&apos;s you.
              </p>

              {onLocalhost && (
                <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  You&apos;re on <code>localhost</code>, where Firebase refuses
                  real numbers for phone verification. Open this page on{" "}
                  <a
                    className="font-semibold underline"
                    href={`http://${LOCAL_DEV_ROOT}${devPort ? ":" + devPort : ""}/signup`}
                  >
                    {LOCAL_DEV_ROOT}
                    {devPort ? ":" + devPort : ""}
                  </a>{" "}
                  instead (same server, it resolves to this machine), or use a
                  fictional test number from the Identity Platform console.
                </div>
              )}

              <div className="flex flex-col gap-3">
                <label className="text-sm font-semibold text-gray-700">
                  Mobile number
                </label>
                <div className="flex gap-2">
                  <PhoneInput
                    defaultCountry="IN"
                    countrySelectComponent={CountrySelect}
                    labels={customPhoneLabels}
                    placeholder="Mobile number"
                    value={phone}
                    onChange={setPhone}
                    disabled={phoneSent}
                    numberInputProps={{ autoComplete: "tel-national" }}
                    className="stq-phone"
                  />
                  <button
                    type="button"
                    onClick={handleSendPhoneOtp}
                    disabled={busy || phoneSent || !phone}
                    className="stq-btn stq-btn-primary whitespace-nowrap text-sm px-4"
                  >
                    {phoneSent ? "Sent" : busy ? "…" : "Send OTP"}
                  </button>
                </div>

                {phoneSent && (
                  <div className="flex flex-col gap-2 pt-2 animate-in fade-in slide-in-from-top-2">
                    <label className="text-sm font-semibold text-gray-700">
                      Enter the 6-digit code
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        className="stq-input flex-1 h-12"
                        placeholder="6-digit code"
                        inputMode="numeric"
                        maxLength={6}
                        autoFocus
                        value={phoneCode}
                        onChange={(e) =>
                          setPhoneCode(e.target.value.replace(/\D/g, ""))
                        }
                      />
                      <button
                        type="button"
                        onClick={handleVerifyPhoneOtp}
                        disabled={busy || phoneCode.length < 6}
                        className="stq-btn stq-btn-primary whitespace-nowrap px-5"
                      >
                        {busy ? "…" : "Verify"}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setPhoneSent(false);
                        setPhoneCode("");
                        setError("");
                      }}
                      className="text-xs text-gray-500 hover:text-primary text-left mt-1"
                    >
                      ← Wrong number? Edit and resend
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── You + your store — ONE screen ──────────────────────
              Name and store name were two screens; Google users arrive with
              their name prefilled, so for them this is one field plus the
              address chip. The country is pre-filled from the verified phone.
              The business ADDRESS is deliberately not here: it prints on
              invoices and a new store has none, so the go-live checklist
              collects it where it is first needed. */}
          {step === "store" && (
            <div className="animate-in fade-in slide-in-from-right-2 duration-300">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">
                About you and your store
              </h1>
              <p className="text-gray-500 mb-8">
                You can change the store name later — the address is yours to
                keep.
              </p>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!firstName.trim()) {
                    setError("Enter your first name.");
                    return;
                  }
                  if (!isNameAvailable) {
                    setError("Choose an available store name.");
                    return;
                  }
                  setError("");
                  setStep("theme");
                }}
                className="flex flex-col gap-5"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-semibold text-gray-700">
                      First name
                    </label>
                    <input
                      className="stq-input h-12"
                      placeholder="First name"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      autoFocus={!firstName}
                      autoComplete="given-name"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-semibold text-gray-700">
                      Last name{" "}
                      <span className="font-normal text-gray-400">
                        (optional)
                      </span>
                    </label>
                    <input
                      className="stq-input h-12"
                      placeholder="Last name"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      autoComplete="family-name"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-semibold text-gray-700">
                    Store name
                  </label>
                  <input
                    className="stq-input h-12 text-lg"
                    placeholder="E.g., My Awesome Store"
                    value={name}
                    onChange={(e) => onNameChange(e.target.value)}
                    autoFocus={!!firstName}
                    maxLength={50}
                  />
                  <div className={`stq-hint !mt-1 ${h.cls}`}>{h.text}</div>
                </div>

                {/* Live subdomain chip */}
                <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-500 font-mono">
                  <Lock className="w-3.5 h-3.5 text-emerald-600" />
                  https://{currentSlug}.{ROOT_DOMAIN}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="business-country"
                    className="text-sm font-semibold text-gray-700"
                  >
                    Country you sell from
                  </label>
                  <select
                    id="business-country"
                    className="stq-input h-12 bg-white"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    autoComplete="country"
                  >
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-400">
                    Your full business address is added from the dashboard
                    before your store opens.
                  </p>
                </div>

                <div className="mt-1 flex items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50/80 p-3 shadow-sm">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-indigo-100 bg-white text-xl shadow-sm">
                    🎉
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-indigo-900">
                      Free lifetime domain
                    </h4>
                    <p className="mt-0.5 text-xs font-medium text-indigo-700">
                      Your .storemink.com address is free forever.
                    </p>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={!isNameAvailable || !firstName.trim()}
                  className="stq-btn stq-btn-primary w-full h-12 flex items-center justify-center gap-2"
                >
                  Continue <ChevronRight className="w-5 h-5" />
                </button>
              </form>
            </div>
          )}

          {/* ── Theme ─────────────────────────────────────────────── */}
          {step === "theme" && (
            <div className="animate-in fade-in slide-in-from-right-2 duration-300">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">
                Pick a starting look
              </h1>
              <p className="text-gray-500 mb-6">
                We&apos;ve selected a theme for{" "}
                {name.trim() ? name : "your store"} — keep it, or pick another.
                Every colour, page and photo is editable later.
              </p>

              <div className="mb-6 flex flex-wrap gap-2">
                {themeCategories.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setThemeFilter(c.id)}
                    className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
                      themeFilter === c.id
                        ? "border-primary bg-primary text-white"
                        : "border-gray-200 bg-white text-gray-600 hover:border-primary/50"
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                {themeCatalog
                  .filter(isThemeSelectable)
                  .filter(
                    (t) =>
                      themeFilter === "all" ||
                      t.catalog.industries.includes(themeFilter),
                  )
                  .map((t) => {
                    const selected = template === t.id;
                    const locked = !!t.catalog.minPlan; // signup provisions "free"
                    const previewable = canPreviewTheme(t);
                    return (
                      <div
                        key={t.id}
                        onClick={() => !locked && setTemplate(t.id)}
                        className={`group relative overflow-hidden rounded-xl border-2 bg-white shadow-sm transition-all ${
                          locked
                            ? "cursor-not-allowed opacity-70"
                            : "cursor-pointer"
                        } ${
                          selected
                            ? "border-primary ring-2 ring-primary ring-offset-2"
                            : "border-gray-200 hover:border-primary/50 hover:shadow-md"
                        }`}
                      >
                        <div className="relative aspect-[4/3] w-full overflow-hidden border-b bg-gray-100">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={t.catalog.previewImage}
                            alt={t.name}
                            className="h-full w-full object-cover"
                          />
                          {selected && (
                            <div className="absolute inset-0 flex items-center justify-center bg-primary/10">
                              <div className="rounded-full bg-white p-1 shadow-md">
                                <CheckCircle2 className="h-6 w-6 text-primary" />
                              </div>
                            </div>
                          )}
                          {locked && (
                            <span className="absolute right-2 top-2 rounded-full bg-gray-900/80 px-2.5 py-1 text-[11px] font-bold text-white">
                              {t.catalog.minPlan!.toUpperCase()}+ plan
                            </span>
                          )}
                        </div>
                        <div className="p-4">
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <h3 className="text-lg font-bold text-gray-900">
                              {t.name}
                            </h3>
                            <button
                              type="button"
                              disabled={!previewable}
                              title={
                                previewable
                                  ? `Preview ${t.name}`
                                  : t.demo.unavailableReason ||
                                    "Preview is temporarily unavailable"
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!previewable) return;
                                window.open(
                                  demoUrl(t.demo.slug),
                                  "_blank",
                                  "noopener,noreferrer",
                                );
                              }}
                              className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-600 hover:border-primary/50 hover:text-primary disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400 disabled:hover:border-gray-200"
                            >
                              {previewable ? "Preview" : "Preview unavailable"}
                              {previewable && (
                                <ExternalLink className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                          <p className="line-clamp-2 h-8 text-xs text-gray-500">
                            {t.description}
                          </p>
                        </div>
                      </div>
                    );
                  })}
              </div>

              <button
                type="button"
                onClick={finalize}
                disabled={busy}
                className="stq-btn stq-btn-primary w-full h-12 max-w-md flex items-center justify-center gap-2"
              >
                {busy ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <>
                    Create my free store <ChevronRight className="h-5 w-5" />
                  </>
                )}
              </button>
            </div>
          )}

          {/* ── Creating ──────────────────────────────────────────── */}
          {step === "creating" && (
            <div className="mt-16 flex flex-col items-center text-center">
              <Loader2 className="mb-6 h-12 w-12 animate-spin text-primary" />
              <h1 className="mb-2 text-2xl font-bold tracking-tight text-gray-900">
                Creating {name || "your store"}…
              </h1>
              <p className="text-gray-500">
                Applying your theme and setting up your dashboard. Hang tight!
              </p>
            </div>
          )}

          {/* Back control */}
          {BACK[step] && step !== "creating" && (
            <button
              type="button"
              onClick={() => {
                setError("");
                setStep(BACK[step]!);
              }}
              className="stq-btn stq-btn-ghost mt-6 flex items-center gap-1 font-medium"
            >
              <ChevronLeft className="h-4 w-4" /> Back
            </button>
          )}
        </div>
      </main>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.583-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.166 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}
