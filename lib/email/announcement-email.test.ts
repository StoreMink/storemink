import { describe, expect, it } from "vitest";
import { renderAnnouncementEmail } from "./announcement-email";
import { platformEmailBrand } from "./platform-brand";

// ---------------------------------------------------------------------------
// The platform announcement: StoreMink writing to its merchants. It wears
// StoreMink's own identity, opens with the subject as the headline, and always
// says why it arrived.
// ---------------------------------------------------------------------------

const BASE = {
  brand: platformEmailBrand(),
  subject: "Pick up in store is now live",
  bodyHtml:
    "<p>Shoppers can now collect online orders from your shop.</p><ul><li>Set a hold period</li><li>Hand over with a code</li></ul>",
  ctaLabel: "Turn it on",
  ctaUrl: "https://storemink.com/dashboard/locations",
  category: "feature" as const,
  preferencesUrl: "https://storemink.com/dashboard/settings/account",
  recipientName: "Priya",
};

describe("renderAnnouncementEmail", () => {
  it("keeps the subject exactly as written", () => {
    expect(renderAnnouncementEmail(BASE).subject).toBe(
      "Pick up in store is now live",
    );
  });

  it("wears the standard frame and StoreMink's own lockup", () => {
    const { html } = renderAnnouncementEmail(BASE);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('class="sm-email-canvas"');
    expect(html).toContain("storemink-mark.png");
    expect(html).toContain(">Mink</span>");
    expect(html).toContain("&copy; ");
    expect(html).toContain(" StoreMink</p>");
  });

  // The composer has a Subject and a free-form Body with no headline of its
  // own, so the subject becomes the serif headline.
  it("uses the subject as the headline", () => {
    const { html } = renderAnnouncementEmail(BASE);
    expect(html).toMatch(/<h1[^>]*>Pick up in store is now live<\/h1>/);
  });

  it("drops a leading heading that only repeats the subject", () => {
    const { html } = renderAnnouncementEmail({
      ...BASE,
      bodyHtml: "<h2>Pick up in store is now live!</h2><p>Details.</p>",
    });
    expect(html.match(/Pick up in store is now live/g)).toHaveLength(2); // <title> + <h1>
    expect(html).toContain("Details.");
  });

  it("keeps a leading heading that says something else", () => {
    const { html } = renderAnnouncementEmail({
      ...BASE,
      bodyHtml: "<h2>How it works</h2><p>Details.</p>",
    });
    expect(html).toMatch(/<h2[^>]*>How it works<\/h2>/);
  });

  // The old renderer forgot this: the body is now styled like every other
  // StoreMink email, not left as bare browser-default markup.
  it("styles the operator's paragraphs, lists and headings", () => {
    const { html } = renderAnnouncementEmail({
      ...BASE,
      bodyHtml:
        '<h3>What changes</h3><p>Copy.</p><ul><li>One</li></ul><a href="https://storemink.com">link</a>',
    });
    expect(html).toMatch(/<h3 style="[^"]+">What changes<\/h3>/);
    expect(html).toMatch(/<p style="[^"]+">Copy\.<\/p>/);
    expect(html).toMatch(/<ul style="[^"]+"><li style="[^"]+">One<\/li>/);
    expect(html).toMatch(/<a href="https:\/\/storemink\.com" style="[^"]+">/);
  });

  it("greets a named recipient and escapes the name", () => {
    expect(renderAnnouncementEmail(BASE).html).toContain("Hi Priya,");
    const { html } = renderAnnouncementEmail({
      ...BASE,
      recipientName: "<b>Eve</b>",
    });
    expect(html).toContain("Hi &lt;b&gt;Eve&lt;/b&gt;,");
    expect(html).not.toContain("<b>Eve</b>");
  });

  it("skips the greeting when there is no name", () => {
    const { html } = renderAnnouncementEmail({ ...BASE, recipientName: "  " });
    expect(html).not.toContain("Hi ");
  });

  // ★ Sanitized at render, not only at save.
  it("sanitizes the stored body", () => {
    const { html } = renderAnnouncementEmail({
      ...BASE,
      bodyHtml:
        '<p onclick="steal()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>',
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
  });

  it("renders the call to action as the near-black button", () => {
    const { html } = renderAnnouncementEmail(BASE);
    expect(html).toContain('href="https://storemink.com/dashboard/locations"');
    expect(html).toContain(">Turn it on</a>");
    expect(html).toContain("background-color:#141413");
  });

  it.each([
    ["no label", { ctaLabel: "  " }],
    ["no url", { ctaUrl: null }],
    ["an unsafe url", { ctaUrl: "javascript:alert(1)" }],
    ["a relative url", { ctaUrl: "/dashboard" }],
  ])("omits the button with %s", (_case, patch) => {
    const { html } = renderAnnouncementEmail({ ...BASE, ...patch });
    expect(html).not.toContain(">Turn it on</a>");
    expect(html).not.toContain("javascript:");
  });

  // ★ Feature mail honours consent and says where the preference lives.
  it("tells feature-mail readers why, with a link to their preferences", () => {
    const { html } = renderAnnouncementEmail(BASE);
    expect(html).toContain(">Product update</p>");
    expect(html).toContain("you opted in to product updates from StoreMink");
    expect(html).toMatch(
      /<a href="https:\/\/storemink\.com\/dashboard\/settings\/account"[^>]*>Change what you get emailed about<\/a>/,
    );
  });

  // Operational mail is not opt-out-able, so it must not pretend to be.
  it("offers no preferences link on operational mail", () => {
    const { html } = renderAnnouncementEmail({
      ...BASE,
      category: "operational",
    });
    expect(html).toContain(">Service notice</p>");
    expect(html).toContain("This is a service notice about your store");
    expect(html).not.toContain("Change what you get emailed about");
    expect(html).not.toContain("dashboard/settings/account");
  });

  it("drops an unsafe preferences link rather than rendering it", () => {
    const { html } = renderAnnouncementEmail({
      ...BASE,
      preferencesUrl: "javascript:alert(1)",
    });
    expect(html).not.toContain("javascript:");
    expect(html).toContain("you opted in to product updates from StoreMink.");
  });

  it("previews the opening of the copy in the inbox", () => {
    const { html } = renderAnnouncementEmail(BASE);
    expect(html).toContain(
      ">Shoppers can now collect online orders from your shop. Set a hold period",
    );
  });

  it("has no long dash in either category", () => {
    for (const category of ["feature", "operational"] as const) {
      const { subject, html } = renderAnnouncementEmail({ ...BASE, category });
      expect(subject).not.toMatch(/[\u2013\u2014]/);
      expect(html).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
