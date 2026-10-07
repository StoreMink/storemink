import { describe, it, expect } from "vitest";
import {
  absoluteUrl,
  platformBrand,
  renderNotificationDigest,
  renderNotificationEmail,
  type NotificationEmailItem,
} from "./notification-emails";
import {
  digestSendAfter,
  DAILY_DIGEST_HOUR_UTC,
} from "@/lib/notifications/digest";
import type { StoreBrand } from "@/lib/store/brand";
import { EMAIL_THEME } from "./shell";

/** The owner's rule: no em dash or en dash anywhere in an email. */
const LONG_DASH = /[\u2013\u2014]/;

const brand: StoreBrand = {
  name: "Acme Juice",
  logoUrl: null,
  primaryColor: "#123456",
  tagline: null,
  blurb: null,
  legalName: null,
  creditLine: null,
  email: null,
  phone: null,
  hours: null,
  social: { instagram: null, youtube: null, whatsapp: null },
  badges: [],
  domain: "acme.storemink.com",
};

const BASE = "https://acme.storemink.com";

function item(
  overrides: Partial<NotificationEmailItem> = {},
): NotificationEmailItem {
  return {
    title: "New order ORD10010004",
    body: "₹1,240 · from Priya S.",
    url: "/dashboard/orders?q=ORD10010004",
    severity: "success",
    createdAt: "2026-07-25T10:00:00.000Z",
    ...overrides,
  };
}

describe("absoluteUrl", () => {
  it("absolutises an app-relative path", () => {
    expect(absoluteUrl("/dashboard/orders", BASE)).toBe(
      "https://acme.storemink.com/dashboard/orders",
    );
  });

  it("passes an already-absolute URL through", () => {
    expect(absoluteUrl("https://elsewhere.test/x", BASE)).toBe(
      "https://elsewhere.test/x",
    );
  });

  it("doesn't double the slash when the base has a trailing one", () => {
    expect(absoluteUrl("/orders", "https://acme.storemink.com/")).toBe(
      "https://acme.storemink.com/orders",
    );
  });

  // A stored value that isn't a plain path must not become a link somewhere
  // else entirely (or a javascript: URL in a mail client).
  it("drops anything that isn't a plain path", () => {
    expect(absoluteUrl("javascript:alert(1)", BASE)).toBeNull();
    expect(absoluteUrl("//evil.test/x", BASE)).toBe(
      "https://acme.storemink.com//evil.test/x",
    );
    expect(absoluteUrl("mailto:a@b.com", BASE)).toBeNull();
    expect(absoluteUrl("", BASE)).toBeNull();
    expect(absoluteUrl(null, BASE)).toBeNull();
  });
});

describe("renderNotificationEmail", () => {
  it("uses the notification title as the subject", () => {
    const { subject } = renderNotificationEmail({
      item: item(),
      brand,
      baseUrl: BASE,
    });
    expect(subject).toBe("New order ORD10010004");
  });

  it("includes the body, an absolute CTA, and the preferences footer", () => {
    const { html } = renderNotificationEmail({
      item: item(),
      brand,
      baseUrl: BASE,
    });
    expect(html).toContain("₹1,240");
    expect(html).toContain(
      "https://acme.storemink.com/dashboard/orders?q=ORD10010004",
    );
    expect(html).toContain(
      "https://acme.storemink.com/dashboard/settings/notifications",
    );
  });

  it("renders without a CTA when the notification has no link", () => {
    const { html } = renderNotificationEmail({
      item: item({ url: null }),
      brand,
      baseUrl: BASE,
    });
    expect(html).not.toContain("View in dashboard");
  });

  // WHERE ESCAPING HAPPENS, and why it differs by field:
  //
  //   title — always escaped here. It is a plain string built from DB values
  //           (an order ref, a customer name) and must never become markup.
  //   body  — trusted HTML by the time it reaches this function. It is either
  //           our own default template or a merchant's, sanitised with
  //           sanitizeBlogContent at SAVE time (notification-actions.ts), and
  //           every {{value}} substituted into it was escaped by
  //           renderTemplate. Escaping again here would print the tags.
  it("escapes the title so no tag can form", () => {
    const { html } = renderNotificationEmail({
      item: item({ title: 'Order <img src=x onerror="alert(1)">' }),
      brand,
      baseUrl: BASE,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("onerror=&quot;");
  });

  it("renders the body as the HTML it is", () => {
    const { html } = renderNotificationEmail({
      item: item({ body: "<p>Hello</p><ul><li>One</li></ul>" }),
      brand,
      baseUrl: BASE,
    });
    // Styled by inlineEmailStyles rather than escaped.
    expect(html).toContain("<p style=");
    expect(html).toContain("<li style=");
  });

  it("uses the event-specific customer action and no staff preferences", () => {
    const { html } = renderNotificationEmail({
      item: item({
        eventKey: "order.ready_for_pickup",
        url: "/orders/o1",
      }),
      brand,
      baseUrl: BASE,
      isTeam: false,
    });
    expect(html).toContain("View collection details");
    expect(html).not.toContain("settings/notifications");
  });

  it("wears the standard frame: canvas, serif headline, footer, preheader", () => {
    const { html } = renderNotificationEmail({
      item: item({ body: "<p>A new order is ready for review.</p>" }),
      brand,
      baseUrl: BASE,
    });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('class="sm-email-canvas"');
    // The title is the headline, set in the serif.
    expect(html).toMatch(
      /<h1 class="sm-email-h1 sm-serif"[^>]*>New order ORD10010004<\/h1>/,
    );
    // A store with no logo is named in the serif wordmark at the top.
    expect(html).toMatch(/<span class="sm-serif"[^>]*>Acme Juice<\/span>/);
    // The inbox preview line is the first line of the body, as plain text.
    expect(html).toContain("A new order is ready for review.&#847;");
    // Footer: why this arrived, and the copyright line.
    expect(html).toContain(
      "You're receiving this because you have notifications turned on for Acme Juice",
    );
    expect(html).toContain(`&copy; ${new Date().getFullYear()} Acme Juice`);
  });

  // Identity is the logo or the name. A merchant colour pushed into a button
  // has to survive dark mode and stay legible at any shade, and when it fails
  // the customer receives something that looks broken.
  it("uses the one near-black button and never the store's colour", () => {
    const brightBrand = { ...brand, primaryColor: "#ffea00" };
    const { html } = renderNotificationEmail({
      item: item({ eventKey: "order.placed", url: "/orders/o1" }),
      brand: brightBrand,
      baseUrl: BASE,
      isTeam: false,
    });
    expect(html).not.toContain("#ffea00");
    expect(html).toContain(`bgcolor="${EMAIL_THEME.button}"`);
    expect(html).toMatch(
      /<a href="https:\/\/acme\.storemink\.com\/orders\/o1" style="[^"]*color:#ffffff[^"]*">View your order<\/a>/,
    );
    // One call to action, not one in the copy and another in the chrome.
    expect(html.match(/>View your order</g)).toHaveLength(1);
  });

  it("tells a customer why the mail arrived without a preferences link", () => {
    const { html } = renderNotificationEmail({
      item: item({ eventKey: "order.placed", url: "/orders/o1" }),
      brand,
      baseUrl: BASE,
      isTeam: false,
    });
    expect(html).toContain(
      "You're receiving this because of your order with Acme Juice.",
    );
    expect(html).not.toContain("Change what you get emailed about");
  });

  it("puts the order summary between the copy and the button", () => {
    const { html } = renderNotificationEmail({
      item: item({
        eventKey: "order.placed",
        body: "<p>Thank you for your order.</p>",
        url: "/orders/o1",
        summary: {
          currency: "INR",
          items: [{ name: "Almond Shake", quantity: 1, total: 220 }],
          total: 220,
        },
      }),
      brand,
      baseUrl: BASE,
      isTeam: false,
    });
    const copy = html.indexOf("Thank you for your order.</p>");
    const summary = html.indexOf("Order summary");
    const button = html.indexOf(">View your order</a>");
    expect(copy).toBeGreaterThan(-1);
    expect(summary).toBeGreaterThan(copy);
    expect(button).toBeGreaterThan(summary);
  });

  it("never carries a long dash of its own", () => {
    const { subject, html } = renderNotificationEmail({
      item: item(),
      brand,
      baseUrl: BASE,
    });
    expect(subject).not.toMatch(LONG_DASH);
    expect(html).not.toMatch(LONG_DASH);
  });
});

describe("renderNotificationDigest", () => {
  const items = [
    item(),
    item({ title: "Low stock · Cold Brew", severity: "warning" }),
  ];

  it("summarises the count in the subject", () => {
    const { subject } = renderNotificationDigest({
      items,
      brand,
      baseUrl: BASE,
      digest: "daily",
    });
    expect(subject).toBe("2 updates from Acme Juice");
  });

  it("singularises a one-item digest", () => {
    const { subject } = renderNotificationDigest({
      items: [item()],
      brand,
      baseUrl: BASE,
      digest: "hourly",
    });
    expect(subject).toBe("1 update from Acme Juice");
  });

  it("lists every item with its own link", () => {
    const { html } = renderNotificationDigest({
      items,
      brand,
      baseUrl: BASE,
      digest: "daily",
    });
    expect(html).toContain("New order ORD10010004");
    expect(html).toContain("Low stock · Cold Brew");
    expect(html).toContain("https://acme.storemink.com/dashboard/logs");
    // Each title links to its own destination, with the arrow the checklist
    // and the digest share.
    expect(html).toMatch(
      /<a href="https:\/\/acme\.storemink\.com\/dashboard\/orders\?q=ORD10010004"[^>]*>New order ORD10010004&nbsp;&rarr;<\/a>/,
    );
  });

  it("is one standard email: headline, list card, one button", () => {
    const { html } = renderNotificationDigest({
      items,
      brand,
      baseUrl: BASE,
      digest: "daily",
    });
    expect(html).toContain('class="sm-email-canvas"');
    expect(html).toMatch(/<h1 [^>]*>2 updates since yesterday<\/h1>/);
    // The list sits on a white inset card on the cream canvas.
    expect(html).toContain(`bgcolor="${EMAIL_THEME.card}"`);
    // One line of context under each title, not the whole body.
    expect(html).toContain("₹1,240 · from Priya S.");
    expect(html.match(/>Open dashboard<\/a>/g)).toHaveLength(1);
    expect(html).toContain(`bgcolor="${EMAIL_THEME.button}"`);
    expect(html).not.toContain(brand.primaryColor);
    // Inbox preview line.
    expect(html).toContain("2 updates since yesterday&#847;");
    expect(html).toContain(
      "https://acme.storemink.com/dashboard/settings/notifications",
    );
    expect(html).not.toMatch(LONG_DASH);
  });

  it("names the window it covers", () => {
    expect(
      renderNotificationDigest({
        items,
        brand,
        baseUrl: BASE,
        digest: "hourly",
      }).html,
    ).toContain("in the last hour");
    expect(
      renderNotificationDigest({ items, brand, baseUrl: BASE, digest: "daily" })
        .html,
    ).toContain("since yesterday");
  });

  it("escapes item copy", () => {
    const { html } = renderNotificationDigest({
      items: [item({ title: "<b>bold</b>" })],
      brand,
      baseUrl: BASE,
      digest: "daily",
    });
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("platformBrand", () => {
  it("is a complete StoreBrand for operator mail", () => {
    const b = platformBrand();
    expect(b.name).toBe("StoreMink");
    expect(b.domain).toBeTruthy();
    expect(b.primaryColor).toMatch(/^#/);
  });
});

describe("digestSendAfter", () => {
  const at = (iso: string) => new Date(iso);

  it("sends instant rows immediately", () => {
    const from = at("2026-07-25T14:37:12.000Z");
    expect(digestSendAfter("instant", from).toISOString()).toBe(
      from.toISOString(),
    );
  });

  // Clock-aligned, not "now + 1h": everything in one hour must share a send
  // time or the digest degrades into one email per event.
  it("aligns an hourly digest to the top of the next hour", () => {
    expect(
      digestSendAfter("hourly", at("2026-07-25T14:37:12.000Z")).toISOString(),
    ).toBe("2026-07-25T15:00:00.000Z");
    expect(
      digestSendAfter("hourly", at("2026-07-25T14:00:00.000Z")).toISOString(),
    ).toBe("2026-07-25T15:00:00.000Z");
  });

  it("rolls an hourly digest past midnight", () => {
    expect(
      digestSendAfter("hourly", at("2026-07-25T23:40:00.000Z")).toISOString(),
    ).toBe("2026-07-26T00:00:00.000Z");
  });

  it("sends a daily digest at the next daily slot", () => {
    const hh = String(DAILY_DIGEST_HOUR_UTC).padStart(2, "0");
    // Before today's slot → today.
    expect(
      digestSendAfter("daily", at("2026-07-25T02:00:00.000Z")).toISOString(),
    ).toBe(`2026-07-25T${hh}:00:00.000Z`);
    // Past it → tomorrow's.
    const past = at(`2026-07-25T${hh}:30:00.000Z`);
    expect(digestSendAfter("daily", past).toISOString()).toBe(
      `2026-07-26T${hh}:00:00.000Z`,
    );
  });

  // The slot must land BEFORE the /api/cron/send-emails heartbeat (00:00 UTC),
  // or a daily digest comes due just after the only run of the day and waits a
  // further 24 hours. See the note on DAILY_DIGEST_HOUR_UTC.
  it("keeps the daily slot ahead of the 00:00 UTC cron", () => {
    expect(DAILY_DIGEST_HOUR_UTC).toBeGreaterThanOrEqual(20);
    expect(DAILY_DIGEST_HOUR_UTC).toBeLessThan(24);
  });

  it("two events in the same window share a send time", () => {
    const a = digestSendAfter("hourly", at("2026-07-25T14:01:00.000Z"));
    const b = digestSendAfter("hourly", at("2026-07-25T14:59:00.000Z"));
    expect(a.toISOString()).toBe(b.toISOString());
  });
});

describe("who is speaking (PLATFORM_VOICE_EVENTS)", () => {
  // StoreMink writing to a merchant about their account must not arrive under
  // the merchant's own name: "Welcome to StoreMink" from "Acme Juice" reads as
  // the store mailing itself.
  it("frames a StoreMink account event with StoreMink's lockup", () => {
    const out = renderNotificationEmail({
      item: item({ eventKey: "store.created", title: "Acme Juice is ready" }),
      brand,
      baseUrl: BASE,
      isTeam: true,
    });
    expect(out.voice).toBe("platform");
    expect(out.html).toContain(">Store<span");
    expect(out.html).toContain("Mink</span>");
    expect(out.html).toContain("you run Acme Juice on StoreMink");
  });

  it("keeps a shop event in the store's own voice", () => {
    const out = renderNotificationEmail({
      item: item({ eventKey: "order.placed" }),
      brand,
      baseUrl: BASE,
      isTeam: true,
    });
    expect(out.voice).toBe("store");
    expect(out.html).not.toContain(">Store<span");
    expect(out.html).toContain("Acme Juice");
  });

  it("never platform-voices shopper mail", () => {
    const out = renderNotificationEmail({
      item: item({ eventKey: "store.created" }),
      brand,
      baseUrl: BASE,
      isTeam: false,
    });
    expect(out.voice).toBe("store");
  });

  it("offers the preferences link only for events that can be switched off", () => {
    const locked = renderNotificationEmail({
      item: item({ eventKey: "store.domain_reverted" }),
      brand,
      baseUrl: BASE,
      isTeam: true,
    });
    expect(locked.html).not.toContain("Change what you get emailed about");

    const switchable = renderNotificationEmail({
      item: item({ eventKey: "inventory.low_stock" }),
      brand,
      baseUrl: BASE,
      isTeam: true,
    });
    expect(switchable.html).toContain("Change what you get emailed about");
  });

  it("platform-voices a digest only when every item is StoreMink speaking", () => {
    const allPlatform = renderNotificationDigest({
      items: [
        item({ eventKey: "plan.expiring" }),
        item({ eventKey: "ai.credits_low" }),
      ],
      brand,
      baseUrl: BASE,
      digest: "daily",
    });
    expect(allPlatform.voice).toBe("platform");
    expect(allPlatform.subject).toBe("2 updates from StoreMink");

    const mixed = renderNotificationDigest({
      items: [
        item({ eventKey: "plan.expiring" }),
        item({ eventKey: "order.placed" }),
      ],
      brand,
      baseUrl: BASE,
      digest: "daily",
    });
    expect(mixed.voice).toBe("store");
    expect(mixed.subject).toBe("2 updates from Acme Juice");
  });
});

describe("long digests and plain bodies", () => {
  it("caps a digest and points at the activity log for the rest", () => {
    const items = Array.from({ length: 45 }, (_, i) =>
      item({ title: `Update number ${i + 1}` }),
    );
    const out = renderNotificationDigest({
      items,
      brand,
      baseUrl: BASE,
      digest: "daily",
    });
    expect(out.html).toContain("Update number 30");
    expect(out.html).not.toContain("Update number 31");
    expect(out.html).toContain("And 15 more updates");
    // The subject still counts everything that happened.
    expect(out.subject).toBe("45 updates from Acme Juice");
  });

  it("sets a plain-text body as a styled, escaped paragraph", () => {
    const out = renderNotificationEmail({
      item: item({ body: "Store <b>Acme</b> was created\nby Priya" }),
      brand,
      baseUrl: BASE,
    });
    expect(out.html).toMatch(/<p style="[^"]*font-size:16px[^"]*">/);
    expect(out.html).toContain("Store Acme was created<br />by Priya");
  });
});
