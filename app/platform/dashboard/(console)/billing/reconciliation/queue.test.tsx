// @vitest-environment jsdom
// The operator reconciliation queue.
//
// These are money discrepancies, so what the screen SAYS matters: the direction
// and size of a mismatch, whose money it is, and — most of all — that closing an
// item records a judgement rather than moving anything.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReconciliationQueue } from "./queue";
import type { ReconciliationItem } from "@/lib/billing/invoice-types";

const billing = vi.hoisted(() => ({
  issueRefund: vi.fn(),
  recordRefundMadeOutside: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/platform", () => ({
  closeReconciliationItem: vi.fn(),
}));
// The refund dialogs the refund items open (renewal-cancel, design 7.4).
vi.mock("@/app/actions/platform-billing", () => ({
  issueRefund: billing.issueRefund,
  recordRefundMadeOutside: billing.recordRefundMadeOutside,
  sendRefund: vi.fn(),
  retryRefund: vi.fn(),
  cancelRefund: vi.fn(),
  cancelPlanAtCycleEnd: vi.fn(),
  undoPlanCancellation: vi.fn(),
  endPlanNow: vi.fn(),
  listStoreBilling: vi.fn(),
}));

function item(over: Partial<ReconciliationItem> = {}): ReconciliationItem {
  return {
    id: "item-1",
    storeId: "store-1",
    storeName: "Acme Retail",
    storeSlug: "acme",
    kind: "amount_mismatch",
    status: "open",
    invoiceId: "inv-1",
    attemptId: "att-1",
    providerPaymentId: "pay_abc123",
    providerOrderId: "order_abc",
    expectedPaise: 500_000,
    observedPaise: 400_000,
    detail: {},
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
    createdAt: "2026-09-10T00:00:00.000Z",
    ...over,
  };
}

describe("the queue", () => {
  it("names the discrepancy, the store, and both amounts", () => {
    render(<ReconciliationQueue items={[item()]} status="open" />);
    expect(screen.getByText("Amount mismatch")).toBeInTheDocument();
    expect(screen.getByText("Acme Retail")).toBeInTheDocument();
    expect(screen.getByText("₹5,000")).toBeInTheDocument();
    expect(screen.getByText("₹4,000")).toBeInTheDocument();
  });

  it("★★ says which DIRECTION the difference goes", () => {
    // "₹1,000" alone does not tell an operator whether the merchant was
    // overcharged or underpaid, which is the first thing they need.
    render(<ReconciliationQueue items={[item()]} status="open" />);
    expect(screen.getByText(/₹1,000 short/)).toBeInTheDocument();
  });

  it("★ reads the other way round too", () => {
    render(
      <ReconciliationQueue
        items={[item({ expectedPaise: 400_000, observedPaise: 500_000 })]}
        status="open"
      />,
    );
    expect(screen.getByText(/₹1,000 over/)).toBeInTheDocument();
  });

  it("★★ says so when an item maps to NO store — that is the problem itself", () => {
    // A blank here reads as a rendering bug; it is actually an orphan payment
    // nobody can attribute, which is exactly why a human is needed.
    render(
      <ReconciliationQueue
        items={[
          item({ storeId: null, storeName: null, kind: "orphan_payment" }),
        ]}
        status="open"
      />,
    );
    expect(screen.getByText(/needs attributing/i)).toBeInTheDocument();
  });

  it("★★ says the store was DELETED, by name, instead of asking to attribute it", () => {
    // deleteStore detaches the store's open items and marks them; sending the
    // operator to attribute a payment whose store is gone wastes the one
    // look it gets.
    render(
      <ReconciliationQueue
        items={[
          item({
            storeId: null,
            storeName: null,
            detail: {
              note: "captured amount differs from the attempt",
              storeDeleted: true,
              storeName: "Acme Retail",
            },
          }),
        ]}
        status="open"
      />,
    );
    expect(screen.getByText("Acme Retail (store deleted)")).toBeInTheDocument();
    expect(screen.queryByText(/needs attributing/i)).toBeNull();
    // The sweep's reason is shown, not left in a column nobody renders.
    expect(
      screen.getByText("captured amount differs from the attempt"),
    ).toBeInTheDocument();
  });

  it("★ a payment captured after its store was deleted says so", () => {
    render(
      <ReconciliationQueue
        items={[
          item({
            storeId: null,
            storeName: null,
            kind: "orphan_payment",
            detail: {
              note: "payment captured for a deleted store",
              storeDeleted: true,
            },
          }),
        ]}
        status="open"
      />,
    );
    expect(screen.getByText("store deleted")).toBeInTheDocument();
    expect(
      screen.getByText("payment captured for a deleted store"),
    ).toBeInTheDocument();
  });

  it("shows the gateway payment id, which is what an operator searches on", () => {
    render(<ReconciliationQueue items={[item()]} status="open" />);
    expect(screen.getByText("pay_abc123")).toBeInTheDocument();
  });

  it("★ an already-closed item shows the outcome, who and why — and no button", () => {
    render(
      <ReconciliationQueue
        items={[
          item({
            status: "resolved",
            resolvedBy: "op@storemink.com",
            resolvedAt: "2026-09-11T00:00:00.000Z",
            resolutionNote: "Refunded the difference",
          }),
        ]}
        status="resolved"
      />,
    );
    expect(screen.getByText(/Refunded the difference/)).toBeInTheDocument();
    expect(screen.getByText(/op@storemink.com/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Close this/ })).toBeNull();
  });

  it("★ an empty OPEN queue explains what would land here", () => {
    render(<ReconciliationQueue items={[]} status="open" />);
    expect(screen.getByText("Nothing to review")).toBeInTheDocument();
    expect(screen.getByText(/hourly sweep/i)).toBeInTheDocument();
  });

  it("★★ tells the operator, AT THE POINT OF ACTION, that this moves no money", () => {
    // The whole design rests on closing an item being a judgement rather than a
    // fix. An operator who believes "Resolved" refunded the difference leaves a
    // merchant overcharged and the queue looking clean. This sentence is the
    // only thing standing between those two readings, so it is pinned.
    render(<ReconciliationQueue items={[item()]} status="open" />);
    fireEvent.click(screen.getByRole("button", { name: "Close this" }));
    expect(screen.getByText(/does/)).toHaveTextContent(
      /does\s*not\s*move money/,
    );
  });

  it("★ will not close an item without a note — the note IS the audit trail", () => {
    render(<ReconciliationQueue items={[item()]} status="open" />);
    fireEvent.click(screen.getByRole("button", { name: "Close this" }));
    const submit = screen.getByRole("button", { name: /Close item/ });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Refunded the ₹1,000 difference" },
    });
    expect(submit).toBeEnabled();
  });

  it("★ whitespace is not a note", () => {
    render(<ReconciliationQueue items={[item()]} status="open" />);
    fireEvent.click(screen.getByRole("button", { name: "Close this" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: /Close item/ })).toBeDisabled();
  });

  it("renders a mismatch-less kind without inventing amounts", () => {
    render(
      <ReconciliationQueue
        items={[
          item({
            kind: "missing_webhook",
            expectedPaise: null,
            observedPaise: null,
          }),
        ]}
        status="open"
      />,
    );
    expect(screen.getByText("Missing webhook")).toBeInTheDocument();
    expect(screen.queryByText(/Asked for/)).toBeNull();
  });
});

function repairItem(
  key: string,
  over: Partial<ReconciliationItem> = {},
): ReconciliationItem {
  return item({
    kind: "state_conflict",
    invoiceId: "inv-7",
    attemptId: "att-7",
    providerPaymentId: "pay_777",
    expectedPaise: 240_000,
    observedPaise: null,
    detail: {
      repair_key: `${key}:inv-7`,
      note: "lowercase sweep note",
      invoiceRef: "SM/2026-27/000077",
    },
    ...over,
  });
}

describe("the refund items (design 7.4)", () => {
  it("names a renewal paid for a cycle never reached and sends the operator to the store's refund", () => {
    render(
      <ReconciliationQueue
        items={[repairItem("paid_unreached")]}
        status="open"
        canManage
      />,
    );
    expect(
      screen.getByText("Renewal paid for a cycle the plan did not reach"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Issue a refund (reason: Plan ended before this cycle), then close this with what you did.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("SM/2026-27/000077")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Issue a refund" }).getAttribute("href"),
    ).toBe("/dashboard/stores/store-1?refund=inv-7");
  });

  it("for a deleted store, opens the refund here, reason chosen", async () => {
    billing.issueRefund.mockResolvedValue({
      success: true,
      refundId: "ref-1",
      status: "pending",
    });
    render(
      <ReconciliationQueue
        items={[
          repairItem("paid_unreached", {
            storeId: null,
            storeName: null,
            detail: {
              repair_key: "paid_unreached:inv-7",
              invoiceRef: "SM/2026-27/000077",
              storeDeleted: true,
              storeName: "Acme Retail",
            },
          }),
        ]}
        status="open"
        canManage
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Issue a refund" }));
    expect((screen.getByLabelText("Reason") as HTMLSelectElement).value).toBe(
      "cycle_not_reached",
    );
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "Store deleted, refunding the renewal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send refund" }));
    await waitFor(() =>
      expect(billing.issueRefund).toHaveBeenCalledWith({
        storeId: null,
        invoiceId: "inv-7",
        attemptId: "att-7",
        amountInr: "2400",
        reason: "cycle_not_reached",
        note: "Store deleted, refunding the renewal",
      }),
    );
  });

  it("offers both tools on a payment kept before automatic refunds, and records here", async () => {
    billing.recordRefundMadeOutside.mockResolvedValue({
      success: true,
      refundId: "ref-2",
      status: "recorded",
    });
    render(
      <ReconciliationQueue
        items={[repairItem("kept_before_refunds")]}
        status="open"
        canManage
      />,
    );
    expect(
      screen.getByText(
        "Payment kept after the plan ended, before automatic refunds",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Issue a refund" })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Record a refund made outside StoreMink",
      }),
    );
    fireEvent.change(screen.getByLabelText("Reference"), {
      target: { value: "rfnd_by_hand" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record refund" }));
    await waitFor(() =>
      expect(billing.recordRefundMadeOutside).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: "store-1",
          invoiceId: "inv-7",
          attemptId: "att-7",
          reference: "rfnd_by_hand",
        }),
      ),
    );
  });

  it("shows why an automatic refund was refused, and offers only Record", () => {
    render(
      <ReconciliationQueue
        items={[
          repairItem("refund_refused", {
            detail: {
              repair_key: "refund_refused:att-7",
              reason: "The payment is too old to refund.",
              invoiceRef: "SM/2026-27/000077",
            },
          }),
        ]}
        status="open"
        canManage
      />,
    );
    expect(
      screen.getByText("An automatic refund was refused"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Why it was refused: The payment is too old to refund."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Issue a refund" })).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Record a refund made outside StoreMink",
      }),
    ).toBeTruthy();
  });

  it("★★ a member sees the item and why it waits, with no refund tool", () => {
    render(
      <ReconciliationQueue
        items={[repairItem("kept_before_refunds")]}
        status="open"
      />,
    );
    expect(screen.queryByRole("button", { name: "Issue a refund" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Issue a refund" })).toBeNull();
    expect(
      screen.getByText(
        "Only a platform superadmin can issue or record a refund.",
      ),
    ).toBeInTheDocument();
    // Closing stays anyone's: it records a judgement and moves no money.
    expect(screen.getByRole("button", { name: "Close this" })).toBeTruthy();
  });

  it("a closed refund item offers no tool", () => {
    render(
      <ReconciliationQueue
        items={[repairItem("paid_unreached", { status: "resolved" })]}
        status="resolved"
        canManage
      />,
    );
    expect(screen.queryByRole("link", { name: "Issue a refund" })).toBeNull();
  });
});

/** A closed-tab purchase the hourly check filed for a person (RC-F1b). */
function purchaseItem(
  key: "purchase_refused" | "purchase_unapplied",
  over: Partial<ReconciliationItem> = {},
  detail: Record<string, unknown> = {},
): ReconciliationItem {
  return item({
    kind: "state_conflict",
    invoiceId: "inv-8",
    attemptId: "att-8",
    providerPaymentId: "pay_888",
    expectedPaise: 240_000,
    observedPaise: null,
    detail: {
      repair_key: `${key}:att-8`,
      note: "Plan change payment captured, but the store's subscription is no longer live. Decide whether to refund the payment.",
      purchase: "plan_change",
      ...detail,
    },
    ...over,
  });
}

describe("the closed-tab purchase items (RC-F1b, RC-F1c)", () => {
  it("★★ names a purchase that was not applied, says what was bought and shows the note", () => {
    render(
      <ReconciliationQueue
        items={[purchaseItem("purchase_refused")]}
        status="open"
        canManage
      />,
    );
    expect(
      screen.getByText("A paid purchase was not applied"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Nothing was applied or refunded. Do what the note says: apply the purchase by hand, or refund the payment in the Razorpay dashboard. Then close this with what you did.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("What was bought: A plan change"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Plan change payment captured, but the store's subscription is no longer live. Decide whether to refund the payment.",
      ),
    ).toBeInTheDocument();
    // The generic label is not used once the item is known.
    expect(screen.queryByText("State conflict")).toBeNull();
  });

  it("★ opens the store, and offers no refund for an invoice that may never have been issued", () => {
    render(
      <ReconciliationQueue
        items={[purchaseItem("purchase_refused")]}
        status="open"
        canManage
      />,
    );
    expect(
      screen.getByRole("link", { name: "Open the store" }).getAttribute("href"),
    ).toBe("/dashboard/stores/store-1");
    expect(screen.queryByRole("button", { name: "Issue a refund" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Issue a refund" })).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Record a refund made outside StoreMink",
      }),
    ).toBeNull();
  });

  it("★★ an invoiced purchase that did not apply opens Issue a refund here, the reason left to the operator", async () => {
    billing.issueRefund.mockResolvedValue({
      success: true,
      refundId: "ref-8",
      status: "pending",
    });
    render(
      <ReconciliationQueue
        items={[
          purchaseItem(
            "purchase_unapplied",
            {},
            {
              note: "Location payment captured and its invoice paid, but the locations could not be added. Add them by hand; the merchant was told not to pay again.",
              purchase: "locations",
            },
          ),
        ]}
        status="open"
        canManage
      />,
    );
    expect(
      screen.getByText("A paid purchase was invoiced but not applied"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The invoice is issued and the merchant was told not to pay again. Apply the purchase by hand as the note says, or issue a refund. Then close this with what you did.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("What was bought: Extra locations"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open the store" }).getAttribute("href"),
    ).toBe("/dashboard/stores/store-1");

    fireEvent.click(screen.getByRole("button", { name: "Issue a refund" }));
    const reason = screen.getByLabelText("Reason") as HTMLSelectElement;
    // Not "Plan ended before this cycle": this payment bought a purchase that
    // did not apply, not a cycle the plan did not reach.
    expect(reason.value).toBe("");
    expect(Array.from(reason.options).map((o) => o.value)).not.toContain(
      "cycle_not_reached",
    );
    fireEvent.change(reason, { target: { value: "other" } });
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "Merchant asked for the money back" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send refund" }));
    await waitFor(() =>
      expect(billing.issueRefund).toHaveBeenCalledWith({
        storeId: "store-1",
        invoiceId: "inv-8",
        attemptId: "att-8",
        amountInr: "2400",
        reason: "other",
        note: "Merchant asked for the money back",
      }),
    );
  });

  it("an amount mismatch keeps its title and shows both amounts", () => {
    render(
      <ReconciliationQueue
        items={[
          purchaseItem(
            "purchase_refused",
            { kind: "amount_mismatch", observedPaise: 200_000 },
            { purchase: "enrolment" },
          ),
        ]}
        status="open"
        canManage
      />,
    );
    expect(
      screen.getByText("A paid purchase was not applied"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("What was bought: A first plan payment"),
    ).toBeInTheDocument();
    expect(screen.getByText(/₹400 short/)).toBeInTheDocument();
  });

  it("★★ a member can open the store but gets no refund tool", () => {
    render(
      <ReconciliationQueue
        items={[purchaseItem("purchase_unapplied")]}
        status="open"
      />,
    );
    expect(screen.getByRole("link", { name: "Open the store" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Issue a refund" })).toBeNull();
    expect(
      screen.getByText(
        "Only a platform superadmin can issue or record a refund.",
      ),
    ).toBeInTheDocument();
  });

  it("a deleted store's refused purchase has nowhere to open", () => {
    render(
      <ReconciliationQueue
        items={[
          purchaseItem(
            "purchase_refused",
            { storeId: null, storeName: null },
            { storeDeleted: true, storeName: "Acme Retail" },
          ),
        ]}
        status="open"
        canManage
      />,
    );
    expect(screen.getByText("Acme Retail (store deleted)")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open the store" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Issue a refund" })).toBeNull();
  });

  it("a closed purchase item offers no tool", () => {
    render(
      <ReconciliationQueue
        items={[purchaseItem("purchase_unapplied", { status: "resolved" })]}
        status="resolved"
        canManage
      />,
    );
    expect(
      screen.getByText("A paid purchase was invoiced but not applied"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open the store" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Issue a refund" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GST plan A4.6: a payment captured behind an invoice that was still a draft.
// The repair pass issued the invoice and settled it paid, and never applied
// the purchase; the item asks a person to check that it was.
// ---------------------------------------------------------------------------

function capturedDraftItem(
  over: Partial<ReconciliationItem> = {},
  detail: Record<string, unknown> = {},
): ReconciliationItem {
  return item({
    id: "item-cd",
    kind: "state_conflict",
    invoiceId: "inv-cd",
    attemptId: "att-cd",
    providerPaymentId: "pay_cd",
    expectedPaise: 177_000,
    observedPaise: null,
    detail: {
      repair_key: "captured_draft:inv-cd",
      note: "Payment captured against an invoice that was still a draft. The invoice is now issued. Check that the plan, plan change or location the merchant paid for was applied.",
      purchase: "enrolment",
      ...detail,
    },
    ...over,
  });
}

describe("the captured-draft items (GST plan A4.6)", () => {
  it("★★ names the item, says what was bought, and does not repeat the note", () => {
    render(
      <ReconciliationQueue
        items={[capturedDraftItem()]}
        status="open"
        canManage
      />,
    );
    expect(
      screen.getByText("Payment captured before its invoice was issued"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The invoice is now issued and paid. Check that the plan, plan change or location the merchant paid for was applied, then close this with what you did.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("What was bought: A first plan payment"),
    ).toBeInTheDocument();
    // The note says what the hint says; it is not printed twice.
    expect(
      screen.queryByText(/Payment captured against an invoice that was still/),
    ).toBeNull();
    expect(screen.queryByText("State conflict")).toBeNull();
    expect(screen.getByText("₹1,770")).toBeInTheDocument();
  });

  it("★ opens the store, and offers no refund while the store can still be checked", () => {
    render(
      <ReconciliationQueue
        items={[capturedDraftItem()]}
        status="open"
        canManage
      />,
    );
    expect(
      screen.getByRole("link", { name: "Open the store" }).getAttribute("href"),
    ).toBe("/dashboard/stores/store-1");
    expect(screen.queryByRole("button", { name: "Issue a refund" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Issue a refund" })).toBeNull();
  });

  it("a member can open the store too", () => {
    render(<ReconciliationQueue items={[capturedDraftItem()]} status="open" />);
    expect(screen.getByRole("link", { name: "Open the store" })).toBeTruthy();
    expect(
      screen.queryByText(
        "Only a platform superadmin can issue or record a refund.",
      ),
    ).toBeNull();
  });

  it("★★ a deleted store's item says nothing can be applied and opens Issue a refund here", async () => {
    billing.issueRefund.mockResolvedValue({
      success: true,
      refundId: "ref-cd",
      status: "pending",
    });
    render(
      <ReconciliationQueue
        items={[
          capturedDraftItem(
            { storeId: null, storeName: null },
            {
              storeDeleted: true,
              storeName: "Acme Retail",
              purchase: "locations",
            },
          ),
        ]}
        status="open"
        canManage
      />,
    );
    expect(screen.getByText("Acme Retail (store deleted)")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The store has been deleted, so what it paid for can't be applied. Refund the payment, then close this with what you did.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("What was bought: Extra locations"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open the store" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Issue a refund" }));
    const reason = screen.getByLabelText("Reason") as HTMLSelectElement;
    expect(reason.value).toBe("");
    expect(Array.from(reason.options).map((o) => o.value)).not.toContain(
      "cycle_not_reached",
    );
    fireEvent.change(reason, { target: { value: "other" } });
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "Store deleted before the locations applied" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send refund" }));
    await waitFor(() =>
      expect(billing.issueRefund).toHaveBeenCalledWith({
        storeId: null,
        invoiceId: "inv-cd",
        attemptId: "att-cd",
        amountInr: "1770",
        reason: "other",
        note: "Store deleted before the locations applied",
      }),
    );
  });

  it("a member sees a deleted store's item and why it waits, with no refund tool", () => {
    render(
      <ReconciliationQueue
        items={[
          capturedDraftItem(
            { storeId: null, storeName: null },
            { storeDeleted: true },
          ),
        ]}
        status="open"
      />,
    );
    expect(screen.queryByRole("button", { name: "Issue a refund" })).toBeNull();
    expect(
      screen.getByText(
        "Only a platform superadmin can issue or record a refund.",
      ),
    ).toBeInTheDocument();
  });

  it("a closed captured-draft item offers no tool", () => {
    render(
      <ReconciliationQueue
        items={[capturedDraftItem({ status: "resolved" })]}
        status="resolved"
        canManage
      />,
    );
    expect(
      screen.getByText("Payment captured before its invoice was issued"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open the store" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R1-03: an invoice issued with the GST it was priced with, because a payment
// had already fixed its total. The note names both rates; a person decides.
// ---------------------------------------------------------------------------

const KEPT_NOTE =
  "This invoice was issued with 18% GST included, the tax it was priced with, because its total was already fixed by a payment. The tax in force when it was issued is no GST. Decide whether to issue a credit note or refund the difference (payment pay_kd).";

function keptDraftItem(
  over: Partial<ReconciliationItem> = {},
): ReconciliationItem {
  return item({
    id: "item-kd",
    kind: "state_conflict",
    invoiceId: "inv-kd",
    attemptId: "att-kd",
    providerPaymentId: null,
    expectedPaise: 118_000,
    observedPaise: null,
    detail: {
      repair_key: "kept_draft:inv-kd",
      note: KEPT_NOTE,
      draft_rate_bps: 1800,
      draft_inclusive: true,
      rate_bps: 0,
      inclusive: true,
      total_paise: 118_000,
      provider_payment_id: "pay_kd",
    },
    ...over,
  });
}

describe("the kept-draft items (R1-03)", () => {
  it("★★ names the item, gives the hint and shows the note that names both rates", () => {
    render(
      <ReconciliationQueue items={[keptDraftItem()]} status="open" canManage />,
    );
    expect(
      screen.getByText("Invoice issued with the GST it was priced with"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/A payment had already fixed this invoice's total/),
    ).toBeInTheDocument();
    expect(screen.getByText(KEPT_NOTE)).toBeInTheDocument();
    expect(screen.queryByText("State conflict")).toBeNull();
    expect(screen.queryByText(/What was bought/)).toBeNull();
  });

  it("★ opens the store and offers Issue a refund with no reason chosen", async () => {
    billing.issueRefund.mockResolvedValue({
      success: true,
      refundId: "ref-kd",
      status: "pending",
    });
    render(
      <ReconciliationQueue items={[keptDraftItem()]} status="open" canManage />,
    );
    expect(
      screen.getByRole("link", { name: "Open the store" }).getAttribute("href"),
    ).toBe("/dashboard/stores/store-1");
    fireEvent.click(screen.getByRole("button", { name: "Issue a refund" }));
    const reason = screen.getByLabelText("Reason") as HTMLSelectElement;
    expect(reason.value).toBe("");
    expect(Array.from(reason.options).map((o) => o.value)).not.toContain(
      "cycle_not_reached",
    );
  });

  it("a member can open the store and is told who refunds", () => {
    render(<ReconciliationQueue items={[keptDraftItem()]} status="open" />);
    expect(screen.getByRole("link", { name: "Open the store" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Issue a refund" })).toBeNull();
    expect(
      screen.getByText(
        "Only a platform superadmin can issue or record a refund.",
      ),
    ).toBeInTheDocument();
  });

  it("with no payment on the item, only the store link shows", () => {
    render(
      <ReconciliationQueue
        items={[keptDraftItem({ attemptId: null })]}
        status="open"
        canManage
      />,
    );
    expect(screen.getByRole("link", { name: "Open the store" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Issue a refund" })).toBeNull();
  });
});
