import { describe, it, expect, vi, beforeEach } from "vitest";

const sendEmail = vi.fn();
vi.mock("./send", () => ({ sendEmail: (i: unknown) => sendEmail(i) }));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrandById: vi.fn(async () => ({
    name: "Corner Store",
    logoUrl: null,
    primaryColor: "#2f6f4e",
    tagline: null,
    blurb: null,
    legalName: null,
    creditLine: null,
    email: null,
    phone: null,
    hours: null,
    social: {},
    badges: [],
    domain: "cornerstore.example",
  })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

import {
  buildPosReceiptEmail,
  sendPosReceipt,
  shouldSendDirectReceipt,
} from "./pos-receipt";
import { getStoreBrandById } from "@/lib/store/brand";

const SUMMARY = {
  currency: "INR",
  items: [{ name: "Amul Taaza Toned Milk", quantity: 2, total: 118 }],
  subtotal: 118,
  total: 124,
};

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS.
  sendEmail.mockResolvedValue({ sent: true });
  vi.mocked(getStoreBrandById).mockResolvedValue({
    name: "Corner Store",
    primaryColor: "#2f6f4e",
    domain: "cornerstore.example",
    social: {},
    badges: [],
  } as never);
});

// ---------------------------------------------------------------------------
// ★ ONE RECEIPT, NEVER TWO. An attached customer with an address already gets
// an order confirmation from the order.placed fan-out; a second copy sent
// directly is the two-emails-for-one-action pattern §24 warns about.
// ---------------------------------------------------------------------------
describe("shouldSendDirectReceipt", () => {
  it("sends for a walk-in with no customer attached", () => {
    expect(
      shouldSendDirectReceipt({
        receiptEmail: "a@x.com",
        customerId: null,
        customerEmail: null,
      }),
    ).toBe(true);
  });

  it("does NOT send when the attached customer will get the fan-out's copy", () => {
    expect(
      shouldSendDirectReceipt({
        receiptEmail: "a@x.com",
        customerId: "cust-1",
        customerEmail: "cust@x.com",
      }),
    ).toBe(false);
  });

  // The fan-out resolves the address from their users row; with none there, it
  // queues nothing, so this is still the only receipt they will get.
  it("DOES send for an attached customer with no address on file", () => {
    expect(
      shouldSendDirectReceipt({
        receiptEmail: "a@x.com",
        customerId: "cust-1",
        customerEmail: null,
      }),
    ).toBe(true);
  });

  it.each([[null], [undefined], [""]])(
    "sends nothing when no address was asked for (%s)",
    (value) => {
      expect(
        shouldSendDirectReceipt({
          receiptEmail: value,
          customerId: null,
          customerEmail: null,
        }),
      ).toBe(false);
    },
  );
});

describe("sendPosReceipt", () => {
  const INPUT = {
    storeId: "store-1",
    to: "asha@example.com",
    orderRef: "ORD100110006",
    summary: SUMMARY,
    tenderLabels: ["Cash"],
    changeDue: 76,
  };

  it("sends through sendEmail, so it lands in email_logs", async () => {
    await sendPosReceipt(INPUT);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = sendEmail.mock.calls[0][0];
    expect(msg.to).toBe("asha@example.com");
    expect(msg.storeId).toBe("store-1");
    // The log's "what was this?" column.
    expect(msg.mailer).toBe("pos_receipt");
  });

  // ★ A merchant on their own sending domain would otherwise send from an
  // address Resend has no permission for, and every receipt would bounce.
  it("sends FROM the store's own domain, not a hardcoded one", async () => {
    await sendPosReceipt(INPUT);
    expect(sendEmail.mock.calls[0][0].from).toContain("cornerstore.example");
  });

  it("puts the order reference in the subject", async () => {
    await sendPosReceipt(INPUT);
    expect(sendEmail.mock.calls[0][0].subject).toBe(
      "Your receipt for ORD100110006",
    );
  });

  // The send is a thin wrapper: what goes out is exactly what the pure builder
  // renders, so the gallery and the CI guard check the real message.
  it("sends exactly what buildPosReceiptEmail renders", async () => {
    await sendPosReceipt({ ...INPUT, locationName: "Indiranagar" });
    const msg = sendEmail.mock.calls[0][0];
    const built = buildPosReceiptEmail({
      brand: (await vi.mocked(getStoreBrandById).mock.results[0]
        .value) as never,
      orderRef: INPUT.orderRef,
      locationName: "Indiranagar",
      summary: SUMMARY,
      tenderLabels: INPUT.tenderLabels,
      changeDue: INPUT.changeDue,
    });
    expect(msg.subject).toBe(built.subject);
    // Rendered in the same run, so even the footer's year matches.
    expect(msg.html).toBe(built.html);
  });

  it("sends from the store's Receipts address", async () => {
    await sendPosReceipt(INPUT);
    expect(sendEmail.mock.calls[0][0].from).toBe(
      "Corner Store Receipts <admin@cornerstore.example>",
    );
  });

  it("renders what they bought, what they paid with, and their change", async () => {
    await sendPosReceipt(INPUT);
    const html = sendEmail.mock.calls[0][0].html as string;
    expect(html).toContain("Amul Taaza Toned Milk");
    expect(html).toContain("Cash");
    expect(html).toMatch(/Change given/);
  });

  it("omits the change row when there is none", async () => {
    await sendPosReceipt({ ...INPUT, changeDue: 0 });
    expect(sendEmail.mock.calls[0][0].html).not.toMatch(/Change given/);
  });

  it("names the shop when one is given", async () => {
    await sendPosReceipt({ ...INPUT, locationName: "Indiranagar" });
    expect(sendEmail.mock.calls[0][0].html).toContain("Indiranagar");
  });

  // A customer named `<script>` must not become markup in someone's inbox.
  it("escapes what it renders", async () => {
    await sendPosReceipt({
      ...INPUT,
      locationName: "<script>alert(1)</script>",
    });
    const html = sendEmail.mock.calls[0][0].html as string;
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  // ★ NEVER THROWS. The money is already taken and the stock already moved;
  // the customer is holding the printed copy either way.
  it("swallows a mailer failure rather than failing the sale", async () => {
    sendEmail.mockRejectedValue(new Error("resend down"));
    await expect(sendPosReceipt(INPUT)).resolves.toBeUndefined();
  });

  it("swallows a failure to load the brand", async () => {
    vi.mocked(getStoreBrandById).mockRejectedValue(new Error("db down"));
    await expect(sendPosReceipt(INPUT)).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The pure builder: what the customer actually reads.
// ---------------------------------------------------------------------------
describe("buildPosReceiptEmail", () => {
  const BRAND = {
    name: "Corner Store",
    logoUrl: null,
    primaryColor: "#2f6f4e",
    tagline: null,
    blurb: null,
    legalName: null,
    creditLine: null,
    email: null,
    phone: null,
    hours: null,
    social: { instagram: null, youtube: null, whatsapp: null },
    badges: [],
    domain: "cornerstore.example",
  };
  const BASE = {
    brand: BRAND,
    orderRef: "ORD10010004",
    summary: SUMMARY,
    tenderLabels: ["Cash", "UPI"],
    changeDue: 13,
  };

  it("wears the standard frame with a Receipt eyebrow", () => {
    const { html } = buildPosReceiptEmail(BASE);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('class="sm-email-canvas"');
    expect(html).toMatch(/>Receipt<\/p>/);
  });

  it("thanks them for shopping at the shop when the till knows it", () => {
    const { html } = buildPosReceiptEmail({
      ...BASE,
      locationName: "Connaught Place",
    });
    expect(html).toContain("Thanks for shopping at Connaught Place</h1>");
    // A branch name alone does not say who sold it, so the lead does.
    expect(html).toContain("Here's your receipt from Corner Store.");
  });

  it("thanks them by store name when there is no location", () => {
    const { html } = buildPosReceiptEmail({ ...BASE, locationName: null });
    expect(html).toContain("Thanks for shopping with Corner Store</h1>");
  });

  it("lists the reference, the tenders and the change", () => {
    const { html } = buildPosReceiptEmail(BASE);
    expect(html).toContain("ORD10010004");
    expect(html).toContain("Cash + UPI");
    expect(html).toContain("Change given");
    expect(html).toContain("₹13.00");
    expect(html).toContain("Amul Taaza Toned Milk");
    expect(html).toContain("copy of your in-store receipt");
  });

  it.each([[0], [null], [undefined], [-5], [Number.NaN]])(
    "omits the change row for %s",
    (changeDue) => {
      const { html } = buildPosReceiptEmail({ ...BASE, changeDue });
      expect(html).not.toContain("Change given");
    },
  );

  it("omits the tender row when none was recorded", () => {
    const { html } = buildPosReceiptEmail({ ...BASE, tenderLabels: ["", " "] });
    expect(html).not.toContain("Paid with");
  });

  it("puts the store, reference and total in the inbox preview", () => {
    const { html } = buildPosReceiptEmail(BASE);
    expect(html).toContain(
      "Your receipt from Corner Store for ORD10010004, total ₹124.00",
    );
  });

  it("escapes every value it renders", () => {
    const { html } = buildPosReceiptEmail({
      ...BASE,
      brand: { ...BRAND, name: "<b>Shop</b>" },
      locationName: "<script>alert(1)</script>",
      orderRef: '"><img src=x>',
      tenderLabels: ["<i>Card</i>"],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<b>Shop</b>");
    expect(html).not.toContain('"><img src=x>');
    expect(html).not.toContain("<i>Card</i>");
    expect(html).toContain("&lt;script&gt;");
  });

  // One neutral design: a merchant hue never reaches the email.
  it("carries no merchant brand colour", () => {
    const { html } = buildPosReceiptEmail(BASE);
    expect(html.toLowerCase()).not.toContain("#2f6f4e");
  });

  it("has no long dash anywhere", () => {
    for (const locationName of ["Connaught Place", null]) {
      const { subject, html } = buildPosReceiptEmail({
        ...BASE,
        locationName,
      });
      expect(subject).not.toMatch(/[\u2013\u2014]/);
      expect(html).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
