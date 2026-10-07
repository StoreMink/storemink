/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: (fn: any) => fn(dbHolder.current.db),
}));

import {
  resolveBillingEmail,
  planActivatedTemplate,
  paymentReceiptTemplate,
  paymentFailedTemplate,
  subscriptionCancelledTemplate,
  planDowngradedTemplate,
  renewalDueTemplate,
  renewalOverdueTemplate,
  type BuiltEmail,
} from "./billing-emails";
import { PLATFORM_EMAIL_MARK_URL } from "./platform-brand";

const MANAGE = "https://echos.storemink.com/dashboard/plans";
const LONG_DASH = /[\u2013\u2014]/;

/** Every builder and every variant, with a hostile store name throughout. */
function everyVariant(storeName: string): Record<string, BuiltEmail> {
  return {
    activatedAutopay: planActivatedTemplate({
      storeName,
      planName: "Basic",
      amountInr: 500,
      period: "monthly",
      renewsOn: "2026-08-12T00:00:00.000Z",
      manageUrl: MANAGE,
    }),
    activatedManual: planActivatedTemplate({
      storeName,
      planName: "Pro",
      amountInr: 24000,
      period: "yearly",
      renewsOn: null,
      manageUrl: MANAGE,
    }),
    receipt: paymentReceiptTemplate({
      storeName,
      planName: "Pro",
      amountInr: 1500,
      period: "monthly",
      renewsOn: "2026-08-12T00:00:00.000Z",
      manageUrl: MANAGE,
    }),
    failedRetrying: paymentFailedTemplate({
      storeName,
      planName: "Basic",
      final: false,
      accessUntil: null,
      manageUrl: MANAGE,
    }),
    failedFinal: paymentFailedTemplate({
      storeName,
      planName: "Basic",
      final: true,
      accessUntil: "2026-08-15T00:00:00.000Z",
      manageUrl: MANAGE,
    }),
    failedFinalNoDate: paymentFailedTemplate({
      storeName,
      planName: "Basic",
      final: true,
      accessUntil: null,
      manageUrl: MANAGE,
    }),
    cancelled: subscriptionCancelledTemplate({
      storeName,
      planName: "Pro",
      accessUntil: "2026-09-01T00:00:00.000Z",
      manageUrl: MANAGE,
    }),
    cancelledNoDate: subscriptionCancelledTemplate({
      storeName,
      planName: "Pro",
      accessUntil: null,
      manageUrl: MANAGE,
    }),
    dueAutopay: renewalDueTemplate({
      storeName,
      planName: "Pro",
      amountInr: 3000,
      dueOn: "2026-10-06T00:00:00.000Z",
      invoiceRef: "SM/2026-27/0007",
      autopay: true,
      previousAmountInr: 2400,
      manageUrl: MANAGE,
    }),
    dueManual: renewalDueTemplate({
      storeName,
      planName: "Pro",
      amountInr: 24000,
      dueOn: "2026-10-06T00:00:00.000Z",
      invoiceRef: null,
      autopay: false,
      previousAmountInr: 26000,
      manageUrl: MANAGE,
    }),
    overdueAttempted: renewalOverdueTemplate({
      storeName,
      planName: "Pro",
      accessUntil: "2026-11-09T06:30:00.000Z",
      attempted: true,
      manageUrl: MANAGE,
    }),
    overdueUnattempted: renewalOverdueTemplate({
      storeName,
      planName: "Pro",
      accessUntil: "2026-11-09T06:30:00.000Z",
      attempted: false,
      manageUrl: MANAGE,
    }),
    downgraded: planDowngradedTemplate({
      storeName,
      fromPlanName: "Basic",
      manageUrl: MANAGE,
    }),
  };
}

describe("billing email templates", () => {
  it("plan activated: includes plan, price, renewal", () => {
    const e = planActivatedTemplate({
      storeName: "Echos",
      planName: "Basic",
      amountInr: 500,
      period: "monthly",
      renewsOn: "2026-08-12T00:00:00.000Z",
      manageUrl: MANAGE,
    });
    expect(e.subject).toBe("You're on the Basic plan");
    expect(e.html).toContain("₹500/month");
    expect(e.html).toContain("12 Aug 2026");
    expect(e.html).toContain(MANAGE);
    expect(e.html).toContain("renews automatically");
  });

  it("★ plan activated with no renewal date never claims autopay", () => {
    // receipts.ts withholds the date when there is no mandate. Telling that
    // merchant the plan renews automatically is how they do nothing and are
    // downgraded.
    const e = planActivatedTemplate({
      storeName: "Echos",
      planName: "Pro",
      amountInr: 24000,
      period: "yearly",
      renewsOn: null,
      manageUrl: MANAGE,
    });
    expect(e.html).toContain("₹24,000/year");
    expect(e.html).not.toMatch(/autopay/i);
    expect(e.html).not.toContain("renews automatically");
    expect(e.html).not.toContain("Renews on");
    expect(e.html).toContain("email you before your next renewal");
  });

  it("the welcome headline carries no emoji", () => {
    const e = planActivatedTemplate({
      storeName: "Echos",
      planName: "Pro",
      amountInr: 2400,
      period: "monthly",
      renewsOn: null,
      manageUrl: MANAGE,
    });
    expect(e.html).toContain("Welcome to Pro</h1>");
    expect(e.html).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("payment receipt: shows the charged amount", () => {
    const e = paymentReceiptTemplate({
      storeName: "Echos",
      planName: "Pro",
      amountInr: 1500,
      period: "monthly",
      renewsOn: null,
      manageUrl: MANAGE,
    });
    expect(e.subject).toBe("Payment received for your Pro plan");
    expect(e.html).toContain("₹1,500");
    expect(e.html).toContain("billed monthly");
    expect(e.html).not.toContain("Renews on");
  });

  it("payment failed: retry vs final wording differ", () => {
    const retry = paymentFailedTemplate({
      storeName: "Echos",
      planName: "Basic",
      final: false,
      accessUntil: null,
      manageUrl: MANAGE,
    });
    const final = paymentFailedTemplate({
      storeName: "Echos",
      planName: "Basic",
      final: true,
      accessUntil: "2026-08-15T00:00:00.000Z",
      manageUrl: MANAGE,
    });
    expect(retry.subject).toBe("We couldn't process your Basic payment");
    expect(retry.html).toMatch(/retry/i);
    expect(retry.html).not.toMatch(/action needed/i);
    expect(final.subject).toBe(
      "Action needed: your Basic plan is about to end",
    );
    expect(final.html).toMatch(/action needed/i);
    expect(final.html).toContain("15 Aug 2026");
    expect(final.html).not.toMatch(/retry/i);
  });

  it("cancellation: mentions access-until + re-subscribe", () => {
    const e = subscriptionCancelledTemplate({
      storeName: "Echos",
      planName: "Pro",
      accessUntil: "2026-09-01T00:00:00.000Z",
      manageUrl: MANAGE,
    });
    expect(e.subject).toMatch(/cancelled/i);
    // en-GB short month for September is "Sept" in modern ICU.
    expect(e.html).toMatch(/0?1 Sept? 2026/);
    expect(e.html).toMatch(/re-subscribe/i);
    expect(e.html).toContain("No further payments will be taken");
  });

  it("downgrade: reassures data is safe", () => {
    const e = planDowngradedTemplate({
      storeName: "Echos",
      fromPlanName: "Basic",
      manageUrl: MANAGE,
    });
    expect(e.subject).toMatch(/free plan/i);
    expect(e.html).toMatch(/nothing was deleted/i);
  });

  it("escapes HTML in the store name", () => {
    const e = planActivatedTemplate({
      storeName: "<script>x</script>",
      planName: "Basic",
      amountInr: 500,
      period: "monthly",
      renewsOn: null,
      manageUrl: MANAGE,
    });
    expect(e.html).not.toContain("<script>x</script>");
    expect(e.html).toContain("&lt;script&gt;");
  });

  it("★ escapes the store name in every variant, footer included", () => {
    for (const [name, e] of Object.entries(everyVariant("<b>Evil</b>"))) {
      expect(e.html, name).not.toContain("<b>Evil</b>");
      expect(e.html, name).toContain("&lt;b&gt;Evil&lt;/b&gt;");
    }
  });

  it("★ every variant wears StoreMink's own header and footer", () => {
    for (const [name, e] of Object.entries(everyVariant("Echos"))) {
      expect(e.html, name).toContain('class="sm-email-canvas"');
      expect(e.html, name).toContain(PLATFORM_EMAIL_MARK_URL);
      expect(e.html, name).toContain("Echos's StoreMink subscription");
      expect(e.html, name).toContain("The StoreMink team");
      expect(e.html, name).toContain(MANAGE);
    }
  });

  it("★ no long dash in any subject or body", () => {
    for (const [name, e] of Object.entries(everyVariant("Echos"))) {
      expect(e.subject, name).not.toMatch(LONG_DASH);
      expect(e.html, name).not.toMatch(LONG_DASH);
      expect(e.html, name).not.toContain("\u2014");
      expect(e.html, name).not.toContain("\u2013");
    }
  });
});

describe("renewalDueTemplate: autopay is a heads-up, manual is a bill", () => {
  const base = {
    storeName: "Echos",
    planName: "Pro",
    amountInr: 3000,
    dueOn: "2026-10-06T00:00:00.000Z",
    invoiceRef: "SM/2026-27/0007",
    manageUrl: MANAGE,
  };

  it("autopay tells the merchant there is nothing to do", () => {
    const e = renewalDueTemplate({ ...base, autopay: true });
    expect(e.subject).toBe("Your Pro plan renews on 06 Oct 2026");
    expect(e.html).toContain("nothing you need to do");
    expect(e.html).toContain("Manage your plan");
    expect(e.html).not.toContain("Pay now");
    expect(e.html).toContain("SM/2026-27/0007");
  });

  it("★★ manual is a bill with a deadline and the grace warning", () => {
    const e = renewalDueTemplate({ ...base, autopay: false });
    expect(e.subject).toBe("₹3,000 due for your Pro plan");
    expect(e.html).toContain("payable by");
    expect(e.html).toContain("48 hours");
    expect(e.html).toContain("Pay now");
    expect(e.html).not.toContain("nothing you need to do");
  });

  it("escapes the invoice reference and omits it when absent", () => {
    const withRef = renewalDueTemplate({
      ...base,
      autopay: false,
      invoiceRef: "<i>x</i>",
    });
    expect(withRef.html).toContain("&lt;i&gt;x&lt;/i&gt;");
    const withoutRef = renewalDueTemplate({
      ...base,
      autopay: false,
      invoiceRef: null,
    });
    expect(withRef.html).toContain(">Invoice</strong>");
    expect(withoutRef.html).not.toContain(">Invoice</strong>");
  });
});

describe("renewalOverdueTemplate: `attempted` must be truthful", () => {
  const base = {
    storeName: "Echos",
    planName: "Pro",
    accessUntil: "2026-11-09T06:30:00.000Z",
    manageUrl: MANAGE,
  };

  it("names the deadline in IST and the subject has no long dash", () => {
    const e = renewalOverdueTemplate({ ...base, attempted: true });
    expect(e.subject).toBe("Payment overdue: your Pro plan ends in 48 hours");
    expect(e.html).toContain("09 Nov, 12:00 IST");
    expect(e.html).toContain("point of sale");
  });

  it("★ only says we couldn't collect when a charge was attempted", () => {
    const attempted = renewalOverdueTemplate({ ...base, attempted: true });
    const unattempted = renewalOverdueTemplate({ ...base, attempted: false });
    expect(attempted.html).toContain("We couldn't collect payment");
    expect(unattempted.html).not.toContain("couldn't collect");
    expect(unattempted.html).toContain("renewal hasn't been paid");
  });
});

/**
 * ★★ THE REGRESSION THIS PINS: no phone, no subscription.
 *
 * `startEnrolment` refuses before Razorpay unless it gets BOTH fields back, so
 * a null phone here is not a cosmetic omission: it is a store that cannot
 * subscribe at all. `admins.phone` was the only source and signup never wrote
 * it, which took every wizard-created store's Subscribe button out of service.
 */
describe("renewalDueTemplate: naming a reprice", () => {
  const base = {
    storeName: "Echos",
    planName: "Pro",
    amountInr: 3000,
    dueOn: "2026-10-06T00:00:00.000Z",
    invoiceRef: "SM/2026-27/0007",
    autopay: true,
    manageUrl: MANAGE,
  };

  it("★★ says a rise is a rise, in both the autopay and the bill wording", () => {
    // The amount alone does not tell a merchant it CHANGED; they would have to
    // remember last cycle's figure. An unexplained larger debit is what turns
    // an operator reprice into a chargeback.
    for (const autopay of [true, false]) {
      const e = renewalDueTemplate({
        ...base,
        autopay,
        previousAmountInr: 2400,
      });
      expect(e.html).toContain("an increase");
      expect(e.html).toContain("₹2,400");
    }
  });

  it("★ calls a reduction a reduction", () => {
    // "Your price has changed" reads as a rise to everyone, so a merchant whose
    // bill went DOWN would write in to ask what went wrong.
    const e = renewalDueTemplate({ ...base, previousAmountInr: 4000 });
    expect(e.html).toContain("a reduction");
    expect(e.html).not.toContain("an increase");
  });

  it("★ stays silent when the price did not move", () => {
    // Noise on an unchanged bill is what teaches people to stop reading
    // billing email, the one channel that must still be read.
    for (const previousAmountInr of [3000, null, undefined]) {
      const e = renewalDueTemplate({ ...base, previousAmountInr });
      expect(e.html).not.toContain("an increase");
      expect(e.html).not.toContain("a reduction");
      expect(e.html).not.toContain("last time");
    }
  });
});

describe("resolveBillingEmail", () => {
  const STORE = "store-1";
  const store = [{ name: "Echos", slug: "echos" }];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function seed(owner: any[], billing: any[]) {
    dbHolder.current = makeDbMock({ selectQueue: [store, owner, billing] });
  }

  it("prefers the owner's own verified number", async () => {
    seed(
      [{ email: "owner@echos.test", phone: "+919000000001" }],
      [{ contact_email: "billing@echos.test", contact_phone: "+919000000002" }],
    );
    expect(await resolveBillingEmail(STORE)).toMatchObject({
      email: "owner@echos.test",
      phone: "+919000000001",
    });
  });

  it("★★ falls back to the invoice contact phone when the admin row has none", async () => {
    seed(
      [{ email: "owner@echos.test", phone: null }],
      [{ contact_email: null, contact_phone: "+919814468834" }],
    );
    expect(await resolveBillingEmail(STORE)).toMatchObject({
      email: "owner@echos.test",
      phone: "+919814468834",
    });
  });

  it("normalises the invoice contact phone to E.164", async () => {
    seed(
      [{ email: "owner@echos.test", phone: null }],
      [{ contact_email: null, contact_phone: "98144 68834" }],
    );
    expect((await resolveBillingEmail(STORE))?.phone).toBe("+919814468834");
  });

  it("★ refuses a landline or placeholder rather than registering an unreachable mandate", async () => {
    seed(
      [{ email: "owner@echos.test", phone: null }],
      [{ contact_email: null, contact_phone: "022-24001234" }],
    );
    expect((await resolveBillingEmail(STORE))?.phone).toBeNull();
  });

  it("never pairs the owner's number with someone else's billing email", async () => {
    seed([], [{ contact_email: "billing@echos.test", contact_phone: null }]);
    expect(await resolveBillingEmail(STORE)).toMatchObject({
      email: "billing@echos.test",
      phone: null,
    });
  });

  it("is null when no email exists at all", async () => {
    seed([], [{ contact_email: null, contact_phone: "+919814468834" }]);
    expect(await resolveBillingEmail(STORE)).toBeNull();
  });
});
