import { describe, expect, it } from "vitest";
import { isWhatsAppWebhook, summarizeWebhook } from "./webhook-events";

const delivery = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_1",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "919876543210",
              phone_number_id: "PN_1",
            },
            contacts: [
              { profile: { name: "Rohan Sharma" }, wa_id: "919876543210" },
            ],
            messages: [
              {
                from: "919876543210",
                id: "wamid.1",
                type: "text",
                text: { body: "where is my order?" },
              },
              {
                from: "919876543210",
                id: "wamid.2",
                type: "image",
                image: { id: "m1" },
              },
              {
                from: "919876543210",
                id: "wamid.3",
                type: "text",
                text: { body: "hello" },
              },
            ],
          },
        },
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "PN_1" },
            statuses: [
              {
                id: "wamid.9",
                status: "delivered",
                recipient_id: "919876543210",
              },
              { id: "wamid.9", status: "read", recipient_id: "919876543210" },
            ],
          },
        },
      ],
    },
    {
      id: "WABA_2",
      changes: [
        {
          field: "message_template_status_update",
          value: {
            event: "APPROVED",
            message_template_name: "order_confirmed_v1",
          },
        },
        { field: "account_update", value: { event: "VERIFIED_ACCOUNT" } },
      ],
    },
  ],
};

describe("summarizeWebhook", () => {
  it("counts messages, statuses and events by kind, keyed by WABA and phone number", () => {
    expect(summarizeWebhook(delivery)).toEqual({
      wabaIds: ["WABA_1", "WABA_2"],
      phoneNumberIds: ["PN_1"],
      fields: ["messages", "message_template_status_update", "account_update"],
      messages: { text: 2, image: 1 },
      statuses: { delivered: 1, read: 1 },
      events: [
        "message_template_status_update:APPROVED",
        "account_update:VERIFIED_ACCOUNT",
      ],
    });
  });

  it("★ carries no message text, no wa_id, no profile name and no template name", () => {
    const flat = JSON.stringify(summarizeWebhook(delivery));
    expect(flat).not.toContain("where is my order");
    expect(flat).not.toContain("919876543210");
    expect(flat).not.toContain("Rohan");
    expect(flat).not.toContain("order_confirmed_v1");
  });

  it("returns an empty summary for junk without throwing", () => {
    for (const junk of [
      null,
      42,
      "x",
      [],
      {},
      { entry: "no" },
      { entry: [null, 1, { changes: 2 }] },
    ]) {
      expect(summarizeWebhook(junk)).toEqual({
        wabaIds: [],
        phoneNumberIds: [],
        fields: [],
        messages: {},
        statuses: {},
        events: [],
      });
    }
  });
});

describe("isWhatsAppWebhook", () => {
  it("accepts only the WABA object", () => {
    expect(isWhatsAppWebhook(delivery)).toBe(true);
    expect(isWhatsAppWebhook({ object: "page", entry: [] })).toBe(false);
    expect(isWhatsAppWebhook(null)).toBe(false);
  });
});
