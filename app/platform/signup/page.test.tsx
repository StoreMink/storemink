// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// The wizard's Plan step: a store is created first, on Free; a paid plan then
// verifies the owner's mobile and takes the payment. These tests drive the real
// page from the store step (a resumed session) and stub everything that leaves
// the browser.

vi.mock("firebase/auth", () => ({
  createUserWithEmailAndPassword: vi.fn(async () => ({})),
  signInWithEmailAndPassword: vi.fn(async () => ({})),
  GoogleAuthProvider: vi.fn(function GoogleAuthProvider() {}),
  signInWithPopup: vi.fn(async () => ({})),
}));
vi.mock("@/lib/auth/firebase-client", () => ({
  getFirebaseAuth: vi.fn(() => ({})),
  getCurrentFirebaseUser: vi.fn(async () => null),
  establishSession: vi.fn(async () => null),
  endSession: vi.fn(async () => {}),
  firebaseAuthErrorMessage: vi.fn(() => "Something went wrong."),
}));
vi.mock("@/app/actions/store-signup", () => ({
  checkStoreSlugAvailability: vi.fn(async () => ({
    slug: "saffron-studio",
    available: true,
  })),
  createStore: vi.fn(async () => ({
    slug: "saffron-studio",
    storeId: "store-1",
    phoneVerified: false,
  })),
  getSignupResumeInfo: vi.fn(async () => ({
    authenticated: true,
    hasStore: false,
    emailConfirmed: true,
    email: "asha@example.com",
    firstName: "Asha",
    lastName: "Rao",
  })),
  reclaimUnusedSignupEmail: vi.fn(async () => ({ reclaimed: false })),
}));
vi.mock("@/app/actions/subscribe-actions", () => ({
  startSignupSubscribe: vi.fn(async () => ({
    ok: true,
    invoiceId: "inv-1",
    attemptId: "att-1",
    providerOrderId: "order_1",
    keyId: "rzp_test_key",
    amountPaise: 150000,
    suggestedMandateMaxPaise: 500000,
    providerCustomerId: "cust_1",
    mandateMethod: "upi",
    autopay: true,
  })),
  confirmSignupSubscribe: vi.fn(async () => ({
    ok: true,
    plan: "basic",
    periodEnd: "2026-11-09T00:00:00.000Z",
    autopay: true,
  })),
}));
vi.mock("@/lib/payments/razorpay-client", () => ({
  openRazorpayModal: vi.fn(async () => true),
}));
vi.mock("@/app/actions/legal-actions", () => ({
  acceptPlatformPolicies: vi.fn(async () => ({})),
}));
vi.mock("@/app/actions/signup-email-otp", () => ({
  requestSignupEmailOtp: vi.fn(async () => ({ ok: true })),
  verifySignupEmailOtp: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../brand-mark", () => ({ BrandMark: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));
// The mobile step stands in for the real Firebase flow, which has its own
// tests (verify-phone-form.test.tsx): one button that reports a verified
// number, as `usePhoneVerification` does once the server has saved it.
vi.mock("./phone-verify", () => ({
  default: ({ onVerified }: { onVerified: (phone: string) => void }) => (
    <button type="button" onClick={() => onVerified("+919876543210")}>
      Verify stub
    </button>
  ),
}));
vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default: (loader: () => Promise<{ default: React.ComponentType<any> }>) => {
      const Lazy = React.lazy(loader);
      return function Dynamic(props: any) {
        return (
          <React.Suspense fallback={null}>
            <Lazy {...props} />
          </React.Suspense>
        );
      };
    },
  };
});

import SignupPage from "./page";
import { createStore, getSignupResumeInfo } from "@/app/actions/store-signup";
import { establishSession } from "@/lib/auth/firebase-client";
import { verifySignupEmailOtp } from "@/app/actions/signup-email-otp";
import {
  confirmSignupSubscribe,
  startSignupSubscribe,
} from "@/app/actions/subscribe-actions";
import { openRazorpayModal } from "@/lib/payments/razorpay-client";

function price(monthlyInr: number, yearlyInr: number) {
  return { monthlyInr, yearlyInr, baseMonthlyInr: null, baseYearlyInr: null };
}

function quote(overrides: { basicMonthly?: number; paidCheckout?: boolean }) {
  return {
    plans: {
      free: price(0, 0),
      basic: price(overrides.basicMonthly ?? 1500, 15000),
      pro: price(5000, 50000),
    },
    paidCheckout: overrides.paidCheckout ?? true,
  };
}

let quotes: unknown[] = [];
const fetchMock = vi.fn(async (url: string) => {
  if (url !== "/api/plans/pricing") throw new Error(`unexpected ${url}`);
  // Each call takes the next quote; the last one repeats.
  const next = quotes.length > 1 ? quotes.shift() : quotes[0];
  if (next === "fail") return { ok: false, json: async () => ({}) };
  return { ok: true, json: async () => next };
});

const location = {
  hostname: "localhost",
  protocol: "http:",
  port: "3000",
  pathname: "/signup",
  search: "",
  href: "http://localhost:3000/signup",
  assign: vi.fn(),
};

beforeEach(() => {
  // jsdom implements no layout; the error banner scrolls itself into view.
  Element.prototype.scrollIntoView = vi.fn();
  quotes = [quote({})];
  vi.stubGlobal("fetch", fetchMock);
  location.href = "http://localhost:3000/signup";
  Object.defineProperty(window, "location", {
    configurable: true,
    value: location,
  });
});

const DASHBOARD = "http://saffron-studio.localhost:3000/dashboard";

async function reachPlanStep() {
  render(<SignupPage />);
  await screen.findByRole("heading", { name: "About you and your store" });
  fireEvent.change(screen.getByLabelText("Store name"), {
    target: { value: "Saffron Studio" },
  });
  await waitFor(
    () =>
      expect(
        screen.getByText("saffron-studio.storemink.com is available"),
      ).toBeInTheDocument(),
    { timeout: 2000 },
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "Choose your plan" });
  await screen.findByRole("radio", { name: /^Basic/ });
}

function continueWithBasic() {
  fireEvent.click(
    screen.getByRole("button", { name: "Continue with Basic · ₹1,500/month" }),
  );
}

describe("signup Plan step", () => {
  it("preselects Basic and offers Skip beside it", async () => {
    await reachPlanStep();
    expect(screen.getByRole("radio", { name: /^Basic/ })).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Skip, start on Free" }),
    ).toBeInTheDocument();
    // Store creation waits for the merchant's choice.
    expect(createStore).not.toHaveBeenCalled();
  });

  it("★ Skip creates the store on Free and opens its dashboard, taking no payment", async () => {
    await reachPlanStep();
    fireEvent.click(
      screen.getByRole("button", { name: "Skip, start on Free" }),
    );

    await waitFor(() => expect(location.href).toBe(DASHBOARD));
    expect(createStore).toHaveBeenCalledTimes(1);
    // No theme: the store opens on the default and the owner picks another
    // from the dashboard.
    expect(createStore).toHaveBeenCalledWith({
      name: "Saffron Studio",
      firstName: "Asha",
      lastName: "Rao",
      country: "IN",
    });
    expect(startSignupSubscribe).not.toHaveBeenCalled();
    expect(openRazorpayModal).not.toHaveBeenCalled();
  });

  it("choosing Free makes the main button start on Free", async () => {
    await reachPlanStep();
    fireEvent.click(screen.getByRole("radio", { name: /^Free/ }));
    expect(
      screen.queryByRole("button", { name: "Skip, start on Free" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start on Free" }));
    await waitFor(() => expect(location.href).toBe(DASHBOARD));
    expect(startSignupSubscribe).not.toHaveBeenCalled();
  });

  it("★ asks for the owner's mobile before a paid plan, then pays straight away", async () => {
    await reachPlanStep();
    continueWithBasic();

    await screen.findByRole("heading", { name: "Verify your mobile" });
    expect(createStore).toHaveBeenCalledTimes(1);
    expect(startSignupSubscribe).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "Verify stub" }));

    await waitFor(() => expect(openRazorpayModal).toHaveBeenCalledTimes(1));
    expect(startSignupSubscribe).toHaveBeenCalledWith(
      "basic",
      "monthly",
      "upi",
    );
    const params = vi.mocked(openRazorpayModal).mock.calls[0][0];
    expect(params).toMatchObject({
      keyId: "rzp_test_key",
      rzpOrderId: "order_1",
      amountPaise: 150000,
      // An autopay order binds Checkout to the recurring customer.
      customerId: "cust_1",
      prefill: {
        name: "Asha Rao",
        email: "asha@example.com",
        contact: "+919876543210",
      },
    });
  });

  it("a verified mobile goes straight to payment", async () => {
    vi.mocked(createStore).mockImplementation(async () => ({
      slug: "saffron-studio",
      storeId: "store-1",
      phoneVerified: true,
    }));
    await reachPlanStep();
    continueWithBasic();
    await waitFor(() => expect(openRazorpayModal).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("heading", { name: "Verify your mobile" }),
    ).not.toBeInTheDocument();
  });

  it("★ a successful payment is confirmed against the order and opens the dashboard", async () => {
    vi.mocked(createStore).mockImplementation(async () => ({
      slug: "saffron-studio",
      storeId: "store-1",
      phoneVerified: true,
    }));
    vi.mocked(openRazorpayModal).mockImplementation(async (params: any) => {
      params.onSuccess({
        razorpay_order_id: "order_1",
        razorpay_payment_id: "pay_1",
        razorpay_signature: "sig_1",
      });
      return true;
    });
    await reachPlanStep();
    continueWithBasic();

    await waitFor(() => expect(location.href).toBe(DASHBOARD));
    expect(confirmSignupSubscribe).toHaveBeenCalledWith(
      "inv-1",
      "pay_1",
      "sig_1",
    );
  });

  it("★ a dismissed payment leaves the store on Free and never creates a second one", async () => {
    vi.mocked(createStore).mockImplementation(async () => ({
      slug: "saffron-studio",
      storeId: "store-1",
      phoneVerified: true,
    }));
    vi.mocked(openRazorpayModal).mockImplementation(async (params: any) => {
      params.onDismiss();
      return true;
    });
    await reachPlanStep();
    continueWithBasic();

    expect(
      await screen.findByText(/Payment wasn't completed\./),
    ).toBeInTheDocument();
    // The store exists now: Skip becomes "Continue on Free", and there is no
    // Back or Start over that would pretend it does not.
    expect(
      screen.getByRole("button", { name: "Continue on Free" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Back/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Start over/ }),
    ).not.toBeInTheDocument();

    continueWithBasic();
    await waitFor(() => expect(openRazorpayModal).toHaveBeenCalledTimes(2));
    expect(createStore).toHaveBeenCalledTimes(1);
    expect(startSignupSubscribe).toHaveBeenCalledTimes(2);
  });

  it("★ a payment that cannot be confirmed never offers to take it again", async () => {
    vi.mocked(createStore).mockImplementation(async () => ({
      slug: "saffron-studio",
      storeId: "store-1",
      phoneVerified: true,
    }));
    vi.mocked(openRazorpayModal).mockImplementation(async (params: any) => {
      params.onSuccess({
        razorpay_order_id: "order_1",
        razorpay_payment_id: "pay_1",
        razorpay_signature: "sig_1",
      });
      return true;
    });
    vi.mocked(confirmSignupSubscribe).mockImplementation(async () => ({
      ok: false,
      error:
        "Your payment went through but we couldn't switch your plan over. Contact support. Don't pay again.",
    }));
    await reachPlanStep();
    continueWithBasic();

    await screen.findByRole("heading", {
      name: "We couldn't confirm your payment",
    });
    expect(
      screen.getByText(/Your payment went through but we couldn't switch/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Continue with/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open your dashboard" }),
    );
    expect(location.href).toBe(DASHBOARD);
  });

  it("★ re-reads the price before paying and stops when it has changed", async () => {
    quotes = [quote({}), quote({ basicMonthly: 1800 })];
    await reachPlanStep();
    continueWithBasic();

    expect(
      await screen.findByText(
        "The Basic price has just changed to ₹1,800 a month. Check it, then continue.",
      ),
    ).toBeInTheDocument();
    expect(createStore).not.toHaveBeenCalled();
    expect(startSignupSubscribe).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: "Continue with Basic · ₹1,800/month",
      }),
    ).toBeInTheDocument();
  });

  it("a plan above the autopay limit says renewals are invoiced and opens a plain checkout", async () => {
    vi.mocked(createStore).mockImplementation(async () => ({
      slug: "saffron-studio",
      storeId: "store-1",
      phoneVerified: true,
    }));
    vi.mocked(startSignupSubscribe).mockImplementation(async () => ({
      ok: true,
      invoiceId: "inv-1",
      attemptId: "att-1",
      providerOrderId: "order_2",
      keyId: "rzp_test_key",
      amountPaise: 5000000,
      suggestedMandateMaxPaise: 0,
      providerCustomerId: "cust_1",
      mandateMethod: "upi",
      autopay: false,
    }));
    await reachPlanStep();
    fireEvent.click(screen.getByRole("button", { name: /Yearly/ }));
    fireEvent.click(screen.getByRole("radio", { name: /^Pro/ }));
    expect(
      screen.getByText("Renewals for this plan are invoiced."),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Pro · ₹50,000/year" }),
    );
    await waitFor(() => expect(openRazorpayModal).toHaveBeenCalledTimes(1));
    expect(startSignupSubscribe).toHaveBeenCalledWith("pro", "yearly", "upi");
    // No mandate, so no recurring customer: Checkout must treat it as a plain
    // one-time order.
    expect(
      vi.mocked(openRazorpayModal).mock.calls[0][0].customerId,
    ).toBeUndefined();
  });

  it("the card escape is sent as the rail request", async () => {
    vi.mocked(createStore).mockImplementation(async () => ({
      slug: "saffron-studio",
      storeId: "store-1",
      phoneVerified: true,
    }));
    await reachPlanStep();
    fireEvent.click(
      screen.getByRole("button", { name: "Pay by card instead" }),
    );
    continueWithBasic();
    await waitFor(() => expect(startSignupSubscribe).toHaveBeenCalled());
    expect(startSignupSubscribe).toHaveBeenCalledWith(
      "basic",
      "monthly",
      "card",
    );
  });

  it("without the platform gateway, paid plans are shown but cannot be chosen", async () => {
    quotes = [quote({ paidCheckout: false })];
    render(<SignupPage />);
    await screen.findByRole("heading", { name: "About you and your store" });
    fireEvent.change(screen.getByLabelText("Store name"), {
      target: { value: "Saffron Studio" },
    });
    await waitFor(
      () =>
        expect(
          screen.getByText("saffron-studio.storemink.com is available"),
        ).toBeInTheDocument(),
      { timeout: 2000 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const basic = await screen.findByRole("radio", { name: /^Basic/ });
    expect(basic).toBeDisabled();
    expect(screen.getByRole("radio", { name: /^Free/ })).toBeChecked();
    expect(
      screen.getByText(/Paid plans can't be bought during signup right now/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start on Free" }));
    await waitFor(() => expect(location.href).toBe(DASHBOARD));
  });

  it("an unreadable price list still lets the merchant start on Free, and retries", async () => {
    quotes = ["fail"];
    render(<SignupPage />);
    await screen.findByRole("heading", { name: "About you and your store" });
    fireEvent.change(screen.getByLabelText("Store name"), {
      target: { value: "Saffron Studio" },
    });
    await waitFor(
      () =>
        expect(
          screen.getByText("saffron-studio.storemink.com is available"),
        ).toBeInTheDocument(),
      { timeout: 2000 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByText(/We couldn't load plan prices right now/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: /^Basic/ }),
    ).not.toBeInTheDocument();

    quotes = [quote({})];
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await screen.findByRole("radio", { name: /^Basic/ });
  });

  it("a store creation refused because the account already has one continues with that store", async () => {
    vi.mocked(createStore).mockImplementation(async () => ({
      error: "This account already has a store.",
    }));
    const { getSignupResumeInfo } = await import("@/app/actions/store-signup");
    let resumes = 0;
    vi.mocked(getSignupResumeInfo).mockImplementation(async () => {
      resumes += 1;
      // The mount-time resume finds no store; by the time creation runs, the
      // lost reply's store exists.
      return resumes === 1
        ? {
            authenticated: true,
            hasStore: false,
            emailConfirmed: true,
            email: "asha@example.com",
            firstName: "Asha",
            lastName: "Rao",
          }
        : {
            authenticated: true,
            hasStore: true,
            slug: "saffron-studio",
            phoneVerified: false,
            emailConfirmed: true,
          };
    });
    await reachPlanStep();
    fireEvent.click(
      screen.getByRole("button", { name: "Skip, start on Free" }),
    );
    await waitFor(() => expect(location.href).toBe(DASHBOARD));
  });
});

describe("signup email code on a resumed tab", () => {
  it("★ an accepted code moves on to the store step even when the browser cannot refresh its session", async () => {
    // The tab was reloaded: the wizard resumed from the server session at the
    // email-code step, and the browser has no restored sign-in to refresh.
    vi.mocked(getSignupResumeInfo).mockImplementation(async () => ({
      authenticated: true,
      hasStore: false,
      emailConfirmed: false,
      email: "asha@example.com",
      firstName: "Asha",
      lastName: "Rao",
    }));
    vi.mocked(establishSession).mockImplementation(
      async () => "You're not signed in. Please try again.",
    );
    render(<SignupPage />);
    await screen.findByRole("heading", { name: "Check your email" });

    fireEvent.change(screen.getByLabelText("Verification code"), {
      target: { value: "152337" },
    });

    await screen.findByRole("heading", { name: "About you and your store" });
    expect(verifySignupEmailOtp).toHaveBeenCalledWith("152337");
    expect(
      screen.queryByText("You're not signed in. Please try again."),
    ).not.toBeInTheDocument();
  });

  it("a wrong code still says so and stays on the step", async () => {
    vi.mocked(getSignupResumeInfo).mockImplementation(async () => ({
      authenticated: true,
      hasStore: false,
      emailConfirmed: false,
      email: "asha@example.com",
    }));
    vi.mocked(verifySignupEmailOtp).mockImplementation(async () => ({
      ok: false,
      error: "Incorrect code. 4 attempts left.",
    }));
    render(<SignupPage />);
    await screen.findByRole("heading", { name: "Check your email" });
    fireEvent.change(screen.getByLabelText("Verification code"), {
      target: { value: "000000" },
    });
    expect(
      await screen.findByText("Incorrect code. 4 attempts left."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Check your email" }),
    ).toBeInTheDocument();
  });
});
