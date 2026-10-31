import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import ts from "typescript";
import { findOldPosWording } from "../../scripts/pos-wording.mjs";

// billing-emails reads the database for other templates; these tests only
// render, so the client never runs.
vi.mock("@/lib/db/client", () => ({
  withService: () => {
    throw new Error("no database in tax-copy tests");
  },
}));

import * as TaxCopy from "./tax-copy";
import {
  AUTO_REFUNDS_IDENTITY_INCOMPLETE,
  BILLING_DETAILS,
  BILLING_PAGE,
  CAPTURED_DRAFT_REPAIR,
  CHECKOUT,
  GST_FAQ_QUESTION,
  INVALID_GSTIN,
  INVOICE_LIST_CARD,
  INVOICE_LIST_CSV,
  INVOICE_SHEET,
  KEPT_DRAFT_REPAIR,
  NEXT_RENEWAL_LABEL,
  PAYMENT_REFUSAL,
  SIGNUP_STATE,
  SUPPORT_EMAIL,
  TAX_CHANGE,
  TAX_CONSOLE,
  TAX_IDENTITY,
  TAX_SETTINGS_REFUSAL,
  TAX_STATUS,
  addLocationButton,
  addLocationConfirm,
  amountChanged,
  amountFor,
  asksForState,
  billingDetailsPrefilled,
  billingDetailsUses,
  cancelChangeConfirm,
  changeButtonLabel,
  changeScheduledToast,
  checkoutCreditsRow,
  checkoutPackPrice,
  checkoutPlanCard,
  checkoutSummary,
  currentPlanPrice,
  formatRupees,
  gstFaq,
  gstNoticeBanner,
  gstRateLabel,
  gstSplitLabels,
  impactLines,
  impactPaidHow,
  impactStateOnInvoices,
  impactTruncatedNote,
  impactWarning,
  invoiceCountryLine,
  invoiceGstLine,
  invoiceGstinLine,
  invoiceListFileName,
  invoiceListName,
  invoiceStateLine,
  istLongDate,
  istLongDateTime,
  istMonthLabel,
  istShortDate,
  istTime,
  llpLine,
  locationsExtraSummary,
  nextRenewalGstLine,
  nextRenewalValue,
  noticeOptionLabel,
  noticeRefusal,
  packPrice,
  packTotalPrice,
  planActivatedGstParagraph,
  planActivatedPrice,
  plansGridSuffix,
  posPriceBoxNote,
  priceGstSuffix,
  priceModeOptions,
  pricingCardNote,
  pricingFootnote,
  pricingPriceSuffix,
  receiptAmountRows,
  receiptClosingLine,
  recentIstMonths,
  renewalAmountRows,
  renewalByHandLine,
  renewalChange,
  renewalChangeSentence,
  signupContinueLabel,
  signupPayNowLine,
  signupYearlyLine,
  stateBanner,
  switchOnNowConfirm,
  taxCopyState,
  taxStatusSentence,
  tooSoonAfterNotice,
  upcomingAddedGst,
  upcomingRise,
  valueAddedTaxIncluded,
  type CopyAmount,
  type ImpactCounts,
  type NoticeRenewal,
} from "./tax-copy";
import {
  noticeQualifies,
  taxContextFor,
  termsAt,
  type NoticeFailure,
  type TaxTerms,
  type TaxTermsSource,
} from "./tax-terms";
import {
  buildAddonInvoice,
  buildAiCreditsInvoice,
  buildSubscriptionInvoice,
} from "./invoice";
import type { CollectionRoute } from "./cycle";
import type { PlaceOfSupplyBasis } from "./gst";
import { istDate, refundSentTemplate } from "@/lib/email/billing-emails";

// ── Sample terms ────────────────────────────────────────────────────────────

/** 00:00 IST on 1 December 2026 is 18:30 UTC on 30 November. */
const START = "2026-11-30T18:30:00.000Z";
const NOW = new Date("2026-10-29T06:30:00.000Z");

const BASE: TaxTermsSource = {
  taxEnabled: false,
  taxInclusive: true,
  taxRateBps: 1800,
  nextTaxEnabled: null,
  nextTaxInclusive: null,
  nextTaxRateBps: null,
  nextTaxStartsAt: null,
};

function at(over: Partial<TaxTermsSource>): TaxTerms {
  return termsAt({ ...BASE, ...over }, NOW);
}

function next(enabled: boolean, inclusive: boolean, rateBps: number) {
  return {
    nextTaxEnabled: enabled,
    nextTaxInclusive: inclusive,
    nextTaxRateBps: rateBps,
    nextTaxStartsAt: START,
  };
}

const OFF = at({});
const SCHED_EX = at(next(true, false, 1800));
const SCHED_IN = at(next(true, true, 1800));
const ON_IN = at({ taxEnabled: true, taxInclusive: true });
const ON_EX = at({ taxEnabled: true, taxInclusive: false });
const ON_IN_TO_EX = at({
  taxEnabled: true,
  taxInclusive: true,
  ...next(true, false, 1800),
});
const ON_EX_RATE_UP = at({
  taxEnabled: true,
  taxInclusive: false,
  taxRateBps: 1200,
  ...next(true, false, 1800),
});
const ON_SWITCH_OFF = at({
  taxEnabled: true,
  taxInclusive: true,
  ...next(false, true, 1800),
});

const STATES: Record<string, TaxTerms> = {
  OFF,
  SCHED_EX,
  SCHED_IN,
  ON_IN,
  ON_EX,
  ON_IN_TO_EX,
  ON_EX_RATE_UP,
  ON_SWITCH_OFF,
};
const ALL_TERMS = Object.values(STATES);

// ── Sample amounts (each checked against amountFor below) ──────────────────

const NONE_1500: CopyAmount = {
  totalPaise: 150000,
  taxPaise: 0,
  rateBps: 0,
  inclusive: false,
};
const EX_1500: CopyAmount = {
  totalPaise: 177000,
  taxPaise: 27000,
  rateBps: 1800,
  inclusive: false,
};
const IN_1500: CopyAmount = {
  totalPaise: 150000,
  taxPaise: 22881,
  rateBps: 1800,
  inclusive: true,
};
const EX_15000: CopyAmount = {
  totalPaise: 1770000,
  taxPaise: 270000,
  rateBps: 1800,
  inclusive: false,
};
const EX_PACK: CopyAmount = {
  totalPaise: 15222,
  taxPaise: 2322,
  rateBps: 1800,
  inclusive: false,
};
const ZERO: CopyAmount = {
  totalPaise: 0,
  taxPaise: 0,
  rateBps: 0,
  inclusive: false,
};
const AMOUNTS = [NONE_1500, EX_1500, IN_1500, EX_15000, EX_PACK, ZERO];

const ROUTES: CollectionRoute[] = [
  { auto: true },
  { auto: false, reason: "no_mandate" },
  { auto: false, reason: "over_mandate" },
  { auto: false, reason: "over_afa_limit" },
];

const BASES: PlaceOfSupplyBasis[] = [
  "gstin",
  "billing_state",
  "store_gstin",
  "store_tax_state",
  "location_gstin",
  "location_state",
  "store_address",
  "signup_address",
  "outside_india",
  "supplier_state",
  "unknown",
];

const PERIODS = ["monthly", "yearly"] as const;
const LISTS = [0, 150000, 1500000, 5900, 12900, 100000, 12345];
const CODES = ["07", "03", "7", null, "96", "42"];

// ── Time zones ──────────────────────────────────────────────────────────────

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

function withTz<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  return fn();
}

// ── Names and formats ───────────────────────────────────────────────────────

describe("names and formats", () => {
  it("names the billing page Plans & Billing", () => {
    expect(BILLING_PAGE).toBe("Plans & Billing");
    expect(SUPPORT_EMAIL).toBe("support@storemink.com");
  });

  it("formats paise as the billing emails do", () => {
    expect(formatRupees(177000)).toBe("₹1,770");
    expect(formatRupees(6962)).toBe("₹69.62");
    expect(formatRupees(150050)).toBe("₹1,500.50");
    expect(formatRupees(12345678)).toBe("₹1,23,456.78");
    expect(formatRupees(0)).toBe("₹0");
    expect(formatRupees(5)).toBe("₹0.05");
  });

  it("is exactly the billing emails' moneyPaise", () => {
    for (const paise of [0, 5, 100, 6962, 150050, 177000, 228814, 12345678]) {
      const email = refundSentTemplate({
        storeName: "Echos",
        planName: "Basic",
        amountPaise: paise,
        invoiceRef: null,
        method: "razorpay",
        reason: "goodwill",
        refundReference: null,
        creditNote: null,
        storeState: "active",
        invoicesUrl: null,
      });
      expect(email.subject).toBe(`Your refund of ${formatRupees(paise)}`);
    }
  });

  it("dates in India time, short and long", () => {
    expect(istShortDate("2026-11-30T18:30:00Z")).toBe("1 Dec 2026");
    expect(istShortDate(START)).toBe("1 Dec 2026");
    expect(istShortDate(new Date(START))).toBe("1 Dec 2026");
    expect(istLongDate(START)).toBe("1 December 2026");
    expect(istTime(START)).toBe("00:00");
    expect(istLongDateTime(START)).toBe("1 December 2026, 00:00 IST");
    expect(istLongDateTime("2026-10-29T06:30:00.000Z")).toBe(
      "29 October 2026, 12:00 IST",
    );
  });

  it("returns the text given for a date that does not parse", () => {
    expect(istShortDate("not a date")).toBe("not a date");
    expect(istLongDate("not a date")).toBe("not a date");
    expect(istTime("not a date")).toBe("not a date");
    expect(istLongDateTime("not a date")).toBe("not a date");
    expect(istShortDate(new Date(Number.NaN))).toBe("");
  });

  it("is the billing emails' istDate without the time", () => {
    for (const iso of [
      "2026-10-31T20:00:00.000Z",
      START,
      "2026-01-05T00:00:00.000Z",
      "2027-03-31T18:29:59.000Z",
      "not a date",
    ]) {
      expect(istShortDate(iso)).toBe(istDate(iso));
    }
  });

  it("labels a rate in basis points", () => {
    expect(gstRateLabel(1800)).toBe("18%");
    expect(gstRateLabel(1250)).toBe("12.5%");
    expect(gstRateLabel(1225)).toBe("12.25%");
    expect(gstRateLabel(500)).toBe("5%");
    expect(gstRateLabel(0)).toBe("0%");
  });

  it("labels months and lists them newest first, in India time", () => {
    expect(istMonthLabel("2026-12")).toBe("December 2026");
    expect(istMonthLabel("2027-01")).toBe("January 2027");
    expect(istMonthLabel("2026-13")).toBe("2026-13");
    expect(istMonthLabel("December")).toBe("December");
    // 00:15 IST on 1 December is still November in UTC.
    expect(recentIstMonths(new Date("2026-11-30T18:45:00.000Z"), 2)).toEqual([
      { value: "2026-12", label: "December 2026" },
      { value: "2026-11", label: "November 2026" },
      { value: "2026-10", label: "October 2026" },
    ]);
    expect(recentIstMonths(new Date("2027-01-15T00:00:00.000Z"), 1)).toEqual([
      { value: "2027-01", label: "January 2027" },
      { value: "2026-12", label: "December 2026" },
    ]);
    expect(recentIstMonths(new Date("2027-01-15T00:00:00.000Z"), 0)).toEqual([
      { value: "2027-01", label: "January 2027" },
    ]);
    expect(recentIstMonths(new Date(Number.NaN), 3)).toEqual([]);
    expect(invoiceListFileName("2026-12")).toBe(
      "storemink-invoices-2026-12.csv",
    );
  });
});

describe("dates do not move with the server's time zone", () => {
  it("CONTROL: an unpinned formatter does move with the zone", () => {
    // Without this, the checks below could pass for the wrong reason: if
    // changing process.env.TZ did nothing, every zone would agree anyway.
    const unpinned = (iso: string) =>
      new Date(iso).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    expect(withTz("UTC", () => unpinned(START))).toBe("30 Nov 2026");
    expect(withTz("Asia/Kolkata", () => unpinned(START))).toBe("1 Dec 2026");
  });

  it.each(["UTC", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Kiritimati"])(
    "gives India's date and time in %s",
    (tz) => {
      withTz(tz, () => {
        expect(istShortDate(START)).toBe("1 Dec 2026");
        expect(istLongDate(START)).toBe("1 December 2026");
        expect(istTime(START)).toBe("00:00");
        expect(istLongDateTime(START)).toBe("1 December 2026, 00:00 IST");
        expect(istMonthLabel("2026-12")).toBe("December 2026");
        expect(
          recentIstMonths(new Date("2026-11-30T18:45:00.000Z"), 1),
        ).toEqual([
          { value: "2026-12", label: "December 2026" },
          { value: "2026-11", label: "November 2026" },
        ]);
        expect(pricingCardNote(SCHED_EX, "monthly", 150000)).toBe(
          "₹1,500 billed every month, plus GST from 1 Dec 2026",
        );
      });
    },
  );
});

// ── State ───────────────────────────────────────────────────────────────────

describe("the state the copy is chosen by", () => {
  it("reads each sample as its state", () => {
    expect(taxCopyState(OFF)).toBe("off");
    expect(taxCopyState(SCHED_EX)).toBe("sched_ex");
    expect(taxCopyState(SCHED_IN)).toBe("off");
    expect(taxCopyState(ON_IN)).toBe("on_in");
    expect(taxCopyState(ON_EX)).toBe("on_ex");
    expect(taxCopyState(ON_IN_TO_EX)).toBe("on_in");
    expect(taxCopyState(ON_EX_RATE_UP)).toBe("on_ex");
    expect(taxCopyState(ON_SWITCH_OFF)).toBe("on_in");
  });

  it("finds GST added on top ahead, and a rise ahead", () => {
    expect(upcomingAddedGst(SCHED_EX)?.startsAt).toBe(START);
    expect(upcomingAddedGst(ON_IN_TO_EX)?.startsAt).toBe(START);
    expect(upcomingAddedGst(OFF)).toBeNull();
    expect(upcomingAddedGst(SCHED_IN)).toBeNull();
    expect(upcomingAddedGst(ON_EX)).toBeNull();
    expect(upcomingAddedGst(ON_EX_RATE_UP)).toBeNull();
    expect(upcomingAddedGst(ON_SWITCH_OFF)).toBeNull();

    expect(upcomingRise(SCHED_EX)?.rateBps).toBe(1800);
    expect(upcomingRise(ON_IN_TO_EX)?.rateBps).toBe(1800);
    expect(upcomingRise(ON_EX_RATE_UP)?.rateBps).toBe(1800);
    expect(upcomingRise(SCHED_IN)).toBeNull();
    expect(upcomingRise(ON_SWITCH_OFF)).toBeNull();
    expect(upcomingRise(OFF)).toBeNull();
    expect(upcomingRise(ON_EX)).toBeNull();
  });

  it("asks for the state while GST is charged or any switch-on is scheduled", () => {
    expect(asksForState(OFF)).toBe(false);
    expect(asksForState(SCHED_EX)).toBe(true);
    expect(asksForState(SCHED_IN)).toBe(true);
    expect(asksForState(ON_IN)).toBe(true);
    expect(asksForState(ON_EX)).toBe(true);
    expect(asksForState(ON_SWITCH_OFF)).toBe(true);
    expect(asksForState(at({ ...next(false, true, 1800) }))).toBe(false);
  });
});

// ── Amounts ─────────────────────────────────────────────────────────────────

describe("amountFor", () => {
  it("gives the sample amounts", () => {
    expect(amountFor(150000, OFF)).toEqual(NONE_1500);
    expect(amountFor(150000, ON_EX)).toEqual(EX_1500);
    expect(amountFor(150000, ON_IN)).toEqual(IN_1500);
    expect(amountFor(1500000, ON_EX)).toEqual(EX_15000);
    expect(amountFor(12900, ON_EX)).toEqual(EX_PACK);
    expect(amountFor(1500000, ON_IN).taxPaise).toBe(228814);
    expect(amountFor(150000, ON_EX_RATE_UP)).toEqual({
      totalPaise: 168000,
      taxPaise: 18000,
      rateBps: 1200,
      inclusive: false,
    });
  });

  it("is the invoice builders' arithmetic in every state", () => {
    const lists = [0, 1, 99, 5900, 12900, 100001, 150000, 240000, 1500000];
    for (const terms of [OFF, SCHED_EX, ON_IN, ON_EX, ON_EX_RATE_UP]) {
      const tax = taxContextFor(terms, "03", "07");
      for (const list of lists) {
        const quoted = amountFor(list, terms);
        const built = [
          buildSubscriptionInvoice({
            planLabel: "Basic",
            period: "monthly",
            planPaise: list,
            tax,
          }),
          buildAiCreditsInvoice({
            packLabel: "Starter",
            credits: 60,
            amountPaise: list,
            tax,
          }),
          buildAddonInvoice({
            description: "Extra location",
            amountPaise: list,
            tax,
          }),
        ];
        for (const invoice of built) {
          expect(quoted.totalPaise).toBe(invoice.totalPaise);
          expect(quoted.taxPaise).toBe(invoice.taxPaise);
        }
        expect(quoted.rateBps).toBe(terms.active ? terms.rateBps : 0);
      }
    }
  });

  it("never quotes a negative or broken list price", () => {
    expect(amountFor(-500, ON_EX).totalPaise).toBe(0);
    expect(amountFor(Number.NaN, ON_EX).totalPaise).toBe(0);
  });
});

// ── Refusals when a payment starts ──────────────────────────────────────────

describe("payment refusals", () => {
  it("are the design's sentences", () => {
    expect(PAYMENT_REFUSAL).toEqual({
      invoiceFailed: "Couldn't prepare your invoice. Please try again.",
      settingsIncomplete:
        "Payments are paused while we update our tax details. Please try again later.",
      needsState:
        "Add your state under Billing details before you pay. It goes on your GST invoice.",
      outsideIndia:
        "We can't take payments from businesses outside India yet. Write to support@storemink.com and we'll help.",
    });
  });

  it("tells the merchant the new amount and which button to press", () => {
    expect(amountChanged(177000, "continue_to_payment")).toBe(
      "The amount to pay is now ₹1,770. Check it and press Continue to payment again.",
    );
    expect(amountChanged(47200, "pay")).toBe(
      "The amount to pay is now ₹472. Check it and press Pay again.",
    );
    expect(amountChanged(6962, "continue")).toBe(
      "The amount to pay is now ₹69.62. Check it and press Continue again.",
    );
    // The invoice panel's button reads "Pay now", the packs panel's "Buy now".
    expect(amountChanged(1770000, "pay_now")).toBe(
      "The amount to pay is now ₹17,700. Check it and press Pay now again.",
    );
    expect(amountChanged(6962, "buy_now")).toBe(
      "The amount to pay is now ₹69.62. Check it and press Buy now again.",
    );
    // A dearer plan change's button reads "Pay prorated change" (R2-01).
    expect(amountChanged(59000, "pay_prorated_change")).toBe(
      "The amount to pay is now ₹590. Check it and press Pay prorated change again.",
    );
  });
});

// ── storemink.com ───────────────────────────────────────────────────────────

describe("storemink.com", () => {
  it("writes the card note in each state", () => {
    expect(pricingCardNote(OFF, "monthly", 150000)).toBe(
      "₹1,500 billed every month",
    );
    expect(pricingCardNote(OFF, "yearly", 1500000)).toBe(
      "₹15,000 billed once a year",
    );
    expect(pricingCardNote(SCHED_EX, "monthly", 150000)).toBe(
      "₹1,500 billed every month, plus GST from 1 Dec 2026",
    );
    expect(pricingCardNote(SCHED_EX, "yearly", 1500000)).toBe(
      "₹15,000 billed once a year, plus GST from 1 Dec 2026",
    );
    expect(pricingCardNote(SCHED_IN, "monthly", 150000)).toBe(
      "₹1,500 billed every month",
    );
    expect(pricingCardNote(ON_IN, "monthly", 150000)).toBe(
      "₹1,500 billed every month, GST included",
    );
    expect(pricingCardNote(ON_IN, "yearly", 1500000)).toBe(
      "₹15,000 billed once a year, GST included",
    );
    expect(pricingCardNote(ON_EX, "monthly", 150000)).toBe(
      "₹1,770 billed every month, including GST",
    );
    expect(pricingCardNote(ON_EX, "yearly", 1500000)).toBe(
      "₹17,700 billed once a year, including GST",
    );
    for (const terms of ALL_TERMS) {
      expect(pricingCardNote(terms, "monthly", 0)).toBe("No card needed");
    }
  });

  it("adds the GST words after a headline price", () => {
    expect(pricingPriceSuffix(ON_EX)).toBe("plus GST");
    for (const terms of [OFF, SCHED_EX, SCHED_IN, ON_IN, ON_IN_TO_EX]) {
      expect(pricingPriceSuffix(terms)).toBeNull();
    }
    expect(priceGstSuffix(OFF)).toBe("");
    expect(priceGstSuffix(SCHED_EX)).toBe("");
    expect(priceGstSuffix(SCHED_IN)).toBe("");
    expect(priceGstSuffix(ON_IN)).toBe(" including GST");
    expect(priceGstSuffix(ON_EX)).toBe(" plus GST");
    expect(
      `Paid plans start at ₹1,500 per month${priceGstSuffix(ON_EX)}.`,
    ).toBe("Paid plans start at ₹1,500 per month plus GST.");
  });

  it("writes the footnote under the cards", () => {
    expect(pricingFootnote(OFF)).toBeNull();
    expect(pricingFootnote(SCHED_IN)).toBeNull();
    expect(pricingFootnote(SCHED_EX)).toBe(
      "Prices exclude GST. From 1 December 2026, GST at 18% is added when you pay.",
    );
    expect(pricingFootnote(ON_IN)).toBe("Prices include GST at 18%.");
    expect(pricingFootnote(ON_IN_TO_EX)).toBe(
      "Prices include GST at 18%. From 1 December 2026, prices exclude GST and GST at 18% is added when you pay.",
    );
    expect(pricingFootnote(ON_EX)).toBe(
      "Prices exclude GST. GST at 18% is added when you pay, and you see the total before you pay.",
    );
  });

  it("writes the POS price box and the JSON-LD flag", () => {
    expect(posPriceBoxNote(OFF)).toBe("billed yearly");
    expect(posPriceBoxNote(SCHED_EX)).toBe("billed yearly");
    expect(posPriceBoxNote(ON_IN)).toBe("billed yearly, GST included");
    expect(posPriceBoxNote(ON_EX)).toBe("billed yearly, plus GST");
    expect(valueAddedTaxIncluded(OFF)).toBeUndefined();
    expect(valueAddedTaxIncluded(SCHED_EX)).toBeUndefined();
    expect(valueAddedTaxIncluded(ON_IN)).toBe(true);
    expect(valueAddedTaxIncluded(ON_EX)).toBe(false);
  });

  it("answers the GST question only when GST is on or added ahead", () => {
    expect(GST_FAQ_QUESTION).toBe("Do your prices include GST?");
    expect(gstFaq(OFF)).toBeNull();
    expect(gstFaq(SCHED_IN)).toBeNull();
    expect(gstFaq(ON_IN)).toEqual({
      question: "Do your prices include GST?",
      answer:
        "Yes. Every price on this page includes GST at 18%. Your invoice shows the GST in it, and if you add your GSTIN in Plans & Billing you can claim it as input tax credit.",
    });
    expect(gstFaq(ON_IN_TO_EX)?.answer).toBe(
      "Yes. Every price on this page includes GST at 18%. Your invoice shows the GST in it, and if you add your GSTIN in Plans & Billing you can claim it as input tax credit. From 1 December 2026, prices exclude GST and GST at 18% is added when you pay.",
    );
    expect(gstFaq(ON_EX)?.answer).toBe(
      "No. GST at 18% is added to every plan, extra location and Mink credit pack when you pay, and you see the total with GST before you pay. Your invoice shows the GST charged, and if you add your GSTIN in Plans & Billing you can claim it as input tax credit.",
    );
    expect(gstFaq(SCHED_EX)?.answer).toBe(
      "Today no GST is charged. From 1 December 2026, GST at 18% is added to every plan, extra location and Mink credit pack when you pay, and you see the total with GST before you pay. Your invoice shows the GST charged, and if you add your GSTIN in Plans & Billing you can claim it as input tax credit.",
    );
  });
});

// ── Signup ──────────────────────────────────────────────────────────────────

describe("signup plan step", () => {
  it("writes the yearly line", () => {
    expect(signupYearlyLine(null, 1500000)).toBe(
      "₹1,250 a month, billed yearly",
    );
    expect(signupYearlyLine(OFF, 1500000)).toBe(
      "₹1,250 a month, billed yearly",
    );
    expect(signupYearlyLine(SCHED_EX, 1500000)).toBe(
      "₹1,250 a month, billed yearly",
    );
    expect(signupYearlyLine(ON_IN, 1500000)).toBe(
      "₹1,250 a month, billed yearly, GST included",
    );
    expect(signupYearlyLine(ON_EX, 1500000)).toBe(
      "₹1,475 a month with GST, billed yearly",
    );
    // Whole rupees, as the plan picker rounds them today.
    expect(signupYearlyLine(OFF, 5000000)).toBe(
      "₹4,167 a month, billed yearly",
    );
  });

  it("writes the pay-now line", () => {
    expect(signupPayNowLine(null, "monthly", NONE_1500)).toBe(
      "You'll see the exact amount before you pay.",
    );
    expect(signupPayNowLine(OFF, "monthly", NONE_1500)).toBe(
      "You pay ₹1,500 now.",
    );
    expect(signupPayNowLine(OFF, "yearly", amountFor(1500000, OFF))).toBe(
      "You pay ₹15,000 now for the first year.",
    );
    expect(signupPayNowLine(SCHED_EX, "monthly", NONE_1500)).toBe(
      "You pay ₹1,500 now. From 1 Dec 2026, GST at 18% is added to your renewals.",
    );
    expect(signupPayNowLine(SCHED_IN, "monthly", NONE_1500)).toBe(
      "You pay ₹1,500 now.",
    );
    expect(signupPayNowLine(ON_IN, "monthly", IN_1500)).toBe(
      "You pay ₹1,500 now, including ₹228.81 GST.",
    );
    expect(signupPayNowLine(ON_EX, "monthly", EX_1500)).toBe(
      "You pay ₹1,770 now: ₹1,500 plus ₹270 GST.",
    );
    expect(signupPayNowLine(ON_EX, "yearly", EX_15000)).toBe(
      "You pay ₹17,700 now for the first year: ₹15,000 plus ₹2,700 GST.",
    );
    expect(signupPayNowLine(ON_IN_TO_EX, "monthly", IN_1500)).toBe(
      "You pay ₹1,500 now, including ₹228.81 GST. From 1 Dec 2026, GST at 18% is added to your renewals.",
    );
  });

  it("writes the continue button", () => {
    expect(signupContinueLabel(null, "Basic", "monthly", 150000)).toBe(
      "Continue with Basic · ₹1,500/month",
    );
    expect(signupContinueLabel(ON_IN, "Basic", "monthly", 150000)).toBe(
      "Continue with Basic · ₹1,500/month",
    );
    expect(signupContinueLabel(ON_EX, "Basic", "monthly", 177000)).toBe(
      "Continue with Basic · ₹1,770/month with GST",
    );
    expect(signupContinueLabel(ON_EX, "Basic", "yearly", 1770000)).toBe(
      "Continue with Basic · ₹17,700/year with GST",
    );
  });

  it("asks for the state", () => {
    expect(INVALID_GSTIN).toBe(
      "That doesn't look like a valid 15-character GSTIN.",
    );
    expect(SIGNUP_STATE).toEqual({
      stateLabel: "Your business's state",
      stateHint: "It goes on your invoices, as the GST rules require.",
      gstinLabel: "GSTIN (optional)",
      gstinHint:
        "Add it to claim the GST as input tax credit. Your state is then taken from it.",
      invalidGstin: "That doesn't look like a valid 15-character GSTIN.",
      outsideIndia:
        "We can't take payments from businesses outside India yet. Start on Free, and write to support@storemink.com if you'd like a paid plan.",
      saveFailed: "Couldn't save your state. Please try again.",
    });
  });
});

// ── Plans & Billing ─────────────────────────────────────────────────────────

describe("Plans & Billing", () => {
  it("writes the current plan's price for its own period", () => {
    expect(currentPlanPrice(OFF, "monthly", 150000)).toBe("₹1,500 a month");
    expect(currentPlanPrice(OFF, "yearly", 1500000)).toBe("₹15,000 a year");
    expect(currentPlanPrice(SCHED_EX, "monthly", 150000)).toBe(
      "₹1,500 a month",
    );
    expect(currentPlanPrice(ON_IN, "monthly", 150000)).toBe(
      "₹1,500 a month, including GST",
    );
    expect(currentPlanPrice(ON_EX, "monthly", 150000)).toBe(
      "₹1,500 a month plus GST",
    );
    expect(currentPlanPrice(ON_EX, "monthly", 0)).toBe("Free");
  });

  it("writes the next renewal", () => {
    expect(NEXT_RENEWAL_LABEL).toBe("Next renewal");
    expect(nextRenewalValue(EX_1500, "2026-11-13T18:30:00.000Z")).toBe(
      "₹1,770 on 14 Nov 2026",
    );
    expect(nextRenewalGstLine(EX_1500)).toBe("Including ₹270 GST");
    expect(nextRenewalGstLine(IN_1500)).toBe("Including ₹228.81 GST");
    expect(nextRenewalGstLine(NONE_1500)).toBeNull();
  });

  it("says when a renewal is paid by hand", () => {
    const due = "2026-11-13T18:30:00.000Z";
    expect(
      renewalByHandLine({
        route: { auto: true },
        totalPaise: 177000,
        dueOn: due,
        mandateMaxPaise: 500000,
      }),
    ).toBeNull();
    expect(
      renewalByHandLine({
        route: { auto: false, reason: "over_afa_limit" },
        totalPaise: 1770000,
        dueOn: due,
        mandateMaxPaise: 2000000,
      }),
    ).toBe(
      "Your next renewal of ₹17,700 is above ₹15,000, the most that can be charged automatically, so we'll email you an invoice to pay by 14 Nov 2026.",
    );
    expect(
      renewalByHandLine({
        route: { auto: false, reason: "over_mandate" },
        totalPaise: 519200,
        dueOn: due,
        mandateMaxPaise: 500000,
      }),
    ).toBe(
      "Your next renewal of ₹5,192 is above the ₹5,000 autopay limit you approved, so we'll email you an invoice to pay by 14 Nov 2026.",
    );
    expect(
      renewalByHandLine({
        route: { auto: false, reason: "over_mandate" },
        totalPaise: 519200,
        dueOn: due,
        mandateMaxPaise: null,
      }),
    ).toBe(
      "We'll email you an invoice for your next renewal of ₹5,192 to pay by 14 Nov 2026.",
    );
    expect(
      renewalByHandLine({
        route: { auto: false, reason: "no_mandate" },
        totalPaise: 177000,
        dueOn: due,
        mandateMaxPaise: null,
      }),
    ).toBe(
      "We'll email you an invoice for your next renewal of ₹1,770 to pay by 14 Nov 2026.",
    );
  });

  describe("the GST notice banner", () => {
    const after: NoticeRenewal = {
      renewsOn: "2026-12-13T18:30:00.000Z",
      amount: EX_1500,
      route: { auto: true },
      mandateMaxPaise: 500000,
    };
    const tail =
      "Add your GSTIN under Billing details to claim the GST as input tax credit.";
    const from =
      "From then, GST at 18% is added to every plan, extra location and Mink credit pack.";

    it("shows only while a rise is scheduled", () => {
      for (const terms of [OFF, SCHED_IN, ON_IN, ON_EX, ON_SWITCH_OFF]) {
        expect(gstNoticeBanner(terms, after)).toBeNull();
      }
    });

    it("names the start and, for a renewal after it, its amount", () => {
      expect(gstNoticeBanner(SCHED_EX, null)).toEqual({
        title: "GST will be added to our prices from 1 December 2026",
        lines: [from, tail],
      });
      expect(gstNoticeBanner(SCHED_EX, after)).toEqual({
        title: "GST will be added to our prices from 1 December 2026",
        lines: [
          from,
          "Your renewal on 14 Dec 2026 will be ₹1,770: ₹1,500 plus ₹270 GST.",
          tail,
        ],
      });
      expect(gstNoticeBanner(ON_IN_TO_EX, after)?.title).toBe(
        "GST will be added to our prices from 1 December 2026",
      );
    });

    it("leaves out a renewal invoiced before the start", () => {
      expect(
        gstNoticeBanner(SCHED_EX, { ...after, amount: NONE_1500 })?.lines,
      ).toEqual([from, tail]);
      expect(
        gstNoticeBanner(ON_EX_RATE_UP, {
          ...after,
          amount: amountFor(150000, ON_EX_RATE_UP),
        })?.lines,
      ).toEqual([from, tail]);
    });

    it("says when the renewal stops fitting automatic collection", () => {
      expect(
        gstNoticeBanner(SCHED_EX, {
          ...after,
          amount: EX_15000,
          route: { auto: false, reason: "over_afa_limit" },
        })?.lines,
      ).toEqual([
        from,
        "Your renewal on 14 Dec 2026 will be ₹17,700: ₹15,000 plus ₹2,700 GST.",
        "That's above ₹15,000, the most that can be charged automatically, so we'll email you an invoice to pay instead.",
        tail,
      ]);
      expect(
        gstNoticeBanner(SCHED_EX, {
          ...after,
          route: { auto: false, reason: "over_mandate" },
          mandateMaxPaise: 150000,
        })?.lines,
      ).toEqual([
        from,
        "Your renewal on 14 Dec 2026 will be ₹1,770: ₹1,500 plus ₹270 GST.",
        "That's above the ₹1,500 autopay limit you approved, so we'll email you an invoice to pay instead.",
        tail,
      ]);
      expect(
        gstNoticeBanner(SCHED_EX, {
          ...after,
          route: { auto: false, reason: "no_mandate" },
        })?.lines,
      ).toHaveLength(3);
    });

    it("titles a rate rise as a rise", () => {
      expect(gstNoticeBanner(ON_EX_RATE_UP, after)).toEqual({
        title: "The GST on our prices goes up from 1 December 2026",
        lines: [
          from,
          "Your renewal on 14 Dec 2026 will be ₹1,770: ₹1,500 plus ₹270 GST.",
          tail,
        ],
      });
    });
  });

  describe("the state banner", () => {
    const why =
      "the GST rules ask us to show your state on them. We couldn't find it in your details. Add it under Billing details below.";

    it("asks a store with no state of its own", () => {
      expect(stateBanner(SCHED_EX, "supplier_state")).toEqual({
        title: "Add your state for your invoices",
        body: `From 1 Dec 2026 StoreMink's invoices show GST, and ${why}`,
        action: "Add your state",
      });
      expect(stateBanner(SCHED_IN, "unknown")?.body).toBe(
        `From 1 Dec 2026 StoreMink's invoices show GST, and ${why}`,
      );
      expect(stateBanner(ON_IN, "supplier_state")).toEqual({
        title: "Add your state for your invoices",
        body: `StoreMink's invoices show GST, and ${why}`,
        action: "Add your state",
      });
    });

    it("says nothing while no GST is ahead, or once a state is known", () => {
      expect(stateBanner(OFF, "supplier_state")).toBeNull();
      expect(stateBanner(OFF, "unknown")).toBeNull();
      for (const basis of BASES.filter(
        (b) => !["supplier_state", "unknown", "outside_india"].includes(b),
      )) {
        expect(stateBanner(ON_EX, basis)).toBeNull();
      }
    });

    it("tells a business outside India, while GST is charged", () => {
      expect(stateBanner(ON_EX, "outside_india")).toEqual({
        title: null,
        body: "Your business is outside India. Your renewals are charged IGST. New payments can't be made from outside India yet; write to support@storemink.com if you need one.",
        action: null,
      });
      expect(stateBanner(SCHED_EX, "outside_india")).toBeNull();
    });
  });

  it("writes the grid suffix and the pack price, never per credit", () => {
    expect(plansGridSuffix(OFF)).toBeNull();
    expect(plansGridSuffix(SCHED_EX)).toBeNull();
    expect(plansGridSuffix(ON_IN)).toBe("including GST");
    expect(plansGridSuffix(ON_EX)).toBe("plus GST");
    expect(packPrice(OFF, 5900)).toBe("₹59");
    expect(packPrice(SCHED_EX, 5900)).toBe("₹59");
    expect(packPrice(ON_IN, 5900)).toBe("₹59 including GST");
    expect(packPrice(ON_EX, 5900)).toBe("₹69.62 including GST");
    // An amount that already includes any GST (what a start asked for).
    expect(packTotalPrice(OFF, 15222)).toBe("₹152.22");
    expect(packTotalPrice(SCHED_EX, 15222)).toBe("₹152.22");
    expect(packTotalPrice(ON_IN, 15222)).toBe("₹152.22 including GST");
    expect(packTotalPrice(ON_EX, 15222)).toBe("₹152.22 including GST");
    // packPrice is packTotalPrice over amountFor, in every state.
    for (const t of ALL_TERMS) {
      for (const l of LISTS) {
        expect(packPrice(t, l)).toBe(
          packTotalPrice(t, amountFor(l, t).totalPaise),
        );
      }
    }
  });

  it("names invoices and their GST", () => {
    expect(invoiceListName("SM/2026-27/00001", 27000)).toBe(
      "Tax invoice SM/2026-27/00001",
    );
    expect(invoiceListName("SM/2026-27/00002", 0)).toBe(
      "Invoice SM/2026-27/00002",
    );
    expect(invoiceGstLine(270000, 1800)).toBe("Including ₹2,700 GST (18%)");
    expect(invoiceGstLine(27000, null)).toBe("Including ₹270 GST");
    expect(invoiceGstLine(0, 1800)).toBeNull();
  });

  it("writes the Billing details card", () => {
    expect(BILLING_DETAILS.title).toBe("Billing details");
    expect(BILLING_DETAILS.description).toBe(
      "These go on the invoices StoreMink sends you. Add your GSTIN to claim the GST on them as input tax credit.",
    );
    expect(BILLING_DETAILS.fields).toEqual({
      country: { label: "Country" },
      countryName: { label: "Country name" },
      businessName: {
        label: "Business name",
        hint: "As it should appear on your invoices. Leave blank to use your store's name.",
      },
      gstin: {
        label: "GSTIN (optional)",
        hint: "15 characters. Your state is taken from it.",
      },
      state: {
        label: "State",
        hint: "Decides whether your invoice shows CGST and SGST or IGST.",
        placeholder: "Choose your state",
      },
      address: { label: "Address" },
      address2: { label: "Address line 2 (optional)" },
      city: { label: "City" },
      pin: { label: "PIN code" },
      postalCode: { label: "Postal code (optional)" },
    });
    expect(BILLING_DETAILS.save).toBe("Save billing details");
    expect(BILLING_DETAILS.saving).toBe("Saving…");
    expect(BILLING_DETAILS.saved).toBe(
      "Billing details saved. They apply to invoices issued from now on.",
    );
    expect(BILLING_DETAILS.errors).toEqual({
      gstin: "That doesn't look like a valid 15-character GSTIN.",
      state: "Choose your state.",
      pin: "Enter a 6-digit PIN code.",
      countryName: "Enter your country's name.",
      failed: "Couldn't save your billing details. Please try again.",
    });
    expect(BILLING_DETAILS.footnote).toBe(
      "An invoice that has already been issued can't be changed.",
    );
    expect(BILLING_DETAILS.staffOnly).toBe(
      "Only someone who manages billing can change these.",
    );
    expect(BILLING_DETAILS.loadFailed).toBe(
      "Couldn't load your billing details. Refresh the page to try again.",
    );

    expect(billingDetailsPrefilled(null)).toBeNull();
    expect(billingDetailsPrefilled("taxes_and_invoices")).toBe(
      "Filled in from Settings → Taxes & invoices. Check them and save.",
    );
    expect(billingDetailsPrefilled("location")).toBe(
      "Filled in from your main location. Check them and save.",
    );
    expect(billingDetailsPrefilled("signup")).toBe(
      "Filled in from the details you gave when you signed up. Check them and save.",
    );
  });

  it("says which state the invoices use, and from where", () => {
    expect(billingDetailsUses({ code: "07", basis: "gstin" }, null)).toBe(
      "Your invoices use: Delhi (07), from your GSTIN.",
    );
    expect(
      billingDetailsUses({ code: "03", basis: "billing_state" }, null),
    ).toBe("Your invoices use: Punjab (03), from these billing details.");
    expect(billingDetailsUses({ code: "07", basis: "store_gstin" }, null)).toBe(
      "Your invoices use: Delhi (07), from Taxes & invoices.",
    );
    expect(
      billingDetailsUses({ code: "07", basis: "location_state" }, null),
    ).toBe("Your invoices use: Delhi (07), from your main location.");
    expect(
      billingDetailsUses({ code: "07", basis: "store_address" }, null),
    ).toBe(
      "Your invoices use: Delhi (07), from the address you typed in Taxes & invoices.",
    );
    expect(
      billingDetailsUses({ code: "07", basis: "signup_address" }, null),
    ).toBe("Your invoices use: Delhi (07), from your signup details.");
    expect(
      billingDetailsUses(
        { code: "96", basis: "outside_india" },
        "United States",
      ),
    ).toBe("Your invoices use: outside India (United States).");
    expect(
      billingDetailsUses({ code: "96", basis: "outside_india" }, " "),
    ).toBe("Your invoices use: outside India.");
    const none =
      "We couldn't find your state. Choose it above so your invoices show it.";
    expect(
      billingDetailsUses({ code: "03", basis: "supplier_state" }, null),
    ).toBe(none);
    expect(billingDetailsUses({ code: null, basis: "unknown" }, null)).toBe(
      none,
    );
    expect(billingDetailsUses({ code: "42", basis: "gstin" }, null)).toBe(none);
  });

  it("writes the checkout dialog's cards and rows", () => {
    expect(checkoutPlanCard(OFF, "monthly", 150000)).toEqual({
      amount: "₹1,500",
      line: "Billed every month",
    });
    expect(checkoutPlanCard(SCHED_EX, "monthly", 150000)).toEqual({
      amount: "₹1,500",
      line: "Billed every month, plus GST from 1 Dec 2026",
    });
    expect(checkoutPlanCard(ON_IN, "yearly", 1500000)).toEqual({
      amount: "₹15,000",
      line: "Billed every year, GST included",
    });
    expect(checkoutPlanCard(ON_EX, "monthly", 150000)).toEqual({
      amount: "₹1,500 plus GST",
      line: "₹1,770 billed every month",
    });
    expect(checkoutPlanCard(ON_EX, "monthly", 0)).toEqual({
      amount: "Free",
      line: "No recurring charge",
    });

    expect(checkoutPackPrice(OFF, 5900)).toBe("₹59 once");
    expect(checkoutPackPrice(SCHED_EX, 5900)).toBe("₹59 once");
    expect(checkoutPackPrice(ON_IN, 5900)).toBe("₹59 once, including GST");
    expect(checkoutPackPrice(ON_EX, 5900)).toBe("₹69.62 once, including GST");
    expect(checkoutCreditsRow(OFF, 60, 12900)).toBe("60 credits · ₹129 once");
    expect(checkoutCreditsRow(ON_IN, 60, 12900)).toBe(
      "60 credits · ₹129 once, including GST",
    );
    expect(checkoutCreditsRow(ON_EX, 60, 12900)).toBe(
      "60 credits · ₹152.22 once, including GST",
    );

    expect(CHECKOUT).toEqual({
      exactAmount: "The payment window asks for exactly this amount.",
      nothingChargedNow: "Nothing is charged now.",
      working: "Working out the total…",
      failed: "We couldn't work out the total. Please try again.",
      tryAgain: "Try again",
      needsState: "Add your state before you pay. It goes on your GST invoice.",
      save: "Save",
      outsideIndia:
        "We can't take payments from businesses outside India yet. Write to support@storemink.com and we'll help.",
    });
  });

  describe("the checkout summary", () => {
    const row = (
      label: string,
      value: string | null,
      note: string | null = null,
    ) => ({
      label,
      value,
      note,
    });

    it("a new plan in each state", () => {
      expect(
        checkoutSummary({
          terms: OFF,
          period: "monthly",
          kind: "subscribe",
          payNow: NONE_1500,
          renewal: NONE_1500,
        }),
      ).toEqual({
        rows: [row("Pay now", "₹1,500"), row("Then", "₹1,500 every month")],
        note: "The payment window asks for exactly this amount.",
      });
      expect(
        checkoutSummary({
          terms: ON_EX,
          period: "monthly",
          kind: "subscribe",
          payNow: EX_1500,
          renewal: EX_1500,
        }).rows,
      ).toEqual([
        row("Plan", "₹1,500"),
        row("GST (18%)", "₹270"),
        row("Pay now", "₹1,770"),
        row("Then", "₹1,770 every month, including GST"),
      ]);
      expect(
        checkoutSummary({
          terms: ON_IN,
          period: "monthly",
          kind: "subscribe",
          payNow: IN_1500,
          renewal: IN_1500,
        }).rows,
      ).toEqual([
        row("Pay now", "₹1,500", "Includes ₹228.81 GST (18%)"),
        row("Then", "₹1,500 every month, including GST"),
      ]);
      expect(
        checkoutSummary({
          terms: SCHED_EX,
          period: "monthly",
          kind: "subscribe",
          payNow: NONE_1500,
          renewal: EX_1500,
        }).rows,
      ).toEqual([
        row("Pay now", "₹1,500"),
        row("Then", "₹1,770 every month, including GST from 1 Dec 2026"),
      ]);
      expect(
        checkoutSummary({
          terms: ON_IN_TO_EX,
          period: "monthly",
          kind: "subscribe",
          payNow: IN_1500,
          renewal: EX_1500,
        }).rows,
      ).toEqual([
        row("Pay now", "₹1,500", "Includes ₹228.81 GST (18%)"),
        row("Then", "₹1,770 every month, including GST from 1 Dec 2026"),
      ]);
    });

    // R2-14: a renewal invoiced before a scheduled added-GST start holds for
    // that renewal only, so the row says when GST joins it.
    it("says when GST joins a renewal invoiced before the start", () => {
      const then = (
        terms: TaxTerms,
        kind: "subscribe" | "dearer_change" | "scheduled_change",
        payNow: CopyAmount,
        renewal: CopyAmount,
      ) =>
        checkoutSummary({
          terms,
          period: "monthly",
          kind,
          payNow,
          renewal,
          effectiveAt: "2026-11-14T18:30:00.000Z",
        }).rows.at(-1);
      expect(then(SCHED_EX, "subscribe", NONE_1500, NONE_1500)).toEqual(
        row(
          "Then",
          "₹1,500 every month. GST at 18% is added to renewals invoiced from 1 Dec 2026.",
        ),
      );
      expect(then(SCHED_EX, "dearer_change", NONE_1500, NONE_1500)).toEqual(
        row(
          "From your next renewal",
          "₹1,500 every month. GST at 18% is added to renewals invoiced from 1 Dec 2026.",
        ),
      );
      expect(then(SCHED_EX, "scheduled_change", NONE_1500, NONE_1500)).toEqual(
        row(
          "From 15 Nov 2026",
          "₹1,500 every month. GST at 18% is added to renewals invoiced from 1 Dec 2026.",
        ),
      );
      // Prices that include GST today, moving to GST added on top.
      expect(then(ON_IN_TO_EX, "subscribe", IN_1500, IN_1500)).toEqual(
        row(
          "Then",
          "₹1,500 every month, including GST. GST at 18% is added to renewals invoiced from 1 Dec 2026.",
        ),
      );
      // Nothing scheduled that adds GST: no sentence.
      expect(then(OFF, "subscribe", NONE_1500, NONE_1500)).toEqual(
        row("Then", "₹1,500 every month"),
      );
      expect(then(SCHED_IN, "subscribe", NONE_1500, NONE_1500)).toEqual(
        row("Then", "₹1,500 every month"),
      );
      expect(then(ON_IN, "subscribe", IN_1500, IN_1500)).toEqual(
        row("Then", "₹1,500 every month, including GST"),
      );
    });

    it("a dearer change, a scheduled change and a pack", () => {
      expect(
        checkoutSummary({
          terms: ON_EX,
          period: "monthly",
          kind: "dearer_change",
          payNow: {
            totalPaise: 35400,
            taxPaise: 5400,
            rateBps: 1800,
            inclusive: false,
          },
          renewal: {
            totalPaise: 283200,
            taxPaise: 43200,
            rateBps: 1800,
            inclusive: false,
          },
        }),
      ).toEqual({
        rows: [
          row("Plan", "₹300"),
          row("GST (18%)", "₹54"),
          row("Pay now for the rest of this cycle", "₹354"),
          row("From your next renewal", "₹2,832 every month, including GST"),
        ],
        note: "The payment window asks for exactly this amount.",
      });
      expect(
        checkoutSummary({
          terms: SCHED_EX,
          period: "yearly",
          kind: "scheduled_change",
          payNow: EX_1500,
          renewal: EX_15000,
          effectiveAt: "2026-12-13T18:30:00.000Z",
        }),
      ).toEqual({
        rows: [
          row("Nothing to pay now", null),
          row("From 14 Dec 2026", "₹17,700 every year, including GST"),
        ],
        note: "Nothing is charged now.",
      });
      expect(
        checkoutSummary({
          terms: ON_EX,
          period: "monthly",
          kind: "subscribe",
          payNow: EX_1500,
          renewal: EX_1500,
          pack: EX_PACK,
        }).rows.at(-1),
      ).toEqual(row("Mink credits, separate payment", "₹152.22 including GST"));
      expect(
        checkoutSummary({
          terms: OFF,
          period: "monthly",
          kind: "subscribe",
          payNow: NONE_1500,
          renewal: NONE_1500,
          pack: amountFor(12900, OFF),
        }).rows.at(-1),
      ).toEqual(row("Mink credits, separate payment", "₹129"));
    });
  });
});

// ── Locations ───────────────────────────────────────────────────────────────

describe("Locations", () => {
  it("writes the summary and the button", () => {
    expect(locationsExtraSummary(OFF, 2, 100000, "monthly")).toBe(
      "2 extra at ₹1,000/month each",
    );
    expect(locationsExtraSummary(SCHED_EX, 2, 100000, "monthly")).toBe(
      "2 extra at ₹1,000/month each",
    );
    expect(locationsExtraSummary(ON_IN, 2, 100000, "monthly")).toBe(
      "2 extra at ₹1,000/month each, including GST",
    );
    expect(locationsExtraSummary(ON_EX, 1, 1000000, "yearly")).toBe(
      "1 extra at ₹10,000/year each, plus GST",
    );
    expect(addLocationButton(OFF, 100000, "monthly")).toBe(
      "Add a location · ₹1,000/month",
    );
    expect(addLocationButton(ON_IN, 100000, "monthly")).toBe(
      "Add a location · ₹1,000/month",
    );
    expect(addLocationButton(ON_EX, 100000, "monthly")).toBe(
      "Add a location · ₹1,000/month plus GST",
    );
  });

  describe("the confirmation", () => {
    const off = amountFor(100000, OFF);
    const offNow = amountFor(40000, OFF);
    const inc = amountFor(100000, ON_IN);
    const incNow = amountFor(40000, ON_IN);
    const exc = amountFor(100000, ON_EX);
    const excNow = amountFor(40000, ON_EX);

    it("with no GST", () => {
      expect(
        addLocationConfirm({
          terms: OFF,
          period: "monthly",
          perLocation: off,
          nextPurchase: offNow,
          nextRenewal: off,
        }),
      ).toEqual({
        text: "Add a location for ₹1,000/month. You'll pay ₹400 now for the rest of this cycle, then ₹1,000/month from your next renewal.",
        confirmLabel: "Pay ₹400",
      });
      expect(
        addLocationConfirm({
          terms: OFF,
          period: "monthly",
          perLocation: off,
          nextPurchase: null,
          nextRenewal: off,
        }),
      ).toEqual({
        text: "Add a location for ₹1,000/month, billed from your next renewal.",
        confirmLabel: "Add location",
      });
    });

    it("with a switch to prices excluding GST scheduled", () => {
      expect(
        addLocationConfirm({
          terms: SCHED_EX,
          period: "monthly",
          perLocation: off,
          nextPurchase: offNow,
          nextRenewal: off,
        }).text,
      ).toBe(
        "Add a location for ₹1,000/month. You'll pay ₹400 now for the rest of this cycle, then ₹1,000/month from your next renewal. GST at 18% is added to renewals invoiced from 1 Dec 2026.",
      );
      expect(
        addLocationConfirm({
          terms: SCHED_EX,
          period: "monthly",
          perLocation: off,
          nextPurchase: offNow,
          nextRenewal: exc,
        }).text,
      ).toBe(
        "Add a location for ₹1,000/month. You'll pay ₹400 now for the rest of this cycle, then ₹1,180/month including GST from your next renewal.",
      );
      expect(
        addLocationConfirm({
          terms: SCHED_EX,
          period: "monthly",
          perLocation: off,
          nextPurchase: { ...offNow, totalPaise: 0 },
          nextRenewal: exc,
        }).text,
      ).toBe("Add a location for ₹1,000/month, billed from your next renewal.");
    });

    it("with prices including GST", () => {
      expect(
        addLocationConfirm({
          terms: ON_IN,
          period: "monthly",
          perLocation: inc,
          nextPurchase: incNow,
          nextRenewal: inc,
        }),
      ).toEqual({
        text: "Add a location for ₹1,000/month, including GST. You'll pay ₹400 now for the rest of this cycle, including ₹61.02 GST, then ₹1,000/month from your next renewal.",
        confirmLabel: "Pay ₹400",
      });
      expect(
        addLocationConfirm({
          terms: ON_IN,
          period: "monthly",
          perLocation: inc,
          nextPurchase: null,
          nextRenewal: inc,
        }).text,
      ).toBe(
        "Add a location for ₹1,000/month, including GST, billed from your next renewal.",
      );
    });

    it("with prices excluding GST", () => {
      expect(
        addLocationConfirm({
          terms: ON_EX,
          period: "monthly",
          perLocation: exc,
          nextPurchase: excNow,
          nextRenewal: exc,
        }),
      ).toEqual({
        text: "Add a location for ₹1,000/month plus GST, ₹1,180/month in all. You'll pay ₹472 now for the rest of this cycle (₹400 plus ₹72 GST), then ₹1,180/month from your next renewal.",
        confirmLabel: "Pay ₹472",
      });
      expect(
        addLocationConfirm({
          terms: ON_EX,
          period: "monthly",
          perLocation: exc,
          nextPurchase: null,
          nextRenewal: exc,
        }).text,
      ).toBe(
        "Add a location for ₹1,000/month plus GST, billed from your next renewal.",
      );
    });

    // R2-04: no renewal will bill the location (the plan is cancelling, the
    // next plan has no POS, or the renewal could not be read). Nothing may
    // promise a renewal figure, in any state.
    it("with no renewal to bill it", () => {
      const noRenewal = (
        terms: TaxTerms,
        perLocation: CopyAmount,
        nextPurchase: CopyAmount | null,
      ) =>
        addLocationConfirm({
          terms,
          period: "monthly",
          perLocation,
          nextPurchase,
          nextRenewal: null,
        });
      expect(noRenewal(OFF, off, offNow)).toEqual({
        text: "Add a location for ₹1,000/month. You'll pay ₹400 now for the rest of this cycle.",
        confirmLabel: "Pay ₹400",
      });
      expect(noRenewal(OFF, off, null)).toEqual({
        text: "Add a location for ₹1,000/month.",
        confirmLabel: "Add location",
      });
      // SCHED-EX: no GST-ahead sentence either, since no renewal is coming.
      expect(noRenewal(SCHED_EX, off, offNow)).toEqual({
        text: "Add a location for ₹1,000/month. You'll pay ₹400 now for the rest of this cycle.",
        confirmLabel: "Pay ₹400",
      });
      expect(noRenewal(SCHED_EX, off, null).text).toBe(
        "Add a location for ₹1,000/month.",
      );
      expect(noRenewal(ON_IN, inc, incNow)).toEqual({
        text: "Add a location for ₹1,000/month, including GST. You'll pay ₹400 now for the rest of this cycle, including ₹61.02 GST.",
        confirmLabel: "Pay ₹400",
      });
      expect(noRenewal(ON_IN, inc, null).text).toBe(
        "Add a location for ₹1,000/month, including GST.",
      );
      expect(noRenewal(ON_EX, exc, excNow)).toEqual({
        text: "Add a location for ₹1,000/month plus GST, ₹1,180/month in all. You'll pay ₹472 now for the rest of this cycle (₹400 plus ₹72 GST).",
        confirmLabel: "Pay ₹472",
      });
      expect(noRenewal(ON_EX, exc, null).text).toBe(
        "Add a location for ₹1,000/month plus GST.",
      );
      for (const terms of [OFF, SCHED_EX, ON_IN, ON_EX]) {
        for (const nextPurchase of [null, offNow, incNow, excNow]) {
          const { text } = noRenewal(
            terms,
            amountFor(100000, terms),
            nextPurchase,
          );
          expect(text).not.toMatch(/renewal/);
          expect(text).not.toMatch(/,\.|, then/);
        }
      }
    });
  });
});

// ── The invoice ─────────────────────────────────────────────────────────────

describe("the invoice sheet", () => {
  it("has the design's labels", () => {
    expect(INVOICE_SHEET).toEqual({
      taxTitle: "Tax Invoice",
      plainTitle: "Invoice",
      original: "Original for recipient",
      placeOfSupply: "Place of supply",
      reverseCharge: "Tax payable on reverse charge",
      reverseChargeValue: "No",
      columns: {
        description: "Description",
        sac: "SAC",
        qty: "Qty",
        rate: "Rate",
        amount: "Amount",
        amountInclusive: "Amount (GST included)",
      },
      totals: {
        taxableValue: "Taxable value",
        subtotal: "Subtotal",
        discount: "Discount",
        total: "Total",
      },
      taxFooter:
        "This is a computer-generated tax invoice and does not require a signature.",
      plainFooter:
        "No GST has been charged on this invoice. This is a computer-generated document and does not require a signature.",
    });
  });

  it("writes the party lines and the GST labels", () => {
    expect(invoiceGstinLine("03ABCDE1234F1Z5")).toBe("GSTIN: 03ABCDE1234F1Z5");
    expect(invoiceStateLine("03")).toBe("State: Punjab (03)");
    expect(invoiceStateLine("7")).toBe("State: Delhi (07)");
    expect(invoiceStateLine("96")).toBeNull();
    expect(invoiceStateLine("42")).toBeNull();
    expect(invoiceStateLine(null)).toBeNull();
    expect(invoiceCountryLine("United States")).toBe("Country: United States");
    expect(gstSplitLabels(1800)).toEqual({
      cgst: "CGST 9%",
      sgst: "SGST 9%",
      igst: "IGST 18%",
    });
    expect(gstSplitLabels(1250)).toEqual({
      cgst: "CGST 6.25%",
      sgst: "SGST 6.25%",
      igst: "IGST 12.5%",
    });
  });

  it("writes the LLP line only with an LLPIN", () => {
    expect(
      llpLine({
        legalName: "STOREMINK LLP",
        llpin: "ADC-5432",
        registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
      }),
    ).toBe(
      "STOREMINK LLP is registered with limited liability. LLPIN ADC-5432. Registered office: Bala ji Colony, Faridkot, Punjab, India.",
    );
    expect(
      llpLine({
        legalName: "STOREMINK LLP",
        llpin: "ADC-5432",
        registeredOffice: "Bala ji Colony, Faridkot, Punjab, India.",
      }),
    ).toBe(
      "STOREMINK LLP is registered with limited liability. LLPIN ADC-5432. Registered office: Bala ji Colony, Faridkot, Punjab, India.",
    );
    expect(
      llpLine({
        legalName: "STOREMINK LLP",
        llpin: "ADC-5432",
        registeredOffice: null,
      }),
    ).toBe(
      "STOREMINK LLP is registered with limited liability. LLPIN ADC-5432.",
    );
    expect(
      llpLine({
        legalName: "STOREMINK LLP",
        llpin: " ",
        registeredOffice: "x",
      }),
    ).toBeNull();
    expect(
      llpLine({
        legalName: "STOREMINK LLP",
        llpin: null,
        registeredOffice: "x",
      }),
    ).toBeNull();
  });
});

// ── Billing emails ──────────────────────────────────────────────────────────

describe("billing emails", () => {
  it("writes the renewal-due amount rows", () => {
    expect(renewalAmountRows(EX_1500, true)).toEqual([
      { label: "Price", value: "₹1,500" },
      { label: "GST (18%)", value: "₹270" },
      { label: "Amount", value: "₹1,770" },
    ]);
    expect(renewalAmountRows(EX_1500, false).at(-1)).toEqual({
      label: "Amount due",
      value: "₹1,770",
    });
    expect(renewalAmountRows(IN_1500, true)).toEqual([
      { label: "Amount", value: "₹1,500" },
      { label: "Includes GST (18%)", value: "₹228.81" },
    ]);
    expect(renewalAmountRows(NONE_1500, false)).toEqual([
      { label: "Amount due", value: "₹1,500" },
    ]);
  });

  it("writes the receipt rows and closing line", () => {
    expect(receiptAmountRows(EX_1500)).toEqual([
      { label: "Amount paid", value: "₹1,770" },
      { label: "Includes GST (18%)", value: "₹270" },
    ]);
    expect(receiptAmountRows(NONE_1500)).toEqual([
      { label: "Amount paid", value: "₹1,500" },
    ]);
    expect(receiptClosingLine(27000)).toBe(
      "Your plan is active. Your tax invoice is in Plans & Billing whenever you need it.",
    );
    expect(receiptClosingLine(0)).toBeNull();
  });

  it("writes the plan-activated price and paragraph", () => {
    expect(planActivatedPrice(EX_1500, "monthly")).toBe(
      "₹1,770/month, including GST",
    );
    expect(planActivatedPrice(IN_1500, "monthly")).toBe(
      "₹1,500/month, including GST",
    );
    expect(planActivatedPrice(NONE_1500, "monthly")).toBe("₹1,500/month");
    expect(planActivatedPrice(EX_15000, "yearly")).toBe(
      "₹17,700/year, including GST",
    );
    expect(planActivatedGstParagraph(SCHED_EX, EX_1500, "monthly")).toBe(
      "From 1 Dec 2026, GST at 18% is added to our prices, so renewals invoiced from then cost ₹1,770 a month including GST.",
    );
    expect(planActivatedGstParagraph(ON_IN_TO_EX, EX_15000, "yearly")).toBe(
      "From 1 Dec 2026, GST at 18% is added to our prices, so renewals invoiced from then cost ₹17,700 a year including GST.",
    );
    for (const terms of [OFF, SCHED_IN, ON_IN, ON_EX, ON_EX_RATE_UP]) {
      expect(planActivatedGstParagraph(terms, EX_1500, "monthly")).toBeNull();
    }
  });

  it("explains why a renewal costs something else", () => {
    const dearer: CopyAmount = { ...NONE_1500, totalPaise: 200000 };
    const both: CopyAmount = {
      totalPaise: 236000,
      taxPaise: 36000,
      rateBps: 1800,
      inclusive: false,
    };
    const lowerRate = amountFor(150000, ON_EX_RATE_UP);

    expect(renewalChange(null, EX_1500)).toBeNull();
    expect(renewalChange(EX_1500, EX_1500)).toBeNull();
    expect(renewalChange(NONE_1500, EX_1500)).toBe("gst_started");
    expect(renewalChange(IN_1500, EX_1500)).toBe("gst_started");
    expect(renewalChange(lowerRate, EX_1500)).toBe("gst_started");
    expect(renewalChange(NONE_1500, both)).toBe("both");
    expect(renewalChange(NONE_1500, dearer)).toBe("price_changed");
    expect(renewalChange(EX_1500, both)).toBe("price_changed");
    expect(renewalChange(EX_1500, NONE_1500)).toBe("lower");

    expect(renewalChangeSentence(null, EX_1500)).toBeNull();
    expect(renewalChangeSentence(EX_1500, EX_1500)).toBeNull();
    expect(renewalChangeSentence(NONE_1500, EX_1500)).toBe(
      "This is more than last time because GST at 18% is now added to our prices. Nothing about your plan changed.",
    );
    // R2-06: the previous invoice is compared whatever the plan, period or
    // location count, so these name no cause beyond GST.
    expect(renewalChangeSentence(NONE_1500, both)).toBe(
      "This is an increase from ₹1,500 last time, and GST at 18% is now added to our prices.",
    );
    expect(renewalChangeSentence(NONE_1500, dearer)).toBe(
      "This is an increase from ₹1,500 last time.",
    );
    expect(renewalChangeSentence(EX_1500, NONE_1500)).toBe(
      "This is a reduction from ₹1,770 last time.",
    );
  });
});

// ── Operator console ────────────────────────────────────────────────────────

describe("operator console", () => {
  it("writes the page and card titles", () => {
    expect(TAX_CONSOLE).toEqual({
      intro:
        "What StoreMink's own invoices say (plans, extra locations and Mink credit packs) and whether they charge GST. This is StoreMink's tax identity, not a merchant's. A merchant's own tax settings live in their dashboard.",
      statusTitle: "GST status",
      identityTitle: "StoreMink's tax identity",
      changeTitle: "Charging GST",
      readFailed:
        "Couldn't read the billing and tax settings, so nothing on this page can be saved. Refresh the page to try again.",
    });
  });

  it("writes the status sentence in each state", () => {
    expect(taxStatusSentence(OFF)).toBe(
      "No GST is being charged. Invoices show no GST.",
    );
    expect(taxStatusSentence(SCHED_EX)).toBe(
      "No GST is being charged yet. From 1 December 2026, 00:00 IST, GST at 18% is added to every price.",
    );
    expect(taxStatusSentence(SCHED_IN)).toBe(
      "No GST is being charged yet. From 1 December 2026, 00:00 IST, GST at 18% is included in every price.",
    );
    expect(taxStatusSentence(ON_IN)).toBe(
      "GST is being charged at 18%, included in every price: plans, extra locations and Mink credit packs.",
    );
    expect(taxStatusSentence(ON_EX)).toBe(
      "GST is being charged at 18%, added to every price: plans, extra locations and Mink credit packs.",
    );
    expect(taxStatusSentence(ON_IN_TO_EX)).toBe(
      "GST is being charged at 18%, included in every price: plans, extra locations and Mink credit packs. From 1 December 2026, 00:00 IST: GST at 18% is added to every price.",
    );
    expect(taxStatusSentence(ON_SWITCH_OFF)).toBe(
      "GST is being charged at 18%, included in every price: plans, extra locations and Mink credit packs. From 1 December 2026, 00:00 IST: No GST is charged.",
    );
  });

  it("writes the status card's controls", () => {
    expect(TAX_STATUS).toEqual({
      cancel: "Cancel this change",
      confirmCancel: "Cancel the change",
      keep: "Keep it",
      cancelled: "Scheduled change cancelled.",
      llpMissing:
        "Invoices don't show the LLP's particulars yet. The LLP Act asks for the LLPIN and the registered office on every invoice. Add them under StoreMink's tax identity.",
    });
    expect(cancelChangeConfirm(START)).toBe(
      "Cancel the change scheduled for 1 December 2026, 00:00 IST? If you sent merchants a notice, tell them it won't happen.",
    );
  });

  it("writes the identity card", () => {
    expect(TAX_IDENTITY.legalName).toEqual({
      label: "Registered legal name",
      hint: "The entity issuing the invoice, exactly as on the GST registration.",
      placeholder: "STOREMINK LLP",
    });
    expect(TAX_IDENTITY.gstin.placeholder).toBe("03ABCDE1234F1Z5");
    expect(TAX_IDENTITY.gstin.hint).toBe(
      "15 characters. Its first two digits are the state, and they must match the state below.",
    );
    expect(TAX_IDENTITY.state.hint).toBe(
      "Decides CGST and SGST for merchants in the same state, IGST for everyone else.",
    );
    expect(TAX_IDENTITY.address).toEqual({
      label: "Address printed on invoices",
      hint: "Your principal place of business as on the GST registration. Printed on every invoice.",
      line1: "Address line 1",
      line2: "Address line 2",
      city: "City",
      pin: "PIN",
    });
    expect(TAX_IDENTITY.sacCode).toEqual({
      label: "SAC code",
      hint: "The 6-digit service code printed on every tax invoice. Choose it with your accountant.",
      placeholder: "6 digits",
    });
    expect(TAX_IDENTITY.llpin.placeholder).toBe("AAA-0000");
    expect(TAX_IDENTITY.registeredOffice.useAddress).toBe(
      "Use the address above",
    );
    expect(TAX_IDENTITY.prefix.maxLength).toBe(2);
    expect(TAX_IDENTITY.prefix.hint).toBe(
      "1 or 2 letters or digits. Invoice numbers look like SM/2026-27/00001, the 16 characters GST allows. Changing it does not renumber existing invoices.",
    );
    expect(TAX_IDENTITY.save).toBe("Save tax identity");
    expect(TAX_IDENTITY.saved).toBe("Tax identity saved.");
  });

  it("writes the charging card", () => {
    expect(TAX_CHANGE.dontCharge).toBe("Don't charge GST");
    expect(TAX_CHANGE.charge).toBe("Charge GST");
    expect(TAX_CHANGE.rateHint).toBe(
      "18% for StoreMink's services. Change it only when the law changes it.",
    );
    expect(TAX_CHANGE.whenHint).toBe(
      "Invoices built from this moment use the new setting. Invoices already issued never change. Pick a time on or after the date your GST registration takes effect.",
    );
    expect(TAX_CHANGE.noticeHint).toBe(
      "The Operational notice you emailed all store owners about this change. GST can start 1 month after it at the earliest.",
    );
    expect(TAX_CHANGE.impactColumns).toEqual([
      "Store",
      "Plan",
      "Next renewal",
      "Today",
      "After the change",
      "Paid how",
      "State on invoices",
    ]);
    expect(TAX_CHANGE.amberNote).toBe(
      "The pricing page, signup and every price in merchants' dashboards read this setting, so they change with it. Prices that exclude GST raise every bill: send the notice first.",
    );
    expect(TAX_CHANGE.impactFailed).toBe(
      "Couldn't work out what this changes. Please try again.",
    );
    expect(impactTruncatedNote(200)).toBe(
      "Showing the 200 renewals that need a look first.",
    );
    expect(impactTruncatedNote(1)).toBe(
      "Showing the 1 renewal that needs a look first.",
    );

    expect(priceModeOptions(150000, 1800)).toEqual({
      inclusive: {
        title: "Prices include GST",
        body: "A ₹1,500 plan is still billed ₹1,500, of which ₹228.81 is GST. Nobody's bill changes; StoreMink keeps less of each payment.",
      },
      exclusive: {
        title: "Prices exclude GST",
        body: "A ₹1,500 plan is billed ₹1,770. Every merchant's bill goes up, so this needs 1 month's notice.",
      },
    });

    expect(changeButtonLabel({ when: "scheduled", switchesOn: true })).toBe(
      "Schedule this change",
    );
    expect(changeButtonLabel({ when: "now", switchesOn: true })).toBe(
      "Switch GST on now",
    );
    expect(changeButtonLabel({ when: "now", switchesOn: false })).toBe("Save");
    expect(switchOnNowConfirm(1800, true)).toBe(
      "Switch GST on now? Invoices built from now charge GST at 18%, included in every price.",
    );
    expect(switchOnNowConfirm(1800, false)).toBe(
      "Switch GST on now? Invoices built from now charge GST at 18%, added to every price.",
    );
    expect(changeScheduledToast(START)).toBe(
      "GST change scheduled for 1 December 2026, 00:00 IST.",
    );
  });

  it("lists notices with the reason one does not count", () => {
    const sent = "2026-10-29T06:30:00.000Z";
    const notice = {
      category: "operational",
      status: "sent",
      sent: 40,
      sentAt: sent,
      channels: { email: true },
      audience: {},
    };
    expect(
      noticeOptionLabel({
        title: "GST from 1 December",
        sentAt: sent,
        sent: 40,
        failed: 2,
        check: noticeQualifies(notice),
      }),
    ).toBe("GST from 1 December, sent 29 Oct 2026: 40 delivered, 2 failed");
    expect(
      noticeOptionLabel({
        title: "GST from 1 December",
        sentAt: sent,
        sent: 40,
        failed: 0,
        check: noticeQualifies({ ...notice, channels: { sms: true } }),
      }),
    ).toBe(
      "GST from 1 December, sent 29 Oct 2026: 40 delivered, 0 failed (not by email)",
    );
    expect(
      noticeOptionLabel({
        title: "Spring launch",
        sentAt: null,
        sent: 0,
        failed: 0,
        check: { ok: false, reason: "not_sent" },
      }),
    ).toBe("Spring launch: 0 delivered, 0 failed (not sent)");
    const reasons: Record<NoticeFailure, string> = {
      not_operational: "product news",
      not_sent: "not sent",
      nothing_delivered: "nothing delivered",
      not_email: "not by email",
      audience: "only some store owners",
    };
    for (const [reason, words] of Object.entries(reasons)) {
      expect(
        noticeOptionLabel({
          title: "N",
          sentAt: null,
          sent: 0,
          failed: 0,
          check: { ok: false, reason: reason as NoticeFailure },
        }),
      ).toBe(`N: 0 delivered, 0 failed (${words})`);
    }
  });

  it("refuses a notice that does not count, in the design's words", () => {
    expect(noticeRefusal("not_operational")).toBe(
      "That announcement is product news. Only an Operational notice reaches every store owner.",
    );
    expect(noticeRefusal("not_sent")).toBe(
      "That notice hasn't reached anyone yet. Wait until it has been sent, or send it again.",
    );
    expect(noticeRefusal("nothing_delivered")).toBe(
      "That notice hasn't reached anyone yet. Wait until it has been sent, or send it again.",
    );
    expect(noticeRefusal("not_email")).toBe(
      "That notice wasn't sent by email. Merchants are promised an email.",
    );
    expect(noticeRefusal("audience")).toBe(
      "That notice went to only some store owners. Send one to all store owners, with no plan, status, age or launch filter.",
    );
  });

  it("writes the impact panel", () => {
    const zero: ImpactCounts = {
      rise: 0,
      byHand: 0,
      aboveMandate: 0,
      aboveAfaLimit: 0,
      noState: 0,
      fromAddress: 0,
      outsideIndia: 0,
      supplierStateCode: "03",
    };
    expect(impactLines(zero)).toEqual([]);
    expect(
      impactLines({
        rise: 12,
        byHand: 2,
        aboveMandate: 1,
        aboveAfaLimit: 1,
        noState: 3,
        fromAddress: 2,
        outsideIndia: 2,
        supplierStateCode: "03",
      }),
    ).toEqual([
      "12 renewals will cost more.",
      "2 of them are charged automatically today and will need paying by hand: 1 is above the merchant's autopay limit and 1 is above ₹15,000, the most that can be charged automatically.",
      "3 stores have no state on record, so their invoices would use Punjab, StoreMink's state, and name no state for them. The notice asks them to add one; you can also contact them.",
      "2 stores' states are read from the address they typed. Each can check it under Billing details.",
      "2 stores are outside India. While GST is charged they can't make new payments, and their renewals are charged IGST.",
    ]);
    expect(
      impactLines({
        ...zero,
        rise: 1,
        byHand: 1,
        aboveAfaLimit: 1,
        noState: 1,
        fromAddress: 1,
        outsideIndia: 1,
        supplierStateCode: null,
      }),
    ).toEqual([
      "1 renewal will cost more.",
      "1 of them is charged automatically today and will need paying by hand: 1 is above ₹15,000, the most that can be charged automatically.",
      "1 store has no state on record, so its invoices would use StoreMink's state, and name no state for it. The notice asks it to add one; you can also contact it.",
      "1 store's state is read from the address it typed. It can check it under Billing details.",
      "1 store is outside India. While GST is charged it can't make new payments, and its renewals are charged IGST.",
    ]);
    expect(impactLines({ ...zero, byHand: 3, aboveMandate: 3 })).toEqual([
      "3 of them are charged automatically today and will need paying by hand: 3 are above the merchant's autopay limit.",
    ]);
    expect(impactLines({ ...zero, byHand: 2 })).toEqual([
      "2 of them are charged automatically today and will need paying by hand.",
    ]);

    expect(impactPaidHow({ auto: true })).toBe("Automatically");
    expect(impactPaidHow({ auto: false, reason: "over_mandate" })).toBe(
      "By hand: above autopay limit",
    );
    expect(impactPaidHow({ auto: false, reason: "over_afa_limit" })).toBe(
      "By hand: above ₹15,000",
    );
    expect(impactPaidHow({ auto: false, reason: "no_mandate" })).toBe(
      "By hand: no autopay",
    );
  });

  it("writes the impact table's state column", () => {
    const delhi = (basis: PlaceOfSupplyBasis) =>
      impactStateOnInvoices({ code: "07", basis }, null);
    expect(delhi("gstin")).toBe("Delhi (GSTIN)");
    expect(delhi("billing_state")).toBe("Delhi (Billing details)");
    expect(delhi("store_gstin")).toBe("Delhi (Taxes & invoices)");
    expect(delhi("store_tax_state")).toBe("Delhi (Taxes & invoices)");
    expect(delhi("location_gstin")).toBe("Delhi (location)");
    expect(delhi("location_state")).toBe("Delhi (location)");
    expect(delhi("store_address")).toBe("Delhi (from typed address)");
    expect(
      impactStateOnInvoices({ code: "03", basis: "signup_address" }, null),
    ).toBe("Punjab (older signup)");
    expect(
      impactStateOnInvoices({ code: "03", basis: "supplier_state" }, null),
    ).toBe("None: Punjab used");
    expect(
      impactStateOnInvoices({ code: null, basis: "supplier_state" }, null),
    ).toBe("None");
    expect(
      impactStateOnInvoices(
        { code: "96", basis: "outside_india" },
        "United States",
      ),
    ).toBe("Outside India: United States");
    expect(
      impactStateOnInvoices({ code: "96", basis: "outside_india" }, null),
    ).toBe("Outside India");
    expect(impactStateOnInvoices({ code: null, basis: "unknown" }, null)).toBe(
      "None",
    );
    expect(impactStateOnInvoices({ code: "42", basis: "gstin" }, null)).toBe(
      "None",
    );
  });

  it("warns before saving while stores have no state or are outside India", () => {
    expect(impactWarning(0, 0)).toBeNull();
    expect(impactWarning(3, 1)).toBe(
      "3 stores have no state on record and 1 is outside India. You can still schedule this; consider waiting until more of them have added a state.",
    );
    expect(impactWarning(1, 2)).toBe(
      "1 store has no state on record and 2 are outside India. You can still schedule this; consider waiting until more of them have added a state.",
    );
    expect(impactWarning(3, 0)).toBe(
      "3 stores have no state on record. You can still schedule this; consider waiting until more of them have added a state.",
    );
    expect(impactWarning(0, 1)).toBe(
      "1 store is outside India. You can still schedule this.",
    );
  });

  it("refuses a save in the words of design 5.8", () => {
    expect(TAX_SETTINGS_REFUSAL).toEqual({
      sacShape:
        "The SAC code is 6 digits starting with 99, for example 998314.",
      llpinShape:
        "An LLPIN looks like ADC-5432: three letters, a hyphen and four digits.",
      prefix:
        "Use 1 or 2 letters or digits, so invoice numbers stay within the 16 characters GST allows.",
      enableWithoutSac:
        "Add the SAC code before switching GST on. It is printed on every tax invoice.",
      enableWithoutAddress:
        "Add the registered address and PIN before switching GST on. They are printed on every tax invoice.",
      enableWithoutLlp:
        "Add the LLPIN and the registered office before switching GST on. The law asks for them on every invoice.",
      clearIdentityWhileOn:
        "GST is on or scheduled, so the GSTIN, state, legal name, SAC code, address, PIN, LLPIN and registered office can't be removed. Switch GST off first.",
      startTooClose:
        "Pick a start at least 5 minutes from now. Invoices already issued never change.",
      startTooFar:
        "Pick a start within 400 days of now. A date further out is usually a typo in the year.",
      llpinWithoutLegalName:
        "Add the registered legal name with the LLPIN. The invoice's LLP line names it.",
      riseNow:
        "This raises what merchants pay, so it can't start now. Schedule it at least 1 month after you email them.",
      riseWithoutNotice:
        "This raises what merchants pay, so it needs at least 1 month's notice. Send an Operational notice by email to all store owners from Announcements, then choose it here.",
      rateRiseNotConfirmed:
        "A higher rate raises bills when prices exclude GST. Tick that the law changed the rate, or schedule it with notice.",
      cancelAfterStart:
        "This change has already started. To stop charging GST, choose Don't charge GST under Charging GST.",
      enableWithoutGstin:
        "Add the GSTIN before switching GST on. An invoice that charges GST without one isn't a valid tax invoice.",
      enableWithoutState:
        "Add the state before switching GST on. It decides whether invoices show CGST and SGST, or IGST.",
      enableWithoutLegalName:
        "Add the registered legal name before switching GST on. It is the name the invoice is issued by.",
      whenMissing: "Choose when the change starts.",
      rateRange: "Enter a tax rate between 0 and 100.",
    });
    expect(
      tooSoonAfterNotice(
        "2026-11-29T06:30:00.000Z",
        "2026-10-29T06:30:00.000Z",
      ),
    ).toBe(
      "This can start on 29 November 2026, 12:00 IST at the earliest: 1 month after the notice went out on 29 October 2026, 12:00 IST.",
    );
  });

  it("writes the monthly invoice list card and its CSV", () => {
    expect(INVOICE_LIST_CARD).toEqual({
      title: "Monthly invoice list",
      body: "Every invoice StoreMink issued in a month, with GSTINs, place of supply, SAC and the GST split, for your accountant's GST returns.",
      download: "Download CSV",
      preparing: "Preparing…",
      failed: "Couldn't prepare the invoice list. Please try again.",
      tooMany:
        "This month has more invoices than one download can hold. Ask an engineer to export it in parts.",
    });
    expect(INVOICE_LIST_CSV).toEqual({
      columns: [
        "Invoice number",
        "Date",
        "Type",
        "Customer name",
        "Customer GSTIN",
        "Place of supply",
        "Place of supply basis",
        "SAC",
        "Taxable value",
        "CGST",
        "SGST",
        "IGST",
        "Total",
        "Status",
        "Store",
      ],
      taxInvoice: "Tax invoice",
      invoice: "Invoice",
      creditNote: "Credit note",
      deletedStore: "deleted store",
    });
  });

  it("writes the refund switch refusal and the captured-draft repair", () => {
    expect(AUTO_REFUNDS_IDENTITY_INCOMPLETE).toBe(
      "Couldn't save this switch: StoreMink's tax identity is incomplete. Save StoreMink's tax identity first, then try again.",
    );
    expect(CAPTURED_DRAFT_REPAIR).toEqual({
      title: "Payment captured before its invoice was issued",
      hint: "The invoice is now issued and paid. Check that the plan, plan change or location the merchant paid for was applied, then close this with what you did.",
      detail:
        "Payment captured against an invoice that was still a draft. The invoice is now issued. Check that the plan, plan change or location the merchant paid for was applied.",
    });
    expect(KEPT_DRAFT_REPAIR).toEqual({
      title: "Invoice issued with the GST it was priced with",
      hint: "A payment had already fixed this invoice's total, so it kept the GST it was priced with. The note gives that GST and the GST in force. If the merchant paid more than they owe, refund the difference with Issue a refund, which issues its credit note. Then close this with what you did.",
    });
  });
});

// ── The sweep: every output, every state ───────────────────────────────────

const flat = <T, U>(xs: T[], fn: (x: T) => U | U[]): U[] =>
  xs.flatMap((x) => fn(x) as U[]);

const STATE_COUNTS: ImpactCounts[] = [0, 1, 3].flatMap((n) =>
  [null, "03", "42"].map((code) => ({
    rise: n,
    byHand: n,
    aboveMandate: n,
    aboveAfaLimit: n === 3 ? 2 : n,
    noState: n,
    fromAddress: n,
    outsideIndia: n,
    supplierStateCode: code,
  })),
);

const NOTICE_CHECKS = [
  { ok: true } as const,
  ...(
    [
      "not_operational",
      "not_sent",
      "nothing_delivered",
      "not_email",
      "audience",
    ] as const
  ).map((reason) => ({ ok: false as const, reason })),
];

type Press = Parameters<typeof amountChanged>[1];

/**
 * Every button the amount guard can name. The Record has to list each press
 * amountChanged accepts, exactly, or this file does not compile, so a press
 * added later cannot escape the sweep.
 */
const PRESSES = Object.keys({
  continue_to_payment: 0,
  pay_prorated_change: 0,
  continue: 0,
  pay: 0,
  pay_now: 0,
  buy_now: 0,
} satisfies Record<Press, 0>) as Press[];

/**
 * Every exported function, called over every state and amount. The coverage
 * test below fails when an export is missing here, so a new sentence cannot
 * escape the checks.
 */
const SWEEP: Record<string, () => unknown[]> = {
  formatRupees: () => LISTS.map(formatRupees),
  istShortDate: () => [START, new Date(START), "bad"].map(istShortDate),
  istLongDate: () => [START, new Date(START)].map(istLongDate),
  istTime: () => [START].map(istTime),
  istLongDateTime: () => [START].map(istLongDateTime),
  gstRateLabel: () => [0, 500, 1250, 1800, 2800].map(gstRateLabel),
  taxCopyState: () => ALL_TERMS.map(taxCopyState),
  upcomingAddedGst: () => ALL_TERMS.map(upcomingAddedGst),
  upcomingRise: () => ALL_TERMS.map(upcomingRise),
  asksForState: () => ALL_TERMS.map(asksForState),
  amountFor: () => flat(ALL_TERMS, (t) => LISTS.map((l) => amountFor(l, t))),
  amountChanged: () =>
    flat(AMOUNTS, (a) => PRESSES.map((p) => amountChanged(a.totalPaise, p))),
  pricingCardNote: () =>
    flat(ALL_TERMS, (t) =>
      flat([...PERIODS], (p) => LISTS.map((l) => pricingCardNote(t, p, l))),
    ),
  pricingPriceSuffix: () => ALL_TERMS.map(pricingPriceSuffix),
  // Starts with its space by design, so trimmed for the edge check.
  priceGstSuffix: () => ALL_TERMS.map((t) => priceGstSuffix(t).trim()),
  pricingFootnote: () => ALL_TERMS.map(pricingFootnote),
  posPriceBoxNote: () => ALL_TERMS.map(posPriceBoxNote),
  valueAddedTaxIncluded: () => ALL_TERMS.map(valueAddedTaxIncluded),
  gstFaq: () => ALL_TERMS.map(gstFaq),
  signupYearlyLine: () =>
    flat([null, ...ALL_TERMS], (t) => LISTS.map((l) => signupYearlyLine(t, l))),
  signupPayNowLine: () =>
    flat([null, ...ALL_TERMS], (t) =>
      flat([...PERIODS], (p) => AMOUNTS.map((a) => signupPayNowLine(t, p, a))),
    ),
  signupContinueLabel: () =>
    flat([null, ...ALL_TERMS], (t) =>
      flat([...PERIODS], (p) =>
        AMOUNTS.map((a) => signupContinueLabel(t, "Basic", p, a.totalPaise)),
      ),
    ),
  currentPlanPrice: () =>
    flat(ALL_TERMS, (t) =>
      flat([...PERIODS], (p) => LISTS.map((l) => currentPlanPrice(t, p, l))),
    ),
  nextRenewalValue: () => AMOUNTS.map((a) => nextRenewalValue(a, START)),
  nextRenewalGstLine: () => AMOUNTS.map(nextRenewalGstLine),
  renewalByHandLine: () =>
    flat(ROUTES, (route) =>
      flat([null, 500000], (max) =>
        AMOUNTS.map((a) =>
          renewalByHandLine({
            route,
            totalPaise: a.totalPaise,
            dueOn: START,
            mandateMaxPaise: max,
          }),
        ),
      ),
    ),
  gstNoticeBanner: () =>
    flat(ALL_TERMS, (t) => [
      gstNoticeBanner(t, null),
      ...flat(ROUTES, (route) =>
        flat([null, 150000], (max) =>
          AMOUNTS.map((amount) =>
            gstNoticeBanner(t, {
              renewsOn: START,
              amount,
              route,
              mandateMaxPaise: max,
            }),
          ),
        ),
      ),
    ]),
  stateBanner: () =>
    flat(ALL_TERMS, (t) => BASES.map((b) => stateBanner(t, b))),
  plansGridSuffix: () => ALL_TERMS.map(plansGridSuffix),
  packPrice: () => flat(ALL_TERMS, (t) => LISTS.map((l) => packPrice(t, l))),
  packTotalPrice: () =>
    flat(ALL_TERMS, (t) => LISTS.map((l) => packTotalPrice(t, l))),
  invoiceListName: () =>
    AMOUNTS.map((a) => invoiceListName("SM/2026-27/00001", a.taxPaise)),
  invoiceGstLine: () =>
    flat(AMOUNTS, (a) =>
      [null, 0, 1800].map((r) => invoiceGstLine(a.taxPaise, r)),
    ),
  billingDetailsPrefilled: () =>
    ([null, "taxes_and_invoices", "location", "signup"] as const).map(
      billingDetailsPrefilled,
    ),
  billingDetailsUses: () =>
    flat(BASES, (basis) =>
      flat(CODES, (code) =>
        [null, "United States", " "].map((c) =>
          billingDetailsUses({ code, basis }, c),
        ),
      ),
    ),
  checkoutPlanCard: () =>
    flat(ALL_TERMS, (t) =>
      flat([...PERIODS], (p) => LISTS.map((l) => checkoutPlanCard(t, p, l))),
    ),
  checkoutPackPrice: () =>
    flat(ALL_TERMS, (t) => LISTS.map((l) => checkoutPackPrice(t, l))),
  checkoutCreditsRow: () =>
    flat(ALL_TERMS, (t) => LISTS.map((l) => checkoutCreditsRow(t, 60, l))),
  checkoutSummary: () =>
    flat(ALL_TERMS, (terms) =>
      flat([...PERIODS], (period) =>
        flat(
          ["subscribe", "dearer_change", "scheduled_change"] as const,
          (kind) =>
            flat(AMOUNTS, (payNow) =>
              flat([null, EX_PACK], (pack) =>
                AMOUNTS.map((renewal) =>
                  checkoutSummary({
                    terms,
                    period,
                    kind,
                    payNow,
                    renewal,
                    pack,
                    effectiveAt: START,
                  }),
                ),
              ),
            ),
        ),
      ),
    ),
  locationsExtraSummary: () =>
    flat(ALL_TERMS, (t) =>
      flat([...PERIODS], (p) =>
        [1, 2].map((n) => locationsExtraSummary(t, n, 100000, p)),
      ),
    ),
  addLocationButton: () =>
    flat(ALL_TERMS, (t) =>
      [...PERIODS].map((p) => addLocationButton(t, 100000, p)),
    ),
  addLocationConfirm: () =>
    flat(ALL_TERMS, (terms) =>
      flat([...PERIODS], (period) =>
        flat([null, ...AMOUNTS], (nextPurchase) =>
          [null, ...AMOUNTS].map((nextRenewal) =>
            addLocationConfirm({
              terms,
              period,
              perLocation: amountFor(100000, terms),
              nextPurchase,
              nextRenewal,
            }),
          ),
        ),
      ),
    ),
  invoiceGstinLine: () => [invoiceGstinLine("03ABCDE1234F1Z5")],
  invoiceStateLine: () => CODES.map(invoiceStateLine),
  invoiceCountryLine: () => [invoiceCountryLine("United States")],
  gstSplitLabels: () => [500, 1250, 1800].map(gstSplitLabels),
  llpLine: () =>
    flat([null, "ADC-5432"], (llpin) =>
      [null, "Faridkot.", "Faridkot"].map((registeredOffice) =>
        llpLine({ legalName: "STOREMINK LLP", llpin, registeredOffice }),
      ),
    ),
  renewalAmountRows: () =>
    flat(AMOUNTS, (a) => [true, false].map((x) => renewalAmountRows(a, x))),
  receiptAmountRows: () => AMOUNTS.map(receiptAmountRows),
  receiptClosingLine: () => AMOUNTS.map((a) => receiptClosingLine(a.taxPaise)),
  planActivatedPrice: () =>
    flat(AMOUNTS, (a) => [...PERIODS].map((p) => planActivatedPrice(a, p))),
  planActivatedGstParagraph: () =>
    flat(ALL_TERMS, (t) =>
      flat(AMOUNTS, (a) =>
        [...PERIODS].map((p) => planActivatedGstParagraph(t, a, p)),
      ),
    ),
  renewalChange: () =>
    flat([null, ...AMOUNTS], (prev) =>
      AMOUNTS.map((cur) => renewalChange(prev, cur)),
    ),
  renewalChangeSentence: () =>
    flat([null, ...AMOUNTS], (prev) =>
      AMOUNTS.map((cur) => renewalChangeSentence(prev, cur)),
    ),
  taxStatusSentence: () => ALL_TERMS.map(taxStatusSentence),
  cancelChangeConfirm: () => [cancelChangeConfirm(START)],
  priceModeOptions: () =>
    flat([150000, 240000], (l) =>
      [1200, 1800].map((r) => priceModeOptions(l, r)),
    ),
  changeButtonLabel: () =>
    flat(["now", "scheduled"] as const, (when) =>
      [true, false].map((switchesOn) =>
        changeButtonLabel({ when, switchesOn }),
      ),
    ),
  switchOnNowConfirm: () =>
    flat([1250, 1800], (r) =>
      [true, false].map((i) => switchOnNowConfirm(r, i)),
    ),
  changeScheduledToast: () => [changeScheduledToast(START)],
  noticeOptionLabel: () =>
    flat(NOTICE_CHECKS, (check) =>
      [START, null].map((sentAt) =>
        noticeOptionLabel({
          title: "GST notice",
          sentAt,
          sent: 3,
          failed: 1,
          check,
        }),
      ),
    ),
  noticeRefusal: () =>
    (
      [
        "not_operational",
        "not_sent",
        "nothing_delivered",
        "not_email",
        "audience",
      ] as const
    ).map(noticeRefusal),
  impactLines: () => STATE_COUNTS.map(impactLines),
  impactPaidHow: () => ROUTES.map(impactPaidHow),
  impactStateOnInvoices: () =>
    flat(BASES, (basis) =>
      flat(CODES, (code) =>
        [null, "United States"].map((c) =>
          impactStateOnInvoices({ code, basis }, c),
        ),
      ),
    ),
  impactTruncatedNote: () => [1, 2, 200].map(impactTruncatedNote),
  impactWarning: () =>
    flat([0, 1, 3], (a) => [0, 1, 2].map((b) => impactWarning(a, b))),
  tooSoonAfterNotice: () => [tooSoonAfterNotice(START, START)],
  invoiceListFileName: () => [invoiceListFileName("2026-12")],
  istMonthLabel: () => ["2026-01", "2026-12", "bad"].map(istMonthLabel),
  recentIstMonths: () => [recentIstMonths(new Date(START), 24)],
};

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) stringsIn(v, out);
  }
  return out;
}

const PROBLEMS: { name: string; pattern: RegExp }[] = [
  { name: "a long dash", pattern: /[\u2013\u2014]/ },
  {
    name: "an old name for Plans & Billing",
    pattern: /\bPlans? & billing\b|\bPlan & Billing\b/,
  },
  {
    name: "a credit price",
    pattern:
      /\/\s*credit\b|\bper credit\b|\bcredits? (?:cost|costs|used|each)\b/i,
  },
  { name: "an HTML entity", pattern: /&(?:[a-z]+|#\d+);/i },
  { name: "Rs for the rupee sign", pattern: /\bRs\.?\s*\d/ },
  {
    name: "a leaked value",
    pattern: /\b(?:undefined|NaN|null|Infinity)\b|\[object Object\]/,
  },
  { name: "a double space", pattern: / {2}/ },
  { name: "a space before punctuation", pattern: / [,.;:!?](?:\s|$)/ },
  { name: "space at an edge", pattern: /^\s|\s$/ },
];

function problemsIn(where: string, texts: string[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const { name, pattern } of PROBLEMS) {
      if (pattern.test(text)) found.push(`${where}: ${name} in "${text}"`);
    }
    for (const hit of findOldPosWording(text)) {
      found.push(`${where}: old POS word "${hit.words}" in "${text}"`);
    }
  }
  return found;
}

describe("the sweep", () => {
  it("covers every exported function", () => {
    const functions = Object.entries(TaxCopy)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .sort();
    expect(functions).toEqual(Object.keys(SWEEP).sort());
  });

  it("finds nothing wrong in any output, in any state", () => {
    const found: string[] = [];
    let count = 0;
    for (const [name, run] of Object.entries(SWEEP)) {
      const texts = stringsIn(run());
      count += texts.length;
      found.push(...problemsIn(name, texts));
    }
    expect(found).toEqual([]);
    // The sweep must actually have read thousands of sentences.
    expect(count).toBeGreaterThan(5000);
  });

  it("finds nothing wrong in any exported constant", () => {
    const constants = Object.entries(TaxCopy).filter(
      ([, v]) => typeof v !== "function",
    );
    expect(constants.length).toBeGreaterThan(15);
    const found = constants.flatMap(([name, value]) =>
      problemsIn(name, stringsIn(value)),
    );
    expect(found).toEqual([]);
  });

  it("CONTROL: the checks catch what they look for", () => {
    const bad = [
      "Open Plan & billing",
      "Plans & billing shows it",
      "₹2.36/credit",
      "₹1,500 \u2014 billed",
      "Rs 1,500",
      "Paid NaN",
      "Open the register",
      "Total  ₹1",
      "A &amp; B",
    ];
    for (const text of bad) {
      expect(problemsIn("control", [text]), text).not.toEqual([]);
    }
  });
});

// ── Client-safe ─────────────────────────────────────────────────────────────

describe("client safety", () => {
  const ROOT = process.cwd();

  /** The module specifiers a file imports at runtime (type-only skipped). */
  function runtimeImports(file: string): string[] {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      false,
    );
    const out: string[] = [];
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly) continue;
        const bindings = clause?.namedBindings;
        const onlyTypes =
          clause &&
          !clause.name &&
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((e) => e.isTypeOnly);
        if (onlyTypes) continue;
        out.push((statement.moduleSpecifier as ts.StringLiteral).text);
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        !statement.isTypeOnly
      ) {
        out.push((statement.moduleSpecifier as ts.StringLiteral).text);
      }
    }
    return out;
  }

  function resolveSpecifier(from: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
    else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
    else return null;
    for (const candidate of [
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  it("imports nothing server-only, directly or through its imports", () => {
    const start = join(ROOT, "lib/billing/tax-copy.ts");
    expect(existsSync(start)).toBe(true);
    const seen = new Set<string>();
    const packages = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of runtimeImports(file)) {
        const target = resolveSpecifier(file, spec);
        if (target) queue.push(target);
        else packages.add(spec);
      }
    }
    const files = [...seen].map((f) => relative(ROOT, f)).sort();
    // The walk really followed the runtime imports, and only those.
    expect(files).toEqual([
      "lib/billing/gst.ts",
      "lib/billing/invoice.ts",
      "lib/billing/mandate-types.ts",
      "lib/billing/tax-copy.ts",
      "lib/billing/tax-terms.ts",
    ]);
    expect([...packages]).toEqual([]);
    for (const file of seen) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/^\s*import\s+["']server-only["']/m);
      expect(text, file).not.toMatch(/["']@\/lib\/db|["']next\/headers["']/);
    }
  });
});
