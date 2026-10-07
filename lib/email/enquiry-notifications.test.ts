import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./send", () => ({ sendEmail: vi.fn(async () => undefined) }));

import type { StoreBrand } from "@/lib/store/brand";
import { sendEmail } from "./send";
import {
  buildEnquiryAcknowledgementEmail,
  sendEnquiryAcknowledgementEmail,
} from "./enquiry-notifications";

const brand: StoreBrand = {
  name: "Acme Juice",
  logoUrl: null,
  primaryColor: "#2f6b3a",
  tagline: null,
  blurb: null,
  legalName: null,
  creditLine: null,
  email: null,
  phone: null,
  hours: null,
  social: { instagram: null, youtube: null, whatsapp: null },
  badges: [],
  domain: "acmejuice.in",
};

const base = {
  name: "Priya",
  subject: "Bulk order",
  message: "Hi!\nCould you do 40 bottles?",
  brand,
};

describe("buildEnquiryAcknowledgementEmail", () => {
  it("names the enquiry in the subject when there is one", () => {
    expect(buildEnquiryAcknowledgementEmail(base).subject).toBe(
      'We received your enquiry: "Bulk order"',
    );
    expect(
      buildEnquiryAcknowledgementEmail({ ...base, subject: "   " }).subject,
    ).toBe("We received your enquiry");
    expect(
      buildEnquiryAcknowledgementEmail({ ...base, subject: null }).subject,
    ).toBe("We received your enquiry");
  });

  it("composes through the standard frame with the headline and sign-off", () => {
    const { html } = buildEnquiryAcknowledgementEmail(base);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('class="sm-email-canvas"');
    expect(html).toContain("Thanks for reaching out</h1>");
    expect(html).toContain("Hi Priya,");
    expect(html).toContain("The Acme Juice team");
    expect(html).toContain("1 to 2 business days");
  });

  it("quotes the message with its line breaks preserved", () => {
    const { html } = buildEnquiryAcknowledgementEmail(base);
    expect(html).toContain(
      'white-space:pre-wrap;">Hi!\nCould you do 40 bottles?</p>',
    );
    expect(html).toContain(">Bulk order</p>");
  });

  it("leaves the subject title out of the quote when there is none", () => {
    const { html } = buildEnquiryAcknowledgementEmail({
      ...base,
      subject: null,
    });
    expect(html).not.toContain(">Bulk order</p>");
    expect(html).toContain("Could you do 40 bottles?");
  });

  it("greets a shopper with no name without an empty name", () => {
    const { html } = buildEnquiryAcknowledgementEmail({ ...base, name: "  " });
    expect(html).toContain("Hi there,");
    expect(html).not.toContain("Hi ,");
  });

  it("escapes every shopper-supplied value", () => {
    const { html } = buildEnquiryAcknowledgementEmail({
      ...base,
      name: "<img src=x>",
      subject: "<b>urgent</b>",
      message: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("<b>urgent</b>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Hi &lt;img src=x&gt;,");
    expect(html).toContain("&lt;b&gt;urgent&lt;/b&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("contains no long dash in the subject or body", () => {
    for (const subject of ["Bulk order", null]) {
      const out = buildEnquiryAcknowledgementEmail({ ...base, subject });
      expect(out.subject).not.toMatch(/[–—]/);
      expect(out.html).not.toMatch(/[–—]/);
    }
  });
});

describe("sendEnquiryAcknowledgementEmail", () => {
  beforeEach(() => vi.mocked(sendEmail).mockClear());

  it("sends the built email from the store's address under the enquiry mailer", async () => {
    await sendEnquiryAcknowledgementEmail({
      ...base,
      to: "priya@example.com",
      storeId: "store-1",
    });
    const built = buildEnquiryAcknowledgementEmail(base);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(sendEmail).mock.calls[0][0];
    expect(sent).toMatchObject({
      storeId: "store-1",
      to: "priya@example.com",
      from: "Acme Juice <admin@acmejuice.in>",
      subject: built.subject,
      mailer: "enquiry_notification",
    });
    // The footer's year is the only part that could differ between two
    // renders, and both happen in the same test run.
    expect(sent.html).toBe(built.html);
  });

  it("defaults the store id to null", async () => {
    await sendEnquiryAcknowledgementEmail({ ...base, to: "p@example.com" });
    expect(vi.mocked(sendEmail).mock.calls[0][0].storeId).toBeNull();
  });
});
