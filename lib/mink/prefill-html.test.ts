import { describe, expect, it } from "vitest";
import { escapeMinkText, minkPrefillBodyToHtml } from "./prefill-html";

describe("minkPrefillBodyToHtml", () => {
  it("turns blank-line-separated text into paragraphs", () => {
    expect(minkPrefillBodyToHtml("First para.\n\nSecond para.")).toBe(
      "<p>First para.</p><p>Second para.</p>",
    );
  });

  it("keeps a single line break inside a paragraph", () => {
    expect(minkPrefillBodyToHtml("Line one\nline two")).toBe(
      "<p>Line one<br>line two</p>",
    );
  });

  it("makes a leading # or ## line a heading", () => {
    expect(minkPrefillBodyToHtml("# Why oat milk\n\nIt froths.")).toBe(
      "<h2>Why oat milk</h2><p>It froths.</p>",
    );
    expect(minkPrefillBodyToHtml("## Steps\nMix well.")).toBe(
      "<h2>Steps</h2><p>Mix well.</p>",
    );
  });

  it("makes dash lines a bullet list", () => {
    expect(
      minkPrefillBodyToHtml("What you need:\n- oats\n- water\n\nBlend."),
    ).toBe(
      "<p>What you need:</p><ul><li>oats</li><li>water</li></ul><p>Blend.</p>",
    );
    expect(minkPrefillBodyToHtml("* one\n* two")).toBe(
      "<ul><li>one</li><li>two</li></ul>",
    );
  });

  it("escapes HTML so markup in the text stays text", () => {
    expect(minkPrefillBodyToHtml('<script>alert("x")</script> & co')).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co</p>",
    );
    expect(minkPrefillBodyToHtml("- <b>bold</b>")).toBe(
      "<ul><li>&lt;b&gt;bold&lt;/b&gt;</li></ul>",
    );
    expect(escapeMinkText("it's")).toBe("it&#39;s");
  });

  it("normalises Windows line endings and surrounding whitespace", () => {
    expect(minkPrefillBodyToHtml("  \r\nHello\r\n\r\nWorld\r\n ")).toBe(
      "<p>Hello</p><p>World</p>",
    );
    expect(minkPrefillBodyToHtml("   ")).toBe("");
  });
});
