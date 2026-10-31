// @vitest-environment jsdom
// Buying an extra location when an earlier, already paid purchase is finished
// instead (RC-F1b, RC-F1c).
//
// The server either finishes the earlier payment (a success: the locations are
// added) or says the payment went through and the locations are added shortly
// (a notice). Neither may open a second payment window, and the first must
// never read as an error.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  actions: {
    startBuyLocations: vi.fn(),
    confirmBuyLocations: vi.fn(),
    releaseExtraLocations: vi.fn(),
    // The state picker's save (GST design 7.3), behind the Pay button's place.
    saveMyBillingDetails: vi.fn(),
  },
  openRazorpayModal: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/app/actions/subscribe-actions", () => h.actions);
vi.mock("@/lib/payments/razorpay-client", () => ({
  openRazorpayModal: h.openRazorpayModal,
}));

import {
  LOCATIONS_BILLING_STAFF_ONLY,
  LocationBillingCard,
  locationCardCopy,
} from "./location-billing-card";
import type { LocationBillingState } from "@/lib/billing/invoice-types";
import type { AmountQuote } from "@/lib/billing/quote-types";
import type { TaxTerms } from "@/lib/billing/tax-terms";
import {
  CHECKOUT,
  addLocationConfirm,
  amountChanged,
} from "@/lib/billing/tax-copy";

const STATE: LocationBillingState = {
  included: 2,
  billed: 0,
  existing: 2,
  allowance: 2,
  required: 0,
  releasable: 0,
  scheduled: null,
  pricePerPeriodInr: 1000,
  period: "monthly",
  nextPurchaseInr: 500,
  canBuy: true,
};

function buyOne() {
  render(<LocationBillingCard state={STATE} canManage canPay />);
  fireEvent.click(screen.getByRole("button", { name: /Add a location/ }));
  fireEvent.click(screen.getByRole("button", { name: "Pay ₹500" }));
}

beforeEach(() => {
  h.openRazorpayModal.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

describe("buying a location when an earlier payment is finished instead", () => {
  it("★★ is a success, never an error, and opens no second payment", async () => {
    const message =
      "Your earlier payment went through, and your extra locations are now added.";
    h.actions.startBuyLocations.mockResolvedValue({
      ok: true,
      completedEarlier: true,
      message,
    });
    buyOne();
    await vi.waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith(message),
    );
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.toast.info).not.toHaveBeenCalled();
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalled();
    // The confirm row closes: nothing left to pay.
    expect(screen.queryByRole("button", { name: "Pay ₹500" })).toBeNull();
  });

  it("★ a payment that went through but adds the locations shortly is a notice", async () => {
    const message =
      "Your earlier payment went through, and we'll add your locations shortly. Please don't pay again. If they haven't been added within a day, write to support@storemink.com.";
    h.actions.startBuyLocations.mockResolvedValue({
      ok: false,
      error: message,
      waiting: true,
    });
    buyOne();
    await vi.waitFor(() => expect(h.toast.info).toHaveBeenCalledWith(message));
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Pay ₹500" })).toBeNull();
  });

  it("an ordinary purchase still opens the payment window", async () => {
    h.actions.startBuyLocations.mockResolvedValue({
      ok: true,
      invoiceId: "inv-1",
      providerOrderId: "order_1",
      keyId: "rzp_1",
      amountPaise: 50_000,
    });
    buyOne();
    await vi.waitFor(() =>
      expect(h.openRazorpayModal).toHaveBeenCalledTimes(1),
    );
    expect(h.toast.success).not.toHaveBeenCalled();
  });
});

// ── GST (design 7.5, GST Stage 16) ─────────────────────────────────────────

const TERMS_OFF: TaxTerms = {
  active: false,
  inclusive: false,
  rateBps: 0,
  upcoming: null,
};
const TERMS_EX: TaxTerms = {
  active: true,
  inclusive: false,
  rateBps: 1800,
  upcoming: null,
};
const TERMS_IN: TaxTerms = {
  active: true,
  inclusive: true,
  rateBps: 1800,
  upcoming: null,
};

function quote(
  listedPaise: number,
  taxPaise: number,
  inclusive: boolean,
  rateBps = 1800,
): AmountQuote {
  return {
    listedPaise,
    taxablePaise: inclusive ? listedPaise - taxPaise : listedPaise,
    totalPaise: inclusive ? listedPaise : listedPaise + taxPaise,
    taxPaise,
    rateBps: taxPaise > 0 ? rateBps : 0,
    inclusive,
  };
}

/** ON-EX: ₹1,000/month plus 18% GST; ₹400 of the cycle left. */
const GST_EX: LocationBillingState = {
  ...STATE,
  billed: 2,
  existing: 4,
  allowance: 4,
  pricePerPeriodInr: 1000,
  nextPurchaseInr: 400,
  perPeriod: quote(100_000, 18_000, false),
  nextPurchase: quote(40_000, 7_200, false),
  nextRenewal: {
    perLocation: quote(100_000, 18_000, false),
    issuedAt: "2026-11-10T00:00:00.000Z",
  },
  terms: TERMS_EX,
  needsState: false,
  outsideIndia: false,
};

const GST_OFF: LocationBillingState = {
  ...GST_EX,
  perPeriod: quote(100_000, 0, false),
  nextPurchase: quote(40_000, 0, false),
  nextRenewal: {
    perLocation: quote(100_000, 0, false),
    issuedAt: "2026-11-10T00:00:00.000Z",
  },
  terms: TERMS_OFF,
};

const GST_IN: LocationBillingState = {
  ...GST_EX,
  perPeriod: quote(100_000, 15_254, true),
  nextPurchase: quote(40_000, 6_102, true),
  nextRenewal: {
    perLocation: quote(100_000, 15_254, true),
    issuedAt: "2026-11-10T00:00:00.000Z",
  },
  terms: TERMS_IN,
};

function openConfirm(state: LocationBillingState) {
  render(<LocationBillingCard state={state} canManage canPay />);
  fireEvent.click(screen.getByRole("button", { name: /Add a location/ }));
}

function startsWith(amountPaise: number) {
  return {
    ok: true,
    invoiceId: "inv-1",
    providerOrderId: "order_1",
    keyId: "rzp_1",
    amountPaise,
  };
}

describe("the Locations card's words by GST state (design 7.5)", () => {
  it("GST off: the list price, and Pay the part period", () => {
    openConfirm(GST_OFF);
    expect(screen.getByText(/2 extra at ₹1,000\/month each$/)).toBeTruthy();
    expect(
      screen.getByText(
        "Add a location for ₹1,000/month. You'll pay ₹400 now for the rest of this cycle, then ₹1,000/month from your next renewal.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pay ₹400" })).toBeTruthy();
  });

  it("GST added on top: 'plus GST' on the summary and the button, and the GST in the confirmation", () => {
    render(<LocationBillingCard state={GST_EX} canManage canPay />);
    expect(
      screen.getByText(/2 extra at ₹1,000\/month each, plus GST$/),
    ).toBeTruthy();
    const add = screen.getByRole("button", { name: /Add a location/ });
    expect(add.textContent).toBe("Add a location · ₹1,000/month plus GST");
    fireEvent.click(add);
    expect(
      screen.getByText(
        "Add a location for ₹1,000/month plus GST, ₹1,180/month in all. You'll pay ₹472 now for the rest of this cycle (₹400 plus ₹72 GST), then ₹1,180/month from your next renewal.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pay ₹472" })).toBeTruthy();
  });

  it("GST included: 'including GST', and the same price", () => {
    openConfirm(GST_IN);
    expect(
      screen.getByText(/2 extra at ₹1,000\/month each, including GST$/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Add a location for ₹1,000/month, including GST. You'll pay ₹400 now for the rest of this cycle, including ₹61.02 GST, then ₹1,000/month from your next renewal.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pay ₹400" })).toBeTruthy();
  });

  it("nothing due now: billed from the next renewal, and Add location", () => {
    openConfirm({ ...GST_EX, nextPurchase: null });
    expect(
      screen.getByText(
        "Add a location for ₹1,000/month plus GST, billed from your next renewal.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add location" })).toBeTruthy();
  });

  it("every 'from your next renewal' figure is the renewal's own total", () => {
    // A renewal invoiced after a scheduled start, while today is GST free.
    const state: LocationBillingState = {
      ...GST_OFF,
      nextRenewal: {
        perLocation: quote(100_000, 18_000, false),
        issuedAt: "2026-12-10T00:00:00.000Z",
      },
    };
    openConfirm(state);
    expect(
      screen.getByText(
        "Add a location for ₹1,000/month. You'll pay ₹400 now for the rest of this cycle, then ₹1,180/month including GST from your next renewal.",
      ),
    ).toBeTruthy();
  });

  // R2-04: with no renewal figure (a cancelling plan, a next plan without
  // POS, or a failed read) nothing stands in for it, in any state: the
  // confirmation names no renewal at all.
  it("with no renewal figure, the confirmation promises no renewal", () => {
    const state: LocationBillingState = { ...GST_EX, nextRenewal: null };
    expect(locationCardCopy(state).confirm).toEqual(
      addLocationConfirm({
        terms: TERMS_EX,
        period: "monthly",
        perLocation: GST_EX.perPeriod!,
        nextPurchase: GST_EX.nextPurchase!,
        nextRenewal: null,
      }),
    );
    openConfirm(state);
    expect(
      screen.getByText(
        "Add a location for ₹1,000/month plus GST, ₹1,180/month in all. You'll pay ₹472 now for the rest of this cycle (₹400 plus ₹72 GST).",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pay ₹472" })).toBeTruthy();
  });

  it.each([
    ["GST off", { ...GST_OFF, nextRenewal: null }],
    ["GST included", { ...GST_IN, nextRenewal: null }],
    ["GST added on top", { ...GST_EX, nextRenewal: null }],
    [
      "GST added on top from a scheduled date",
      {
        ...GST_OFF,
        nextRenewal: null,
        terms: {
          ...TERMS_OFF,
          upcoming: {
            enabled: true,
            inclusive: false,
            rateBps: 1800,
            startsAt: "2026-11-30T18:30:00.000Z",
          },
        },
      },
    ],
  ] as [string, LocationBillingState][])(
    "%s: no renewal figure means no renewal sentence",
    (_label, state) => {
      const nothingDue = {
        ...state,
        nextPurchase: null,
      } as LocationBillingState;
      for (const s of [state, nothingDue]) {
        const { text } = locationCardCopy(s).confirm;
        expect(text).not.toMatch(/renewal/);
        expect(text).not.toMatch(/GST at 18% is added/);
      }
    },
  );

  it("a state without the GST figures keeps the card's earlier words", () => {
    const copy = locationCardCopy(STATE);
    expect(copy.addButton).toBe("Add a location · ₹1,000/month");
    expect(copy.confirm.confirmLabel).toBe("Pay ₹500");
    expect(copy.shownPaise).toBe(50_000);
    expect(copy.gate).toBeNull();
  });
});

describe("the amount guard on buy() (design 7.4)", () => {
  it("★★ a start asking for another amount never opens the payment window", async () => {
    h.actions.startBuyLocations.mockResolvedValue(startsWith(47_500));
    openConfirm(GST_EX);
    fireEvent.click(screen.getByRole("button", { name: "Pay ₹472" }));
    const told = amountChanged(47_500, "pay");
    await vi.waitFor(() => expect(h.toast.info).toHaveBeenCalledWith(told));
    expect(told).toBe(
      "The amount to pay is now ₹475. Check it and press Pay again.",
    );
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalled();
    // The new amount stays on screen under the confirmation.
    expect(screen.getByText(told)).toBeTruthy();
  });

  it("★★ a start asking for exactly the shown amount opens the window once", async () => {
    h.actions.startBuyLocations.mockResolvedValue(startsWith(47_200));
    openConfirm(GST_EX);
    fireEvent.click(screen.getByRole("button", { name: "Pay ₹472" }));
    await vi.waitFor(() =>
      expect(h.openRazorpayModal).toHaveBeenCalledTimes(1),
    );
    expect(h.openRazorpayModal).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 47_200, rzpOrderId: "order_1" }),
    );
    expect(h.actions.startBuyLocations).toHaveBeenCalledWith(3);
    expect(h.toast.info).not.toHaveBeenCalled();
  });

  it("after a difference, the next press opens only for the amount the merchant was told", async () => {
    h.actions.startBuyLocations.mockResolvedValue(startsWith(47_500));
    openConfirm(GST_EX);
    fireEvent.click(screen.getByRole("button", { name: "Pay ₹472" }));
    await vi.waitFor(() => expect(h.toast.info).toHaveBeenCalledTimes(1));
    expect(h.openRazorpayModal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Pay ₹472" }));
    await vi.waitFor(() =>
      expect(h.openRazorpayModal).toHaveBeenCalledTimes(1),
    );
    expect(h.openRazorpayModal).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 47_500 }),
    );
  });

  it("never opens a payment when the confirmation showed nothing due now", async () => {
    h.actions.startBuyLocations.mockResolvedValue(startsWith(1_200));
    openConfirm({ ...GST_EX, nextPurchase: null });
    fireEvent.click(screen.getByRole("button", { name: "Add location" }));
    await vi.waitFor(() =>
      expect(h.toast.info).toHaveBeenCalledWith(amountChanged(1_200, "pay")),
    );
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
  });
});

// R2-10: buying, releasing and the state prompt are billing actions, which
// the server refuses without the billing permission.
describe("a manager of locations who cannot pay", () => {
  it("sees one line instead of the buy controls and the state prompt", () => {
    render(
      <LocationBillingCard
        state={{ ...GST_EX, needsState: true, releasable: 1 }}
        canManage
        canPay={false}
      />,
    );
    expect(screen.getByText(LOCATIONS_BILLING_STAFF_ONLY)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add a location/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Release/ })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText(CHECKOUT.needsState)).toBeNull();
  });

  it("says nothing about billing to someone who cannot manage locations", () => {
    render(<LocationBillingCard state={GST_EX} canManage={false} canPay />);
    expect(screen.queryByText(LOCATIONS_BILLING_STAFF_ONLY)).toBeNull();
    expect(screen.queryByRole("button", { name: /Add a location/ })).toBeNull();
  });

  it("shows the buy controls to someone who manages both", () => {
    render(<LocationBillingCard state={GST_EX} canManage canPay />);
    expect(screen.queryByText(LOCATIONS_BILLING_STAFF_ONLY)).toBeNull();
    expect(screen.getByRole("button", { name: /Add a location/ })).toBeTruthy();
  });
});

describe("the state picker or the outside-India sentence in place of Pay", () => {
  it("★ asks for the state, with no Pay button, and saves only the state", async () => {
    h.actions.saveMyBillingDetails.mockResolvedValue({ ok: true });
    openConfirm({ ...GST_EX, needsState: true });
    expect(screen.queryByRole("button", { name: "Pay ₹472" })).toBeNull();
    expect(screen.getByText(CHECKOUT.needsState)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "07" },
    });
    fireEvent.click(screen.getByRole("button", { name: CHECKOUT.save }));
    await vi.waitFor(() =>
      expect(h.actions.saveMyBillingDetails).toHaveBeenCalledWith({
        stateCode: "07",
      }),
    );
    await vi.waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.actions.startBuyLocations).not.toHaveBeenCalled();
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
    // Cancel still closes the confirmation.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("★ outside India: the sentence, no Pay button, and no payment start", () => {
    openConfirm({ ...GST_EX, outsideIndia: true, needsState: true });
    expect(screen.getByText(CHECKOUT.outsideIndia)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pay ₹472" })).toBeNull();
    expect(screen.queryByText(CHECKOUT.needsState)).toBeNull();
    expect(h.actions.startBuyLocations).not.toHaveBeenCalled();
  });
});
