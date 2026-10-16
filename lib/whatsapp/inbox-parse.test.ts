import { describe, expect, it } from "vitest";
import {
  MAX_BODY_CHARS,
  parseEchoMessage,
  parseInboundMessage,
  phoneFromWaId,
  previewOf,
} from "./inbox-parse";

const contacts = [{ profile: { name: "Rohan" }, wa_id: "919876543210" }];
const base = { from: "919876543210", id: "wamid.1", timestamp: "1760000000" };

describe("parseInboundMessage", () => {
  it("text: sender, name, body and Meta's clock", () => {
    const m = parseInboundMessage(
      { ...base, type: "text", text: { body: "Is it in stock?" } },
      contacts,
    );
    expect(m).toMatchObject({
      providerId: "wamid.1",
      waId: "919876543210",
      phone: "+919876543210",
      profileName: "Rohan",
      kind: "text",
      body: "Is it in stock?",
      media: null,
    });
    expect(m!.sentAt).toBe(new Date(1760000000 * 1000).toISOString());
  });

  it("media: the file id and caption, by type", () => {
    const m = parseInboundMessage(
      {
        ...base,
        type: "document",
        document: {
          id: "media-1",
          mime_type: "application/pdf",
          filename: "bill.pdf",
          caption: "the bill",
        },
      },
      [],
    );
    expect(m).toMatchObject({
      kind: "document",
      body: "the bill",
      media: { id: "media-1", mime: "application/pdf", filename: "bill.pdf" },
      profileName: null,
    });
  });

  it("location: a readable line plus the coordinates", () => {
    const m = parseInboundMessage(
      {
        ...base,
        type: "location",
        location: {
          latitude: 12.97,
          longitude: 77.59,
          name: "Shop 4",
          address: "MG Road",
        },
      },
      [],
    );
    expect(m!.body).toBe("📍 Shop 4, MG Road");
    expect(m!.payload).toMatchObject({ latitude: 12.97, longitude: 77.59 });
  });

  it("button and interactive replies carry their id, not only their title", () => {
    const b = parseInboundMessage(
      { ...base, type: "button", button: { text: "Yes", payload: "COD_YES" } },
      [],
    );
    expect(b).toMatchObject({ kind: "button", body: "Yes" });
    expect(b!.payload).toEqual({ buttonPayload: "COD_YES" });
    const i = parseInboundMessage(
      {
        ...base,
        type: "interactive",
        interactive: {
          type: "list_reply",
          list_reply: { id: "menu_1", title: "Menu" },
        },
      },
      [],
    );
    expect(i).toMatchObject({ kind: "interactive", body: "Menu" });
    expect(i!.payload).toEqual({ replyId: "menu_1", replyType: "list" });
  });

  it("order: counts the items and keeps them for later", () => {
    const m = parseInboundMessage(
      {
        ...base,
        type: "order",
        order: {
          catalog_id: "cat",
          product_items: [
            {
              product_retailer_id: "SKU1",
              quantity: 2,
              item_price: 100,
              currency: "INR",
            },
            {
              product_retailer_id: "SKU2",
              quantity: 1,
              item_price: 50,
              currency: "INR",
            },
          ],
        },
      },
      [],
    );
    expect(m!.kind).toBe("order");
    expect(m!.body).toBe("🛒 Sent a cart with 3 items");
    expect((m!.payload as { items: unknown[] }).items).toHaveLength(2);
  });

  it("quotes, reactions and referrals", () => {
    const q = parseInboundMessage(
      {
        ...base,
        type: "text",
        text: { body: "this one" },
        context: { id: "wamid.0" },
      },
      [],
    );
    expect(q!.quotedProviderId).toBe("wamid.0");
    const r = parseInboundMessage(
      {
        ...base,
        type: "reaction",
        reaction: { message_id: "wamid.0", emoji: "👍" },
      },
      [],
    );
    expect(r).toMatchObject({
      kind: "reaction",
      body: "👍",
      quotedProviderId: "wamid.0",
    });
    const ad = parseInboundMessage(
      {
        ...base,
        type: "text",
        text: { body: "hi" },
        referral: {
          source_type: "ad",
          source_id: "123",
          headline: "Sale",
          nested: { x: 1 },
        },
      },
      [],
    );
    expect(ad!.referral).toEqual({
      source_type: "ad",
      source_id: "123",
      headline: "Sale",
    });
  });

  it("★ bounds everything a customer controls", () => {
    const m = parseInboundMessage(
      { ...base, type: "text", text: { body: "x".repeat(10_000) } },
      [{ profile: { name: "n".repeat(500) }, wa_id: "919876543210" }],
    );
    expect(m!.body!.length).toBe(MAX_BODY_CHARS);
    expect(m!.profileName!.length).toBe(200);
  });

  it("an unknown type is filed as unsupported, never dropped", () => {
    const m = parseInboundMessage(
      {
        ...base,
        type: "unknown",
        errors: [{ code: 131051, title: "Unsupported message type" }],
      },
      [],
    );
    expect(m).toMatchObject({ kind: "unsupported" });
    expect(m!.body).toContain("Unsupported message type");
  });

  it("returns null without an id or a sender", () => {
    expect(
      parseInboundMessage({ type: "text", text: { body: "x" } }, []),
    ).toBeNull();
    expect(parseInboundMessage({ id: "w", type: "text" }, [])).toBeNull();
    expect(parseInboundMessage(null, [])).toBeNull();
  });

  it("an absurd timestamp falls back to now rather than 1970", () => {
    const before = Date.now();
    const m = parseInboundMessage(
      { ...base, timestamp: "12", type: "text", text: { body: "x" } },
      [],
    );
    expect(new Date(m!.sentAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe("parseEchoMessage", () => {
  it("files the merchant's phone message against the CUSTOMER (`to`)", () => {
    const e = parseEchoMessage({
      from: "919000000000",
      to: "919876543210",
      id: "wamid.e",
      timestamp: "1760000000",
      type: "text",
      text: { body: "Yes, in stock" },
    });
    expect(e).toMatchObject({
      providerId: "wamid.e",
      waId: "919876543210",
      phone: "+919876543210",
      kind: "text",
      body: "Yes, in stock",
    });
  });
  it("null without a recipient", () => {
    expect(parseEchoMessage({ id: "x", type: "text" })).toBeNull();
  });
});

describe("helpers", () => {
  it("phoneFromWaId", () => {
    expect(phoneFromWaId("919876543210")).toBe("+919876543210");
    expect(phoneFromWaId("12")).toBeNull();
  });
  it("previewOf is one short line, labelled for media", () => {
    expect(previewOf("Hello\nthere", "text")).toBe("Hello");
    expect(previewOf(null, "image")).toBe("📷 Photo");
    expect(previewOf("look", "image")).toBe("📷 Photo · look");
    expect(previewOf("x".repeat(200), "text").length).toBe(120);
  });
});
