import { describe, expect, it } from "vitest";
import {
  createLongDashRewriter,
  hasLongDash,
  withoutLongDashes,
} from "./long-dashes";

describe("withoutLongDashes", () => {
  it("turns a dash between words into a comma and a number range into 'to'", () => {
    expect(withoutLongDashes("Cold pressed — our own facility")).toBe(
      "Cold pressed, our own facility",
    );
    expect(withoutLongDashes("Ships in 2–4 days")).toBe("Ships in 2 to 4 days");
    expect(withoutLongDashes("Price ₹200—₹400")).toBe("Price ₹200 to ₹400");
  });

  it("never leaves doubled punctuation behind", () => {
    expect(withoutLongDashes("Fresh oil —.")).toBe("Fresh oil.");
  });
});

/** Run a text through the rewriter in the given fragments. */
function rewrite(fragments: string[]): string {
  const rewriter = createLongDashRewriter();
  let out = "";
  for (const fragment of fragments) out += rewriter.push(fragment);
  return out + rewriter.finish();
}

const SAMPLES = [
  "you can review all changes—including the new category—and apply them.",
  "Delivery in 2—4 days, 10% — 20% off, ₹500 – ₹1,000 and done.",
  "Wait, — really. Done —. — Signed\nLine two —\nLine three",
  "- **Look**—off-white\n| a | b |\n## Heading — sub",
  "Price $—$5 and costs $ 5, , ok —, fine",
  "ਸ਼ੁੱਧ — ਕੱਚੀ —",
  "trailing dash at end —",
  "Cold-pressed mustard oil, 1 L.",
];

describe("createLongDashRewriter", () => {
  it("sends exactly the cleaned whole, wherever the text is split", () => {
    for (const text of SAMPLES) {
      const expected = withoutLongDashes(text);
      for (let i = 0; i <= text.length; i++) {
        expect(rewrite([text.slice(0, i), text.slice(i)])).toBe(expected);
      }
      expect(rewrite([...text])).toBe(expected);
    }
  });

  it("survives random fragmenting (deterministic seed)", () => {
    let seed = 11;
    const random = () =>
      (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 2_000; n++) {
      const text = SAMPLES[Math.floor(random() * SAMPLES.length)];
      const fragments: string[] = [];
      for (let i = 0; i < text.length; ) {
        const size = 1 + Math.floor(random() * 6);
        fragments.push(text.slice(i, i + size));
        i += size;
      }
      expect(rewrite(fragments)).toBe(withoutLongDashes(text));
    }
  });

  it("holds back a range until the next fragment settles it", () => {
    const rewriter = createLongDashRewriter();
    expect(rewriter.push("Delivery takes 2")).toBe("Delivery takes 2");
    expect(rewriter.push("–")).toBe("");
    expect(rewriter.push("4 days.")).toBe(" to 4 days.");
    expect(rewriter.finish()).toBe("");
  });

  it("leaves text without a long dash unchanged", () => {
    const text = "Cold-pressed mustard oil, 1 L.";
    expect(hasLongDash(text)).toBe(false);
    expect(rewrite([text])).toBe(text);
  });
});
