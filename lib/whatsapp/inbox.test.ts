/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: true,
  gcsUploadObject: vi.fn(async (path: string) => `https://x/${path}`),
}));
vi.mock("@/lib/payments/crypto", () => ({
  decryptSecret: vi.fn(() => "tok"),
}));
vi.mock("./graph", () => ({
  getMediaInfo: vi.fn(),
  downloadMedia: vi.fn(),
}));

import {
  applyStatusToMessage,
  inboundMediaPath,
  recordEchoMessage,
  recordInboundMessage,
  recordOutboundMessage,
  serviceWindow,
  storeInboundMedia,
} from "./inbox";
import { downloadMedia, getMediaInfo } from "./graph";
import { gcsUploadObject } from "@/lib/storage/gcs";

const STORE = "11111111-1111-4111-8111-111111111111";

const inbound = (over: Record<string, unknown> = {}) => ({
  kind: "message",
  contacts: [{ profile: { name: "Rohan" }, wa_id: "919876543210" }],
  message: {
    from: "919876543210",
    id: "wamid.1",
    timestamp: "1760000000",
    type: "text",
    text: { body: "Is it in stock?" },
    ...over,
  },
});

describe("serviceWindow", () => {
  it("opens for 24 hours from the customer's last message, exactly", () => {
    const now = Date.parse("2026-10-08T10:00:00Z");
    const at = new Date(now - 23 * 3600_000).toISOString();
    expect(serviceWindow(at, now)).toEqual({
      open: true,
      closesAt: new Date(now + 3600_000).toISOString(),
    });
    expect(
      serviceWindow(new Date(now - 24 * 3600_000).toISOString(), now).open,
    ).toBe(false);
    expect(serviceWindow(null, now)).toEqual({ open: false, closesAt: null });
    expect(serviceWindow("junk", now).open).toBe(false);
  });
});

describe("recordInboundMessage", () => {
  beforeEach(() => {
    dbHolder.current = makeDbMock({
      executeQueue: [
        // contact upsert
        [
          {
            id: "k1",
            user_id: null,
            marketing_opt_in_at: null,
            marketing_opt_out_at: null,
          },
        ],
        // conversation ensure — it was OPEN, so this message makes it needs_reply
        [{ id: "c1", status: "open" }],
        // the bump
        [],
      ],
      returningQueue: [[{ id: "m1" }]],
    });
  });

  it("files the message, bumps the conversation and asks for the bell", async () => {
    const r = await recordInboundMessage(dbHolder.current.db, {
      storeId: STORE,
      value: inbound(),
    });
    expect(r).toMatchObject({
      inserted: true,
      contactId: "k1",
      conversationId: "c1",
      messageId: "m1",
      needsNotify: true,
      kind: "text",
      preview: "Is it in stock?",
      contactLabel: "Rohan",
    });
    const { calls } = dbHolder.current;
    // ★ The window clock moves on the CONTACT, with the message's time.
    const contactSql = sqlText(calls.execute[0]);
    expect(contactSql).toContain("insert into public.whatsapp_contacts");
    expect(contactSql).toContain("last_inbound_at");
    expect(sqlParamValues(calls.execute[0])).toContain("+919876543210");
    // The message row carries Meta's id, which is the dedupe key.
    expect(calls.values[0]).toMatchObject({
      direction: "in",
      source: "customer",
      kind: "text",
      providerMessageId: "wamid.1",
      status: "received",
    });
    // The bump reopens and counts.
    const bump = sqlText(calls.execute[2]);
    expect(bump).toContain("else 'needs_reply' end");
    expect(bump).toMatch(
      /unread_count = unread_count \+ case when .* then 0 else 1 end/,
    );
    // An ordinary message is not automated: it asks for a reply and counts.
    expect(sqlParamValues(calls.execute[2])).toContain(false);
  });

  it("★ a COD button tap is filed but neither counts nor asks for a reply", async () => {
    const ORDER = "22222222-3333-4444-8555-666666666666";
    const r = await recordInboundMessage(dbHolder.current.db, {
      storeId: STORE,
      value: inbound({
        type: "button",
        text: undefined,
        button: { text: "Confirm order", payload: `cod:confirm:${ORDER}` },
      }),
    });
    expect(r).toMatchObject({
      inserted: true,
      kind: "button",
      needsNotify: false,
      codReply: { action: "confirm", orderId: ORDER },
      phone: "+919876543210",
    });
    // The bump is told this message was automated.
    expect(sqlParamValues(dbHolder.current.calls.execute[2])).toContain(true);
  });

  it("a button tap we did not write is an ordinary message", async () => {
    const r = await recordInboundMessage(dbHolder.current.db, {
      storeId: STORE,
      value: inbound({
        type: "button",
        text: undefined,
        button: { text: "Yes", payload: "something-else" },
      }),
    });
    expect(r.codReply).toBeNull();
    expect(r.needsNotify).toBe(true);
    expect(sqlParamValues(dbHolder.current.calls.execute[2])).toContain(false);
  });

  it("★ a conversation already waiting does not ring the bell again", async () => {
    dbHolder.current = makeDbMock({
      executeQueue: [
        [
          {
            id: "k1",
            user_id: "u1",
            marketing_opt_in_at: null,
            marketing_opt_out_at: null,
          },
        ],
        [{ id: "c1", status: "needs_reply" }],
        [],
      ],
      returningQueue: [[{ id: "m2" }]],
    });
    const r = await recordInboundMessage(dbHolder.current.db, {
      storeId: STORE,
      value: inbound({ id: "wamid.2" }),
    });
    expect(r.inserted).toBe(true);
    expect(r.needsNotify).toBe(false);
    expect(r.userId).toBe("u1");
  });

  it("★ a redelivered message changes nothing: no bump, no bell", async () => {
    dbHolder.current = makeDbMock({
      executeQueue: [
        [
          {
            id: "k1",
            user_id: null,
            marketing_opt_in_at: null,
            marketing_opt_out_at: null,
          },
        ],
        [{ id: "c1", status: "open" }],
      ],
      // DO NOTHING matched the UNIQUE: nothing returned.
      returningQueue: [[]],
    });
    const r = await recordInboundMessage(dbHolder.current.db, {
      storeId: STORE,
      value: inbound(),
    });
    expect(r.inserted).toBe(false);
    expect(r.needsNotify).toBe(false);
    expect(dbHolder.current.calls.execute).toHaveLength(2);
  });

  it("STOP marks the contact out of offers and flags the message", async () => {
    const r = await recordInboundMessage(dbHolder.current.db, {
      storeId: STORE,
      value: inbound({ text: { body: "STOP" } }),
    });
    expect(r.inserted).toBe(true);
    const { calls } = dbHolder.current;
    expect(calls.set[0]).toMatchObject({
      marketingOptOutAt: expect.any(String),
    });
    expect(calls.set[1]).toEqual({ payload: { intent: "stop" } });
  });

  it("★ STOP is answered by the system: reported for a reply, never Needs reply or the bell", async () => {
    const r = await recordInboundMessage(dbHolder.current.db, {
      storeId: STORE,
      value: inbound({ text: { body: "STOP" } }),
    });
    expect(r).toMatchObject({
      optOut: "stop",
      needsNotify: false,
      phone: "+919876543210",
    });
    expect(sqlParamValues(dbHolder.current.calls.execute[2])).toContain(true);
  });

  it("START from somebody who never agreed to offers is an ordinary message", async () => {
    const r = await recordInboundMessage(dbHolder.current.db, {
      storeId: STORE,
      value: inbound({ text: { body: "start" } }),
    });
    expect(r.optOut).toBeNull();
    expect(r.needsNotify).toBe(true);
    expect(sqlParamValues(dbHolder.current.calls.execute[2])).toContain(false);
  });

  it("★ START re-opts in only somebody who had opted in before", async () => {
    await recordInboundMessage(dbHolder.current.db, {
      storeId: STORE,
      value: inbound({ text: { body: "start" } }),
    });
    // Never opted in → nothing written to the contact.
    expect(dbHolder.current.calls.set).toHaveLength(0);

    dbHolder.current = makeDbMock({
      executeQueue: [
        [
          {
            id: "k1",
            user_id: null,
            marketing_opt_in_at: "2026-01-01T00:00:00Z",
            marketing_opt_out_at: "2026-02-01T00:00:00Z",
          },
        ],
        [{ id: "c1", status: "open" }],
        [],
      ],
      returningQueue: [[{ id: "m3" }]],
    });
    await recordInboundMessage(dbHolder.current.db, {
      storeId: STORE,
      value: inbound({ text: { body: "start" } }),
    });
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      marketingOptInAt: expect.any(String),
      marketingOptOutAt: null,
    });
  });

  it("hands media back to be fetched after the commit", async () => {
    const r = await recordInboundMessage(dbHolder.current.db, {
      storeId: STORE,
      value: inbound({
        type: "image",
        image: { id: "media-9", mime_type: "image/jpeg" },
        text: undefined,
      }),
    });
    expect(r.media).toEqual({
      id: "media-9",
      mime: "image/jpeg",
      filename: null,
    });
    expect(r.kind).toBe("image");
    expect(r.preview).toBe("📷 Photo");
  });

  it("throws on an item that is not a message, so the event is marked with the error", async () => {
    await expect(
      recordInboundMessage(dbHolder.current.db, {
        storeId: STORE,
        value: { kind: "message", message: { type: "text" } },
      }),
    ).rejects.toThrow(/no id or sender/);
  });
});

describe("recordEchoMessage", () => {
  it("files the merchant's phone message as outbound and marks the conversation answered", async () => {
    dbHolder.current = makeDbMock({
      executeQueue: [
        [
          {
            id: "k1",
            user_id: null,
            marketing_opt_in_at: null,
            marketing_opt_out_at: null,
          },
        ],
        [{ id: "c1", status: "needs_reply" }],
        [],
      ],
      returningQueue: [[{ id: "m1" }]],
    });
    const r = await recordEchoMessage(dbHolder.current.db, {
      storeId: STORE,
      value: {
        kind: "echo",
        message: {
          from: "919000000000",
          to: "919876543210",
          id: "wamid.e",
          timestamp: "1760000000",
          type: "text",
          text: { body: "Yes" },
        },
      },
    });
    expect(r).toMatchObject({ inserted: true, needsNotify: false });
    const { calls } = dbHolder.current;
    // ★ The window clock does NOT move for an echo.
    expect(sqlParamValues(calls.execute[0])).toContain(null);
    expect(calls.values[0]).toMatchObject({
      direction: "out",
      source: "phone_app",
      status: "sent",
    });
    expect(sqlText(calls.execute[2])).toContain("status = 'open'");
    expect(sqlText(calls.execute[2])).not.toContain("unread_count + 1");
  });
});

describe("recordOutboundMessage", () => {
  it("a sent reply opens the conversation and clears unread; a failed one records only itself", async () => {
    dbHolder.current = makeDbMock({ returningQueue: [[{ id: "m1" }]] });
    await recordOutboundMessage(dbHolder.current.db, {
      storeId: STORE,
      conversationId: "c1",
      source: "dashboard",
      kind: "text",
      body: "Hello",
      providerMessageId: "wamid.o",
      status: "sent",
      sentByAdminId: "a1",
    });
    expect(sqlText(dbHolder.current.calls.execute[0])).toContain(
      "unread_count = 0",
    );

    dbHolder.current = makeDbMock({ returningQueue: [[{ id: "m2" }]] });
    await recordOutboundMessage(dbHolder.current.db, {
      storeId: STORE,
      conversationId: "c1",
      source: "dashboard",
      kind: "text",
      body: "Hello",
      providerMessageId: null,
      status: "failed",
      error: "131047",
    });
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });
});

describe("applyStatusToMessage", () => {
  it("only ever moves an OUTBOUND message forward", async () => {
    dbHolder.current = makeDbMock();
    await applyStatusToMessage(dbHolder.current.db, {
      storeId: STORE,
      providerMessageId: "wamid.o",
      status: "delivered",
    });
    const text = sqlText(dbHolder.current.calls.execute[0]);
    expect(text).toContain("direction = 'out'");
    expect(text).toContain("< ");
    expect(sqlParamValues(dbHolder.current.calls.execute[0])).toContain(
      "delivered",
    );
  });
  it("ignores a status it does not know", async () => {
    dbHolder.current = makeDbMock();
    await applyStatusToMessage(dbHolder.current.db, {
      storeId: STORE,
      providerMessageId: "x",
      status: "warning",
    });
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });
});

describe("storeInboundMedia", () => {
  it("copies the file under the store's own prefix and points the message at it", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ tokenEnc: "enc", status: "connected" }]],
    });
    vi.mocked(getMediaInfo).mockResolvedValue({
      ok: true,
      data: {
        id: "media-9",
        url: "https://lookaside.fbsbx.com/x",
        mime_type: "image/jpeg",
        file_size: 10,
      },
    });
    vi.mocked(downloadMedia).mockResolvedValue({
      ok: true,
      data: { bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" },
    });
    await storeInboundMedia({
      storeId: STORE,
      conversationId: "c1",
      messageId: "m1",
      media: { id: "media-9", mime: "image/jpeg", filename: null },
    });
    expect(gcsUploadObject).toHaveBeenCalledWith(
      `stores/${STORE}/whatsapp/c1/m1.jpg`,
      expect.any(Uint8Array),
      "image/jpeg",
      "private, max-age=0",
    );
    expect(dbHolder.current.calls.set.at(-1)).toMatchObject({
      mediaPath: `stores/${STORE}/whatsapp/c1/m1.jpg`,
    });
  });

  it("a failed fetch leaves the message with an error, never a half-path", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ tokenEnc: "enc", status: "connected" }]],
    });
    vi.mocked(getMediaInfo).mockResolvedValue({
      ok: false,
      outcome: "rejected",
      error: "gone",
    });
    await storeInboundMedia({
      storeId: STORE,
      conversationId: "c1",
      messageId: "m1",
      media: { id: "media-9", mime: null, filename: null },
    });
    expect(gcsUploadObject).not.toHaveBeenCalledTimes(2);
    expect(dbHolder.current.calls.set.at(-1)).toMatchObject({
      error: expect.stringContaining("gone"),
    });
  });

  it("inboundMediaPath keeps a safe extension", () => {
    expect(inboundMediaPath("s", "c", "m", "application/pdf")).toBe(
      "stores/s/whatsapp/c/m.pdf",
    );
    expect(inboundMediaPath("s", "c", "m", "text/html")).toBe(
      "stores/s/whatsapp/c/m",
    );
  });
});
