/* eslint-disable @typescript-eslint/no-explicit-any */
// Invoicing an AI credit purchase.
//
// Two rules carry it, both inherited from enrolment:
//   • a DRAFT at purchase time, FINALIZED when the money lands — so an abandoned
//     checkout never burns a number in the gapless GST series;
//   • nothing here throws, because credits are granted by add_ai_credits and
//     must not fail over a document. The caller refuses a purchase whose draft
//     could not be written (GST, design 5.5).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

const store = vi.hoisted(() => ({
  createAiCreditsInvoice: vi.fn(),
  finalizePaidAiCreditsInvoice: vi.fn(),
}));
vi.mock("./invoice-store", () => store);

import { draftCreditInvoice, issueCreditInvoice } from "./credit-invoice";
import { buildAiCreditsInvoice } from "./invoice";
import type { InvoiceTaxStamp } from "./tax-snapshot";

const STORE = "store-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");
const PAID_AT = new Date("2026-08-31T17:30:00.000Z");

/** GST on, exclusive: a Rs 59 pack is charged Rs 69.62. */
const BUILT = buildAiCreditsInvoice({
  packLabel: "Starter",
  credits: 25,
  amountPaise: 5_900,
  tax: {
    enabled: true,
    rateBps: 1800,
    inclusive: false,
    supplierStateCode: "03",
    placeOfSupply: "29",
  },
});

const STAMP: InvoiceTaxStamp = {
  supplierGstin: "03ABCDE1234F1Z5",
  customerGstin: null,
  placeOfSupply: "29",
  placeOfSupplyBasis: "recipient",
  sacCode: "998314",
};

const args = {
  storeId: STORE,
  purchaseId: "pur-1",
  built: BUILT,
  stamp: STAMP,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.current = makeDbMock({ selectQueue: [] });
  store.createAiCreditsInvoice.mockResolvedValue({
    id: "inv-1",
    status: "draft",
    finalizedAt: null,
    invoiceRef: null,
  });
  store.finalizePaidAiCreditsInvoice.mockResolvedValue({
    id: "inv-1",
    status: "paid",
  });
});

describe("draftCreditInvoice", () => {
  it("raises an ai_credits invoice for the pack", async () => {
    const id = await draftCreditInvoice(args);
    expect(id).toBe("inv-1");
    const built = store.createAiCreditsInvoice.mock.calls[0][0].built;
    expect(built.totalPaise).toBe(6_962);
    expect(built.lines[0].kind).toBe("ai_credits");
  });

  it("★★ writes the caller's built invoice and stamp, read once, unchanged", async () => {
    // The Razorpay order was priced from this very `built`, so the invoice
    // cannot carry another figure, and the stamp is the same reading's.
    await draftCreditInvoice(args);
    expect(store.createAiCreditsInvoice).toHaveBeenCalledWith({
      storeId: STORE,
      built: BUILT,
      stamp: STAMP,
    });
  });

  it("★★ does NOT finalize — an unpaid purchase must not burn a GST number", async () => {
    await draftCreditInvoice(args);
    expect(store.finalizePaidAiCreditsInvoice).not.toHaveBeenCalled();
  });

  it("★ links it to the purchase, so settling can find it", async () => {
    await draftCreditInvoice(args);
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      invoiceId: "inv-1",
    });
  });

  it("★★ NEVER THROWS: the caller decides what a missing draft means", async () => {
    store.createAiCreditsInvoice.mockRejectedValue(new Error("db down"));
    await expect(draftCreditInvoice(args)).resolves.toBeNull();
  });

  it("★ returns null when the invoice could not be created", async () => {
    store.createAiCreditsInvoice.mockResolvedValue(null);
    expect(await draftCreditInvoice(args)).toBeNull();
  });

  it("★ returns null when the purchase could not be linked", async () => {
    // A draft nobody can find at settle time is a payment with no invoice,
    // so a failed link is a failed draft.
    dbHolder.current.db.update = () => {
      throw new Error("db down");
    };
    expect(await draftCreditInvoice(args)).toBeNull();
  });
});

describe("issueCreditInvoice", () => {
  it("finalizes the linked draft directly as paid", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ invoiceId: "inv-1" }]] });
    await issueCreditInvoice("pur-1", NOW);
    expect(store.finalizePaidAiCreditsInvoice).toHaveBeenCalledWith(
      "inv-1",
      NOW,
      undefined,
    );
  });

  it("★ passes the payment's own time through, for the terms in force then", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ invoiceId: "inv-1" }]] });
    await issueCreditInvoice("pur-1", NOW, PAID_AT);
    expect(store.finalizePaidAiCreditsInvoice).toHaveBeenCalledWith(
      "inv-1",
      NOW,
      PAID_AT,
    );
  });

  it("★★ does NOTHING for a purchase with no invoice", async () => {
    // Purchases made before this existed have no draft. Issuing one today would
    // put a number from the CURRENT financial year's series on a months-old
    // sale, which is worse than no number.
    dbHolder.current = makeDbMock({ selectQueue: [[{ invoiceId: null }]] });
    await issueCreditInvoice("pur-old", NOW);
    expect(store.finalizePaidAiCreditsInvoice).not.toHaveBeenCalled();
  });

  it("★ does nothing when the purchase is gone", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    await issueCreditInvoice("pur-x", NOW);
    expect(store.finalizePaidAiCreditsInvoice).not.toHaveBeenCalled();
  });

  it("★★ NEVER THROWS — the credits are already granted by this point", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    await expect(issueCreditInvoice("pur-1", NOW)).resolves.toBeUndefined();
  });
});
