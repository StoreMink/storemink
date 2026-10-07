import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  mergeTokens,
  renderCouponEmail,
  renderCouponEmailBody,
  withoutLongDashes,
  type CouponEmailContent,
} from "./coupon-campaign";

// escapeHtml() is the guard that runs on every AI/hand-written value before it
// is interpolated into email HTML: it's the only thing standing between a
// malicious body and an injected <script> in someone's inbox.
describe("escapeHtml", () => {
  // Each of the five HTML-significant characters must be entity-encoded.
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#39;");
  });

  // Ampersand MUST be replaced first, otherwise the &lt; / &amp; entities it
  // emits for the other chars would themselves get double-escaped.
  it("escapes ampersand first so entities aren't double-escaped", () => {
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("a & b < c")).toBe("a &amp; b &lt; c");
    // The literal text "&lt;" must survive as a visible &amp;lt;, proving the
    // & got handled before any < would have produced a fresh entity.
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  // A full attack string round-trips into harmless escaped text.
  it("neutralises a script tag", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });

  // Plain text with none of the special characters is returned unchanged.
  it("leaves safe text unchanged", () => {
    expect(escapeHtml("Hello there, friend 123")).toBe(
      "Hello there, friend 123",
    );
    expect(escapeHtml("")).toBe("");
  });
});

// mergeTokens() resolves the per-recipient {{first_name}} / {{name}} merge tag.
describe("mergeTokens", () => {
  // The canonical tag, plus the {{name}} alias, both resolve.
  it("replaces {{first_name}} and {{name}}", () => {
    expect(mergeTokens("Hi {{first_name}}!", "Ada")).toBe("Hi Ada!");
    expect(mergeTokens("Hi {{name}}!", "Ada")).toBe("Hi Ada!");
  });

  // Whitespace inside the braces is tolerated (copy-paste / formatting slips).
  it("tolerates whitespace inside the braces", () => {
    expect(mergeTokens("Hi {{ first_name }}!", "Ada")).toBe("Hi Ada!");
    expect(mergeTokens("Hi {{  name  }}!", "Ada")).toBe("Hi Ada!");
  });

  // The token match is case-insensitive.
  it("matches the token case-insensitively", () => {
    expect(mergeTokens("Hi {{FIRST_NAME}}", "Ada")).toBe("Hi Ada");
    expect(mergeTokens("Hi {{First_Name}}", "Ada")).toBe("Hi Ada");
    expect(mergeTokens("Hi {{Name}}", "Ada")).toBe("Hi Ada");
  });

  // Empty / whitespace-only names fall back to the friendly "there" default so
  // nobody gets a "Hi !" greeting.
  it("falls back to 'there' for empty / whitespace first names", () => {
    expect(mergeTokens("Hi {{first_name}}", "")).toBe("Hi there");
    expect(mergeTokens("Hi {{first_name}}", "   ")).toBe("Hi there");
  });

  // A real name is trimmed of surrounding whitespace.
  it("trims surrounding whitespace from the name", () => {
    expect(mergeTokens("Hi {{first_name}}", "  Ada  ")).toBe("Hi Ada");
  });

  // Every occurrence in the string is replaced (global flag), not just the first.
  it("replaces every occurrence", () => {
    expect(mergeTokens("{{first_name}} {{name}} {{first_name}}", "Ada")).toBe(
      "Ada Ada Ada",
    );
  });

  // Text with no token at all is returned untouched.
  it("leaves text with no token unchanged", () => {
    expect(mergeTokens("No tokens here", "Ada")).toBe("No tokens here");
    // A non-matching token name is left as-is.
    expect(mergeTokens("Hi {{last_name}}", "Ada")).toBe("Hi {{last_name}}");
  });

  // A name is inserted as typed: "$&" and "$`" are replacement-string
  // patterns, and must not expand into the token or the text before it.
  it("inserts a name containing $ patterns literally", () => {
    expect(mergeTokens("Hi {{first_name}}!", "$&")).toBe("Hi $&!");
    expect(mergeTokens("Hi {{first_name}}!", "A$`B")).toBe("Hi A$`B!");
  });
});

// withoutLongDashes() cleans the AI coupon draft before a merchant sees it.
describe("withoutLongDashes", () => {
  it("turns a number range into 'to'", () => {
    expect(withoutLongDashes("2\u20134 paragraphs")).toBe("2 to 4 paragraphs");
    expect(withoutLongDashes("10% \u2014 20% off")).toBe("10% to 20% off");
    expect(withoutLongDashes("\u20b9500 \u2013 \u20b91,000")).toBe(
      "\u20b9500 to \u20b91,000",
    );
  });

  it("turns any other dash into a comma", () => {
    expect(withoutLongDashes("A treat \u2014 just for you")).toBe(
      "A treat, just for you",
    );
    expect(withoutLongDashes("word\u2014word")).toBe("word, word");
  });

  it("tidies the punctuation a dash leaves behind", () => {
    // Dash at the end of a line keeps the comma, without a trailing space.
    expect(withoutLongDashes("Hi {{first_name}} \u2014\n\nNews.")).toBe(
      "Hi {{first_name}},\n\nNews.",
    );
    // No ", ," or ", ." pairs, and nothing dangling at the start of a line.
    expect(withoutLongDashes("Wait, \u2014 really")).toBe("Wait, really");
    expect(withoutLongDashes("Done \u2014.")).toBe("Done.");
    expect(withoutLongDashes("\u2014 Signed")).toBe("Signed");
  });

  it("leaves dash-free text untouched", () => {
    const text = "Hi {{first_name}},\n\nA gift: 20% off. Shop - now.";
    expect(withoutLongDashes(text)).toBe(text);
  });
});

// Base content used by the render tests; spread + override per case.
const base: CouponEmailContent = {
  body: "Hi {{first_name}},\n\nEnjoy your gift.",
  firstName: "Ada",
  code: "SAVE20",
  discountLabel: "20% OFF",
  validUntilLabel: "31 Dec 2026",
  brand: {
    name: "WholeSip",
    logoUrl: null,
    primaryColor: "#000000",
    tagline: null,
    blurb: null,
    legalName: null,
    creditLine: null,
    email: null,
    phone: null,
    hours: null,
    social: { instagram: null, youtube: null, whatsapp: null },
    badges: [],
    domain: "wholesip.com",
  },
};

// renderCouponEmailBody() builds the inner HTML: escaped + merged paragraphs,
// the coupon card, and the sign-off, before the standard frame goes round it.

// Body paragraphs are emailParagraph() output, which opens with this style.
const BODY_PARA = /<p style="margin:0 0 16px;/g;
describe("renderCouponEmailBody", () => {
  // The headline security property: markup in the body is escaped, never raw.
  it("escapes injected markup in the body", () => {
    const out = renderCouponEmailBody({
      ...base,
      body: "<script>alert(1)</script>",
    });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  // The merge tag is resolved inside the rendered body.
  it("merges the recipient's first name", () => {
    const out = renderCouponEmailBody(base);
    expect(out).toContain("Hi Ada,");
  });

  // The name is what the shopper typed at signup, so it is escaped too: it is
  // spliced in after the copy is escaped, and must not become a live link.
  it("escapes markup in the recipient's first name", () => {
    const out = renderCouponEmailBody({
      ...base,
      firstName: '<a href="javascript:alert(1)">x</a>',
    });
    expect(out).not.toContain("<a href");
    expect(out).toContain(
      "Hi &lt;a href=&quot;javascript:alert(1)&quot;&gt;x&lt;/a&gt;,",
    );
  });

  // An apostrophe in a real name is encoded once, not twice.
  it("encodes an apostrophe in a name exactly once", () => {
    const out = renderCouponEmailBody({ ...base, firstName: "D'Arcy" });
    expect(out).toContain("Hi D&#39;Arcy,");
    expect(out).not.toContain("&amp;#39;");
  });

  // Blank-line-separated blocks become separate <p> paragraphs.
  it("splits blank-line-separated blocks into separate paragraphs", () => {
    const out = renderCouponEmailBody({
      ...base,
      body: "First para.\n\nSecond para.",
    });
    const paraCount = (out.match(BODY_PARA) || []).length;
    expect(paraCount).toBe(2);
    expect(out).toContain("First para.");
    expect(out).toContain("Second para.");
  });

  // A single newline inside a paragraph becomes a <br />, not a new <p>.
  it("turns a single newline into a <br />", () => {
    const out = renderCouponEmailBody({
      ...base,
      body: "Line one\nLine two",
    });
    expect(out).toContain("Line one<br />Line two");
    // Still a single paragraph block.
    const paraCount = (out.match(BODY_PARA) || []).length;
    expect(paraCount).toBe(1);
  });

  // The coupon code and discount label appear (HTML-escaped) in the coupon card.
  it("includes the escaped coupon code and discount label", () => {
    const out = renderCouponEmailBody({
      ...base,
      code: "A&B<20>",
      discountLabel: "Save <50%>",
    });
    expect(out).toContain("A&amp;B&lt;20&gt;");
    expect(out).toContain("Save &lt;50%&gt;");
  });

  // The "valid until" block is present (escaped) when a label is provided.
  it("includes the valid-until block when provided", () => {
    const out = renderCouponEmailBody(base);
    expect(out).toContain("Valid until 31 Dec 2026");
  });

  // ...and is omitted entirely when null or undefined.
  it("omits the valid-until block when null or undefined", () => {
    expect(
      renderCouponEmailBody({ ...base, validUntilLabel: null }),
    ).not.toContain("Valid until");
    expect(
      renderCouponEmailBody({ ...base, validUntilLabel: undefined }),
    ).not.toContain("Valid until");
  });

  // The brand sign-off is always present.
  it("signs off from the store's team", () => {
    const out = renderCouponEmailBody(base);
    expect(out).toContain("Warm regards,");
    expect(out).toContain("The WholeSip team");
  });

  // The code sits on a dashed white card in the monospaced face, so it reads
  // as a coupon rather than another paragraph.
  it("renders the code on a dashed card in the mono face", () => {
    const out = renderCouponEmailBody(base);
    expect(out).toMatch(/border:1\.5px dashed #[0-9a-f]{6}/);
    expect(out).toContain("SF Mono");
  });

  // An empty label is skipped rather than rendering an empty label row.
  it("omits the label row when the discount label is blank", () => {
    const out = renderCouponEmailBody({ ...base, discountLabel: "  " });
    expect(out).not.toContain("text-transform:uppercase");
    expect(out).toContain("SAVE20");
  });
});

// renderCouponEmail() composes the body through the standard frame
// (composeEmail runs for real: it's pure string building).
describe("renderCouponEmail", () => {
  // Produces a full HTML document and still contains the inner body content.
  it("wraps the body in the standard frame", () => {
    const out = renderCouponEmail(base);
    expect(out).toContain("<!DOCTYPE html>");
    expect(out).toContain('class="sm-email-canvas"');
    expect(out).toContain("The WholeSip team");
    expect(out).toContain("Hi Ada,");
    expect(out).toContain("SAVE20");
  });

  // The headline names the offer, and reads naturally for both label shapes
  // the product writes ("25% off" and "₹100 off").
  it("headlines the offer for percentage and amount labels", () => {
    expect(renderCouponEmail({ ...base, discountLabel: "25% off" })).toContain(
      "25% off, just for you</h1>",
    );
    expect(renderCouponEmail({ ...base, discountLabel: "₹100 off" })).toContain(
      "₹100 off, just for you</h1>",
    );
  });

  // A blank label gets no headline rather than one starting with a comma.
  it("drops the headline when the label is blank", () => {
    const out = renderCouponEmail({ ...base, discountLabel: "" });
    expect(out).not.toContain("<h1");
    expect(out).not.toContain(", just for you");
  });

  // The headline is escaped like everything else.
  it("escapes the label inside the headline", () => {
    const out = renderCouponEmail({ ...base, discountLabel: "<b>50%</b> off" });
    expect(out).not.toContain("<b>50%</b>");
    expect(out).toContain("&lt;b&gt;50%&lt;/b&gt; off, just for you");
  });

  // The inbox preview line is the opening of the merged copy, not markup.
  it("uses the merged copy as the preheader", () => {
    const out = renderCouponEmail(base);
    expect(out).toMatch(/opacity:0;[^>]*>Hi Ada, Enjoy your gift\./);
  });

  // The owner's copy rule: no em dash or en dash anywhere in the output.
  it("contains no long dash", () => {
    const out = renderCouponEmail({
      ...base,
      validUntilLabel: null,
    });
    expect(out).not.toMatch(/[\u2013\u2014]/);
    expect(renderCouponEmail(base)).not.toMatch(/[\u2013\u2014]/);
  });

  // A hostile name stays inert through the frame and the preheader.
  it("keeps a hostile first name escaped in the wrapped document", () => {
    const out = renderCouponEmail({
      ...base,
      firstName: '<a href="javascript:alert(1)">x</a>',
    });
    expect(out).not.toContain('<a href="javascript:');
  });

  // The escaping guarantee survives framing: no raw script reaches the doc.
  it("keeps injected markup escaped in the wrapped document", () => {
    const out = renderCouponEmail({
      ...base,
      body: "<script>alert(1)</script>",
    });
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
