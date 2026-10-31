"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
} from "firebase/auth";
import {
  getFirebaseAuth,
  getCurrentFirebaseUser,
  establishSession,
  endSession,
  firebaseAuthErrorMessage,
} from "@/lib/auth/firebase-client";
import {
  checkStoreSlugAvailability,
  createStore,
  getSignupResumeInfo,
  reclaimUnusedSignupEmail,
  type CreateStoreResult,
  type SignupResume,
  type SlugCheck,
} from "@/app/actions/store-signup";
import {
  confirmSignupSubscribe,
  saveSignupBillingDetails,
  startSignupSubscribe,
  type SubscribeConfirm,
  type SubscribeStart,
} from "@/app/actions/subscribe-actions";
import { ChevronLeft, Loader2, Eye, EyeOff, RotateCcw } from "lucide-react";
import { COUNTRIES, DEFAULT_COUNTRY } from "@/lib/countries";
import { PLAN_META, type Plan } from "@/lib/plans";
import {
  chargeFor,
  formatInr,
  parseSignupPlanQuote,
  signupAmount,
  type BillingPeriod,
  type SignupPlanQuote,
} from "@/lib/plans/signup-quote";
import type { MandateMethod } from "@/lib/billing/mandate-types";
import type { SaveBillingDetailsResult } from "@/lib/billing/quote-types";
import { gstStateOptions, gstinStateCode } from "@/lib/billing/gst";
import {
  BILLING_DETAILS,
  BILLING_PAGE,
  SIGNUP_STATE,
  amountChanged,
  asksForState,
  signupContinueLabel,
} from "@/lib/billing/tax-copy";
import { shouldOpenPayment } from "@/app/dashboard/plans/amount-guard";
import {
  openRazorpayModal,
  type RazorpaySuccess,
} from "@/lib/payments/razorpay-client";
import { BrandMark } from "../brand-mark";
import { PlanPicker, periodWord } from "./plan-picker";
import { acceptPlatformPolicies } from "@/app/actions/legal-actions";
import { getLegalDoc, signupRequiredDocs } from "@/lib/legal/documents";
import {
  requestSignupEmailOtp,
  verifySignupEmailOtp,
} from "@/app/actions/signup-email-otp";

// Loaded only when a paid plan needs the owner's mobile: the phone library and
// Firebase's phone sign-in have no business in the bundle of a signup that
// starts on Free.
const SignupPhoneVerify = dynamic(() => import("./phone-verify"), {
  ssr: false,
  loading: () => (
    <p className="sgn-help" role="status">
      Loading…
    </p>
  ),
});

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "storemink.com";
const LOCAL_DEV_ROOT = process.env.NEXT_PUBLIC_LOCAL_DEV_ROOT ?? "localtest.me";
const HELP_URL = `https://help.${ROOT_DOMAIN}`;

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

// Said whenever a server action or network call THROWS rather than answering.
// Before this, a thrown action left `busy` set for ever: a spinner nobody
// could clear, and with it a disabled Start over.
const NETWORK_ERROR =
  "We couldn't reach StoreMink. Check your connection and try again.";

/** Keep the digits of a pasted or typed code, at most six. A `maxLength` on
 *  the input cut "123 456" to "123 45" BEFORE the digits were kept, so a code
 *  pasted from an email with a space in it could never be entered. */
function sixDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

// Steps in flow order. "email" asks for the email AND the password on one
// screen, the way Shopify's signup does; "email-code" proves the address; the
// two are one stage (Account). "store" asks for the owner's name and the store
// name together. "plan" is where the merchant starts on Free or pays for a
// plan.
//
// ★ NO PHONE, NO ADDRESS AND NO THEME HERE (2026-10-10). The address and the
// mobile are needed before a store can take an order, not before it exists:
// the store opens closed, and the dashboard's go-live checklist asks for each
// where it is first needed. A store starts with NO theme (2026-10-11): its
// storefront shows a "store in progress" page until the owner chooses one on
// the dashboard's Storefront page, a go-live task. The one exception is a PAID plan chosen on the Plan step: Razorpay
// needs a verified mobile before it can take the payment, so that path asks
// for it there, just before paying.
type Step = "email" | "email-code" | "store" | "plan" | "creating";

// Progress stages shown in the stepper (Account folds email + code).
const STAGES = ["Account", "Store", "Plan"] as const;
function stageOf(step: Step): number {
  switch (step) {
    case "email":
    case "email-code":
      return 0;
    case "store":
      return 1;
    default:
      return 2; // plan / creating
  }
}

type CheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; result: SlugCheck };

/** Where the Plan step is. "phone" verifies the owner's mobile before a paid
 *  plan's payment; "confirm-failed" is a payment that went to Razorpay but
 *  could not be confirmed here, which must never offer to take it again;
 *  "payment-waiting" is a payment that went through whose plan switches on
 *  shortly (RC-F1b), a notice that must never offer to take it again either. */
type PlanPhase = "choose" | "phone" | "confirm-failed" | "payment-waiting";

type QuoteState =
  | { status: "idle" | "loading" }
  /** `at`: when the quote was read (ms), for the first renewal's GST terms. */
  | { status: "ready"; quote: SignupPlanQuote; at: number }
  | { status: "failed" };

/**
 * The payment a Continue press asks for, fixed when it is pressed: the plan,
 * the period, the pay-now total the step showed (the amount guard's "shown"
 * side, design 7.4) and, while GST is charged or scheduled, the state and
 * GSTIN to save first (design 7.2).
 */
interface PayIntent {
  plan: Plan;
  period: BillingPeriod;
  shownPaise: number;
  billing: { stateCode: string; gstin: string } | null;
}

/** A typed GSTIN as the server reads it: no spaces, capitals. */
function gstinOf(typed: string): string {
  return typed.replace(/\s+/g, "").toUpperCase();
}

/**
 * Does GST stop a paid plan for this country (design 7.2)? Only while GST is
 * charged NOW: with a switch-on only scheduled, a business outside India can
 * still subscribe.
 */
function outsideIndiaNow(
  quote: SignupPlanQuote | null,
  country: string,
): boolean {
  return !!quote?.tax?.active && country !== DEFAULT_COUNTRY;
}

/** Does the step ask for the business's state before a paid plan? While GST
 *  is charged or a switch-on is scheduled, for a business in India. */
function asksSignupState(
  quote: SignupPlanQuote | null,
  country: string,
): boolean {
  return !!quote?.tax && asksForState(quote.tax) && country === DEFAULT_COUNTRY;
}

/** The store this signup created. Known once, then reused: a paid plan whose
 *  payment is dismissed must not try to create a second store. */
interface CreatedStore {
  slug: string;
  phoneVerified: boolean;
}

type EnsureStoreResult =
  | { ok: true; store: CreatedStore }
  | { ok: false; back: Step; error: string };

/** The live plan prices. A GET, not a Server Action, so it never queues in
 *  front of a signup tap (app/api/plans/pricing). Null means unavailable. */
async function fetchSignupQuote(): Promise<{
  quote: SignupPlanQuote;
  at: number;
} | null> {
  try {
    const res = await fetch("/api/plans/pricing", { cache: "no-store" });
    if (!res.ok) return null;
    const quote = parseSignupPlanQuote(await res.json());
    // When it was read: the first renewal's GST terms are measured from it.
    return quote ? { quote, at: Date.now() } : null;
  } catch {
    return null;
  }
}

function dashboardUrl(slug: string): string {
  const { hostname, protocol, port } = window.location;
  const root = localDevRoot(hostname);
  return root
    ? `${protocol}//${slug}.${root}${port ? ":" + port : ""}/dashboard`
    : `https://${slug}.${ROOT_DOMAIN}/dashboard`;
}

/** A full page load into a store's dashboard, outside the component so the
 *  React Compiler does not read it as a render-time write. */
function openDashboard(slug: string): void {
  window.location.href = dashboardUrl(slug);
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
const TERMS_SLUG = getLegalDoc("terms")?.slug ?? "terms";
const PRIVACY_SLUG = getLegalDoc("privacy")?.slug ?? "privacy";

export default function SignupPage() {
  const [step, setStepRaw] = useState<Step>("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recoveryRequired, setRecoveryRequired] = useState(false);

  // ★★ AN ERROR BELONGS TO THE STEP THAT RAISED IT.
  //
  // There is ONE `error` state and ONE banner, rendered above whichever step is
  // showing — so any transition that forgets to clear it carries the last
  // step's failure onto the next one, where it describes nothing. Going through
  // here makes it structural — a step change cannot leave a stale error
  // behind. ⚠ The flip side: an error that must SURVIVE a transition is set
  // AFTER the call. Store creation once set its error and THEN called setStep,
  // which erased it, so a failed store creation returned in silence.
  function setStep(next: Step) {
    setError("");
    setRecoveryRequired(false);
    setStepRaw(next);
  }

  // The banner sits above the step, and the plan step is long enough that the
  // button which failed is a screen below it. Bring it into view, or a refusal
  // reads as a button that did nothing.
  const errorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (error) {
      errorRef.current?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [error]);

  // Account
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [emailCode, setEmailCode] = useState("");
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [operatorLogOnly, setOperatorLogOnly] = useState(false);
  const [devConsoleOnly, setDevConsoleOnly] = useState(false);

  // You
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  // Store. The country defaults to the platform's home country and stays
  // editable; the full address is collected later on the dashboard, where the
  // go-live checklist requires it.
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

  // Plan. Prices are server state (lib/plans/signup-quote.ts): the step shows
  // the live quote or, when it cannot be read, Free only.
  const [quoteState, setQuoteState] = useState<QuoteState>({ status: "idle" });
  const quoteSeq = useRef(0);
  const [plan, setPlan] = useState<Plan>("basic");
  const planTouched = useRef(false);
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  // ★ Only ever a REQUEST, and only ever the sideways move to card: the server
  // derives the rail from the charge, and "upi" here means "no override".
  const [mandateMethod, setMandateMethod] = useState<MandateMethod>("upi");
  const [planPhase, setPlanPhaseRaw] = useState<PlanPhase>("choose");
  // A non-error message on the Plan step: a dismissed payment window, or a
  // price that changed while the page was open.
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  const [paymentIssue, setPaymentIssue] = useState("");
  // What the spinner on the Plan step's button is waiting for.
  const [progress, setProgress] = useState<string | null>(null);
  const [store, setStore] = useState<CreatedStore | null>(null);
  const [verifiedPhone, setVerifiedPhone] = useState<string | null>(null);
  // The state step (design 7.2): shown while GST is charged or scheduled, for
  // a paid plan and a business in India. A valid GSTIN decides the state.
  const [gstState, setGstState] = useState("");
  const [gstin, setGstin] = useState("");
  const [gstinBlurred, setGstinBlurred] = useState(false);
  const [creating, setCreating] = useState({
    title: "Creating your store…",
    detail: "Setting up your store and dashboard.",
  });

  function setPlanPhase(next: PlanPhase) {
    setError("");
    setPlanNotice(null);
    setPlanPhaseRaw(next);
  }

  async function restartSignup() {
    setBusy(true);
    setError("");
    setRecoveryRequired(false);
    await endSession();
    window.location.assign("/signup");
  }

  /** Prefill what the account already knows (Google supplies names). */
  function applyResume(info: SignupResume) {
    if (info.email) setEmail(info.email);
    if (info.firstName) setFirstName(info.firstName);
    if (info.lastName) setLastName(info.lastName);
  }

  // Place the wizard at the right step for the current session: an account that
  // already owns a store goes to its dashboard; one with a session but no store
  // jumps to the first step it has not finished. Returns true if a session was
  // found.
  function routeFromResume(info: SignupResume): boolean {
    if (!info.authenticated) return false;
    if (info.hasStore && info.slug) {
      window.location.href = dashboardUrl(info.slug);
      return true;
    }
    // A session with no email is not a signup in progress: merchant signup
    // always begins with an email, typed or Google's. It is a SHOPPER's
    // phone-OTP session from a storefront (the cookie spans .storemink.com),
    // and resuming it put them on an email-code screen for an address they
    // never gave. Treat it as signed out; creating the account replaces it.
    if (!info.email) return false;
    applyResume(info);
    setStep(info.emailConfirmed ? "store" : "email-code");
    return true;
  }

  /** Ask the server where this session stands and go there. Used right after
   *  Google sign-in. */
  async function resumeWizard(): Promise<boolean> {
    return routeFromResume(await getSignupResumeInfo());
  }

  // On mount: resume a refreshed tab from the existing session cookie. The step
  // changes when the reply arrives, never during the effect itself. A failure
  // only means the wizard starts at the email step, as it would for a first
  // visit.
  const onResumeInfo = useEffectEvent((info: SignupResume) => {
    routeFromResume(info);
  });
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    getSignupResumeInfo()
      .then((info) => onResumeInfo(info))
      .catch(() => {});
  }, []);

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
      let result: SlugCheck;
      try {
        result = await checkStoreSlugAvailability(value);
      } catch {
        // Without this the hint read "Checking availability…" for ever and
        // Continue never enabled.
        result = {
          slug: value.trim().toLowerCase().replace(/\s+/g, "-"),
          available: false,
          reason: "We couldn't check that name. Try again in a moment.",
        };
      }
      if (mySeq === seq.current) setCheck({ status: "done", result });
    }, 400);
  }
  const isNameAvailable = check.status === "done" && check.result.available;
  function slugHint() {
    if (check.status === "idle")
      return { cls: "neutral", text: `your-store.${ROOT_DOMAIN}` };
    if (check.status === "checking")
      return { cls: "neutral", text: "Checking availability…" };
    const r = check.result;
    return r.available
      ? { cls: "ok", text: `${r.slug}.${ROOT_DOMAIN} is available` }
      : { cls: "bad", text: r.reason ?? "Not available" };
  }

  // ── Account ──────────────────────────────────────────────────────────────
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

  /** Send (or resend) the email code and show its screen. Returns whether a
   *  code went out; throws on a network failure. */
  async function sendEmailCode(): Promise<boolean> {
    const otp = await requestSignupEmailOtp();
    if (otp.alreadyVerified) {
      setStep("store");
      return false;
    }
    setEmailCodeSent((sent) => sent || otp.ok);
    setOperatorLogOnly(otp.operatorLogOnly === true);
    setDevConsoleOnly(otp.devConsoleOnly === true);
    setEmailCode("");
    setStep("email-code");
    // After the transition: setStep clears the banner.
    if (!otp.ok) {
      setError(otp.error ?? "We couldn't send a verification code.");
    }
    return otp.ok;
  }

  async function handleCreateAccount() {
    if (!EMAIL_RE.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setError("Use a password of at least 8 characters.");
      return;
    }
    // The only client-side gate before an account is created. The real
    // guarantee is the server-side acceptance write.
    if (!agreed) {
      setError(`Please accept ${CONSENT_DOC_NAMES} to continue.`);
      return;
    }
    setBusy(true);
    setError("");
    const auth = getFirebaseAuth();
    // True when the email already had a login and this password opened it.
    let existingAccount = false;
    try {
      await createUserWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      // The email may already have an account — try signing in with the same
      // credentials to recover a returning owner.
      if ((err as { code?: string })?.code === "auth/email-already-in-use") {
        try {
          await signInWithEmailAndPassword(auth, email.trim(), password);
          existingAccount = true;
        } catch {
          // A different password. If that login holds no StoreMink role — a
          // deleted store's owner, or an abandoned signup — the server frees
          // the email and the account is created afresh; a login still in use
          // is left alone.
          const { reclaimed } = await reclaimUnusedSignupEmail(
            email.trim(),
          ).catch(() => ({ reclaimed: false }));
          let created = false;
          if (reclaimed) {
            try {
              await createUserWithEmailAndPassword(
                auth,
                email.trim(),
                password,
              );
              created = true;
            } catch (retryErr) {
              setBusy(false);
              setError(firebaseAuthErrorMessage(retryErr));
              return;
            }
          }
          if (!created) {
            setBusy(false);
            setError(
              "An account with this email already exists and that password doesn't match it. Enter the password you used before, continue with Google, or use a different email.",
            );
            return;
          }
        }
      } else {
        setBusy(false);
        setError(firebaseAuthErrorMessage(err));
        return;
      }
    }

    try {
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

      // ★ A password that opened an EXISTING account must not walk its owner
      // back through steps they already finished. It used to: an owner who
      // came to the signup page instead of the login page re-verified their
      // contact details, named a store, picked a theme, and was then refused
      // with "This account already has a store". An owner goes to their
      // dashboard; a half-finished signup resumes where it stopped.
      if (existingAccount) {
        const info = await getSignupResumeInfo();
        if (info.hasStore && info.slug) {
          window.location.href = dashboardUrl(info.slug);
          return; // stays busy while the dashboard loads
        }
        applyResume(info);
        if (info.emailConfirmed) {
          setBusy(false);
          setStep("store");
          return;
        }
      }

      await sendEmailCode();
      setBusy(false);
    } catch {
      setBusy(false);
      setError(NETWORK_ERROR);
    }
  }

  async function handleSendEmailOtp() {
    setBusy(true);
    setError("");
    try {
      await sendEmailCode();
    } catch {
      setError(NETWORK_ERROR);
    }
    setBusy(false);
  }

  async function handleVerifyEmailOtp(code: string = emailCode) {
    if (busy || code.length !== 6) return;
    setBusy(true);
    setError("");
    setRecoveryRequired(false);
    try {
      const result = await verifySignupEmailOtp(code);
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
          const sent = await sendEmailCode();
          setBusy(false);
          if (sent) {
            setError("Your session was refreshed. Enter the new code we sent.");
          }
          return;
        }
        setBusy(false);
        setError(result.error ?? "That code couldn't be verified.");
        return;
      }

      // The Admin SDK changed the server record. Reload the browser user, then
      // mint a session cookie carrying the new email_verified claim.
      //
      // ★★ BOTH ARE BEST-EFFORT. The code was right, and the account record
      // now says verified, which the server reads whenever the cookie still
      // says otherwise (lib/auth/email-verified.ts). This used to stop on
      // "You're not signed in" whenever the browser could not refresh its
      // session (a reloaded tab, where Firebase had not finished restoring the
      // sign-in), after the code had already worked, and every retry then
      // asked for a new code.
      const browserUser = await getCurrentFirebaseUser().catch(() => null);
      await browserUser?.reload().catch(() => undefined);
      await establishSession(true).catch(() => null);
    } catch {
      setBusy(false);
      setError(NETWORK_ERROR);
      return;
    }
    setBusy(false);
    setStep("store");
  }

  // ── Plan ─────────────────────────────────────────────────────────────────
  /** Load the live prices for the Plan step. A newer request wins, so going
   *  Back and Continue again cannot let an older answer land last. */
  async function loadQuote() {
    const mySeq = ++quoteSeq.current;
    setQuoteState({ status: "loading" });
    const read = await fetchSignupQuote();
    if (mySeq !== quoteSeq.current) return;
    if (!read) {
      setQuoteState({ status: "failed" });
      return;
    }
    const { quote } = read;
    setQuoteState({ status: "ready", quote, at: read.at });
    // Basic is preselected because it is the plan most new brands need; Skip
    // sits right under the button. Without the platform's own gateway no paid
    // plan can be bought here, so Free is the only real choice.
    if (!quote.paidCheckout) setPlan("free");
    else if (!planTouched.current) setPlan("basic");
  }

  /** Read the prices again quietly, keeping the step on screen: after the
   *  amount guard stopped a payment (design 7.4). */
  async function refreshQuote() {
    const mySeq = ++quoteSeq.current;
    const read = await fetchSignupQuote();
    if (read && mySeq === quoteSeq.current) {
      setQuoteState({ status: "ready", quote: read.quote, at: read.at });
    }
  }

  /** What a press of Continue pays for, from this quote and what the step
   *  holds now. */
  function payIntentFor(q: SignupPlanQuote): PayIntent {
    let billing: PayIntent["billing"] = null;
    if (asksSignupState(q, country)) {
      const typed = gstinOf(gstin);
      const fromGstin = typed ? gstinStateCode(typed) : null;
      billing = { stateCode: fromGstin ?? gstState, gstin: typed };
    }
    return {
      plan,
      period,
      shownPaise: signupAmount(q.plans[plan], period, q.tax).totalPaise,
      billing,
    };
  }

  /** Is the state step answered: a state chosen, or a valid GSTIN typed? */
  function stateReadyFor(q: SignupPlanQuote | null): boolean {
    if (!asksSignupState(q, country)) return true;
    const typed = gstinOf(gstin);
    return typed ? gstinStateCode(typed) !== null : gstState !== "";
  }

  function goToPlan() {
    setPlanPhaseRaw("choose");
    setPlanNotice(null);
    setStep("plan");
    if (quoteState.status !== "ready") void loadQuote();
  }

  function choosePlan(next: Plan) {
    planTouched.current = true;
    setPlan(next);
    setPlanNotice(null);
    setError("");
  }

  function choosePeriod(next: BillingPeriod) {
    setPeriod(next);
    setPlanNotice(null);
    setError("");
  }

  /**
   * Create the store, once.
   *
   * ★ EVERY PATH THROUGH THE PLAN STEP CREATES THE STORE FIRST, ON FREE.
   * Payment comes after, so a merchant who closes the payment window still has
   * a store, and nothing about a paid plan can leave them with none.
   *
   * Before offering a retry it asks the server where the account stands.
   * "This account already has a store" and a lost reply to a request that
   * succeeded both mean the store exists, and a retry could only be refused as
   * a duplicate. A verification the server no longer sees (an expired session,
   * say) sends the merchant back to the step that fixes it, rather than to a
   * button that will refuse again.
   */
  async function ensureStore(): Promise<EnsureStoreResult> {
    if (store) return { ok: true, store };
    let res: CreateStoreResult;
    try {
      res = await createStore({ name, firstName, lastName, country });
    } catch {
      // The request failed in transit, which says nothing about whether the
      // store exists: the server may have created it and lost only the reply.
      res = { error: NETWORK_ERROR };
    }
    if (!res.error && res.storeId && res.slug) {
      const made = {
        slug: res.slug,
        phoneVerified: res.phoneVerified === true,
      };
      setStore(made);
      return { ok: true, store: made };
    }

    let back: Step = "plan";
    try {
      const info = await getSignupResumeInfo();
      if (info.hasStore && info.slug) {
        const made = {
          slug: info.slug,
          phoneVerified: info.phoneVerified === true,
        };
        setStore(made);
        return { ok: true, store: made };
      }
      if (info.authenticated && !info.emailConfirmed) back = "email-code";
    } catch {
      // Fall through to the error below.
    }
    return {
      ok: false,
      back,
      error: res.error ?? "We couldn't create your store. Please try again.",
    };
  }

  /** Free, or Skip: create the store if this signup hasn't yet, then open its
   *  dashboard. */
  async function startOnFree() {
    setBusy(true);
    setProgress(null);
    setCreating(
      store
        ? {
            title: "Opening your dashboard…",
            detail: "Your store is ready on the Free plan.",
          }
        : {
            title: `Creating ${name.trim() || "your store"}…`,
            detail: "Setting up your store and dashboard.",
          },
    );
    setStep("creating");
    const made = await ensureStore();
    if (made.ok) {
      window.location.href = dashboardUrl(made.store.slug);
      return; // stays busy while the dashboard loads
    }
    setBusy(false);
    setPlanPhaseRaw("choose");
    setStep(made.back);
    // After the transition: setStep clears the banner.
    setError(made.error);
  }

  /** A paid plan: confirm the price, create the store, verify the owner's
   *  mobile if it isn't yet, then take the payment. */
  async function continueWithPlan() {
    if (
      quoteState.status !== "ready" ||
      !quoteState.quote.paidCheckout ||
      outsideIndiaNow(quoteState.quote, country) ||
      plan === "free"
    ) {
      await startOnFree();
      return;
    }
    const shown = chargeFor(quoteState.quote.plans[plan], period);
    const shownTotal = signupAmount(
      quoteState.quote.plans[plan],
      period,
      quoteState.quote.tax,
    ).totalPaise;
    let current = quoteState.quote;
    setBusy(true);
    setError("");
    setPlanNotice(null);
    setProgress("Checking the price…");

    // ★ A PRICE CAN CHANGE WHILE THE PAGE IS OPEN. An operator reprice reaches
    // the server at once, and a card that shows one amount while Razorpay asks
    // for another is how a signup ends in a dispute. If the price cannot be
    // re-read, carry on: the server computes the charge and Razorpay shows it
    // before anything is paid.
    const mySeq = ++quoteSeq.current;
    const read = await fetchSignupQuote();
    if (read && mySeq === quoteSeq.current) {
      const fresh = read.quote;
      current = fresh;
      setQuoteState({ status: "ready", quote: fresh, at: read.at });
      if (!fresh.paidCheckout) {
        setPlan("free");
        setBusy(false);
        setProgress(null);
        setPlanNotice(
          "Paying for a plan isn't available right now. Start on Free and upgrade from your dashboard when you're ready.",
        );
        return;
      }
      // GST started while the page was open: a business outside India can
      // no longer buy a paid plan here, and the step now says so.
      if (outsideIndiaNow(fresh, country)) {
        setBusy(false);
        setProgress(null);
        return;
      }
      const now = chargeFor(fresh.plans[plan], period);
      if (now !== shown) {
        setBusy(false);
        setProgress(null);
        setPlanNotice(
          `The ${PLAN_META[plan].name} price has just changed to ${formatInr(now)} a ${periodWord(period)}. Check it, then continue.`,
        );
        return;
      }
      // The list price held but the GST terms moved: the pay-now total the
      // step showed is no longer what is charged.
      const freshTotal = signupAmount(
        fresh.plans[plan],
        period,
        fresh.tax,
      ).totalPaise;
      if (freshTotal !== shownTotal) {
        setBusy(false);
        setProgress(null);
        setPlanNotice(amountChanged(freshTotal, "continue"));
        return;
      }
      // A switch-on scheduled while the page was open: the state step has
      // just appeared and is not answered yet.
      if (!stateReadyFor(fresh)) {
        setBusy(false);
        setProgress(null);
        setPlanNotice(BILLING_DETAILS.errors.state);
        return;
      }
    }
    const intent = payIntentFor(current);

    setProgress(store ? null : "Creating your store…");
    const made = await ensureStore();
    if (!made.ok) {
      setBusy(false);
      setProgress(null);
      if (made.back !== "plan") setStep(made.back);
      setError(made.error);
      return;
    }

    // Razorpay needs a verified mobile on the billing account before it can
    // take any payment (lib/billing/enrol.ts → ensureRzpCustomer).
    if (!made.store.phoneVerified) {
      setBusy(false);
      setProgress(null);
      setPlanPhase("phone");
      return;
    }
    await pay(made.store, intent, verifiedPhone ?? undefined);
  }

  /** The mobile is verified: carry straight on to the payment. */
  function onPhoneVerified(phone: string) {
    setVerifiedPhone(phone);
    if (!store || quoteState.status !== "ready") return;
    const made = { ...store, phoneVerified: true };
    setStore(made);
    setPlanPhase("choose");
    void pay(made, payIntentFor(quoteState.quote), phone);
  }

  /**
   * Take the payment, in the order design 7.2 sets: save the business's state
   * (while GST is charged or scheduled), start the subscription, check the
   * amount against the one the step showed (the amount guard, design 7.4),
   * then open Razorpay.
   */
  async function pay(made: CreatedStore, intent: PayIntent, contact?: string) {
    const chosen = intent.plan;
    const chosenPeriod = intent.period;
    setBusy(true);
    setError("");
    setPlanNotice(null);
    setProgress("Opening payment…");

    // ★ The state first: the server refuses a GST payment for a business in
    // India with no state, and the store exists by now (ensureStore), so it
    // is saved for that store through the owner gate.
    if (intent.billing) {
      let saved: SaveBillingDetailsResult;
      try {
        saved = await saveSignupBillingDetails(intent.billing);
      } catch {
        saved = { ok: false, error: SIGNUP_STATE.saveFailed };
      }
      if (!saved.ok) {
        setBusy(false);
        setProgress(null);
        setError(saved.error);
        return;
      }
    }

    let start: SubscribeStart;
    try {
      start = await startSignupSubscribe(chosen, chosenPeriod, mandateMethod);
    } catch {
      start = { ok: false, error: NETWORK_ERROR };
    }
    if (!start.ok) {
      setBusy(false);
      setProgress(null);
      if (start.waiting) {
        // ★ An earlier payment went through and the plan switches on shortly
        // (RC-F1b). Not an error and not a retry: say so, and offer only the
        // dashboard, where the plan shows once it moves.
        setPaymentIssue(start.error);
        setPlanPhaseRaw("payment-waiting");
        return;
      }
      setError(start.error);
      return;
    }
    if (start.completedEarlier) {
      // ★★ An earlier payment was finished instead of opening a second one
      // (RC-F1b): the plan is active, so move on to the dashboard exactly as
      // after a payment made here.
      setCreating({
        title: "Opening your dashboard…",
        detail: start.message,
      });
      setStep("creating");
      openDashboard(made.slug);
      return; // stays busy while the dashboard loads
    }

    // ★★ THE AMOUNT GUARD (design 7.4). The window opens only for exactly the
    // amount the step showed; a price or GST change in between stops here,
    // says the new amount, and reads the prices again. The next press resumes
    // the same order (lib/billing/enrol.ts), whose amount is the new one.
    if (!shouldOpenPayment(intent.shownPaise, start.amountPaise)) {
      setBusy(false);
      setProgress(null);
      setError(amountChanged(start.amountPaise, "continue"));
      void refreshQuote();
      return;
    }

    const invoiceId = start.invoiceId;
    const ownerName = `${firstName} ${lastName}`.trim();
    const opened = await openRazorpayModal({
      keyId: start.keyId,
      rzpOrderId: start.providerOrderId,
      amountPaise: start.amountPaise,
      // ★★ OMITTED WHEN THERE IS NO MANDATE. `openRazorpayModal` sends
      // `recurring: true` alongside a customer id, and asking Checkout to treat
      // a plain one-time order as recurring is the mismatch that once showed a
      // Cards-only screen.
      customerId: start.autopay ? start.providerCustomerId : undefined,
      name: "StoreMink",
      description: `${PLAN_META[chosen].name} plan, first ${periodWord(chosenPeriod)}`,
      prefill: {
        name: ownerName || undefined,
        email: email.trim() || undefined,
        contact,
      },
      themeColor: "#573cf0",
      onSuccess: (response) =>
        void confirmPayment(made, chosen, invoiceId, response),
      onDismiss: () => {
        setBusy(false);
        setProgress(null);
        // ★ Not "nothing was charged": a UPI request can still be approved in
        // the app after the window closes, and reconciliation then settles it.
        setPlanNotice(
          "Payment wasn't completed. Your store is ready on the Free plan, so you can try again, choose another plan, or continue on Free.",
        );
      },
    });
    if (!opened) {
      setBusy(false);
      setProgress(null);
      setError(
        "We couldn't open the payment window. Check your connection and try again.",
      );
    }
  }

  async function confirmPayment(
    made: CreatedStore,
    chosen: Plan,
    invoiceId: string,
    response: RazorpaySuccess,
  ) {
    setCreating({
      title: "Confirming your payment…",
      detail: `Then your store moves to the ${PLAN_META[chosen].name} plan.`,
    });
    setStep("creating");
    let confirmed: SubscribeConfirm;
    try {
      confirmed = await confirmSignupSubscribe(
        invoiceId,
        response.razorpay_payment_id,
        response.razorpay_signature,
      );
    } catch {
      confirmed = {
        ok: false,
        error:
          "We couldn't confirm your payment just now. If it went through, it is matched to your store automatically.",
      };
    }
    if (confirmed.ok) {
      window.location.href = dashboardUrl(made.slug);
      return; // stays busy while the dashboard loads
    }
    // ★ NEVER OFFER TO PAY AGAIN FROM HERE. The money may well have moved, and
    // the server's message says what happened; the dashboard is where the
    // outcome becomes visible.
    setBusy(false);
    setProgress(null);
    setPaymentIssue(confirmed.error);
    // A payment that went through and switches the plan on shortly is told as
    // such; anything else could not be confirmed here.
    setPlanPhaseRaw(confirmed.waiting ? "payment-waiting" : "confirm-failed");
    setStep("plan");
  }

  const h = slugHint();
  const stage = stageOf(step);
  const quote = quoteState.status === "ready" ? quoteState.quote : null;
  const quotedAt = quoteState.status === "ready" ? quoteState.at : 0;
  const lockedOutside = outsideIndiaNow(quote, country);
  const paidAllowed = !!quote && quote.paidCheckout && !lockedOutside;
  const paidSelected = paidAllowed && plan !== "free";
  const payNow =
    paidSelected && quote
      ? signupAmount(quote.plans[plan], period, quote.tax)
      : null;
  const planCta =
    quote && payNow
      ? signupContinueLabel(
          quote.tax,
          PLAN_META[plan].name,
          period,
          payNow.totalPaise,
        )
      : store
        ? "Continue on Free"
        : "Start on Free";
  const askState = paidSelected && asksSignupState(quote, country);
  const stateReady = !paidSelected || stateReadyFor(quote);
  const typedGstin = gstinOf(gstin);
  const gstinState = typedGstin ? gstinStateCode(typedGstin) : null;
  const gstinInvalid =
    typedGstin !== "" &&
    gstinState === null &&
    (gstinBlurred || typedGstin.length >= 15);
  const wideCard = step === "plan" && planPhase === "choose";

  return (
    <div className="sgn">
      <header className="sgn-header">
        <Link href="/" className="sgn-logo" aria-label="StoreMink home">
          <BrandMark size={26} priority />
          <span aria-hidden="true">
            Store<em>Mink</em>
          </span>
        </Link>
        <div className="sgn-header-actions">
          {/* Once the store exists there is nothing to start over: signing
              out would only send the owner back to the dashboard they have. */}
          {step !== "email" && step !== "creating" && !store && (
            <button
              type="button"
              onClick={restartSignup}
              disabled={busy}
              className="sgn-restart"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Start
              over
            </button>
          )}
          <p>
            {/* The question is decoration on a phone: with Start over beside
                it the header runs out of width at 375px. The link is the
                part that matters. */}
            <span className="sgn-header-ask">Already have an account? </span>
            <Link href="/login">Log in</Link>
          </p>
        </div>
      </header>

      <main className="sgn-main">
        <div className={`sgn-card${wideCard ? " is-wide" : ""}`}>
          {/* Progress stepper */}
          {step !== "creating" && (
            <div className="sgn-progress">
              <div className="sgn-progress-bar" aria-hidden="true">
                {STAGES.map((label, i) => (
                  <span key={label} className={i <= stage ? "is-done" : ""} />
                ))}
              </div>
              <p>
                Step {stage + 1} of {STAGES.length} · {STAGES[stage]}
              </p>
            </div>
          )}

          {error && (
            <div
              ref={errorRef}
              role="alert"
              aria-live="assertive"
              className="sgn-note is-error"
            >
              <p>{error}</p>
              {recoveryRequired && (
                <div className="sgn-note-actions">
                  <button
                    type="button"
                    onClick={restartSignup}
                    disabled={busy}
                    className="sgn-btn sgn-btn-primary is-auto"
                  >
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4" />
                    )}
                    Start signup again
                  </button>
                  <Link
                    href="/login"
                    className="sgn-btn sgn-btn-outline is-auto"
                  >
                    Go to login
                  </Link>
                </div>
              )}
            </div>
          )}

          {/* ── Email ─────────────────────────────────────────────── */}
          {step === "email" && (
            <div className="sgn-step">
              <h1 className="sgn-title">Create your StoreMink account</h1>
              <p className="sgn-sub">Start free. No credit card needed.</p>

              <button
                type="button"
                onClick={handleGoogle}
                disabled={googleLoading}
                aria-describedby="signup-consent-help"
                className="sgn-btn sgn-btn-outline"
              >
                {googleLoading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <GoogleIcon />
                )}
                Continue with Google
              </button>

              <div className="sgn-or">or</div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleCreateAccount();
                }}
                className="sgn-stack"
              >
                <div className="sgn-field">
                  <label className="sgn-label" htmlFor="signup-email">
                    Email address
                  </label>
                  <input
                    id="signup-email"
                    name="email"
                    type="email"
                    className="sgn-input"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoFocus
                    autoComplete="email"
                  />
                </div>
                <div className="sgn-field">
                  <label className="sgn-label" htmlFor="signup-password">
                    Password
                  </label>
                  <div className="sgn-password">
                    <input
                      id="signup-password"
                      name="password"
                      type={showPassword ? "text" : "password"}
                      className="sgn-input"
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      aria-label={
                        showPassword ? "Hide password" : "Show password"
                      }
                    >
                      {showPassword ? (
                        <EyeOff className="h-5 w-5" />
                      ) : (
                        <Eye className="h-5 w-5" />
                      )}
                    </button>
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  aria-describedby="signup-consent-help"
                  className="sgn-btn sgn-btn-primary"
                >
                  {busy ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    "Create account"
                  )}
                </button>
              </form>

              {/* Consent remains mandatory for both paths, but an enabled
                  button can explain WHY it cannot continue. A silently greyed
                  Google button looked like an OAuth outage. */}
              <div id="signup-consent-help" className="sgn-consent">
                <label className="sgn-check">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                  />
                  {/* Driven by the REGISTRY, not hardcoded: the same list
                      (signupRequiredDocs) decides what this sentence names,
                      what recordSignupConsent writes a row for, and what the
                      re-acceptance gate checks. Hardcoding it here is how a
                      merchant ends up ticking a box for two documents while
                      the server records three. */}
                  <span>
                    I agree to StoreMink&apos;s{" "}
                    {CONSENT_DOCS.map((doc, i) => (
                      <span key={doc.kind}>
                        {i > 0 &&
                          (i === CONSENT_DOCS.length - 1 ? " and " : ", ")}
                        <a
                          href={`/legal/${doc.slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
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
                <label className="sgn-check is-quiet">
                  <input
                    type="checkbox"
                    checked={marketing}
                    onChange={(e) => setMarketing(e.target.checked)}
                  />
                  <span>
                    Send me product updates and selling tips (optional).
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* ── Email code ────────────────────────────────────────── */}
          {step === "email-code" && (
            <div className="sgn-step">
              <h1 className="sgn-title">Check your email</h1>
              <p className="sgn-sub">
                {/* A refreshed tab lands here from the session alone, without
                    this browser having sent anything, so the sentence must
                    not claim a code was just sent. */}
                {emailCodeSent ? (
                  <>
                    Enter the six-digit code we sent to <strong>{email}</strong>
                    .
                  </>
                ) : (
                  <>
                    Enter the six-digit code emailed to <strong>{email}</strong>
                    , or send a new one.
                  </>
                )}
              </p>

              {operatorLogOnly && (
                <div className="sgn-note is-info">
                  This is a reserved test address, so no email was sent. The
                  code is available in Operator dashboard → Email logs.
                </div>
              )}

              {devConsoleOnly && (
                <div className="sgn-note is-warn">
                  Email isn&apos;t configured in this environment, so nothing
                  was sent. The code is printed in your dev server terminal.
                </div>
              )}

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleVerifyEmailOtp();
                }}
                className="sgn-stack"
              >
                <div className="sgn-field">
                  <label className="sgn-label" htmlFor="signup-email-code">
                    Verification code
                  </label>
                  <input
                    id="signup-email-code"
                    type="text"
                    className="sgn-input is-code"
                    placeholder="000000"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    value={emailCode}
                    onChange={(event) => {
                      const next = sixDigits(event.target.value);
                      setEmailCode(next);
                      // Six digits is the whole answer; asking for a second
                      // tap adds nothing.
                      if (next.length === 6) void handleVerifyEmailOtp(next);
                    }}
                  />
                </div>

                <button
                  type="submit"
                  disabled={busy || emailCode.length !== 6}
                  className="sgn-btn sgn-btn-primary"
                >
                  {busy ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    "Verify email"
                  )}
                </button>
              </form>

              <div className="sgn-links">
                <button
                  type="button"
                  onClick={() => void handleSendEmailOtp()}
                  disabled={busy}
                  className="sgn-link"
                >
                  {emailCodeSent ? "Resend code" : "Send a code"}
                </button>
                <button
                  type="button"
                  onClick={restartSignup}
                  disabled={busy}
                  className="sgn-link"
                >
                  Use a different email
                </button>
              </div>
              <p className="sgn-help sgn-gap">
                Codes expire after 10 minutes and work only in this browser.
              </p>
            </div>
          )}

          {/* ── You + your store — ONE screen ──────────────────────
              Name and store name were two screens; Google users arrive with
              their name prefilled, so for them this is one field plus the
              country. */}
          {step === "store" && (
            <div className="sgn-step">
              <h1 className="sgn-title">About you and your store</h1>
              <p className="sgn-sub">
                You can rename your store any time. Its web address stays yours.
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
                  goToPlan();
                }}
                className="sgn-stack"
              >
                <div className="sgn-row">
                  <div className="sgn-field">
                    <label className="sgn-label" htmlFor="signup-first-name">
                      First name
                    </label>
                    <input
                      id="signup-first-name"
                      className="sgn-input"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      autoFocus={!firstName}
                      autoComplete="given-name"
                    />
                  </div>
                  <div className="sgn-field">
                    <label className="sgn-label" htmlFor="signup-last-name">
                      Last name <span className="sgn-optional">(optional)</span>
                    </label>
                    <input
                      id="signup-last-name"
                      className="sgn-input"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      autoComplete="family-name"
                    />
                  </div>
                </div>

                <div className="sgn-field">
                  <label className="sgn-label" htmlFor="signup-store-name">
                    Store name
                  </label>
                  <input
                    id="signup-store-name"
                    className="sgn-input"
                    placeholder="For example, Saffron Studio"
                    value={name}
                    onChange={(e) => onNameChange(e.target.value)}
                    autoFocus={!!firstName}
                    autoComplete="organization"
                    maxLength={50}
                  />
                  <p className={`sgn-hint ${h.cls}`} aria-live="polite">
                    {h.text}
                  </p>
                </div>

                <div className="sgn-field">
                  <label className="sgn-label" htmlFor="business-country">
                    Country you sell from
                  </label>
                  <select
                    id="business-country"
                    className="sgn-input"
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
                  <p className="sgn-help">
                    Next, your dashboard walks you through choosing your
                    store&apos;s look, your business address and your mobile
                    before the store opens.
                  </p>
                </div>

                <button
                  type="submit"
                  disabled={!isNameAvailable || !firstName.trim()}
                  className="sgn-btn sgn-btn-primary"
                >
                  Continue
                </button>
              </form>
            </div>
          )}

          {/* ── Plan ──────────────────────────────────────────────── */}
          {step === "plan" && planPhase === "choose" && (
            <div className="sgn-step">
              <h1 className="sgn-title">Choose your plan</h1>
              <p className="sgn-sub">
                Start on Free, or choose a paid plan to unlock more from day
                one. You can change plans any time.
              </p>

              {planNotice && (
                <div role="status" className="sgn-note is-warn">
                  <p>{planNotice}</p>
                </div>
              )}

              {(quoteState.status === "idle" ||
                quoteState.status === "loading") && (
                <div className="sgn-loading" role="status">
                  <Loader2
                    className="h-5 w-5 animate-spin"
                    aria-hidden="true"
                  />
                  Loading plans…
                </div>
              )}

              {quoteState.status === "failed" && (
                <div className="sgn-note is-warn">
                  <p>
                    We couldn&apos;t load plan prices right now. You can start
                    on Free and choose a plan later from your dashboard.
                  </p>
                  <div className="sgn-note-actions">
                    <button
                      type="button"
                      onClick={() => void loadQuote()}
                      disabled={busy}
                      className="sgn-btn sgn-btn-outline is-auto"
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden="true" />
                      Try again
                    </button>
                  </div>
                </div>
              )}

              {quote && (
                <PlanPicker
                  quote={quote}
                  quotedAt={quotedAt}
                  plan={paidAllowed ? plan : "free"}
                  period={period}
                  mandateMethod={mandateMethod}
                  disabled={busy}
                  outsideIndia={lockedOutside}
                  stateStep={
                    askState ? (
                      <div className="sgn-stack mt-2 w-full">
                        <div className="sgn-field">
                          <label
                            className="sgn-label"
                            htmlFor="signup-gst-state"
                          >
                            {SIGNUP_STATE.stateLabel}
                          </label>
                          <select
                            id="signup-gst-state"
                            className="sgn-input"
                            value={gstinState ?? gstState}
                            disabled={busy || gstinState !== null}
                            aria-describedby="signup-gst-state-hint"
                            onChange={(e) => {
                              setGstState(e.target.value);
                              setError("");
                            }}
                          >
                            <option value="">
                              {BILLING_DETAILS.fields.state.placeholder}
                            </option>
                            {gstStateOptions(gstinState ?? gstState).map(
                              (s) => (
                                <option key={s.code} value={s.code}>
                                  {s.name}
                                </option>
                              ),
                            )}
                          </select>
                          <p
                            id="signup-gst-state-hint"
                            className="sgn-hint neutral"
                          >
                            {SIGNUP_STATE.stateHint}
                          </p>
                        </div>
                        <div className="sgn-field">
                          <label className="sgn-label" htmlFor="signup-gstin">
                            {SIGNUP_STATE.gstinLabel}
                          </label>
                          <input
                            id="signup-gstin"
                            className="sgn-input"
                            value={gstin}
                            maxLength={20}
                            autoComplete="off"
                            autoCapitalize="characters"
                            spellCheck={false}
                            disabled={busy}
                            aria-invalid={gstinInvalid || undefined}
                            aria-describedby="signup-gstin-hint"
                            onChange={(e) => {
                              setGstin(e.target.value.toUpperCase());
                              setGstinBlurred(false);
                              setError("");
                            }}
                            onBlur={() => setGstinBlurred(true)}
                          />
                          <p
                            id="signup-gstin-hint"
                            className={`sgn-hint ${gstinInvalid ? "bad" : "neutral"}`}
                          >
                            {gstinInvalid
                              ? SIGNUP_STATE.invalidGstin
                              : SIGNUP_STATE.gstinHint}
                          </p>
                        </div>
                      </div>
                    ) : undefined
                  }
                  onPlanChange={choosePlan}
                  onPeriodChange={choosePeriod}
                  onMandateMethodChange={setMandateMethod}
                />
              )}

              {quote && !quote.paidCheckout && (
                <p className="sgn-help sgn-plan-help">
                  Paid plans can&apos;t be bought during signup right now. Your
                  store starts on Free, and you can upgrade from {BILLING_PAGE}{" "}
                  in your dashboard.
                </p>
              )}

              {quote && quote.paidCheckout && lockedOutside && (
                <p className="sgn-help sgn-plan-help">
                  {SIGNUP_STATE.outsideIndia}
                </p>
              )}

              <div className="sgn-plan-actions">
                <button
                  type="button"
                  onClick={() =>
                    void (paidSelected ? continueWithPlan() : startOnFree())
                  }
                  disabled={
                    busy ||
                    quoteState.status === "idle" ||
                    quoteState.status === "loading" ||
                    !stateReady
                  }
                  className="sgn-btn sgn-btn-primary"
                >
                  {busy ? (
                    <>
                      <Loader2
                        className="h-5 w-5 animate-spin"
                        aria-hidden="true"
                      />
                      {progress}
                    </>
                  ) : (
                    planCta
                  )}
                </button>
                {/* Skip is always one tap away while a paid plan is chosen:
                    the store starts on Free and can upgrade from Plans &
                    Billing at any time. */}
                {paidSelected && (
                  <button
                    type="button"
                    onClick={() => void startOnFree()}
                    disabled={busy}
                    className="sgn-link"
                  >
                    {store ? "Continue on Free" : "Skip, start on Free"}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── Plan: the owner's mobile, before a paid plan's payment ── */}
          {step === "plan" && planPhase === "phone" && (
            <div className="sgn-step">
              <h1 className="sgn-title">Verify your mobile</h1>
              <p className="sgn-sub">
                Your store is ready. Razorpay needs a verified mobile for the{" "}
                {PLAN_META[plan].name} plan&apos;s payment and renewal notices.
              </p>

              <SignupPhoneVerify onVerified={onPhoneVerified} />

              <div className="sgn-links">
                <button
                  type="button"
                  onClick={() => setPlanPhase("choose")}
                  disabled={busy}
                  className="sgn-link"
                >
                  Choose a different plan
                </button>
                <button
                  type="button"
                  onClick={() => void startOnFree()}
                  disabled={busy}
                  className="sgn-link"
                >
                  Continue on Free
                </button>
              </div>
              <p className="sgn-help sgn-gap">
                This also completes the mobile task on your go-live checklist.
              </p>
            </div>
          )}

          {/* ── Plan: a payment we could not confirm ─────────────── */}
          {step === "plan" && planPhase === "confirm-failed" && (
            <div className="sgn-step">
              <h1 className="sgn-title">
                We couldn&apos;t confirm your payment
              </h1>
              <div role="status" className="sgn-note is-info">
                <p>{paymentIssue}</p>
              </div>
              <p className="sgn-sub">
                Your store is ready. Please don&apos;t pay again from here:{" "}
                {BILLING_PAGE} in your dashboard shows what happened.
              </p>
              <button
                type="button"
                onClick={() => {
                  if (!store) return;
                  setBusy(true);
                  window.location.href = dashboardUrl(store.slug);
                }}
                disabled={busy || !store}
                className="sgn-btn sgn-btn-primary"
              >
                {busy ? (
                  <Loader2
                    className="h-5 w-5 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  "Open your dashboard"
                )}
              </button>
            </div>
          )}

          {/* ── Plan: a payment that went through, plan switching shortly ── */}
          {step === "plan" && planPhase === "payment-waiting" && (
            <div className="sgn-step">
              <h1 className="sgn-title">Your payment went through</h1>
              <div role="status" className="sgn-note is-info">
                <p>{paymentIssue}</p>
              </div>
              <p className="sgn-sub">
                Your store is ready. {BILLING_PAGE} in your dashboard shows your
                plan once it switches on.
              </p>
              <button
                type="button"
                onClick={() => {
                  if (!store) return;
                  setBusy(true);
                  window.location.href = dashboardUrl(store.slug);
                }}
                disabled={busy || !store}
                className="sgn-btn sgn-btn-primary"
              >
                {busy ? (
                  <Loader2
                    className="h-5 w-5 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  "Open your dashboard"
                )}
              </button>
            </div>
          )}

          {/* ── Creating ──────────────────────────────────────────── */}
          {step === "creating" && (
            <div className="sgn-creating" role="status">
              <Loader2 className="h-10 w-10 animate-spin" aria-hidden="true" />
              <h1>{creating.title}</h1>
              <p>{creating.detail}</p>
            </div>
          )}

          {/* Back control: only until the store exists. After that the name
              and address it was created with cannot change from here. */}
          {step === "plan" && planPhase === "choose" && !store && (
            <button
              type="button"
              onClick={() => setStep("store")}
              disabled={busy}
              className="sgn-link sgn-back"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Back
            </button>
          )}
        </div>
      </main>

      <footer className="sgn-footer">
        <a href={HELP_URL}>Help</a>
        <a href={`/legal/${PRIVACY_SLUG}`}>Privacy</a>
        <a href={`/legal/${TERMS_SLUG}`}>Terms</a>
      </footer>
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
