// @vitest-environment jsdom
// Cancelling, as the merchant reads it on Plans & Billing (renewal-cancel
// design 8.1, 8.3 and 8.4).
//
// Every sentence here is a promise about money: what they keep, until when,
// and what happens to a renewal invoice that is open, paid or still going
// through. So the tests pin the exact words, case by case, and the two rules
// the screen must never break: the cancelling banner shows only while the
// subscription is live and cancelling, and a refusal to pay is shown exactly
// as the server worded it.
//
// GST (design 7.3, 7.4): the prices, the next renewal, the checkout summary
// from `quoteCheckout`, the state and outside-India prompts, and the amount
// guard on every button here that opens a payment window: a start that asks
// for a different amount than the screen showed never opens Razorpay, and an
// equal one opens it exactly once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  actions: {
    cancelMySubscription: vi.fn(),
    resumeMySubscription: vi.fn(),
    changeMyPlan: vi.fn(),
    confirmMyPlanChange: vi.fn(),
    confirmSubscribe: vi.fn(),
    startSubscribe: vi.fn(),
    startPayInvoice: vi.fn(),
    confirmPayInvoice: vi.fn(),
    quoteCheckout: vi.fn(),
    saveMyBillingDetails: vi.fn(),
  },
  credits: {
    confirmCreditPurchase: vi.fn(),
    startCreditPurchase: vi.fn(),
  },
  openRazorpayModal: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/app/actions/subscribe-actions", () => h.actions);
vi.mock("@/app/actions/ai-credit-actions", () => h.credits);
vi.mock("@/lib/payments/razorpay-client", () => ({
  openRazorpayModal: h.openRazorpayModal,
}));

import { PlansBillingClient } from "./plans-client";
import { OpenInvoices } from "./open-invoices";
import { GstNotice } from "./gst-notice";
import { BillingDetailsCard, StatePrompt } from "./billing-details-card";
import type {
  NextInvoiceView,
  PayableInvoice,
  SubscriptionView,
} from "@/lib/billing/invoice-types";
import type { AiUsagePageData } from "@/app/actions/ai-credit-actions";
import type {
  AmountQuote,
  BillingDetailsView,
  CheckoutQuoteResult,
  RenewalQuote,
} from "@/lib/billing/quote-types";
import type { TaxTerms } from "@/lib/billing/tax-terms";
import type { CreditPack } from "@/lib/ai/credits";
import { amountFor } from "@/lib/billing/tax-copy";

/** 30 Oct 2026, 12:00 in India. */
const PERIOD_END = "2026-10-30T06:30:00.000Z";
/** 1 Nov 2026, 14:00 in India. */
const GRACE_END = "2026-11-01T08:30:00.000Z";
/** 24 Oct 2026, 15:30 in India. */
const ASKED_AT = "2026-10-24T10:00:00.000Z";
const REFUND_TIMING = "after your plan ends, usually within 5 working days";

function invoice(over: Partial<NextInvoiceView> = {}): NextInvoiceView {
  return {
    id: "inv-next",
    status: "open",
    totalPaise: 2_400_00,
    invoiceRef: "SM/2026-27/00042",
    inFlight: false,
    ...over,
  };
}
const OPEN = invoice();
const IN_FLIGHT = invoice({ status: "processing", inFlight: true });
const PAID = invoice({ status: "paid" });

function subscription(over: Partial<SubscriptionView> = {}): SubscriptionView {
  return {
    plan: "pro",
    period: "monthly",
    status: "active",
    currentEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    scheduledPlan: null,
    scheduledPeriod: null,
    scheduledLocations: null,
    autopay: false,
    active: true,
    nextInvoice: null,
    graceEndsAt: null,
    cancelRequestedBy: null,
    cancelRequestedAt: null,
    ...over,
  };
}

const DATA: AiUsagePageData = {
  usage: {
    used: 10,
    cap: 300,
    creditBalance: 0,
    resetsAt: "2026-11-15T00:00:00.000Z",
    available: true,
  },
  plan: "pro",
  planExpiresAt: null,
  planSource: "paid",
  compOffer: null,
  compActive: null,
  paidPlan: "pro",
  canBuyCredits: true,
  purchasesAvailable: true,
  ledger: [],
};

const PRICE = (monthlyInr: number, yearlyInr: number) => ({
  monthlyInr,
  yearlyInr,
  baseMonthlyInr: null,
  baseYearlyInr: null,
});

// ── GST fixtures ──────────────────────────────────────────────────────────

const OFF: TaxTerms = {
  active: false,
  inclusive: false,
  rateBps: 0,
  upcoming: null,
};
const ON_EX: TaxTerms = {
  active: true,
  inclusive: false,
  rateBps: 1800,
  upcoming: null,
};
/** GST added on top from 1 Dec 2026 (00:00 IST), off until then. */
const SCHED_EX: TaxTerms = {
  ...OFF,
  upcoming: {
    enabled: true,
    inclusive: false,
    rateBps: 1800,
    startsAt: "2026-11-30T18:30:00.000Z",
  },
};

function quoteAmount(listPaise: number, terms: TaxTerms): AmountQuote {
  return {
    ...amountFor(listPaise, terms),
    listedPaise: listPaise,
    taxablePaise: listPaise,
  };
}

const PACK: CreditPack = {
  id: "pack-60",
  name: "Starter",
  credits: 60,
  priceInr: 129,
};

type QuoteOpts = {
  terms?: TaxTerms;
  /** The payment now, in paise before GST; null for nothing to pay now. */
  payNow?: number | null;
  renewal?: number;
  period?: "monthly" | "yearly";
  kind?: "subscribe" | "change";
  timing?: "now" | "scheduled";
  autopay?: boolean;
  needsState?: boolean;
  outsideIndia?: boolean;
  earlierPayment?: boolean;
  pack?: number | null;
};

function okQuote(o: QuoteOpts = {}): CheckoutQuoteResult {
  const terms = o.terms ?? OFF;
  const period = o.period ?? "yearly";
  const earlier = o.earlierPayment ?? false;
  const payNowList = o.payNow === undefined ? 15_000_00 : o.payNow;
  const payNow =
    earlier || payNowList === null ? null : quoteAmount(payNowList, terms);
  const renewal = earlier
    ? null
    : {
        plan: "basic" as const,
        period,
        amount: quoteAmount(o.renewal ?? 15_000_00, terms),
        issuedAt: "2027-10-26T06:30:00.000Z",
        renewsOn: "2027-10-30T06:30:00.000Z",
        autopay: o.autopay ?? false,
      };
  const flags = {
    terms,
    needsState: o.needsState ?? false,
    outsideIndia: o.outsideIndia ?? false,
  };
  const plan =
    (o.kind ?? "subscribe") === "subscribe"
      ? {
          kind: "subscribe" as const,
          plan: "basic" as const,
          period,
          earlierPayment: earlier,
          payNow,
          resumed: false,
          renewal,
          ...flags,
        }
      : {
          kind: "change" as const,
          plan: "basic" as const,
          period,
          earlierPayment: earlier,
          timing: o.timing ?? "now",
          payNow: o.timing === "scheduled" ? null : payNow,
          effectiveAt: o.timing === "scheduled" ? PERIOD_END : null,
          renewal,
          ...flags,
        };
  return {
    ok: true,
    plan,
    pack:
      o.pack === undefined || o.pack === null
        ? null
        : quoteAmount(o.pack, terms),
    ...flags,
  };
}

function nextRenewal(over: Partial<RenewalQuote> = {}): RenewalQuote {
  return {
    plan: "pro",
    period: "monthly",
    billedLocations: 0,
    amount: quoteAmount(2_400_00, ON_EX),
    issued: false,
    issuedAt: "2026-10-26T06:30:00.000Z",
    renewsOn: PERIOD_END,
    route: { auto: false, reason: "no_mandate" },
    autoCollect: false,
    reason: "no_mandate",
    mandateMaxPaise: null,
    terms: ON_EX,
    placeOfSupply: { code: "07", basis: "billing_state" },
    ...over,
  };
}

function billingDetails(
  over: Partial<BillingDetailsView> = {},
): BillingDetailsView {
  return {
    saved: true,
    legalName: "Kesar Ghani LLP",
    gstin: "",
    stateCode: "07",
    country: "IN",
    countryName: "",
    addressLine1: "12 MG Road",
    addressLine2: "",
    city: "New Delhi",
    postalCode: "110001",
    prefilledFrom: null,
    placeOfSupply: { code: "07", name: "Delhi", basis: "billing_state" },
    ...over,
  };
}

type RenderOpts = {
  canManage?: boolean;
  terms?: TaxTerms | null;
  nextRenewal?: RenewalQuote | null;
  billingDetails?: BillingDetailsView | null;
  packs?: CreditPack[];
  data?: AiUsagePageData;
};

function renderPlans(
  sub: Partial<SubscriptionView> = {},
  opts: RenderOpts = {},
) {
  return render(
    <PlansBillingClient
      initialData={opts.data ?? DATA}
      subscription={subscription(sub)}
      packs={opts.packs ?? []}
      canManage={opts.canManage ?? true}
      pricing={{
        free: PRICE(0, 0),
        basic: PRICE(1500, 15000),
        pro: PRICE(2400, 24000),
      }}
      includedCredits={{ free: 20, basic: 100, pro: 300 }}
      terms={opts.terms === undefined ? OFF : opts.terms}
      nextRenewal={opts.nextRenewal ?? null}
      billingDetails={opts.billingDetails ?? null}
    />,
  );
}

/** Press Cancel subscription and return what the confirmation asked. */
function confirmText(sub: Partial<SubscriptionView>): string {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  renderPlans(sub);
  fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));
  expect(confirm).toHaveBeenCalledTimes(1);
  return String(confirm.mock.calls[0][0]);
}

/** The cancelling banner's sentence, or null when none is shown. */
function bannerText(): string | null {
  const banner = screen.queryByText(/^Cancelled - /);
  return banner ? banner.textContent : null;
}

beforeEach(() => {
  h.actions.cancelMySubscription.mockResolvedValue({
    ok: true,
    message:
      "Cancelled. You keep your Pro plan until 30 Oct 2026, then move to Free.",
  });
  h.actions.resumeMySubscription.mockResolvedValue({
    ok: true,
    message: "Resumed. Your renewal is already paid, so your plan continues.",
    advanced: true,
  });
  h.actions.quoteCheckout.mockResolvedValue(okQuote());
  h.actions.saveMyBillingDetails.mockResolvedValue({ ok: true });
  h.openRazorpayModal.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the cancel confirmation (design 8.1)", () => {
  it("case 1: no paid cycle promises nothing kept", () => {
    expect(confirmText({ currentEnd: null })).toBe(
      "Cancel your subscription? No payments will be taken.",
    );
  });

  it("case 2: active, no next invoice", () => {
    expect(confirmText({})).toBe(
      "Cancel your subscription? You keep your Pro plan until 30 Oct 2026, then your store moves to the Free plan. No more payments will be taken.",
    );
  });

  it("case 3: the renewal invoice is open, named by its number", () => {
    expect(confirmText({ nextInvoice: OPEN })).toBe(
      "Cancel your subscription? You keep your Pro plan until 30 Oct 2026, then your store moves to the Free plan. Your renewal invoice SM/2026-27/00042 won't be charged.",
    );
  });

  it("case 3 without a number: no number is invented", () => {
    cleanup();
    expect(confirmText({ nextInvoice: invoice({ invoiceRef: null }) })).toBe(
      "Cancel your subscription? You keep your Pro plan until 30 Oct 2026, then your store moves to the Free plan. Your renewal invoice won't be charged.",
    );
  });

  it("case 4: a renewal payment is already under way", () => {
    expect(confirmText({ nextInvoice: IN_FLIGHT })).toBe(
      `Cancel your subscription? You keep your Pro plan until 30 Oct 2026, then your store moves to the Free plan. A renewal payment of ₹2,400 is already under way and can't be stopped. If it goes through, we refund it ${REFUND_TIMING}.`,
    );
  });

  it("case 5: the renewal is already paid", () => {
    expect(confirmText({ nextInvoice: PAID })).toBe(
      `Cancel your subscription? You keep your Pro plan until 30 Oct 2026, then your store moves to the Free plan. We refund your renewal payment of ₹2,400 ${REFUND_TIMING}.`,
    );
  });

  it("case 6: past due, the plan ends when grace ends, with the time", () => {
    expect(
      confirmText({
        status: "past_due",
        graceEndsAt: GRACE_END,
        nextInvoice: OPEN,
      }),
    ).toBe(
      "Cancel your subscription? Your renewal hasn't been paid, so your Pro plan ends on 1 Nov 2026, 14:00 IST and your store moves to the Free plan. Your unpaid invoice won't be charged.",
    );
  });

  it("case 7: past due with a payment still going through", () => {
    expect(
      confirmText({
        status: "grace",
        graceEndsAt: GRACE_END,
        nextInvoice: IN_FLIGHT,
      }),
    ).toBe(
      "Cancel your subscription? Your Pro plan ends on 1 Nov 2026, 14:00 IST and your store moves to the Free plan. A renewal payment of ₹2,400 is still going through. If it completes, we refund it.",
    );
  });

  it("names the SUBSCRIPTION's plan, not a comp's", () => {
    // The effective plan (DATA.plan) is Pro; the subscription is on Basic.
    expect(confirmText({ plan: "basic" })).toContain("your Basic plan");
  });

  it("a declined confirmation cancels nothing", () => {
    confirmText({});
    expect(h.actions.cancelMySubscription).not.toHaveBeenCalled();
  });

  it("an accepted one cancels and shows the server's message", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPlans();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel subscription" }),
    );
    await vi.waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith(
        "Cancelled. You keep your Pro plan until 30 Oct 2026, then move to Free.",
      ),
    );
    expect(h.actions.cancelMySubscription).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalled();
  });

  it("a refused cancel shows the server's refusal", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    h.actions.cancelMySubscription.mockResolvedValue({
      ok: false,
      error: "Your subscription is already cancelling.",
    });
    renderPlans();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel subscription" }),
    );
    await vi.waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith(
        "Your subscription is already cancelling.",
      ),
    );
    expect(h.toast.success).not.toHaveBeenCalled();
  });
});

describe("the cancelling banner (design 8.3)", () => {
  it("★★ is NOT shown while the plan is not cancelling", () => {
    renderPlans({ nextInvoice: OPEN });
    expect(bannerText()).toBeNull();
    expect(
      screen.getByRole("button", { name: "Cancel subscription" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Keep my plan" })).toBeNull();
  });

  it("★★ is NOT shown once the plan has ended, whatever the flag says (defect D6)", () => {
    renderPlans({
      status: "downgraded",
      active: false,
      cancelAtPeriodEnd: true,
    });
    expect(bannerText()).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep my plan" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Cancel subscription" }),
    ).toBeNull();
  });

  it("active, nothing issued: what they keep and until when", () => {
    renderPlans({ cancelAtPeriodEnd: true });
    expect(bannerText()).toBe(
      "Cancelled - you keep Pro until 30 Oct 2026, then move to Free.",
    );
  });

  it("active, the renewal invoice is open", () => {
    renderPlans({ cancelAtPeriodEnd: true, nextInvoice: OPEN });
    expect(bannerText()).toBe(
      "Cancelled - you keep Pro until 30 Oct 2026, then move to Free. Your renewal invoice won't be charged.",
    );
  });

  it("active, a renewal payment is in flight", () => {
    renderPlans({ cancelAtPeriodEnd: true, nextInvoice: IN_FLIGHT });
    expect(bannerText()).toBe(
      `Cancelled - you keep Pro until 30 Oct 2026, then move to Free. A renewal payment of ₹2,400 is still going through. If it completes, we refund it ${REFUND_TIMING}.`,
    );
  });

  it("active, the renewal is paid", () => {
    renderPlans({ cancelAtPeriodEnd: true, nextInvoice: PAID });
    expect(bannerText()).toBe(
      `Cancelled - you keep Pro until 30 Oct 2026, then move to Free. We refund your renewal payment of ₹2,400 ${REFUND_TIMING}.`,
    );
  });

  it("grace, unpaid: the plan ends when grace ends", () => {
    renderPlans({
      status: "past_due",
      cancelAtPeriodEnd: true,
      graceEndsAt: GRACE_END,
      nextInvoice: OPEN,
    });
    expect(bannerText()).toBe(
      "Cancelled - your Pro plan ends on 1 Nov 2026, 14:00 IST, then your store moves to Free. Your unpaid invoice won't be charged.",
    );
  });

  it("grace, a payment under way", () => {
    renderPlans({
      status: "grace",
      cancelAtPeriodEnd: true,
      graceEndsAt: GRACE_END,
      nextInvoice: IN_FLIGHT,
    });
    expect(bannerText()).toBe(
      "Cancelled - your Pro plan ends on 1 Nov 2026, 14:00 IST, then your store moves to Free. A renewal payment of ₹2,400 is still going through. If it completes, we refund it.",
    );
  });

  it("grace, the renewal was paid while they were cancelling", () => {
    renderPlans({
      status: "grace",
      cancelAtPeriodEnd: true,
      graceEndsAt: GRACE_END,
      nextInvoice: PAID,
    });
    expect(bannerText()).toBe(
      `Cancelled - your Pro plan ends on 1 Nov 2026, 14:00 IST, then your store moves to Free. Your renewal was paid while you were cancelling. Choose Keep my plan to keep it, or we refund it ${REFUND_TIMING}.`,
    );
  });

  it("★ says when StoreMink cancelled it at their request", () => {
    renderPlans({
      cancelAtPeriodEnd: true,
      nextInvoice: OPEN,
      cancelRequestedBy: "operator",
      cancelRequestedAt: ASKED_AT,
    });
    expect(bannerText()).toBe(
      "Cancelled - you keep Pro until 30 Oct 2026, then move to Free. Your renewal invoice won't be charged. Cancelled by StoreMink at your request on 24 Oct 2026.",
    );
  });

  it("names no operator when the merchant cancelled it themselves", () => {
    renderPlans({
      cancelAtPeriodEnd: true,
      cancelRequestedBy: "merchant",
      cancelRequestedAt: ASKED_AT,
    });
    expect(bannerText()).not.toContain("StoreMink");
  });

  it("shows no buttons to someone who cannot manage billing", () => {
    renderPlans({ cancelAtPeriodEnd: true }, { canManage: false });
    expect(bannerText()).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Keep my plan" })).toBeNull();
  });
});

describe("Keep my plan", () => {
  it("★ works in grace, and shows the server's message", async () => {
    renderPlans({
      status: "grace",
      cancelAtPeriodEnd: true,
      graceEndsAt: GRACE_END,
      nextInvoice: PAID,
    });
    fireEvent.click(screen.getByRole("button", { name: "Keep my plan" }));
    await vi.waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith(
        "Resumed. Your renewal is already paid, so your plan continues.",
      ),
    );
    expect(h.actions.resumeMySubscription).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalled();
  });

  it("a toast that the advance is still to come is shown as worded", async () => {
    h.actions.resumeMySubscription.mockResolvedValue({
      ok: true,
      message:
        "Resumed. Your renewal is already paid, so your plan continues. We'll finish renewing it when grace ends on 1 Nov 2026, 14:00 IST.",
      advanced: false,
    });
    renderPlans({
      status: "past_due",
      cancelAtPeriodEnd: true,
      graceEndsAt: GRACE_END,
      nextInvoice: PAID,
    });
    fireEvent.click(screen.getByRole("button", { name: "Keep my plan" }));
    await vi.waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith(
        "Resumed. Your renewal is already paid, so your plan continues. We'll finish renewing it when grace ends on 1 Nov 2026, 14:00 IST.",
      ),
    );
  });

  it("a refusal is shown as an error", async () => {
    h.actions.resumeMySubscription.mockResolvedValue({
      ok: false,
      error:
        "That subscription can't be resumed. Subscribe again to start a new cycle.",
    });
    renderPlans({ cancelAtPeriodEnd: true });
    fireEvent.click(screen.getByRole("button", { name: "Keep my plan" }));
    await vi.waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith(
        "That subscription can't be resumed. Subscribe again to start a new cycle.",
      ),
    );
  });
});

describe("paying an open invoice (design 8.4)", () => {
  const OWED: PayableInvoice = {
    id: "inv-9",
    invoiceRef: "SM/2026-27/00009",
    status: "open",
    totalPaise: 2_400_00,
    periodStart: "2026-10-30T06:30:00.000Z",
    periodEnd: "2026-11-29T06:30:00.000Z",
    dueAt: "2026-10-30T06:30:00.000Z",
    createdAt: "2026-10-26T06:30:00.000Z",
    taxPaise: 0,
    taxRateBps: null,
    taxInclusive: false,
    autopayAt: null,
  };

  async function refusedWith(error: string) {
    h.actions.startPayInvoice.mockResolvedValue({ ok: false, error });
    render(<OpenInvoices invoices={[OWED]} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));
    await vi.waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
  }

  it("★★ shows the cancelling refusal exactly as the server words it", async () => {
    const message =
      "You've cancelled your plan, so this invoice won't be charged. To keep your plan, choose Keep my plan first.";
    await refusedWith(message);
    expect(h.toast.error).toHaveBeenCalledWith(message);
    // The list is out of date: the server's list leaves this invoice out now.
    expect(h.refresh).toHaveBeenCalled();
  });

  it("shows the closed-invoice refusal exactly as the server words it", async () => {
    const message =
      "That invoice is closed and can't be paid. Subscribe again to start a new cycle.";
    await refusedWith(message);
    expect(h.toast.error).toHaveBeenCalledWith(message);
  });

  it("★ a payment that arrived after the plan ended is news, not a failure", async () => {
    const message =
      "Your plan ended before this payment arrived, so we're refunding it to the account you paid from, usually within 5 working days.";
    h.actions.startPayInvoice.mockResolvedValue({
      ok: true,
      invoiceId: "inv-9",
      providerOrderId: "order_9",
      keyId: "rzp_1",
      amountPaise: 2_400_00,
      invoiceRef: "SM/2026-27/00009",
    });
    h.actions.confirmPayInvoice.mockResolvedValue({
      ok: false,
      error: message,
    });
    h.openRazorpayModal.mockImplementation(
      async (opts: {
        onSuccess: (res: {
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => Promise<void>;
      }) => {
        await opts.onSuccess({
          razorpay_payment_id: "pay_1",
          razorpay_signature: "sig",
        });
        return true;
      },
    );
    render(<OpenInvoices invoices={[OWED]} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));
    await vi.waitFor(() => expect(h.toast.info).toHaveBeenCalledWith(message));
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.toast.success).not.toHaveBeenCalled();
  });
});

describe("an earlier payment that was finished instead (RC-F1b, RC-F1c)", () => {
  const FREE_DATA: AiUsagePageData = {
    ...DATA,
    plan: "free",
    paidPlan: "free",
  };

  function renderFree() {
    return renderPlans(
      {
        plan: "free",
        status: "inactive",
        active: false,
        currentEnd: null,
      },
      { data: FREE_DATA },
    );
  }

  // ★ "Continue to payment" stays disabled until the quote's total is shown
  // (GST design 7.3), so the press waits for it.
  async function reachPayment() {
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Basic" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Mink credits" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review purchase" }));
    const pay = screen.getByRole("button", { name: "Continue to payment" });
    await vi.waitFor(() =>
      expect((pay as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(pay);
  }

  async function reachChange() {
    fireEvent.click(screen.getByRole("button", { name: "Switch to Basic" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Mink credits" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review purchase" }));
    const button = screen.getByRole("button", {
      name: /Pay prorated change|Schedule at renewal/,
    });
    await vi.waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(button);
  }

  it("★★ shows success, never an error, and opens no second payment", async () => {
    const message =
      "Your earlier payment went through, and your plan is now active.";
    h.actions.startSubscribe.mockResolvedValue({
      ok: true,
      completedEarlier: true,
      message,
    });
    renderFree();
    await reachPayment();
    await vi.waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith(message),
    );
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
    // The page reloads its plan, as after a payment made here.
    await vi.waitFor(() => expect(h.refresh).toHaveBeenCalled());
  });

  it("★ a payment that went through but switches shortly is a notice with nothing to retry", async () => {
    const message =
      "Your earlier payment went through, and we'll switch your plan on shortly. Please don't pay again. If it hasn't changed within a day, write to support@storemink.com.";
    h.actions.startSubscribe.mockResolvedValue({
      ok: false,
      error: message,
      waiting: true,
    });
    renderFree();
    await reachPayment();
    await vi.waitFor(() => expect(h.toast.info).toHaveBeenCalledWith(message));
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
    // The window closes: no "Continue to payment" left to press again.
    await vi.waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Continue to payment" }),
      ).toBeNull(),
    );
  });

  it("an ordinary refusal is still an error, and the window stays open", async () => {
    h.actions.startSubscribe.mockResolvedValue({
      ok: false,
      error: "Couldn't start the payment.",
    });
    renderFree();
    await reachPayment();
    await vi.waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith("Couldn't start the payment."),
    );
    expect(h.toast.info).not.toHaveBeenCalled();
    // The window's button comes back once the refusal has re-rendered it.
    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Continue to payment" }),
      ).toBeTruthy(),
    );
  });

  it("★ a plan change paid earlier and finished instead is a success", async () => {
    const message =
      "Your earlier payment went through, and you're now on Basic.";
    h.actions.changeMyPlan.mockResolvedValue({
      ok: true,
      scheduled: false,
      completedEarlier: true,
      message,
    });
    renderPlans();
    await reachChange();
    await vi.waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith(message),
    );
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
  });

  it("★ a plan change that switches shortly is a notice, never an error", async () => {
    const message =
      "Your earlier payment went through, and we'll switch your plan shortly. Please don't pay again. If it hasn't changed within a day, write to support@storemink.com.";
    h.actions.changeMyPlan.mockResolvedValue({
      ok: false,
      error: message,
      waiting: true,
    });
    renderPlans();
    await reachChange();
    await vi.waitFor(() => expect(h.toast.info).toHaveBeenCalledWith(message));
    expect(h.toast.error).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: /Pay prorated change|Schedule at renewal/,
        }),
      ).toBeNull(),
    );
  });
});

// ── GST on Plans & Billing (design 7.3) ────────────────────────────────────

const FREE_STORE: AiUsagePageData = { ...DATA, plan: "free", paidPlan: "free" };
const NO_SUBSCRIPTION: Partial<SubscriptionView> = {
  plan: "free",
  status: "inactive",
  active: false,
  currentEnd: null,
};

/** A Razorpay window that is paid at once. */
function payImmediately() {
  h.openRazorpayModal.mockImplementation(
    async (opts: {
      onSuccess: (res: {
        razorpay_payment_id: string;
        razorpay_signature: string;
      }) => Promise<void>;
    }) => {
      await opts.onSuccess({
        razorpay_payment_id: "pay_1",
        razorpay_signature: "sig",
      });
      return true;
    },
  );
}

function enrolment(amountPaise: number) {
  return {
    ok: true,
    invoiceId: "inv-1",
    attemptId: "att-1",
    providerOrderId: "order_1",
    keyId: "rzp_1",
    amountPaise,
    suggestedMandateMaxPaise: 0,
    providerCustomerId: "cust_1",
    mandateMethod: "upi",
    autopay: false,
  };
}

function creditStart(amountPaise: number) {
  return {
    success: true,
    purchaseId: "pur-1",
    rzpOrderId: "order_c",
    keyId: "rzp_1",
    amountPaise,
    packName: "Starter",
  };
}

/** Upgrade a Free store to Basic (yearly) and reach the review stage. */
async function toReview(opts: { pack?: boolean } = {}) {
  fireEvent.click(screen.getByRole("button", { name: "Upgrade to Basic" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Continue to Mink credits" }),
  );
  if (opts.pack) {
    fireEvent.click(screen.getByRole("button", { name: /^60 credits/ }));
  }
  fireEvent.click(screen.getByRole("button", { name: "Review purchase" }));
}

async function enabled(name: string | RegExp): Promise<HTMLButtonElement> {
  // The label can change when the quote lands ("Schedule at renewal" against
  // "Pay prorated change"), so wait for the name, then for the button to wake.
  const button = (await screen.findByRole("button", {
    name,
  })) as HTMLButtonElement;
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

describe("the plan card (design 7.3)", () => {
  it("prices the current plan for the subscription's own period", () => {
    renderPlans({ period: "yearly" }, { terms: ON_EX });
    expect(screen.getByText("₹24,000 a year plus GST")).toBeTruthy();
  });

  it("monthly, with GST included", () => {
    renderPlans({}, { terms: { ...ON_EX, inclusive: true } });
    expect(screen.getByText("₹2,400 a month, including GST")).toBeTruthy();
  });

  it("★ a failed terms read shows the list price with no GST words", () => {
    renderPlans({}, { terms: null });
    expect(screen.getByText("₹2,400 a month")).toBeTruthy();
    expect(screen.queryByText(/GST/)).toBeNull();
  });

  it("shows the next renewal, its GST, and the amber line when it is invoiced", () => {
    renderPlans({}, { terms: ON_EX, nextRenewal: nextRenewal() });
    expect(screen.getByText("Next renewal")).toBeTruthy();
    expect(screen.getByText("₹2,832 on 30 Oct 2026")).toBeTruthy();
    expect(screen.getByText("Including ₹432 GST")).toBeTruthy();
    expect(
      screen.getByText(
        "We'll email you an invoice for your next renewal of ₹2,832 to pay by 30 Oct 2026.",
      ),
    ).toBeTruthy();
  });

  it("no amber line when the renewal is collected automatically", () => {
    renderPlans(
      {},
      {
        terms: ON_EX,
        nextRenewal: nextRenewal({ route: { auto: true }, autoCollect: true }),
      },
    );
    expect(screen.queryByText(/We'll email you an invoice/)).toBeNull();
  });

  it("names the limit when the renewal is above the autopay limit approved", () => {
    renderPlans(
      {},
      {
        terms: ON_EX,
        nextRenewal: nextRenewal({
          route: { auto: false, reason: "over_mandate" },
          reason: "over_mandate",
          mandateMaxPaise: 2_500_00,
        }),
      },
    );
    expect(
      screen.getByText(
        "Your next renewal of ₹2,832 is above the ₹2,500 autopay limit you approved, so we'll email you an invoice to pay by 30 Oct 2026.",
      ),
    ).toBeTruthy();
  });

  it("the plans grid says plus GST under the paid prices", () => {
    renderPlans({}, { terms: ON_EX });
    expect(screen.getAllByText("plus GST")).toHaveLength(2);
  });

  it("the plans grid says nothing while GST is off", () => {
    renderPlans({}, { terms: OFF });
    expect(screen.queryByText("plus GST")).toBeNull();
    expect(screen.queryByText("including GST")).toBeNull();
  });

  // R2-12: every date on the card is India's, in the GST copy's one style
  // ("1 Dec 2026"): a cycle ending at 00:00 IST must not read as the day
  // before in a browser outside India, nor with a leading zero.
  it("dates the cycle end in India time, with no leading zero", () => {
    /** 00:00 IST on 1 December 2026. */
    const end = "2026-11-30T18:30:00.000Z";
    renderPlans({ currentEnd: end });
    expect(screen.getByText("1 Dec 2026")).toBeTruthy();
    expect(screen.getByText(/runs to 1 Dec 2026/)).toBeTruthy();
    expect(screen.queryByText(/01 Dec 2026|30 Nov 2026/)).toBeNull();
  });
});

describe("the Mink credit packs panel (design 7.3, decision 10)", () => {
  it("★ shows the amount payable now and never a price per credit", () => {
    renderPlans({}, { terms: ON_EX, packs: [PACK] });
    expect(screen.getByText("₹152.22 including GST")).toBeTruthy();
    expect(screen.queryByText(/\/credit/)).toBeNull();
  });

  it("GST off: the list price alone", () => {
    renderPlans({}, { terms: OFF, packs: [PACK] });
    expect(screen.getByText("₹129")).toBeTruthy();
  });

  it("asks for the state before Buy now when GST needs it", async () => {
    renderPlans(
      {},
      {
        terms: ON_EX,
        packs: [PACK],
        billingDetails: billingDetails({
          stateCode: "",
          placeOfSupply: {
            code: "03",
            name: "Punjab",
            basis: "supplier_state",
          },
        }),
      },
    );
    expect(
      screen.getByText(
        "Add your state before you pay. It goes on your GST invoice.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Buy now" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    const prompt = screen.getByLabelText("State") as HTMLSelectElement;
    expect(prompt.value).toBe("");
    expect(prompt.options[0].textContent).toBe("Choose your state");
    fireEvent.change(prompt, {
      target: { value: "07" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() =>
      expect(h.actions.saveMyBillingDetails).toHaveBeenCalledWith({
        stateCode: "07",
      }),
    );
    await vi.waitFor(() => expect(h.refresh).toHaveBeenCalled());
  });

  it("outside India: the sentence, and Buy now stays off", () => {
    renderPlans(
      {},
      {
        terms: ON_EX,
        packs: [PACK],
        billingDetails: billingDetails({
          country: "US",
          placeOfSupply: { code: "96", name: null, basis: "outside_india" },
        }),
      },
    );
    expect(
      screen.getByText(
        "We can't take payments from businesses outside India yet. Write to support@storemink.com and we'll help.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Buy now" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("the checkout dialog (design 7.3)", () => {
  it("stage 1 and 2 copy follows the GST terms", () => {
    renderPlans(NO_SUBSCRIPTION, {
      data: FREE_STORE,
      terms: ON_EX,
      packs: [PACK],
    });
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Basic" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getAllByText("₹15,000 plus GST").length,
    ).toBeGreaterThan(0);
    expect(within(dialog).getByText("₹17,700 billed every year")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Mink credits" }),
    );
    expect(
      within(dialog).getByText("₹152.22 once, including GST"),
    ).toBeTruthy();
  });

  it("a scheduled start names its date on stage 1", () => {
    renderPlans(NO_SUBSCRIPTION, { data: FREE_STORE, terms: SCHED_EX });
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Basic" }));
    expect(
      within(screen.getByRole("dialog")).getAllByText(
        "Billed every year, plus GST from 1 Dec 2026",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("★★ the summary is rebuilt from quoteCheckout, GST rows and all", async () => {
    h.actions.quoteCheckout.mockResolvedValue(
      okQuote({
        terms: ON_EX,
        payNow: 1_500_00,
        renewal: 1_500_00,
        period: "monthly",
        pack: 129_00,
      }),
    );
    renderPlans(NO_SUBSCRIPTION, {
      data: FREE_STORE,
      terms: ON_EX,
      packs: [PACK],
    });
    await toReview({ pack: true });
    await enabled("Continue to payment");
    expect(h.actions.quoteCheckout).toHaveBeenCalledWith(
      "basic",
      "yearly",
      PACK.id,
    );
    const aside = screen.getByRole("dialog");
    expect(within(aside).getByText("GST (18%)")).toBeTruthy();
    expect(within(aside).getByText("₹270")).toBeTruthy();
    expect(within(aside).getByText("₹1,770")).toBeTruthy();
    expect(
      within(aside).getByText("₹1,770 every month, including GST"),
    ).toBeTruthy();
    expect(
      within(aside).getByText("Mink credits, separate payment"),
    ).toBeTruthy();
    expect(
      within(aside).getAllByText("₹152.22 including GST").length,
    ).toBeGreaterThan(0);
    expect(
      within(aside).getByText(
        "The payment window asks for exactly this amount.",
      ),
    ).toBeTruthy();
    expect(
      within(aside).getByText("60 credits · ₹152.22 once, including GST"),
    ).toBeTruthy();
  });

  it("while the quote is on its way: working, and Continue stays off", async () => {
    let answer: (value: CheckoutQuoteResult) => void = () => {};
    h.actions.quoteCheckout.mockReturnValue(
      new Promise<CheckoutQuoteResult>((resolve) => {
        answer = resolve;
      }),
    );
    renderPlans(NO_SUBSCRIPTION, { data: FREE_STORE });
    await toReview();
    expect(screen.getByText("Working out the total…")).toBeTruthy();
    const pay = screen.getByRole("button", {
      name: "Continue to payment",
    }) as HTMLButtonElement;
    expect(pay.disabled).toBe(true);
    answer(okQuote());
    await vi.waitFor(() => expect(pay.disabled).toBe(false));
  });

  it("a failed quote says so and offers Try again, which asks again", async () => {
    h.actions.quoteCheckout.mockResolvedValue({ ok: false, error: "no" });
    renderPlans(NO_SUBSCRIPTION, { data: FREE_STORE });
    await toReview();
    await vi.waitFor(() =>
      expect(
        screen.getByText("We couldn't work out the total. Please try again."),
      ).toBeTruthy(),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Continue to payment",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    h.actions.quoteCheckout.mockResolvedValue(okQuote());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await enabled("Continue to payment");
    expect(h.actions.quoteCheckout).toHaveBeenCalledTimes(2);
  });

  it("needs a state: the prompt replaces the rows, and saving asks again", async () => {
    h.actions.quoteCheckout.mockResolvedValue(
      okQuote({ terms: ON_EX, needsState: true }),
    );
    renderPlans(NO_SUBSCRIPTION, { data: FREE_STORE, terms: ON_EX });
    await toReview();
    await vi.waitFor(() =>
      expect(
        screen.getByText(
          "Add your state before you pay. It goes on your GST invoice.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("Pay now")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Continue to payment",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    h.actions.quoteCheckout.mockResolvedValue(okQuote({ terms: ON_EX }));
    fireEvent.change(screen.getByLabelText("State"), {
      target: { value: "27" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await enabled("Continue to payment");
    expect(h.actions.saveMyBillingDetails).toHaveBeenCalledWith({
      stateCode: "27",
    });
    expect(h.actions.quoteCheckout).toHaveBeenCalledTimes(2);
  });

  it("outside India: the sentence replaces the rows and payment stays off", async () => {
    h.actions.quoteCheckout.mockResolvedValue(
      okQuote({ terms: ON_EX, outsideIndia: true }),
    );
    renderPlans(NO_SUBSCRIPTION, { data: FREE_STORE, terms: ON_EX });
    await toReview();
    await vi.waitFor(() =>
      expect(
        screen.getByText(
          "We can't take payments from businesses outside India yet. Write to support@storemink.com and we'll help.",
        ),
      ).toBeTruthy(),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Continue to payment",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("an earlier payment to finish: nothing is charged now, and Continue may go ahead", async () => {
    h.actions.quoteCheckout.mockResolvedValue(
      okQuote({ earlierPayment: true }),
    );
    renderPlans(NO_SUBSCRIPTION, { data: FREE_STORE });
    await toReview();
    await enabled("Continue to payment");
    expect(screen.getByText("Nothing is charged now.")).toBeTruthy();
  });

  it("the rail note reads the quote's renewal: autopay", async () => {
    h.actions.quoteCheckout.mockResolvedValue(okQuote({ autopay: true }));
    renderPlans(NO_SUBSCRIPTION, { data: FREE_STORE });
    await toReview();
    await enabled("Continue to payment");
    expect(
      screen.getByText("Renewals are charged by UPI Autopay"),
    ).toBeTruthy();
  });

  it("the rail note reads the quote's renewal: invoiced", async () => {
    h.actions.quoteCheckout.mockResolvedValue(okQuote({ autopay: false }));
    renderPlans(NO_SUBSCRIPTION, { data: FREE_STORE });
    await toReview();
    await enabled("Continue to payment");
    expect(
      screen.getByText("Renewals for this plan are invoiced"),
    ).toBeTruthy();
  });

  it("a scheduled change: nothing to pay now, from its date", async () => {
    h.actions.quoteCheckout.mockResolvedValue(
      okQuote({
        kind: "change",
        timing: "scheduled",
        terms: ON_EX,
        period: "monthly",
      }),
    );
    renderPlans({}, { terms: ON_EX });
    fireEvent.click(screen.getByRole("button", { name: "Switch to Basic" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Mink credits" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review purchase" }));
    await enabled("Schedule at renewal");
    expect(screen.getByText("Nothing to pay now")).toBeTruthy();
    expect(screen.getByText("From 30 Oct 2026")).toBeTruthy();
    expect(screen.getByText("Nothing is charged now.")).toBeTruthy();
  });
});

// ── The amount guard (design 7.4): four of the five buttons here; the
// invoice panel's Pay is in open-invoices.test.tsx. ─────────────────────────

const CHANGED = (rupees: string) =>
  `The amount to pay is now ${rupees}. Check it and press Continue to payment again.`;
/** The packs panel's button reads "Buy now", so its message names that. */
const CHANGED_BUY = (rupees: string) =>
  `The amount to pay is now ${rupees}. Check it and press Buy now again.`;
/** A plan change's button reads "Pay prorated change" (R2-01). */
const CHANGED_PLAN = (rupees: string) =>
  `The amount to pay is now ${rupees}. Check it and press Pay prorated change again.`;

describe("the amount guard: handleBuy (packs panel)", () => {
  it("★★ a different start amount never opens Razorpay", async () => {
    h.credits.startCreditPurchase.mockResolvedValue(creditStart(152_22));
    renderPlans({}, { terms: OFF, packs: [PACK] });
    fireEvent.click(screen.getByRole("button", { name: "Buy now" }));
    await vi.waitFor(() =>
      expect(h.toast.info).toHaveBeenCalledWith(CHANGED_BUY("₹152.22")),
    );
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
    // The card now shows what the window will ask for.
    expect(screen.getByText("₹152.22")).toBeTruthy();
  });

  it("with GST charged, the asked amount reads as including GST", async () => {
    h.credits.startCreditPurchase.mockResolvedValue(creditStart(160_00));
    renderPlans({}, { terms: ON_EX, packs: [PACK] });
    expect(screen.getByText("₹152.22 including GST")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Buy now" }));
    await vi.waitFor(() =>
      expect(h.toast.info).toHaveBeenCalledWith(CHANGED_BUY("₹160")),
    );
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
    expect(screen.getByText("₹160 including GST")).toBeTruthy();
    expect(screen.queryByText("₹152.22 including GST")).toBeNull();
  });

  it("an equal amount opens it exactly once", async () => {
    h.credits.startCreditPurchase.mockResolvedValue(creditStart(129_00));
    renderPlans({}, { terms: OFF, packs: [PACK] });
    fireEvent.click(screen.getByRole("button", { name: "Buy now" }));
    await vi.waitFor(() =>
      expect(h.openRazorpayModal).toHaveBeenCalledTimes(1),
    );
    expect(h.openRazorpayModal.mock.calls[0][0].amountPaise).toBe(129_00);
  });

  it("the next press opens at the amount now shown", async () => {
    h.credits.startCreditPurchase.mockResolvedValue(creditStart(152_22));
    renderPlans({}, { terms: OFF, packs: [PACK] });
    fireEvent.click(screen.getByRole("button", { name: "Buy now" }));
    await vi.waitFor(() => expect(h.toast.info).toHaveBeenCalled());
    fireEvent.click(await enabled("Buy now"));
    await vi.waitFor(() =>
      expect(h.openRazorpayModal).toHaveBeenCalledTimes(1),
    );
  });
});

describe("the amount guard: subscribe", () => {
  it("★★ a different start amount never opens Razorpay, and quotes again", async () => {
    h.actions.startSubscribe.mockResolvedValue(enrolment(17_700_00));
    renderPlans(NO_SUBSCRIPTION, { data: FREE_STORE });
    await toReview();
    fireEvent.click(await enabled("Continue to payment"));
    await vi.waitFor(() =>
      expect(h.toast.info).toHaveBeenCalledWith(CHANGED("₹17,700")),
    );
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(h.actions.quoteCheckout).toHaveBeenCalledTimes(2),
    );
    // The new amount is on screen, and the next press opens at it.
    await vi.waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(CHANGED("₹17,700")),
    );
    fireEvent.click(await enabled("Continue to payment"));
    await vi.waitFor(() =>
      expect(h.openRazorpayModal).toHaveBeenCalledTimes(1),
    );
    expect(h.openRazorpayModal.mock.calls[0][0].amountPaise).toBe(17_700_00);
  });

  it("an equal amount opens it exactly once", async () => {
    h.actions.startSubscribe.mockResolvedValue(enrolment(15_000_00));
    renderPlans(NO_SUBSCRIPTION, { data: FREE_STORE });
    await toReview();
    fireEvent.click(await enabled("Continue to payment"));
    await vi.waitFor(() =>
      expect(h.openRazorpayModal).toHaveBeenCalledTimes(1),
    );
    expect(h.openRazorpayModal.mock.calls[0][0].amountPaise).toBe(15_000_00);
    expect(h.toast.info).not.toHaveBeenCalled();
  });
});

describe("the amount guard: doChange", () => {
  async function pressChange() {
    renderPlans();
    fireEvent.click(screen.getByRole("button", { name: "Switch to Basic" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Mink credits" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review purchase" }));
    fireEvent.click(await enabled("Pay prorated change"));
  }

  function changeWith(amountPaise: number) {
    h.actions.changeMyPlan.mockResolvedValue({
      ok: true,
      payment: {
        invoiceId: "inv-c",
        providerOrderId: "order_c",
        keyId: "rzp_1",
        amountPaise,
      },
      scheduled: false,
      message: "Moving to Basic.",
    });
  }

  it("★★ a different start amount never opens Razorpay", async () => {
    h.actions.quoteCheckout.mockResolvedValue(
      okQuote({ kind: "change", payNow: 500_00 }),
    );
    changeWith(590_00);
    await pressChange();
    await vi.waitFor(() =>
      expect(h.toast.info).toHaveBeenCalledWith(CHANGED_PLAN("₹590")),
    );
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
    // R2-01: the line under the summary names the button a plan change
    // carries, never the new subscription's "Continue to payment".
    await vi.waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(CHANGED_PLAN("₹590")),
    );
    expect(screen.queryByText(CHANGED("₹590"))).toBeNull();
    expect(
      screen.getByRole("button", { name: "Pay prorated change" }),
    ).toBeTruthy();
  });

  it("★ a change shown as nothing to pay that now wants paying never opens", async () => {
    h.actions.quoteCheckout.mockResolvedValue(
      okQuote({ kind: "change", timing: "now", payNow: null }),
    );
    changeWith(500_00);
    await pressChange();
    await vi.waitFor(() =>
      expect(h.toast.info).toHaveBeenCalledWith(CHANGED_PLAN("₹500")),
    );
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
  });

  it("an equal amount opens it exactly once", async () => {
    h.actions.quoteCheckout.mockResolvedValue(
      okQuote({ kind: "change", payNow: 500_00 }),
    );
    changeWith(500_00);
    await pressChange();
    await vi.waitFor(() =>
      expect(h.openRazorpayModal).toHaveBeenCalledTimes(1),
    );
    expect(h.openRazorpayModal.mock.calls[0][0].amountPaise).toBe(500_00);
  });
});

describe("the amount guard: buySelectedCredits", () => {
  beforeEach(() => {
    h.actions.quoteCheckout.mockResolvedValue(okQuote({ pack: 129_00 }));
    h.actions.startSubscribe.mockResolvedValue(enrolment(15_000_00));
    h.actions.confirmSubscribe.mockResolvedValue({
      ok: true,
      plan: "basic",
      periodEnd: PERIOD_END,
      autopay: false,
    });
    h.credits.confirmCreditPurchase.mockResolvedValue({
      success: true,
      creditsAdded: 60,
    });
    payImmediately();
  });

  it("★★ a different pack amount never opens a second window", async () => {
    h.credits.startCreditPurchase.mockResolvedValue(creditStart(152_22));
    renderPlans(NO_SUBSCRIPTION, { data: FREE_STORE, packs: [PACK] });
    await toReview({ pack: true });
    fireEvent.click(await enabled("Continue to payment"));
    await vi.waitFor(() =>
      expect(h.toast.info).toHaveBeenCalledWith(CHANGED("₹152.22")),
    );
    // Only the plan's window opened.
    expect(h.openRazorpayModal).toHaveBeenCalledTimes(1);
    expect(h.openRazorpayModal.mock.calls[0][0].amountPaise).toBe(15_000_00);
    // The dialog waits for the credits at the amount now shown.
    fireEvent.click(await enabled("Continue to payment"));
    await vi.waitFor(() =>
      expect(h.openRazorpayModal).toHaveBeenCalledTimes(2),
    );
    expect(h.openRazorpayModal.mock.calls[1][0].amountPaise).toBe(152_22);
  });

  it("an equal amount opens the credits window exactly once", async () => {
    h.credits.startCreditPurchase.mockResolvedValue(creditStart(129_00));
    renderPlans(NO_SUBSCRIPTION, { data: FREE_STORE, packs: [PACK] });
    await toReview({ pack: true });
    fireEvent.click(await enabled("Continue to payment"));
    await vi.waitFor(() =>
      expect(h.openRazorpayModal).toHaveBeenCalledTimes(2),
    );
    expect(h.openRazorpayModal.mock.calls[1][0].amountPaise).toBe(129_00);
    expect(h.toast.success).toHaveBeenCalledWith("60 Mink credits added.");
  });
});

// ── The banners and the Billing details card ───────────────────────────────

describe("the GST banners (design 7.3)", () => {
  it("the GST notice while GST added on top is scheduled", () => {
    render(
      <GstNotice
        terms={SCHED_EX}
        canManage
        renewal={nextRenewal({
          renewsOn: "2026-12-14T06:30:00.000Z",
          amount: quoteAmount(1_500_00, ON_EX),
          terms: ON_EX,
        })}
      />,
    );
    expect(
      screen.getByText("GST will be added to our prices from 1 December 2026"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "From then, GST at 18% is added to every plan, extra location and Mink credit pack.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Your renewal on 14 Dec 2026 will be ₹1,770: ₹1,500 plus ₹270 GST.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Add your GSTIN under Billing details to claim the GST as input tax credit.",
      ),
    ).toBeTruthy();
  });

  it("the state banner, whose button goes to the Billing details state", () => {
    render(
      <>
        <GstNotice
          terms={ON_EX}
          canManage
          renewal={nextRenewal({
            placeOfSupply: { code: "03", basis: "supplier_state" },
          })}
        />
        <BillingDetailsCard
          details={billingDetails({ stateCode: "" })}
          canManage
        />
      </>,
    );
    expect(screen.getByText("Add your state for your invoices")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add your state" }));
    expect(document.activeElement?.id).toBe("billing-details-state");
  });

  // R2-10: staff who cannot manage billing see the banner's words, and no
  // button that leads to fields they are not shown.
  it("offers no button to someone who cannot manage billing", () => {
    render(
      <GstNotice
        terms={ON_EX}
        canManage={false}
        renewal={nextRenewal({
          placeOfSupply: { code: "03", basis: "supplier_state" },
        })}
      />,
    );
    expect(screen.getByText("Add your state for your invoices")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("outside India: the sentence, with no title and no button", () => {
    render(
      <GstNotice
        terms={ON_EX}
        canManage
        renewal={nextRenewal({
          placeOfSupply: { code: "96", basis: "outside_india" },
        })}
      />,
    );
    expect(
      screen.getByText(
        "Your business is outside India. Your renewals are charged IGST. New payments can't be made from outside India yet; write to support@storemink.com if you need one.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("★ says nothing when the terms could not be read, or there is nothing to say", () => {
    const { container, unmount } = render(
      <GstNotice terms={null} renewal={nextRenewal()} canManage />,
    );
    expect(container.textContent).toBe("");
    unmount();
    const off = render(<GstNotice terms={OFF} renewal={null} canManage />);
    expect(off.container.textContent).toBe("");
  });
});

describe("the Billing details card (design 7.3)", () => {
  it("someone who cannot manage billing sees why there is nothing to change", () => {
    render(<BillingDetailsCard details={null} canManage={false} />);
    expect(screen.getByText("Billing details")).toBeTruthy();
    expect(
      screen.getByText("Only someone who manages billing can change these."),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("★ a details read that failed says so, and offers no form to save", () => {
    render(<BillingDetailsCard details={null} canManage />);
    expect(screen.getByText("Billing details")).toBeTruthy();
    expect(
      screen.getByText(
        "Couldn't load your billing details. Refresh the page to try again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("the state select starts on Choose your state when none is saved", () => {
    render(
      <BillingDetailsCard
        details={billingDetails({ stateCode: "" })}
        canManage
      />,
    );
    const state = screen.getByLabelText("State") as HTMLSelectElement;
    expect(state.value).toBe("");
    expect(state.options[0].textContent).toBe("Choose your state");
  });

  it("shows the prefill source and the state the invoices use", () => {
    render(
      <BillingDetailsCard
        details={billingDetails({
          saved: false,
          prefilledFrom: "taxes_and_invoices",
          placeOfSupply: {
            code: "07",
            name: "Delhi",
            basis: "store_tax_state",
          },
        })}
        canManage
      />,
    );
    expect(
      screen.getByText(
        "Filled in from Settings → Taxes & invoices. Check them and save.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Your invoices use: Delhi (07), from Taxes & invoices."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "An invoice that has already been issued can't be changed.",
      ),
    ).toBeTruthy();
  });

  it("a GSTIN sets the state and locks it", () => {
    render(<BillingDetailsCard details={billingDetails()} canManage />);
    fireEvent.change(screen.getByLabelText("GSTIN (optional)"), {
      target: { value: "27ABCDE1234F1Z5" },
    });
    const state = screen.getByLabelText("State") as HTMLSelectElement;
    expect(state.value).toBe("27");
    expect(state.disabled).toBe(true);
  });

  it("★ the state select is signup's list: no Other Territory, by name (R2-11)", () => {
    render(<BillingDetailsCard details={billingDetails()} canManage />);
    const state = screen.getByLabelText("State") as HTMLSelectElement;
    const names = Array.from(state.options)
      .slice(1)
      .map((o) => o.textContent ?? "");
    expect(names).not.toContain("Other Territory");
    expect(names).toHaveLength(36);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("a GSTIN that names Other Territory still shows it in the locked select", () => {
    render(<BillingDetailsCard details={billingDetails()} canManage />);
    fireEvent.change(screen.getByLabelText("GSTIN (optional)"), {
      target: { value: "97ABCDE1234F1Z5" },
    });
    const state = screen.getByLabelText("State") as HTMLSelectElement;
    expect(state.value).toBe("97");
    expect(state.selectedOptions[0]?.textContent).toBe("Other Territory");
  });

  it("the state prompt offers the same list", () => {
    render(<StatePrompt onSaved={() => {}} />);
    const state = screen.getByLabelText("State") as HTMLSelectElement;
    const names = Array.from(state.options)
      .slice(1)
      .map((o) => o.textContent ?? "");
    expect(names).not.toContain("Other Territory");
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("saves every field and says so", async () => {
    render(<BillingDetailsCard details={billingDetails()} canManage />);
    fireEvent.change(screen.getByLabelText("City"), {
      target: { value: "Delhi" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save billing details" }),
    );
    await vi.waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith(
        "Billing details saved. They apply to invoices issued from now on.",
      ),
    );
    expect(h.actions.saveMyBillingDetails).toHaveBeenCalledWith({
      country: "IN",
      legalName: "Kesar Ghani LLP",
      addressLine1: "12 MG Road",
      addressLine2: "",
      city: "Delhi",
      postalCode: "110001",
      gstin: "",
      stateCode: "07",
    });
    expect(h.refresh).toHaveBeenCalled();
  });

  it("refuses a bad GSTIN before saving", () => {
    render(<BillingDetailsCard details={billingDetails()} canManage />);
    fireEvent.change(screen.getByLabelText("GSTIN (optional)"), {
      target: { value: "NOTAGSTIN" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save billing details" }),
    );
    expect(
      screen.getByText("That doesn't look like a valid 15-character GSTIN."),
    ).toBeTruthy();
    expect(h.actions.saveMyBillingDetails).not.toHaveBeenCalled();
  });

  it("shows the server's refusal under the field it names", async () => {
    h.actions.saveMyBillingDetails.mockResolvedValue({
      ok: false,
      error: "Enter a 6-digit PIN code.",
      field: "postalCode",
    });
    render(<BillingDetailsCard details={billingDetails()} canManage />);
    fireEvent.click(
      screen.getByRole("button", { name: "Save billing details" }),
    );
    await vi.waitFor(() =>
      expect(screen.getByText("Enter a 6-digit PIN code.")).toBeTruthy(),
    );
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it("outside India hides GSTIN and State, and the PIN becomes a postal code", () => {
    render(
      <BillingDetailsCard
        details={billingDetails({
          country: "US",
          countryName: "United States",
          placeOfSupply: { code: "96", name: null, basis: "outside_india" },
        })}
        canManage
      />,
    );
    expect(screen.queryByLabelText("GSTIN (optional)")).toBeNull();
    expect(screen.queryByLabelText("State")).toBeNull();
    expect(screen.getByLabelText("Postal code (optional)")).toBeTruthy();
    expect(
      screen.getByText("Your invoices use: outside India (United States)."),
    ).toBeTruthy();
  });
});
