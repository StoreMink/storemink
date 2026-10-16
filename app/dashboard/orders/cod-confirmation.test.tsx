// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CodConfirmationTag, codConfirmationLabel } from "./cod-confirmation";

describe("CodConfirmationTag", () => {
  it("names each answer", () => {
    expect(codConfirmationLabel("requested")).toBe(
      "Awaiting confirmation on WhatsApp",
    );
    expect(codConfirmationLabel("confirmed")).toBe("Confirmed on WhatsApp");
    expect(codConfirmationLabel("cancelled")).toBe("Cancelled on WhatsApp");
  });

  it("★ an automatic cancellation does not read as the customer cancelling", () => {
    expect(codConfirmationLabel("expired")).toBe("Not confirmed on WhatsApp");
  });

  // ★ Meta reported the message failed: the customer never saw the buttons,
  // so "Awaiting confirmation" would have the merchant wait for nothing.
  it("★ a message that never arrived says so, in the failure tone", () => {
    expect(codConfirmationLabel("undelivered")).toBe(
      "WhatsApp message not delivered",
    );
    render(<CodConfirmationTag value="undelivered" />);
    const tag = screen.getByText("WhatsApp message not delivered");
    expect(tag.className).toContain("text-rose-700");
  });

  it("no answer's label uses a long dash", () => {
    for (const value of [
      "requested",
      "confirmed",
      "cancelled",
      "expired",
      "undelivered",
    ]) {
      expect(codConfirmationLabel(value), value).not.toMatch(/[—–]/);
    }
  });

  it("★ renders nothing when the customer was never asked", () => {
    const { container } = render(<CodConfirmationTag value={null} />);
    expect(container.textContent).toBe("");
    expect(codConfirmationLabel("junk")).toBeNull();
  });

  it("renders the label", () => {
    render(<CodConfirmationTag value="confirmed" />);
    expect(screen.getByText("Confirmed on WhatsApp")).toBeTruthy();
  });
});
