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
