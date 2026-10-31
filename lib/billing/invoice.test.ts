import { describe, expect, it } from "vitest";
import {
  INVOICE_BODY_KINDS,
  amountDuePaise,
  buildAddonInvoice,
  buildAiCreditsInvoice,
  buildSubscriptionInvoice,
  prorationPaise,
  rebuildForIssue,
  taxOnPaise,
  taxWithinPaise,
  type InvoiceLine,
  type TaxContext,
} from "./invoice";
import { splitGstPaise } from "./gst";

const NO_TAX: TaxContext = {
  enabled: false,
  rateBps: 1800,
  inclusive: false,
  supplierStateCode: null,
  placeOfSupply: null,
};
// ★ NUMERIC GST state codes ("07" Delhi, "29" Karnataka) — normalizeStateCode
// rejects anything non-numeric, and a rejected code falls back to INTRA-state.
const GST_INTRA: TaxContext = {
  enabled: true,
  rateBps: 1800,
  inclusive: false,
  supplierStateCode: "07",
  placeOfSupply: "07",
};
/** Same rate, but the listed price already contains the tax. */
const GST_INCL: TaxContext = { ...GST_INTRA, inclusive: true };
const GST_INTER: TaxContext = {
  enabled: true,
  rateBps: 1800,
  inclusive: false,
  supplierStateCode: "07",
  placeOfSupply: "29",
};

describe("splitGstPaise", () => {
  it("halves intra-state tax and re-sums exactly", () => {
    const s = splitGstPaise(17_700_00 - 15_000_00, true);
    expect(s.cgstPaise + s.sgstPaise).toBe(2_700_00);
    expect(s.igstPaise).toBe(0);
    expect(s.intraState).toBe(true);
  });

  it("★ gives sgst the odd paise, so the halves always re-sum", () => {
    const s = splitGstPaise(5, true);
    expect([s.cgstPaise, s.sgstPaise]).toEqual([2, 3]);
    expect(s.cgstPaise + s.sgstPaise).toBe(5);
  });

  it("puts everything in IGST inter-state", () => {
    const s = splitGstPaise(2_700_00, false);
    expect(s).toEqual({
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 2_700_00,
      intraState: false,
    });
  });

  it("never returns negative tax", () => {
    expect(splitGstPaise(-500, true).cgstPaise).toBe(0);
  });
});

describe("taxOnPaise", () => {
  it("is 18% of the taxable base, half-up", () => {
    expect(taxOnPaise(15_000_00, 1800)).toBe(2_700_00);
    expect(taxOnPaise(1_500_00, 1800)).toBe(270_00);
  });

  it("rounds a fractional paise half-up", () => {
    // 1_00 paise (₹1) at 18% = 18 paise exactly; 3 paise at 18% = 0.54 → 1.
    expect(taxOnPaise(1_00, 1800)).toBe(18);
    expect(taxOnPaise(3, 1800)).toBe(1);
  });

  it("is zero at a zero rate or base", () => {
    expect(taxOnPaise(15_000_00, 0)).toBe(0);
    expect(taxOnPaise(0, 1800)).toBe(0);
  });
});

describe("buildSubscriptionInvoice", () => {
  it("bills the bare plan with no tax while GST is off", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Basic",
      period: "yearly",
      planPaise: 15_000_00,
      tax: NO_TAX,
    });
    expect(inv.subtotalPaise).toBe(15_000_00);
    expect(inv.taxPaise).toBe(0);
    expect(inv.totalPaise).toBe(15_000_00);
    expect(inv.taxRateBps).toBe(0);
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0].kind).toBe("base_plan");
    expect(inv.lines[0].description).toBe("Basic plan · 1 year");
  });

  it("★ Basic yearly becomes ₹17,700 once GST is on", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Basic",
      period: "yearly",
      planPaise: 15_000_00,
      tax: GST_INTRA,
    });
    expect(inv.totalPaise).toBe(17_700_00);
    expect(inv.taxPaise).toBe(2_700_00);
    expect(inv.gst.cgstPaise + inv.gst.sgstPaise).toBe(2_700_00);
  });

  it("splits inter-state tax as IGST", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      tax: GST_INTER,
    });
    expect(inv.gst.igstPaise).toBe(900_00);
    expect(inv.gst.cgstPaise).toBe(0);
  });

  it("bills extra locations as their own line", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      locations: { count: 3, unitPaise: 1_000_00 },
      tax: NO_TAX,
    });
    const loc = inv.lines.find((l) => l.kind === "location");
    expect(loc?.quantity).toBe(3);
    expect(loc?.amountPaise).toBe(3_000_00);
    expect(inv.totalPaise).toBe(8_000_00);
  });

  it("omits the location line at zero, and singularises at one", () => {
    expect(
      buildSubscriptionInvoice({
        planLabel: "Pro",
        period: "monthly",
        planPaise: 5_000_00,
        locations: { count: 0, unitPaise: 1_000_00 },
        tax: NO_TAX,
      }).lines.some((l) => l.kind === "location"),
    ).toBe(false);

    expect(
      buildSubscriptionInvoice({
        planLabel: "Pro",
        period: "monthly",
        planPaise: 5_000_00,
        locations: { count: 1, unitPaise: 1_000_00 },
        tax: NO_TAX,
      }).lines.find((l) => l.kind === "location")?.description,
    ).toContain("Extra location");
  });

  it("taxes AFTER the discount, never the gross", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      discountPaise: 1_000_00,
      tax: GST_INTRA,
    });
    expect(inv.discountPaise).toBe(1_000_00);
    expect(inv.taxPaise).toBe(720_00); // 18% of 4,000, not of 5,000
    expect(inv.totalPaise).toBe(4_720_00);
  });

  it("shows the discount as a NEGATIVE line", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      discountPaise: 1_000_00,
      tax: NO_TAX,
    });
    expect(inv.lines.find((l) => l.kind === "discount")?.amountPaise).toBe(
      -1_000_00,
    );
  });

  it("caps a discount at the subtotal rather than going negative", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Basic",
      period: "monthly",
      planPaise: 1_500_00,
      discountPaise: 9_999_00,
      tax: GST_INTRA,
    });
    expect(inv.discountPaise).toBe(1_500_00);
    expect(inv.totalPaise).toBe(0);
  });

  it("clamps a negative proration instead of issuing a silent credit", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      proration: { amountPaise: -2_000_00 },
      tax: NO_TAX,
    });
    expect(inv.lines.some((l) => l.kind === "proration")).toBe(false);
    expect(inv.totalPaise).toBe(5_000_00);
  });

  it("★ always satisfies the billing_invoices_total_adds_up CHECK", () => {
    for (const tax of [NO_TAX, GST_INTRA, GST_INTER]) {
      for (const discount of [0, 1, 777_77, 1_500_00]) {
        const inv = buildSubscriptionInvoice({
          planLabel: "Pro",
          period: "monthly",
          planPaise: 5_000_00,
          locations: { count: 2, unitPaise: 1_000_00 },
          proration: { amountPaise: 333_33 },
          discountPaise: discount,
          tax,
        });
        expect(inv.totalPaise).toBe(
          inv.subtotalPaise - inv.discountPaise + inv.taxPaise,
        );
        expect(Number.isInteger(inv.totalPaise)).toBe(true);
      }
    }
  });

  it("★ never emits an ai_credits line on a subscription invoice", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      locations: { count: 2, unitPaise: 1_000_00 },
      proration: { amountPaise: 100 },
      tax: GST_INTRA,
    });
    expect(inv.lines.some((l) => l.kind === "ai_credits")).toBe(false);
  });

  it("★ never emits an account_credit line — credit is a payment, not a discount", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      tax: GST_INTRA,
    });
    expect(inv.lines.some((l) => l.kind === "account_credit")).toBe(false);
  });
});

// ★★ This is the hazard, pinned so nobody has to rediscover it. A non-numeric
// or missing state code is rejected by normalizeStateCode, and isIntraState then
// falls back to INTRA-state — correct for a POS walk-in, WRONG for platform
// billing, where supplier and merchant are usually in different states. The
// real guard is the DB CHECK on both state_code columns (billing_01); these
// tests document what happens if a bad value ever reaches this layer.
describe("★★ state-code format is load-bearing", () => {
  const inter = (supplier: string | null, place: string | null) =>
    buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      tax: {
        enabled: true,
        rateBps: 1800,
        inclusive: false,
        supplierStateCode: supplier,
        placeOfSupply: place,
      },
    }).gst;

  it("splits IGST for a genuine inter-state pair", () => {
    expect(inter("07", "29")).toMatchObject({
      igstPaise: 900_00,
      cgstPaise: 0,
      intraState: false,
    });
  });

  it("accepts an unpadded numeric code", () => {
    expect(inter("7", "07").intraState).toBe(true);
    expect(inter("7", "29").intraState).toBe(false);
  });

  it("★ a two-LETTER code silently becomes intra-state — the wrong tax", () => {
    expect(inter("DL", "KA").intraState).toBe(true);
    expect(inter("DL", "KA").igstPaise).toBe(0);
  });

  it("★ a missing code silently becomes intra-state", () => {
    expect(inter(null, "29").intraState).toBe(true);
    expect(inter("07", null).intraState).toBe(true);
  });

  it("charges the same TOTAL either way — only the split differs", () => {
    const a = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      tax: GST_INTRA,
    });
    const b = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      tax: GST_INTER,
    });
    expect(a.totalPaise).toBe(b.totalPaise);
    expect(a.gst.cgstPaise + a.gst.sgstPaise).toBe(b.gst.igstPaise);
  });
});

describe("taxWithinPaise (inclusive)", () => {
  it("★ carves out gross×r/(1+r), NOT gross×r", () => {
    // ₹15,000 inclusive at 18% contains ₹2,288.14 — not the ₹2,700 that
    // exclusive would ADD. Getting this wrong under-declares output tax.
    expect(taxWithinPaise(15_000_00, 1800)).toBe(2_288_14);
    expect(taxWithinPaise(15_000_00, 1800)).not.toBe(
      taxOnPaise(15_000_00, 1800),
    );
  });

  it("is zero at a zero rate or gross", () => {
    expect(taxWithinPaise(15_000_00, 0)).toBe(0);
    expect(taxWithinPaise(0, 1800)).toBe(0);
  });

  it("★ round-trips: gross − taxWithin, re-taxed exclusively, returns the gross", () => {
    for (const gross of [1_500_00, 5_000_00, 15_000_00, 50_000_00, 129_00, 7]) {
      const inside = taxWithinPaise(gross, 1800);
      const taxable = gross - inside;
      // Allow the single-paise rounding slack the two roundings can produce.
      expect(
        Math.abs(taxable + taxOnPaise(taxable, 1800) - gross),
      ).toBeLessThanOrEqual(1);
    }
  });
});

describe("★ inclusive vs exclusive tax mode", () => {
  const basicYearly = (tax: TaxContext) =>
    buildSubscriptionInvoice({
      planLabel: "Basic",
      period: "yearly",
      planPaise: 15_000_00,
      tax,
    });

  it("★ inclusive holds the total at the listed price", () => {
    const inv = basicYearly(GST_INCL);
    expect(inv.totalPaise).toBe(15_000_00);
    expect(inv.taxPaise).toBe(2_288_14);
    expect(inv.subtotalPaise).toBe(12_711_86);
  });

  it("★ exclusive raises the total above the listed price", () => {
    const inv = basicYearly(GST_INTRA);
    expect(inv.totalPaise).toBe(17_700_00);
    expect(inv.taxPaise).toBe(2_700_00);
    expect(inv.subtotalPaise).toBe(15_000_00);
  });

  it("★ subtotal + tax re-sums to the listed price exactly under inclusive", () => {
    for (const p of [
      1_500_00, 5_000_00, 15_000_00, 50_000_00, 1, 7, 12_345_67,
    ]) {
      const inv = buildSubscriptionInvoice({
        planLabel: "X",
        period: "monthly",
        planPaise: p,
        tax: GST_INCL,
      });
      expect(inv.subtotalPaise + inv.taxPaise).toBe(p);
      expect(inv.totalPaise).toBe(p);
    }
  });

  it("★ enabling GST changes nothing under inclusive, and +18% under exclusive", () => {
    const off = basicYearly(NO_TAX).totalPaise;
    expect(basicYearly(GST_INCL).totalPaise).toBe(off);
    expect(basicYearly(GST_INTRA).totalPaise).toBeGreaterThan(off);
  });

  it("still satisfies total_adds_up in inclusive mode, with a discount", () => {
    for (const discount of [0, 1, 777_77, 1_500_00]) {
      const inv = buildSubscriptionInvoice({
        planLabel: "Pro",
        period: "monthly",
        planPaise: 5_000_00,
        locations: { count: 2, unitPaise: 1_000_00 },
        discountPaise: discount,
        tax: GST_INCL,
      });
      expect(inv.totalPaise).toBe(
        inv.subtotalPaise - inv.discountPaise + inv.taxPaise,
      );
      // Inclusive: the merchant pays the listed price less any discount.
      expect(inv.totalPaise).toBe(7_000_00 - Math.min(discount, 7_000_00));
    }
  });

  it("labels an inclusive tax line as included, so it can't read as an extra charge", () => {
    expect(
      basicYearly(GST_INCL).lines.find((l) => l.kind === "tax")?.description,
    ).toBe("GST @ 18% (included)");
    expect(
      basicYearly(GST_INTRA).lines.find((l) => l.kind === "tax")?.description,
    ).toBe("GST @ 18%");
  });

  it("splits an inclusive tax the same way as an exclusive one", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Basic",
      period: "yearly",
      planPaise: 15_000_00,
      tax: { ...GST_INCL, placeOfSupply: "29" },
    });
    expect(inv.gst.igstPaise).toBe(2_288_14);
    expect(inv.gst.cgstPaise).toBe(0);
  });

  it("applies to AI credit invoices too", () => {
    const incl = buildAiCreditsInvoice({
      packLabel: "Popular",
      credits: 60,
      amountPaise: 129_00,
      tax: GST_INCL,
    });
    expect(incl.totalPaise).toBe(129_00);
    expect(incl.subtotalPaise + incl.taxPaise).toBe(129_00);
  });
});

describe("buildAiCreditsInvoice", () => {
  it("is its own document and carries only a credits line", () => {
    const inv = buildAiCreditsInvoice({
      packLabel: "Popular",
      credits: 60,
      amountPaise: 129_00,
      tax: GST_INTRA,
    });
    expect(inv.lines.filter((l) => l.kind === "ai_credits")).toHaveLength(1);
    expect(inv.lines.some((l) => l.kind === "base_plan")).toBe(false);
    expect(inv.subtotalPaise).toBe(129_00);
    expect(inv.taxPaise).toBe(2322); // 18% of ₹129 = ₹23.22
    expect(inv.totalPaise).toBe(129_00 + 2322);
  });

  it("names the pack and the credit count", () => {
    expect(
      buildAiCreditsInvoice({
        packLabel: "Bulk",
        credits: 150,
        amountPaise: 299_00,
        tax: NO_TAX,
      }).lines[0].description,
    ).toBe("Mink credits · Bulk (150 credits)");
  });
});

describe("prorationPaise", () => {
  const base = {
    period: "monthly" as const,
    periodDays: 30,
    periodEnd: new Date("2026-09-01T00:00:00.000Z"),
  };

  it("charges the difference for the days remaining", () => {
    // 15 of 30 days left, ₹5,000 − ₹1,500 = ₹3,500 → ₹1,750.
    expect(
      prorationPaise({
        ...base,
        currentPeriodPaise: 1_500_00,
        targetPeriodPaise: 5_000_00,
        now: new Date("2026-08-17T00:00:00.000Z"),
      }),
    ).toBe(1_750_00);
  });

  it("★ returns 0 for a downgrade — it waits for the cycle boundary", () => {
    expect(
      prorationPaise({
        ...base,
        currentPeriodPaise: 5_000_00,
        targetPeriodPaise: 1_500_00,
        now: new Date("2026-08-17T00:00:00.000Z"),
      }),
    ).toBe(0);
  });

  it("returns 0 for a same-price move", () => {
    expect(
      prorationPaise({
        ...base,
        currentPeriodPaise: 5_000_00,
        targetPeriodPaise: 5_000_00,
        now: new Date("2026-08-17T00:00:00.000Z"),
      }),
    ).toBe(0);
  });

  it("charges the full difference at the very start of a cycle", () => {
    expect(
      prorationPaise({
        ...base,
        currentPeriodPaise: 1_500_00,
        targetPeriodPaise: 5_000_00,
        now: new Date("2026-08-02T00:00:00.000Z"),
      }),
    ).toBe(3_500_00);
  });

  it("charges nothing once the cycle has ended", () => {
    expect(
      prorationPaise({
        ...base,
        currentPeriodPaise: 1_500_00,
        targetPeriodPaise: 5_000_00,
        now: new Date("2026-09-05T00:00:00.000Z"),
      }),
    ).toBe(0);
  });

  it("never exceeds the full difference, even on a corrupt period_end", () => {
    expect(
      prorationPaise({
        ...base,
        periodEnd: new Date("2027-09-01T00:00:00.000Z"),
        currentPeriodPaise: 1_500_00,
        targetPeriodPaise: 5_000_00,
        now: new Date("2026-08-02T00:00:00.000Z"),
      }),
    ).toBe(3_500_00);
  });

  it("returns whole paise", () => {
    const n = prorationPaise({
      ...base,
      currentPeriodPaise: 1_500_00,
      targetPeriodPaise: 5_000_01,
      now: new Date("2026-08-18T13:00:00.000Z"),
    });
    expect(Number.isInteger(n)).toBe(true);
  });
});

describe("amountDuePaise", () => {
  it("subtracts applied credit from the total", () => {
    expect(amountDuePaise(17_700_00, 5_000_00)).toBe(12_700_00);
  });

  it("★ never goes negative when credit exceeds the invoice", () => {
    expect(amountDuePaise(1_500_00, 9_999_00)).toBe(0);
  });

  it("is the full total with no credit", () => {
    expect(amountDuePaise(17_700_00, 0)).toBe(17_700_00);
  });

  it("ignores a negative credit rather than inflating the bill", () => {
    expect(amountDuePaise(1_500_00, -1_000_00)).toBe(1_500_00);
  });
});

describe("BuiltInvoice.inclusive", () => {
  const basic = (tax: TaxContext) =>
    buildSubscriptionInvoice({
      planLabel: "Basic",
      period: "monthly",
      planPaise: 1_500_00,
      tax,
    });

  it("is true only when GST is on with prices including it", () => {
    expect(basic(GST_INCL).inclusive).toBe(true);
    expect(basic(GST_INTRA).inclusive).toBe(false);
    expect(basic(NO_TAX).inclusive).toBe(false);
    // An inclusive setting with GST off carves nothing, so nothing is included.
    expect(basic({ ...NO_TAX, inclusive: true }).inclusive).toBe(false);
  });

  it("is set by every builder", () => {
    expect(
      buildAiCreditsInvoice({
        packLabel: "Small",
        credits: 25,
        amountPaise: 59_00,
        tax: GST_INCL,
      }).inclusive,
    ).toBe(true);
    expect(
      buildAddonInvoice({
        description: "Extra location",
        amountPaise: 1_000_00,
        tax: GST_INTRA,
      }).inclusive,
    ).toBe(false);
  });
});

describe("INVOICE_BODY_KINDS", () => {
  it("is every line kind except the derived tax and discount lines", () => {
    expect([...INVOICE_BODY_KINDS].sort()).toEqual(
      [
        "account_credit",
        "addon",
        "ai_credits",
        "base_plan",
        "location",
        "proration",
      ].sort(),
    );
    expect(INVOICE_BODY_KINDS).not.toContain("tax");
    expect(INVOICE_BODY_KINDS).not.toContain("discount");
  });
});

describe("rebuildForIssue", () => {
  // StoreMink in Punjab (03), the merchant in Punjab: CGST + SGST.
  const PUNJAB_EXCL: TaxContext = {
    enabled: true,
    rateBps: 1800,
    inclusive: false,
    supplierStateCode: "03",
    placeOfSupply: "03",
  };
  const PUNJAB_INCL: TaxContext = { ...PUNJAB_EXCL, inclusive: true };
  const OFF: TaxContext = { ...PUNJAB_EXCL, enabled: false, rateBps: 0 };

  const draft = (tax: TaxContext, discountPaise = 0) =>
    buildSubscriptionInvoice({
      planLabel: "Basic",
      period: "yearly",
      planPaise: 1_500_00,
      discountPaise,
      tax,
    });

  const count = (lines: InvoiceLine[], kind: InvoiceLine["kind"]) =>
    lines.filter((l) => l.kind === kind).length;

  it("not frozen, exclusive: an untaxed 150000 draft is issued at 177000", () => {
    const built = draft(OFF);
    const out = rebuildForIssue({
      lines: built.lines,
      discountPaise: built.discountPaise,
      tax: PUNJAB_EXCL,
      frozenTotalPaise: null,
    });
    expect(out).not.toBeNull();
    expect(out?.carved).toBe(false);
    expect(out?.totalPaise).toBe(1_770_00);
    expect(out?.taxPaise).toBe(270_00);
    expect(out?.subtotalPaise).toBe(1_500_00);
    expect(out?.inclusive).toBe(false);
    expect(out?.taxRateBps).toBe(1800);
  });

  it("frozen 150000 under exclusive: the GST is carved out of what was paid", () => {
    const built = draft(OFF);
    const out = rebuildForIssue({
      lines: built.lines,
      discountPaise: built.discountPaise,
      tax: PUNJAB_EXCL,
      frozenTotalPaise: 1_500_00,
    });
    expect(out?.carved).toBe(true);
    expect(out?.totalPaise).toBe(1_500_00);
    expect(out?.taxPaise).toBe(228_81);
    expect(out?.subtotalPaise).toBe(1_271_19);
    expect(out?.inclusive).toBe(true);
    expect(out?.gst).toMatchObject({
      cgstPaise: 114_40,
      sgstPaise: 114_41,
      igstPaise: 0,
    });
    expect(out?.lines.find((l) => l.kind === "tax")?.description).toBe(
      "GST @ 18% (included)",
    );
  });

  it("frozen under inclusive: the same total, GST inside it", () => {
    const built = draft(OFF);
    const out = rebuildForIssue({
      lines: built.lines,
      discountPaise: built.discountPaise,
      tax: PUNJAB_INCL,
      frozenTotalPaise: 1_500_00,
    });
    expect(out?.carved).toBe(false);
    expect(out?.totalPaise).toBe(1_500_00);
    expect(out?.taxPaise).toBe(228_81);
    expect(out?.inclusive).toBe(true);
  });

  it("frozen 177000 built at 18% cannot be reproduced at 28%: null", () => {
    const built = draft(PUNJAB_EXCL);
    expect(built.totalPaise).toBe(1_770_00);
    expect(
      rebuildForIssue({
        lines: built.lines,
        discountPaise: built.discountPaise,
        tax: { ...PUNJAB_EXCL, rateBps: 2800 },
        frozenTotalPaise: built.totalPaise,
      }),
    ).toBeNull();
  });

  it("frozen with GST switched off since: null, the draft is kept", () => {
    const built = draft(PUNJAB_EXCL);
    expect(
      rebuildForIssue({
        lines: built.lines,
        discountPaise: built.discountPaise,
        tax: OFF,
        frozenTotalPaise: built.totalPaise,
      }),
    ).toBeNull();
  });

  it("only the place of supply changed: same amounts, the split moves", () => {
    const built = draft(PUNJAB_EXCL);
    const out = rebuildForIssue({
      lines: built.lines,
      discountPaise: built.discountPaise,
      tax: { ...PUNJAB_EXCL, placeOfSupply: "07" },
      frozenTotalPaise: built.totalPaise,
    });
    expect(out?.carved).toBe(false);
    expect(out?.totalPaise).toBe(built.totalPaise);
    expect(out?.taxPaise).toBe(built.taxPaise);
    expect(out?.subtotalPaise).toBe(built.subtotalPaise);
    expect(built.gst.intraState).toBe(true);
    expect(out?.gst).toMatchObject({
      intraState: false,
      igstPaise: 270_00,
      cgstPaise: 0,
    });
  });

  it("keeps a discount, applying it once", () => {
    const built = draft(OFF, 100_00);
    expect(count(built.lines, "discount")).toBe(1);
    const out = rebuildForIssue({
      lines: built.lines,
      discountPaise: built.discountPaise,
      tax: PUNJAB_EXCL,
      frozenTotalPaise: null,
    });
    expect(out?.discountPaise).toBe(100_00);
    expect(out?.taxPaise).toBe(252_00); // 18% of 1,400, after the discount
    expect(out?.totalPaise).toBe(1_652_00);
    expect(count(out?.lines ?? [], "discount")).toBe(1);
    expect(out?.lines.find((l) => l.kind === "discount")?.amountPaise).toBe(
      -100_00,
    );
  });

  it("never counts the stored tax and discount lines twice", () => {
    const built = draft(PUNJAB_EXCL, 100_00);
    expect(count(built.lines, "tax")).toBe(1);
    expect(count(built.lines, "discount")).toBe(1);
    const out = rebuildForIssue({
      lines: built.lines,
      discountPaise: built.discountPaise,
      tax: PUNJAB_EXCL,
      frozenTotalPaise: null,
    });
    expect(out).toEqual({ ...built, carved: false });
    expect(count(out?.lines ?? [], "tax")).toBe(1);
    expect(count(out?.lines ?? [], "discount")).toBe(1);
  });

  it("keeps locations and proration as they were", () => {
    const built = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 2_400_00,
      locations: { count: 2, unitPaise: 1_000_00 },
      proration: { amountPaise: 333_33, description: "Plan change" },
      tax: OFF,
    });
    const out = rebuildForIssue({
      lines: built.lines,
      discountPaise: 0,
      tax: PUNJAB_EXCL,
      frozenTotalPaise: null,
    });
    expect(
      out?.lines.filter((l) => INVOICE_BODY_KINDS.includes(l.kind)),
    ).toEqual(built.lines);
    expect(out?.subtotalPaise).toBe(2_400_00 + 2_000_00 + 333_33);
  });

  it("always satisfies the billing_invoices_total_adds_up CHECK", () => {
    for (const discount of [0, 1, 777_77]) {
      for (const frozen of [null, 1_500_00 - Math.min(discount, 1_500_00)]) {
        const built = draft(OFF, discount);
        const out = rebuildForIssue({
          lines: built.lines,
          discountPaise: built.discountPaise,
          tax: PUNJAB_EXCL,
          frozenTotalPaise: frozen,
        });
        expect(out).not.toBeNull();
        if (!out) continue;
        expect(out.totalPaise).toBe(
          out.subtotalPaise - out.discountPaise + out.taxPaise,
        );
        if (frozen !== null) expect(out.totalPaise).toBe(frozen);
      }
    }
  });
});
