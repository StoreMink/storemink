import { describe, it, expect } from "vitest";
import {
  extractVariables,
  renderTemplate,
  templateValues,
  validateTemplate,
} from "./template";
import {
  BASE_VARIABLES,
  sampleValuesFor,
  variableNamesFor,
  variablesFor,
} from "./variables";
import { EVENTS } from "./events";
import { defaultEmailTemplate } from "./default-templates";
import { renderNotification } from "./render";
import { inlineEmailStyles } from "@/lib/email/notification-emails";
import { EMAIL_MONO, EMAIL_THEME } from "@/lib/email/shell";
import { evaluateLaunchChecklist } from "@/lib/store/launch-checklist-rules";

/** The owner's rule: no em dash (U+2014) or en dash (U+2013) in any email. */
const LONG_DASH = /[\u2013\u2014]/;

describe("renderTemplate", () => {
  it("substitutes values", () => {
    expect(
      renderTemplate("New order {{subject_label}}", {
        subject_label: "ORD10010004",
      }),
    ).toBe("New order ORD10010004");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(
      renderTemplate("{{  subject_label  }}", { subject_label: "X" }),
    ).toBe("X");
  });

  it("substitutes the same variable everywhere it appears", () => {
    expect(
      renderTemplate("{{store_name}} — {{store_name}}", {
        store_name: "Acme",
      }),
    ).toBe("Acme — Acme");
  });

  // A template must never leak its own plumbing into a customer's inbox.
  it("renders a missing value as empty, not as the token", () => {
    expect(renderTemplate("Hi {{actor_name}}!", {})).toBe("Hi !");
    expect(renderTemplate("Hi {{actor_name}}!", { actor_name: null })).toBe(
      "Hi !",
    );
  });

  it("leaves non-variable braces alone", () => {
    expect(renderTemplate("{ not a var } {{}}", {})).toBe("{ not a var } {{}}");
  });

  // Values come from the database — customer names, product names.
  it("escapes substituted values in HTML mode", () => {
    const out = renderTemplate(
      "<p>{{actor_name}}</p>",
      { actor_name: "<script>alert(1)</script>" },
      "html",
    );
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("does not escape in text mode (subject lines aren't HTML)", () => {
    expect(
      renderTemplate("{{store_name}}", { store_name: "Ben & Jerry's" }, "text"),
    ).toBe("Ben & Jerry's");
  });

  it("coerces numbers", () => {
    expect(renderTemplate("{{stock}} left", { stock: 4 })).toBe("4 left");
  });

  it("returns empty for an empty template", () => {
    expect(renderTemplate("", { a: "b" })).toBe("");
  });
});

describe("extractVariables", () => {
  it("lists each distinct token once, in order", () => {
    expect(extractVariables("{{b}} {{a}} {{b}} plain {{c}}")).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("is empty for a template with no variables", () => {
    expect(extractVariables("Just words")).toEqual([]);
  });
});

describe("validateTemplate", () => {
  it("accepts variables the event provides", () => {
    const result = validateTemplate(
      "New order {{subject_label}} — {{total}}",
      "order.placed",
    );
    expect(result.valid).toBe(true);
    expect(result.unknown).toEqual([]);
  });

  // The merchant finds out while editing, not from a customer.
  it("rejects a variable the event doesn't provide", () => {
    const result = validateTemplate(
      "Track it: {{tracking_number}}",
      "order.placed",
    );
    expect(result.valid).toBe(false);
    expect(result.unknown).toEqual(["tracking_number"]);
    expect(result.error).toContain("tracking_number");
  });

  it("names every unknown variable at once", () => {
    const result = validateTemplate("{{foo}} {{bar}}", "order.placed");
    expect(result.unknown).toEqual(["foo", "bar"]);
  });

  it("rejects a variable that belongs to a DIFFERENT event", () => {
    // `rating` is real, but only on customer.review_submitted.
    expect(validateTemplate("{{rating}}", "order.placed").valid).toBe(false);
    expect(
      validateTemplate("{{rating}}", "customer.review_submitted").valid,
    ).toBe(true);
  });

  it("enforces a subject length limit", () => {
    const result = validateTemplate("x".repeat(400), "order.placed", "subject");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("too long");
  });

  it("allows the base variables on every event", () => {
    for (const def of EVENTS) {
      for (const variable of BASE_VARIABLES) {
        expect(
          validateTemplate(`{{${variable.name}}}`, def.key).valid,
          `${def.key} / ${variable.name}`,
        ).toBe(true);
      }
    }
  });
});

describe("templateValues", () => {
  it("maps the event envelope onto base variables", () => {
    const values = templateValues(
      "order.placed",
      {
        storeName: "Acme",
        actorLabel: "Priya S.",
        subjectLabel: "ORD10010004",
        eventName: "New order",
        date: "26 Jul 2026",
        link: "https://acme.storemink.com/dashboard/orders",
      },
      null,
    );
    expect(values.store_name).toBe("Acme");
    expect(values.subject_label).toBe("ORD10010004");
    expect(values.link).toContain("https://");
  });

  it("converts camelCase payload keys to snake_case tokens", () => {
    const values = templateValues("plan.expiring", {}, { daysLeft: 7 });
    // Formatted for reading, not echoed raw — see lib/notifications/format.ts.
    expect(values.days_left).toBe("7 days");
  });

  // A payload key nobody documented must not be reachable from a template.
  it("ignores payload keys the event doesn't declare", () => {
    const values = templateValues(
      "order.placed",
      {},
      { total: 1240, internalSecretRef: "abc" },
    );
    // Money carries its currency: "Total ₹1,240.00", never a bare "1240".
    expect(values.total).toBe("₹1,240.00");
    expect(values).not.toHaveProperty("internal_secret_ref");
  });

  it("skips null and undefined", () => {
    const values = templateValues(
      "order.placed",
      { storeName: null },
      { total: null },
    );
    expect(values).not.toHaveProperty("store_name");
    expect(values).not.toHaveProperty("total");
  });
});

describe("default email templates", () => {
  it("gives every notification a subject and a non-empty body", () => {
    for (const def of EVENTS) {
      const t = defaultEmailTemplate(def.key);
      expect(t.subject.length, def.key).toBeGreaterThan(0);
      expect(t.body.length, def.key).toBeGreaterThan(20);
    }
  });

  it("only uses variables the event actually provides", () => {
    for (const def of EVENTS) {
      const t = defaultEmailTemplate(def.key);
      expect(
        validateTemplate(t.subject, def.key, "subject").valid,
        def.key,
      ).toBe(true);
      expect(validateTemplate(t.body, def.key, "body").valid, def.key).toBe(
        true,
      );
    }
  });

  it("renders with no leftover tokens", () => {
    for (const def of EVENTS) {
      const t = defaultEmailTemplate(def.key);
      const values = sampleValuesFor(def.key);
      expect(renderTemplate(t.subject, values, "text"), def.key).not.toContain(
        "{{",
      );
      expect(renderTemplate(t.body, values), def.key).not.toContain("{{");
    }
  });

  it("★ a refund's amount reaches the customer", () => {
    // The emitters sent `total`, the catalog declares `amount`, and
    // templateValues drops anything undeclared — so the figure silently
    // vanished and the email read "Your refund has been …" with no number.
    const withAmount = templateValues(
      "order.refund_issued",
      { date: new Date("2026-08-22T10:00:00Z").toISOString() },
      { amount: 1240, currency: "INR", paymentMethod: "razorpay" },
    );
    expect(withAmount.amount).toBe("\u20b91,240.00");

    // The old shape yields nothing at all — this is what regressed.
    const asTotal = templateValues(
      "order.refund_issued",
      {},
      { total: 1240, currency: "INR" },
    );
    expect(asTotal.amount).toBeUndefined();
  });

  it("★ a refund email never claims the original payment method it didn't use", () => {
    // Both renderers said "sent to your original payment method" for EVERY
    // method, so a store-credit refund told the shopper their card was
    // credited when no money had left at all.
    const credit = defaultEmailTemplate(
      "order.refund_issued",
      "customer",
      {},
      {
        paymentMethod: "store_credit",
      },
    );
    expect(credit.body).toMatch(/store credit/i);
    expect(credit.body).not.toMatch(/original payment method/i);
    // …and no bank timeline, because no bank is involved.
    expect(credit.body).not.toMatch(/working days/);

    const manual = defaultEmailTemplate(
      "order.refund_issued",
      "customer",
      {},
      {
        paymentMethod: "manual",
      },
    );
    expect(manual.body).not.toMatch(/original payment method/i);

    // The gateway refund is the one that earns the promise.
    const online = defaultEmailTemplate(
      "order.refund_issued",
      "customer",
      {},
      {
        paymentMethod: "razorpay",
      },
    );
    expect(online.body).toMatch(/original payment method/i);
    expect(online.body).toMatch(/5 to 7 working days/);
  });

  it("falls back to copy true of any method when none is known", () => {
    const t = defaultEmailTemplate("order.refund_issued", "customer", {}, null);
    expect(t.body).toMatch(/on its way back to you/i);
    expect(t.body).not.toMatch(/original payment method/i);
  });

  it("opens with a readable sentence, not a bare label", () => {
    const t = defaultEmailTemplate("order.placed");
    expect(t.body.split("\n")[0]).toBe(
      '<p class="email-lead">A new order is ready for review.</p>',
    );
  });
});

describe("default template HTML", () => {
  it("is HTML, not plain text", () => {
    const t = defaultEmailTemplate("order.placed");
    expect(t.body).toContain('<p class="email-lead">');
    expect(t.body).toContain('<ul class="email-details">');
    expect(t.body).toContain('<li class="email-detail">');
  });

  it("leads the facts with the thing itself", () => {
    const t = defaultEmailTemplate("order.placed");
    expect(t.body).toContain(">Order</strong>");
    expect(t.body).toContain("{{subject_label}}");
  });

  it("omits the customer identity from shopper copy", () => {
    expect(defaultEmailTemplate("order.placed", "team").body).toContain(
      ">Customer</strong>",
    );
    expect(defaultEmailTemplate("order.placed", "customer").body).not.toContain(
      ">Customer</strong>",
    );
  });

  it("uses a different voice for each audience", () => {
    expect(defaultEmailTemplate("order.placed", "customer").body).toContain(
      "Thank you for your order",
    );
    expect(defaultEmailTemplate("order.placed", "team").body).toContain(
      "ready for review",
    );
  });

  it("makes the pickup code the focal point of ready-to-collect mail", () => {
    const body = defaultEmailTemplate(
      "order.ready_for_pickup",
      "customer",
    ).body;
    expect(body).toContain("Collection code");
    expect(body).toContain('class="email-code"');
    expect(body).toContain("{{collection_code}}");
  });

  it("does not promise a refund before money has actually moved", () => {
    const cancelled = defaultEmailTemplate("order.cancelled", "customer").body;
    const expired = defaultEmailTemplate(
      "order.pickup_expired",
      "customer",
    ).body;
    expect(cancelled).toContain("once it has been issued");
    expect(expired).toContain("once it has been issued");
    expect(cancelled).not.toContain("refund is on its way");
    expect(expired).not.toContain("refund is on its way");
  });

  it("only uses tags the email shell knows how to style", () => {
    // Mirrors TAG_STYLES in lib/email/shell.ts, plus `br` — a void element
    // that needs no styling. A tag the shell doesn't style arrives unstyled in
    // the inbox, which is why this list exists; keep the two in step.
    const allowed = new Set([
      "p",
      "ul",
      "ol",
      "li",
      "strong",
      "br",
      "h2",
      "h3",
      "a",
      "hr",
    ]);
    for (const def of EVENTS) {
      for (const audience of ["team", "customer"] as const) {
        const body = defaultEmailTemplate(def.key, audience).body;
        for (const match of body.matchAll(/<\/?([a-z0-9]+)/gi)) {
          expect(allowed, `${def.key}: <${match[1]}>`).toContain(
            match[1].toLowerCase(),
          );
        }
      }
    }
  });
});

describe("no long dash in any default email", () => {
  const audiences = ["team", "customer"] as const;
  // Every refund method the copy branches on, plus none at all.
  const payloads: (Record<string, unknown> | null)[] = [
    null,
    ...["razorpay", "card", "upi", "cash", "store_credit", "manual"].map(
      (paymentMethod) => ({ paymentMethod }),
    ),
  ];

  it("holds for every event, both audiences, as template text and rendered", () => {
    for (const def of EVENTS) {
      const values = sampleValuesFor(def.key);
      for (const audience of audiences) {
        for (const payload of payloads) {
          for (const given of [undefined, values]) {
            const t = defaultEmailTemplate(def.key, audience, given, payload);
            const where = `${def.key} / ${audience} / ${JSON.stringify(payload)}`;
            expect(t.subject, where).not.toMatch(LONG_DASH);
            expect(t.body, where).not.toMatch(LONG_DASH);
            expect(
              renderTemplate(t.subject, values, "text"),
              where,
            ).not.toMatch(LONG_DASH);
            expect(
              inlineEmailStyles(renderTemplate(t.body, values, "html")),
              where,
            ).not.toMatch(LONG_DASH);
          }
        }
      }
    }
  });

  // The bell line is the email for an audience with no email template of its
  // own (platform operators), and the subject of an in-app notification.
  it("holds for the in-app copy too", () => {
    for (const def of EVENTS) {
      const samples = sampleValuesFor(def.key);
      const payload: Record<string, unknown> = { ...samples };
      for (const [name, value] of Object.entries(samples)) {
        payload[name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] =
          value;
      }
      for (const method of [undefined, "razorpay", "store_credit"]) {
        for (const audience of [
          "store-admins",
          "customer",
          "operators",
        ] as const) {
          const rendered = renderNotification(
            {
              type: def.key,
              actorLabel: "Priya S.",
              subjectId: "o1",
              subjectLabel: "ORD10010004",
              payload: { ...payload, paymentMethod: method },
            },
            audience,
          );
          if (!rendered) continue;
          const where = `${def.key} / ${audience}`;
          expect(rendered.title, where).not.toMatch(LONG_DASH);
          expect(rendered.body ?? "", where).not.toMatch(LONG_DASH);
        }
      }
    }
  });

  it("holds for every event's description, which can open an email", () => {
    for (const def of EVENTS) {
      expect(def.description, def.key).not.toMatch(LONG_DASH);
      expect(def.label, def.key).not.toMatch(LONG_DASH);
    }
  });

  it("holds for every sample value the console preview renders", () => {
    for (const def of EVENTS) {
      for (const variable of variablesFor(def.key)) {
        expect(variable.sample, `${def.key}/${variable.name}`).not.toMatch(
          LONG_DASH,
        );
      }
    }
  });
});

describe("the welcome email (store.created)", () => {
  const template = defaultEmailTemplate("store.created", "team");

  /** Every checklist link in the template, with {{store_url}} stripped. */
  function checklistRoutes(body: string): string[] {
    const list = body.match(
      /<ul class="email-checklist">([\s\S]*?)<\/ul>/,
    )?.[1];
    return [...(list ?? "").matchAll(/href="\{\{store_url\}\}([^"]*)"/g)].map(
      (m) => m[1],
    );
  }

  it("gives the address and says it stays private until Go live", () => {
    const lead = template.body.split("\n")[0];
    expect(lead).toMatch(/^<p class="email-lead">/);
    expect(lead).toContain('<a href="{{store_url}}">{{store_url}}</a>');
    expect(lead).toContain("password page");
    expect(lead).toContain("Go live");
  });

  it("has a setup checklist and ends on the reassurance", () => {
    expect(template.body).toContain("<h2>Your setup checklist</h2>");
    expect(template.body).toContain('<ul class="email-checklist">');
    expect(template.body.trim().split("\n").at(-1)).toBe(
      '<p class="email-note">Everything is editable later, including the store name.</p>',
    );
  });

  // ★ The checklist IS the go-live checklist's required half. If a route
  // moves in lib/store/launch-checklist-rules.ts, the welcome email must not
  // keep sending people to the old one.
  it("links every REQUIRED go-live item, at its real route, and nothing else", () => {
    const rules = evaluateLaunchChecklist({
      plan: "free",
      ownerPhoneVerified: false,
      publishedProducts: 0,
      sampleProducts: 0,
      business: { name: false, address: false, email: false, phone: false },
      policies: {},
      shippingSaved: false,
      homepageEdited: false,
      logo: false,
      paymentsConnected: false,
      gstin: false,
      customDomainLive: false,
    });
    const required = [
      ...new Set(rules.items.filter((i) => i.required).map((i) => i.href)),
    ];
    const routes = checklistRoutes(template.body);
    // The last row is the Go live button itself, on dashboard Home.
    expect(routes.at(-1)).toBe("/dashboard");
    expect(routes.slice(0, -1)).toEqual(required);
  });

  it("substitutes the address into every link, escaped", () => {
    const hostile = 'https://acme.storemink.com/"><script>x</script>';
    const html = renderTemplate(
      template.body,
      { ...sampleValuesFor("store.created"), store_url: hostile },
      "html",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain(
      'href="https://acme.storemink.com/&quot;&gt;&lt;script&gt;x&lt;/script&gt;/dashboard/products"',
    );

    // And with a real address, the inlined email links each row absolutely,
    // with the arrow, and keeps it escaped all the way through.
    const sent = inlineEmailStyles(
      renderTemplate(template.body, sampleValuesFor("store.created"), "html"),
    );
    for (const route of [
      "/dashboard/products",
      "/dashboard/billing",
      "/dashboard/settings/policies",
      "/dashboard/settings/shipping",
    ]) {
      expect(sent).toMatch(
        new RegExp(
          `<a class="sm-serif" href="https://acme\\.storemink\\.com${route.replace(/\//g, "\\/")}" style="[^"]*">[^<]+&nbsp;&rarr;</a>`,
        ),
      );
    }
    expect(sent).not.toContain("<ul");
    expect(inlineEmailStyles(html)).not.toContain("<script>");
  });
});

describe("hand-written emails", () => {
  // The cron fills `reason` from the Domain settings page's message for a
  // domain still being set up ("Google is still issuing the certificate ...
  // you can close this page"), which is wrong in an email saying a live domain
  // broke. The email sends them to that page instead.
  it("never print the raw reason in the domain-reverted email", () => {
    const pending =
      "Your DNS records look right. Google is still issuing the certificate, so you can close this page.";
    const values = {
      domain: "acme.com",
      store_url: "https://acme.storemink.com",
      reason: pending,
    };
    const t = defaultEmailTemplate("store.domain_reverted", "team", values);
    expect(t.body).not.toContain("{{reason}}");
    expect(renderTemplate(t.body, values, "html")).not.toContain(
      "close this page",
    );
    expect(t.body).toContain("Your store is still open.");
    expect(t.body).toMatch(/Domain page under Settings/);
    // The preview shows the same body.
    expect(
      defaultEmailTemplate("store.domain_reverted", "team").body,
    ).not.toContain("{{reason}}");
  });

  // Owners are gated by the password page too, so the welcome's first link
  // leads to a password prompt. It has to say where the password is.
  it("tell a new merchant where the storefront password is", () => {
    const lead = defaultEmailTemplate("store.created", "team").body.split(
      "\n",
    )[0];
    expect(lead).toMatch(/password page/);
    expect(lead).toMatch(/password is on your dashboard Home/);
  });

  it("open with a lead paragraph", () => {
    for (const key of [
      "store.created",
      "store.launched",
      "store.domain_live",
      "store.comp_ended",
      "store.domain_reverted",
    ]) {
      expect(defaultEmailTemplate(key, "team").body, key).toMatch(
        /^<p class="email-lead">/,
      );
    }
  });
});

describe("inlineEmailStyles", () => {
  it("inlines styles for the supported tags", () => {
    const out = inlineEmailStyles("<p>Hello</p>");
    expect(out).toContain("<p style=");
    expect(out).toContain("font-family");
  });

  it("preserves other attributes", () => {
    const out = inlineEmailStyles('<a href="https://x.test">link</a>');
    expect(out).toContain('href="https://x.test"');
    expect(out).toContain("style=");
  });

  // A merchant who deliberately styles something keeps their styling.
  it("leaves a tag that already has a style attribute alone", () => {
    const out = inlineEmailStyles('<p style="color:red">Hi</p>');
    expect(out).toBe('<p style="color:red">Hi</p>');
  });

  it("leaves unknown tags untouched", () => {
    expect(inlineEmailStyles("<span>x</span>")).toBe("<span>x</span>");
  });

  it("styles every occurrence, not just the first", () => {
    const out = inlineEmailStyles("<p>a</p><p>b</p>");
    expect(out.match(/<p style=/g)).toHaveLength(2);
  });

  it("progressively enhances notification template classes", () => {
    const out = inlineEmailStyles(
      '<p class="email-lead">Hi</p><p class="email-code">PK0M-3T9V</p><ul class="email-details"><li class="email-detail"><strong class="email-label">Order</strong><br />ORD1</li></ul><p class="email-note">Later</p>',
    );
    // The code: monospaced and spaced, on a white inset.
    const code = out.match(/<p class="email-code" style="([^"]+)">/)?.[1] ?? "";
    expect(code).toContain(`background-color:${EMAIL_THEME.card};`);
    expect(code).toContain(`font-family:${EMAIL_MONO};`);
    expect(code).toContain("text-align:center;");
    // The facts: a white card with a hairline border.
    expect(out).toContain(
      `<ul class="email-details" style="margin:24px 0; padding:12px 0; list-style:none; background-color:${EMAIL_THEME.card}; border:1px solid ${EMAIL_THEME.border};`,
    );
    expect(out).toMatch(/<li class="email-detail" style="[^"]+">/);
    expect(out).toMatch(
      new RegExp(
        `<strong class="email-label" style="color:${EMAIL_THEME.muted};`,
      ),
    );
    expect(out).toMatch(/<p class="email-lead" style="[^"]*font-size:17px/);
    expect(out).toMatch(
      new RegExp(
        `<p class="email-note" style="[^"]*color:${EMAIL_THEME.muted};`,
      ),
    );
  });

  // No colour but the logo: links and emphasis are ink, whatever the store's
  // brand colour is.
  it("styles links and emphasis in ink", () => {
    const out = inlineEmailStyles(
      '<p><a href="https://x.test">x</a> <strong>y</strong></p>',
    );
    expect(out).toContain(
      `<a href="https://x.test" style="color:${EMAIL_THEME.ink}; text-decoration:underline;">`,
    );
    expect(out).toContain(`<strong style="color:${EMAIL_THEME.ink};`);
  });

  it("keeps a self-closing tag a valid tag", () => {
    expect(
      inlineEmailStyles('<img src="https://x.test/a.png" alt="" />'),
    ).toMatch(
      /^<img src="https:\/\/x\.test\/a\.png" alt="" style="[^"]+" \/>$/,
    );
    expect(inlineEmailStyles("<hr />")).toMatch(/^<hr style="[^"]+" \/>$/);
    expect(inlineEmailStyles("<hr>")).toMatch(/^<hr style="[^"]+">$/);
    // A line break needs no styling and passes through untouched.
    expect(inlineEmailStyles("a<br />b")).toBe("a<br />b");
  });

  describe("the email-checklist list", () => {
    it("expands into checklist rows: a linked serif title with an arrow, its line under it", () => {
      const out = inlineEmailStyles(
        '<ul class="email-checklist"><li><a href="https://acme.test/dashboard/products">Add your first product</a><br />Publish one of your own.</li></ul>',
      );
      // Rows, not a bulleted list.
      expect(out).not.toContain("<ul");
      expect(out).not.toContain("<li");
      expect(out).toContain('<table role="presentation"');
      // The circled tick.
      expect(out).toContain("&#10003;");
      // The title keeps its link, gains the arrow and the serif.
      expect(out).toMatch(
        /<a class="sm-serif" href="https:\/\/acme\.test\/dashboard\/products" style="font-family:Georgia[^"]*">Add your first product&nbsp;&rarr;<\/a>/,
      );
      // The explanation sits under it as its own paragraph.
      expect(out).toMatch(/<p style="[^"]*">Publish one of your own\.<\/p>/);
    });

    it("renders a <strong> title as a plain statement with no arrow", () => {
      const out = inlineEmailStyles(
        '<ul class="email-checklist"><li><strong>Press Go live</strong><br />When the rest is done.</li></ul>',
      );
      expect(out).toMatch(
        /<span class="sm-serif" style="[^"]*">Press Go live<\/span>/,
      );
      expect(out).not.toContain("<strong");
      expect(out).not.toContain("&rarr;");
      expect(out).toContain("When the rest is done.");
    });

    it("drops a title link's own class and style for the checklist's", () => {
      const out = inlineEmailStyles(
        '<ul class="email-checklist"><li><a href="https://a.test" class="x" style="color:red">A</a><br />b</li></ul>',
      );
      expect(out).not.toContain("color:red");
      expect(out).not.toContain('class="x"');
      expect(out).toContain('href="https://a.test/"');
    });

    // ★ A class value with single quotes used to survive the attribute strip
    // and become live attributes on the rebuilt link.
    it("rebuilds the title link from a validated href only", () => {
      const out = inlineEmailStyles(
        `<ul class="email-checklist"><li><a class="x' href='javascript:alert(1)' onmouseover='alert(2)" href="https://a.test/ok">A</a><br />b</li></ul>`,
      );
      expect(out).not.toMatch(/javascript:/i);
      expect(out).not.toMatch(/onmouseover/i);
      expect(out).toContain('href="https://a.test/ok"');
    });

    it("renders a title with an unsafe href as plain text", () => {
      const out = inlineEmailStyles(
        '<ul class="email-checklist"><li><a href="javascript:alert(1)">A</a><br />b</li></ul>',
      );
      expect(out).not.toMatch(/javascript:/i);
      expect(out).toMatch(/<span class="sm-serif" style="[^"]*">A<\/span>/);
    });

    it("still renders a list that doesn't follow the shape, as plain rows", () => {
      // No <br />: the whole item is the title and there is no line under it.
      const out = inlineEmailStyles(
        '<ul class="email-checklist"><li>Just one line</li><li>And another</li></ul>',
      );
      expect(out).toMatch(
        /<span class="sm-serif" style="[^"]*">Just one line<\/span>/,
      );
      expect(out).toMatch(
        /<span class="sm-serif" style="[^"]*">And another<\/span>/,
      );
      expect(out.match(/&#10003;/g)).toHaveLength(2);
      expect(out).not.toContain("<p ");
      // An empty checklist disappears rather than leaving an empty frame.
      expect(inlineEmailStyles('<ul class="email-checklist"></ul>')).toBe("");
    });

    it("leaves an ordinary list a list", () => {
      const out = inlineEmailStyles("<ul><li>One</li></ul>");
      expect(out).toMatch(
        /^<ul style="[^"]+"><li style="[^"]+">One<\/li><\/ul>$/,
      );
    });
  });
});

describe("variable catalog", () => {
  it("gives every event at least the base variables", () => {
    for (const def of EVENTS) {
      expect(variablesFor(def.key).length).toBeGreaterThanOrEqual(
        BASE_VARIABLES.length,
      );
    }
  });

  it("has no duplicate variable names within an event", () => {
    for (const def of EVENTS) {
      const names = variablesFor(def.key).map((v) => v.name);
      expect(new Set(names).size, def.key).toBe(names.length);
    }
  });

  it("uses snake_case tokens throughout", () => {
    for (const def of EVENTS) {
      for (const variable of variablesFor(def.key)) {
        expect(variable.name, `${def.key}/${variable.name}`).toMatch(
          /^[a-z][a-z0-9_]*$/,
        );
      }
    }
  });

  // The preview must exercise the same names the validator allows, or a
  // merchant sees a blank where their variable will actually resolve.
  it("provides a sample for every declared variable", () => {
    for (const def of EVENTS) {
      const samples = sampleValuesFor(def.key);
      for (const name of variableNamesFor(def.key)) {
        expect(samples, `${def.key}/${name}`).toHaveProperty(name);
      }
    }
  });

  // A preview of a welcome email that reads "Finish setting up ORD10010004"
  // shows the merchant something a real send never would.
  it("samples subject_label as what each event's emitter actually labels", () => {
    expect(sampleValuesFor("store.created").subject_label).toBe("Acme Juice");
    expect(sampleValuesFor("inventory.low_stock").subject_label).toBe(
      "Almond Shake",
    );
    expect(sampleValuesFor("order.placed").subject_label).toBe("ORD10010004");
    // The shared base list itself is never mutated by an override.
    expect(BASE_VARIABLES.find((v) => v.name === "subject_label")?.sample).toBe(
      "ORD10010004",
    );
  });

  it("renders a preview with no leftover tokens", () => {
    for (const def of EVENTS) {
      const template = variablesFor(def.key)
        .map((v) => `{{${v.name}}}`)
        .join(" ");
      const out = renderTemplate(template, sampleValuesFor(def.key));
      expect(out, def.key).not.toContain("{{");
    }
  });
});
