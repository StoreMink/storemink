import { describe, expect, it } from "vitest";
import {
  fillCannedReply,
  inboxSearchQuery,
  splitSnippet,
  validateCannedReply,
  validateInboxLabel,
} from "./inbox-workspace";

describe("validateInboxLabel", () => {
  it("trims, bounds the name and falls back to grey", () => {
    expect(validateInboxLabel({ name: "  VIP  ", color: "purple" })).toEqual({
      ok: true,
      name: "VIP",
      color: "purple",
    });
    expect(validateInboxLabel({ name: "Wholesale", color: "neon" })).toEqual({
      ok: true,
      name: "Wholesale",
      color: "grey",
    });
    expect(validateInboxLabel({ name: "   ", color: "red" }).ok).toBe(false);
    expect(validateInboxLabel({ name: "x".repeat(31), color: "red" }).ok).toBe(
      false,
    );
    expect(validateInboxLabel({ name: "two\nlines", color: "red" }).ok).toBe(
      false,
    );
  });
});

describe("validateCannedReply", () => {
  it("normalises the shortcut and refuses one it cannot type after a slash", () => {
    const ok = validateCannedReply({
      shortcut: " /Hours ",
      title: "Opening hours",
      body: "We are open 10 to 7.\r\n",
    });
    expect(ok).toEqual({
      ok: true,
      shortcut: "hours",
      title: "Opening hours",
      body: "We are open 10 to 7.",
    });
    for (const shortcut of ["", "-start", "has space", "x".repeat(31), "é"]) {
      expect(
        validateCannedReply({ shortcut, title: "t", body: "b" }).ok,
        shortcut,
      ).toBe(false);
    }
    expect(
      validateCannedReply({ shortcut: "a", title: "", body: "b" }).ok,
    ).toBe(false);
    expect(
      validateCannedReply({ shortcut: "a", title: "t", body: "  " }).ok,
    ).toBe(false);
    expect(
      validateCannedReply({ shortcut: "a", title: "t", body: "x".repeat(4097) })
        .ok,
    ).toBe(false);
  });
});

describe("fillCannedReply", () => {
  it("fills the first name and drops the token cleanly when there is none", () => {
    expect(
      fillCannedReply("Hi {{name}}, thanks!", { name: "Rohan Sharma" }),
    ).toBe("Hi Rohan, thanks!");
    expect(fillCannedReply("Hi {{ name }},", { name: null })).toBe("Hi,");
    expect(fillCannedReply("Hi {{name}}", { name: "  " })).toBe("Hi");
    // An unknown token stays visible rather than vanishing.
    expect(fillCannedReply("Order {{order}}", { name: "A" })).toBe(
      "Order {{order}}",
    );
  });
});

describe("inboxSearchQuery", () => {
  it("builds a prefix query of required words and strips anything that is not a letter or digit", () => {
    expect(inboxSearchQuery("almond shake")).toBe("almond:* & shake:*");
    expect(inboxSearchQuery("  Stoc  ")).toBe("stoc:*");
    expect(inboxSearchQuery("a & b | !c")).toBe(null);
    expect(inboxSearchQuery("stock) | (refund")).toBe("stock:* & refund:*");
    expect(inboxSearchQuery("ऑर्डर")).toBe("ऑर्डर:*");
    expect(inboxSearchQuery("")).toBe(null);
    expect(inboxSearchQuery("one two three four five six seven")).toBe(
      "one:* & two:* & three:* & four:* & five:* & six:*",
    );
  });
});

describe("splitSnippet", () => {
  it("separates the marked words from the rest", () => {
    expect(splitSnippet("is the «almond» shake in «stock»?")).toEqual([
      { text: "is the ", hit: false },
      { text: "almond", hit: true },
      { text: " shake in ", hit: false },
      { text: "stock", hit: true },
      { text: "?", hit: false },
    ]);
    expect(splitSnippet("plain")).toEqual([{ text: "plain", hit: false }]);
  });
});
