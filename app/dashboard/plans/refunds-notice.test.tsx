// @vitest-environment jsdom
// The "Refunds" notice on Plans & Billing (renewal-cancel, design 8.6).
//
// What a merchant reads about money StoreMink owes or has returned: one line
// per payment, in plain words, with the credit note once the refund reached
// them. It renders nothing at all when there is nothing to say.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RecentRefund } from "@/lib/billing/invoice-history";

vi.mock("../lib/access", () => ({
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/billing/invoice-history", () => ({
  listRecentRefunds: vi.fn(async () => []),
}));

import {
  RefundsNotice,
  RefundsNoticeList,
  refundNoticeLine,
} from "./refunds-notice";
import { listRecentRefunds } from "@/lib/billing/invoice-history";

function refund(over: Partial<RecentRefund> = {}): RecentRefund {
  return {
    id: "ref-1",
    attemptId: "att-1",
    invoiceId: "inv-1",
    invoiceRef: "SM/2026-27/00042",
    reason: "cycle_not_reached",
    status: "processed",
    method: "razorpay",
    amountPaise: 240_000,
    createdAt: "2026-10-30T06:00:00.000Z",
    resolvedAt: "2026-10-30T06:05:00.000Z",
    creditNote: { id: "cn-1", ref: "CN/2026-27/00001" },
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(listRecentRefunds).mockImplementation(async () => []);
});

describe("refundNoticeLine", () => {
  it("words each status", () => {
    expect(refundNoticeLine(refund({ status: "owed" }))).toBe(
      "Being prepared.",
    );
    expect(refundNoticeLine(refund({ status: "pending" }))).toBe("On its way.");
    expect(refundNoticeLine(refund({ status: "processed" }))).toBe(
      "Refunded on 30 Oct 2026. It goes back to the account or card you paid with.",
    );
    expect(
      refundNoticeLine(refund({ status: "recorded", method: "bank_transfer" })),
    ).toBe("Refunded on 30 Oct 2026 by bank transfer.");
    expect(
      refundNoticeLine(refund({ status: "recorded", method: "razorpay" })),
    ).toBe(
      "Refunded on 30 Oct 2026. It goes back to the account or card you paid with.",
    );
    expect(refundNoticeLine(refund({ status: "failed" }))).toBe(
      "We couldn't send this refund automatically. Our team will contact you about it.",
    );
    expect(refundNoticeLine(refund({ status: "cancelled" }))).toBe(
      "Not sent. Write to support@storemink.com if you have a question about it.",
    );
  });

  it("dates the refund in India time, and leaves the date out when there is none", () => {
    // 20:00 UTC on 31 Oct is 1 Nov in Kolkata.
    expect(
      refundNoticeLine(refund({ resolvedAt: "2026-10-31T20:00:00.000Z" })),
    ).toBe(
      "Refunded on 1 Nov 2026. It goes back to the account or card you paid with.",
    );
    expect(
      refundNoticeLine(
        refund({
          status: "recorded",
          method: "bank_transfer",
          resolvedAt: null,
        }),
      ),
    ).toBe("Refunded by bank transfer.");
    expect(refundNoticeLine(refund({ resolvedAt: null }))).toBe(
      "Refunded. It goes back to the account or card you paid with.",
    );
  });

  it("never promises an email or a number of days", () => {
    for (const status of [
      "owed",
      "pending",
      "processed",
      "recorded",
      "failed",
      "cancelled",
    ] as const) {
      const line = refundNoticeLine(refund({ status }));
      expect(line).not.toMatch(/email|working day/i);
    }
  });
});

describe("RefundsNoticeList", () => {
  it("★ renders nothing when nothing is owed or returned", () => {
    const { container } = render(<RefundsNoticeList refunds={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("heading", { name: "Refunds" })).toBeNull();
  });

  it("shows each refund with its amount, invoice and line", () => {
    render(
      <RefundsNoticeList
        refunds={[
          refund(),
          refund({
            id: "ref-2",
            attemptId: "att-2",
            status: "owed",
            amountPaise: 150_050,
            invoiceRef: "SM/2026-27/00043",
            creditNote: null,
          }),
        ]}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Refunds" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("₹2,400 for invoice SM/2026-27/00042"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("₹1,500.50 for invoice SM/2026-27/00043"),
    ).toBeInTheDocument();
    expect(screen.getByText("Being prepared.")).toBeInTheDocument();
  });

  it("links the credit note once the refund reached the merchant", () => {
    render(<RefundsNoticeList refunds={[refund()]} />);
    expect(
      screen.getByRole("link", { name: "Credit note CN/2026-27/00001" }),
    ).toHaveAttribute("href", "/dashboard/plans/credit-notes/cn-1");
  });

  it("does not offer a credit note for a refund that has not reached them", () => {
    render(
      <RefundsNoticeList
        refunds={[
          refund({ status: "failed" }),
          refund({ id: "ref-2", attemptId: "att-2", status: "owed" }),
        ]}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("an invoice with no number still names the amount", () => {
    render(<RefundsNoticeList refunds={[refund({ invoiceRef: null })]} />);
    expect(screen.getByText("₹2,400")).toBeInTheDocument();
  });

  it("says nothing about Mink credits", () => {
    const { container } = render(<RefundsNoticeList refunds={[refund()]} />);
    expect(container.textContent).not.toMatch(/credits?\b(?! note)/i);
  });
});

describe("RefundsNotice", () => {
  it("reads the refunds with the store from the session", async () => {
    vi.mocked(listRecentRefunds).mockImplementation(async () => [refund()]);
    render(await RefundsNotice());
    expect(listRecentRefunds).toHaveBeenCalledWith("store-1");
    expect(
      screen.getByRole("heading", { name: "Refunds" }),
    ).toBeInTheDocument();
  });

  it("renders nothing when the store has no recent refunds", async () => {
    const { container } = render(await RefundsNotice());
    expect(container).toBeEmptyDOMElement();
  });
});
