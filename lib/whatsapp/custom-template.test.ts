// ---------------------------------------------------------------------------
// A merchant's own template: the rules Meta applies at review, checked here
// so the reason is shown before submitting; the components Meta receives;
// and which templates the inbox may send by hand.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  customTemplateComponents,
  quickReplyPayloadsFor,
  templateButtonsOf,
  templateFooterText,
  templateHeaderText,
  templateNameFromTitle,
  templateNeedsSendParameters,
  validateCustomTemplate,
} from "./custom-template";

const draft = (over: Record<string, unknown> = {}) => ({
  name: "delivery_delay",
  language: "en",
  category: "UTILITY",
  headerText: "",
  body: "Hi {{1}}, your order {{2}} is running late. Sorry about that.",
  variables: [
    { name: "customer_name", sample: "Rohan" },
    { name: "order_number", sample: "ORD10010004" },
  ],
  footerText: "",
  buttons: [],
  ...over,
});

describe("validateCustomTemplate", () => {
  it("accepts a plain body with labelled, sampled placeholders", () => {
    const r = validateCustomTemplate(draft());
    expect(r).toEqual({
      ok: true,
      template: {
        name: "delivery_delay",
        language: "en",
        category: "UTILITY",
        headerText: "",
        body: "Hi {{1}}, your order {{2}} is running late. Sorry about that.",
        variables: [
          { name: "customer_name", sample: "Rohan" },
          { name: "order_number", sample: "ORD10010004" },
        ],
        footerText: "",
        buttons: [],
      },
    });
  });

  it("★ the name is Meta's shape, and never StoreMink's own prefix", () => {
    expect(
      validateCustomTemplate(draft({ name: "Delivery Delay" })),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/lower-case letters/),
    });
    expect(validateCustomTemplate(draft({ name: "sm_mine" }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/StoreMink's own/),
    });
    expect(validateCustomTemplate(draft({ name: "" }))).toMatchObject({
      ok: false,
      error: "Give the template a name.",
    });
  });

  it("★ the body rules are the catalogue's: order, edges, adjacency, samples", () => {
    const bad = (body: string, variables = draft().variables) =>
      validateCustomTemplate(draft({ body, variables }));
    expect(bad("{{1}} is late, {{2}}")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cannot start with a placeholder/),
    });
    expect(bad("Hi {{1}}, order {{2}}")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cannot end with a placeholder/),
    });
    expect(bad("Hi {{1}} {{2}} late.")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/next to each other/),
    });
    expect(bad("Hi {{2}}, order {{1}} is late.")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Number the placeholders/),
    });
    expect(bad("Hi {{1}}, late.", [{ name: "a", sample: "" }])).toMatchObject({
      ok: false,
      error: "Give placeholder {{1}} a sample value for Meta's review.",
    });
    expect(bad("Hi {{ 1 }}, late.", [])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/written \{\{1\}\}/),
    });
    expect(bad("x".repeat(1025), [])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/at most 1024/),
    });
  });

  it("placeholder labels are unique slugs; the count follows the body", () => {
    expect(
      validateCustomTemplate(
        draft({
          variables: [
            { name: "Customer Name", sample: "Rohan" },
            { name: "customer_name", sample: "x" },
          ],
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/both labelled/),
    });
    expect(
      validateCustomTemplate(
        draft({ variables: [{ name: "customer_name", sample: "Rohan" }] }),
      ),
    ).toMatchObject({
      ok: false,
      error: "Give every placeholder a sample value.",
    });
    expect(
      validateCustomTemplate(
        draft({
          variables: [
            { name: "1st", sample: "x" },
            { name: "b", sample: "y" },
          ],
        }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/short label/) });
  });

  it("★ header and footer are plain text, bounded, with no placeholder", () => {
    expect(
      validateCustomTemplate(draft({ headerText: "Order {{1}}" })),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/header cannot contain/),
    });
    expect(
      validateCustomTemplate(draft({ footerText: "x".repeat(61) })),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/footer can be at most 60/),
    });
    const ok = validateCustomTemplate(
      draft({
        headerText: " Delivery  update ",
        footerText: "Reply STOP to opt out",
      }),
    );
    expect(ok.ok && ok.template.headerText).toBe("Delivery update");
  });

  it("★ buttons: three at most, 25-character labels, quick replies first, real links and numbers", () => {
    const withButtons = (buttons: unknown[]) =>
      validateCustomTemplate(draft({ buttons }));
    expect(
      withButtons([
        { type: "quick_reply", text: "Yes" },
        {
          type: "url",
          text: "Track",
          url: "https://echoss.storemink.com/orders",
        },
        { type: "phone", text: "Call us", phone: "+91 98765 43210" },
      ]),
    ).toMatchObject({
      ok: true,
      template: {
        buttons: [
          { type: "quick_reply", text: "Yes" },
          {
            type: "url",
            text: "Track",
            url: "https://echoss.storemink.com/orders",
          },
          { type: "phone", text: "Call us", phone: "+919876543210" },
        ],
      },
    });
    expect(
      withButtons([
        { type: "url", text: "Track", url: "https://x.y/z" },
        { type: "quick_reply", text: "Yes" },
      ]),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/quick-reply buttons before/),
    });
    expect(
      withButtons([{ type: "url", text: "Track", url: "http://x.y" }]),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/full https/),
    });
    expect(
      withButtons([{ type: "url", text: "Track", url: "https://x.y/{{1}}" }]),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cannot contain a placeholder/),
    });
    expect(
      withButtons([{ type: "phone", text: "Call", phone: "12" }]),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/country code/),
    });
    expect(
      withButtons([
        { type: "quick_reply", text: "A really long button label!!" },
      ]),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/at most 25/) });
    expect(
      withButtons(
        [1, 2, 3, 4].map((n) => ({ type: "quick_reply", text: `B${n}` })),
      ),
    ).toMatchObject({
      ok: false,
      error: "A template can have at most 3 buttons.",
    });
    expect(
      withButtons([
        { type: "quick_reply", text: "Yes" },
        { type: "quick_reply", text: "yes" },
      ]),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/both called/) });
    expect(withButtons([{ type: "copy_code", text: "Copy" }])).toMatchObject({
      ok: false,
      error: "Choose what button 1 does.",
    });
  });

  it("★ a quick reply worded like STOP or START is only for a marketing template", () => {
    // A tap is read by its label (inbox.ts): "Stop" records an offers opt-out
    // and is answered automatically, so on a utility template it would hide a
    // customer's "stop my subscription" from the shop.
    for (const text of [
      "Stop",
      "STOP promotions",
      "Unsubscribe",
      "Subscribe",
    ]) {
      expect(
        validateCustomTemplate(
          draft({
            category: "UTILITY",
            buttons: [{ type: "quick_reply", text }],
          }),
        ),
      ).toMatchObject({ ok: false, error: expect.stringContaining(text) });
      expect(
        validateCustomTemplate(
          draft({
            category: "MARKETING",
            buttons: [{ type: "quick_reply", text }],
          }),
        ).ok,
      ).toBe(true);
    }
    // Ordinary wording is untouched, and a link button is never a tap.
    expect(
      validateCustomTemplate(
        draft({
          category: "UTILITY",
          buttons: [
            { type: "quick_reply", text: "Stop my order" },
            { type: "url", text: "Stop", url: "https://acme.test/help" },
          ],
        }),
      ).ok,
    ).toBe(true);
  });

  it("language and kind come from the lists", () => {
    expect(validateCustomTemplate(draft({ language: "xx" }))).toMatchObject({
      ok: false,
      error: "Choose a language from the list.",
    });
    expect(
      validateCustomTemplate(draft({ category: "AUTHENTICATION" })),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/utility or marketing/),
    });
    expect(validateCustomTemplate(null).ok).toBe(false);
  });
});

describe("customTemplateComponents", () => {
  it("★ builds Meta's components in order: header, body with examples, footer, buttons", () => {
    const r = validateCustomTemplate(
      draft({
        headerText: "Delivery update",
        footerText: "Echoss",
        buttons: [
          { type: "quick_reply", text: "Yes" },
          { type: "url", text: "Track", url: "https://x.y/z" },
          { type: "phone", text: "Call", phone: "+919876543210" },
        ],
      }),
    );
    if (!r.ok) throw new Error(r.error);
    expect(customTemplateComponents(r.template)).toEqual([
      { type: "HEADER", format: "TEXT", text: "Delivery update" },
      {
        type: "BODY",
        text: "Hi {{1}}, your order {{2}} is running late. Sorry about that.",
        example: { body_text: [["Rohan", "ORD10010004"]] },
      },
      { type: "FOOTER", text: "Echoss" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Yes" },
          { type: "URL", text: "Track", url: "https://x.y/z" },
          { type: "PHONE_NUMBER", text: "Call", phone_number: "+919876543210" },
        ],
      },
    ]);
  });

  it("omits what is empty, and the example when there is no placeholder", () => {
    const r = validateCustomTemplate(
      draft({ body: "We are closed today.", variables: [] }),
    );
    if (!r.ok) throw new Error(r.error);
    expect(customTemplateComponents(r.template)).toEqual([
      { type: "BODY", text: "We are closed today." },
    ]);
  });
});

describe("reading components back", () => {
  const components = [
    { type: "HEADER", format: "TEXT", text: "Hello" },
    { type: "BODY", text: "Hi {{1}}" },
    { type: "FOOTER", text: "Bye" },
    {
      type: "BUTTONS",
      buttons: [
        { type: "QUICK_REPLY", text: "Yes" },
        { type: "URL", text: "Track", url: "https://x.y" },
        { type: "PHONE_NUMBER", text: "Call", phone_number: "+91" },
      ],
    },
  ];

  it("names the header, footer and every button", () => {
    expect(templateHeaderText(components)).toBe("Hello");
    expect(templateFooterText(components)).toBe("Bye");
    expect(templateButtonsOf(components)).toEqual([
      { type: "quick_reply", text: "Yes" },
      { type: "url", text: "Track" },
      { type: "phone", text: "Call" },
    ]);
    expect(templateHeaderText([{ type: "HEADER", format: "IMAGE" }])).toBe("");
    expect(templateButtonsOf("junk")).toEqual([]);
  });

  it("★ a quick reply sent by hand carries its own label as the payload", () => {
    expect(quickReplyPayloadsFor(components)).toEqual(["custom:Yes"]);
    expect(quickReplyPayloadsFor([{ type: "BODY", text: "x" }])).toEqual([]);
  });

  it("★ needs a send-time value only for what the composer cannot fill", () => {
    expect(templateNeedsSendParameters(components)).toBe(false);
    expect(
      templateNeedsSendParameters([{ type: "HEADER", format: "IMAGE" }]),
    ).toBe(true);
    expect(
      templateNeedsSendParameters([
        { type: "HEADER", format: "TEXT", text: "Hi {{1}}" },
      ]),
    ).toBe(true);
    expect(
      templateNeedsSendParameters([
        {
          type: "BUTTONS",
          buttons: [{ type: "URL", text: "Go", url: "https://x.y/{{1}}" }],
        },
      ]),
    ).toBe(true);
    expect(
      templateNeedsSendParameters([
        { type: "BUTTONS", buttons: [{ type: "COPY_CODE", text: "Copy" }] },
      ]),
    ).toBe(true);
    expect(templateNeedsSendParameters([{ type: "CAROUSEL" }])).toBe(true);
    expect(templateNeedsSendParameters(null)).toBe(false);
  });
});

describe("templateNameFromTitle", () => {
  it("spells a title the way Meta wants a name", () => {
    expect(templateNameFromTitle("Delivery delay!")).toBe("delivery_delay");
    expect(templateNameFromTitle("  Diwali  Offer 2026 ")).toBe(
      "diwali_offer_2026",
    );
    expect(templateNameFromTitle("Café ouvert")).toBe("cafe_ouvert");
  });
});
