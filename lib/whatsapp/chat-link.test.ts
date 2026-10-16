import { describe, expect, it } from "vitest";
import { whatsAppChatLink, whatsAppDigits } from "./chat-link";

describe("whatsAppChatLink", () => {
  it("is Meta's click-to-chat scheme with a prefilled greeting", () => {
    expect(whatsAppChatLink("+91 98765 43210", "Echos")).toBe(
      "https://wa.me/919876543210?text=Hi%20Echos%2C%20I%20have%20a%20question.",
    );
  });
  it("digits only, country code first, no plus", () => {
    expect(whatsAppDigits("+91 98765-43210")).toBe("919876543210");
  });
  it("null when there is no number to link", () => {
    expect(whatsAppChatLink(null)).toBeNull();
    expect(whatsAppChatLink("12345")).toBeNull();
  });
  it("a generic greeting without a store name", () => {
    expect(whatsAppChatLink("+919876543210", "  ")).toContain(
      encodeURIComponent("Hi, I have a question."),
    );
  });
});
