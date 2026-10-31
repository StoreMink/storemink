import { describe, expect, it } from "vitest";
import {
  MAX_HIGHLIGHT_TERMS,
  highlightParts,
  highlightTerms,
} from "./highlight";

function join(parts: { text: string }[]) {
  return parts.map((part) => part.text).join("");
}

describe("highlightTerms", () => {
  it("keeps the words worth marking and drops short common ones", () => {
    expect(highlightTerms("How do I connect my domain?")).toEqual([
      "connect",
      "domain",
    ]);
  });

  it("puts longer words first so a word is marked whole", () => {
    expect(highlightTerms("domain domains")).toEqual(["domains", "domain"]);
  });

  it("ignores repeats whatever their case", () => {
    expect(highlightTerms("GST gst Gst invoice")).toEqual(["invoice", "GST"]);
  });

  it("reads words in any script", () => {
    expect(highlightTerms("डोमेन कैसे जोड़ें")).toEqual([
      "जोड़ें",
      "डोमेन",
      "कैसे",
    ]);
  });

  it("marks at most six words", () => {
    const terms = highlightTerms("aa bb cc dd ee ff gg hh");
    expect(terms).toHaveLength(MAX_HIGHLIGHT_TERMS);
  });

  it("returns nothing for an empty search", () => {
    expect(highlightTerms("  ?! ")).toEqual([]);
  });
});

describe("highlightParts", () => {
  it("marks every match ignoring case and gives the text back whole", () => {
    const text = "Which plans include a Custom Domain? A domain costs extra.";
    const parts = highlightParts(text, ["domain"]);
    expect(join(parts)).toBe(text);
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual(
      ["Domain", "domain"],
    );
  });

  it("marks a word inside a longer one", () => {
    const parts = highlightParts("Connect domains", ["domain"]);
    expect(parts).toEqual([
      { text: "Connect ", match: false },
      { text: "domain", match: true },
      { text: "s", match: false },
    ]);
  });

  it("treats the search's characters literally", () => {
    const parts = highlightParts("Price (with GST) is ₹1,000", ["(with"]);
    expect(parts.find((part) => part.match)?.text).toBe("(with");
    expect(join(parts)).toBe("Price (with GST) is ₹1,000");
  });

  it("leaves text alone when there is nothing to mark", () => {
    expect(highlightParts("Shipping rates", [])).toEqual([
      { text: "Shipping rates", match: false },
    ]);
    expect(highlightParts("", ["x"])).toEqual([]);
  });
});
