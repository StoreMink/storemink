/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/notifications/record", () => ({
  recordEvent: vi.fn(async () => "event-1"),
}));
vi.mock("@/lib/email/takedown-emails", async (importOriginal) => {
  const real = await importOriginal<any>();
  return {
    ...real,
    storeOwnerEmails: vi.fn(async () => ({
      emails: ["owner@acme.example", "partner@acme.example"],
      storeName: "Acme Shoes",
      slug: "acme",
      storeStatus: "active",
    })),
    sendStoreNotice: vi.fn(async (input: any) => ({
      recipients: input.to.length,
      sent: input.to.length,
      failed: 0,
    })),
    sendComplainantEmail: vi.fn(async () => ({ sent: true })),
  };
});

import { recordEvent } from "@/lib/notifications/record";
import {
  sendComplainantEmail,
  sendStoreNotice,
  storeOwnerEmails,
} from "@/lib/email/takedown-emails";
import { renderNotification } from "@/lib/notifications/render";
import {
  acknowledgeComplainant,
  indiaDateTime,
  notifyComplaintDue,
  notifyComplaintUrgent,
  notifyOperators,
  notifyTakedownReply,
  tellComplainantOutcome,
  tellStoreOfBlock,
  tellStoreOfLift,
  tellStoreOfReply,
} from "./notify";
import { COMPLAINT_KINDS, URGENT_COMPLAINT_KINDS } from "./kinds";

const STORE_X = "11111111-1111-4111-8111-111111111111";
const BLOCK = "0f9b5c1e-4a7d-4c2b-9e1f-3a2b1c0d9e8f";
const COMPLAINT = "22222222-2222-4222-8222-222222222222";

const recorded = () => vi.mocked(recordEvent).mock.calls.map(([e]) => e);

describe("operator events: always storeId null (design F9)", () => {
  const complaint = {
    id: COMPLAINT,
    refNo: 123,
    kind: "court_order" as const,
    storeId: STORE_X,
    storeName: "Acme Shoes",
  };

  it("an urgent complaint about a store is not the store's event", async () => {
    await notifyComplaintUrgent(complaint, new Date("2026-10-30T08:35:00Z"));
    expect(recorded()).toEqual([
      expect.objectContaining({
        type: "platform.complaint_urgent",
        storeId: null,
        subject: { type: "complaint", id: COMPLAINT, label: "SM-000123" },
        payload: expect.objectContaining({
          kind: "court_order",
          stage: "act",
          dueAt: "2026-10-30T08:35:00.000Z",
          storeName: "Acme Shoes",
        }),
      }),
    ]);
  });

  it("only the urgent kinds ring as urgent", async () => {
    for (const kind of COMPLAINT_KINDS) {
      vi.mocked(recordEvent).mockClear();
      await notifyComplaintUrgent({ ...complaint, kind }, new Date());
      expect(recorded().length).toBe(
        (URGENT_COMPLAINT_KINDS as readonly string[]).includes(kind) ? 1 : 0,
      );
    }
  });

  it("a deadline about a store is not the store's event", async () => {
    const now = new Date("2026-10-30T08:05:00Z");
    await notifyComplaintDue(
      complaint,
      { stage: "act", phase: "soon", dueAt: new Date("2026-10-30T08:35:00Z") },
      now,
    );
    await notifyComplaintDue(
      complaint,
      {
        stage: "acknowledge",
        phase: "overdue",
        dueAt: new Date("2026-10-30T07:55:00Z"),
      },
      now,
    );
    const [soon, overdue] = recorded();
    expect(soon).toMatchObject({
      type: "platform.complaint_due",
      storeId: null,
      payload: { stage: "act", phase: "soon", minutes: 30 },
    });
    expect(overdue).toMatchObject({
      type: "platform.complaint_due",
      storeId: null,
      payload: { stage: "acknowledge", phase: "overdue", minutes: 10 },
    });
    // And the bell reads as design 7.5 says.
    expect(
      renderNotification(
        { type: soon.type, subjectLabel: "SM-000123", payload: soon.payload },
        "operators",
      ),
    ).toEqual({
      title: "SM-000123: Remove or block due in 30 min",
      body: "Court order. Acme Shoes.",
      url: "/dashboard/complaints/SM-000123",
    });
  });

  it("a store's reply is not the store's event", async () => {
    await notifyTakedownReply({
      blockId: BLOCK,
      itemLabel: "Leather shoe",
      storeName: "Acme Shoes",
      askedForReview: true,
    });
    expect(recorded()).toEqual([
      expect.objectContaining({
        type: "platform.takedown_reply",
        storeId: null,
        subject: { type: "content_block", id: BLOCK, label: "Leather shoe" },
        payload: { storeName: "Acme Shoes", askedForReview: true },
      }),
    ]);
  });

  it("the wrapper drops a store id slipped into its input", async () => {
    await notifyOperators({
      type: "platform.complaint_due",
      storeId: STORE_X,
    } as any);
    expect(recorded()[0].storeId).toBeNull();
  });
});

describe("the store's notices", () => {
  const block = {
    blockId: BLOCK,
    storeId: STORE_X,
    kind: "product" as const,
    itemLabel: "Leather shoe",
    reasonKind: "listed_content" as const,
    complaintId: COMPLAINT,
    complaintRefNo: 123,
    storeMessage: "We blocked this product.",
    blockedAt: new Date("2026-10-30T08:35:00Z"),
  };

  it("rings the store's bell and emails every owner, under the store", async () => {
    const result = await tellStoreOfBlock(block);
    expect(result).toEqual({
      bellEventId: "event-1",
      storeFound: true,
      recipients: 2,
      sent: 2,
      failed: 0,
    });
    const [bell] = recorded();
    expect(bell).toMatchObject({
      type: "store.content_blocked",
      storeId: STORE_X,
      subject: { type: "content_block", id: BLOCK, label: "Leather shoe" },
      payload: { kind: "product", contentType: null },
    });
    expect(
      renderNotification(
        {
          type: bell.type,
          subjectId: bell.subject?.id,
          subjectLabel: bell.subject?.label,
          payload: bell.payload,
        },
        "store-admins",
      ),
    ).toEqual({
      title: "StoreMink blocked a product",
      body: "Leather shoe is hidden from your store. See why.",
      url: `/dashboard/settings/notices/${BLOCK}`,
    });
    const sent = vi.mocked(sendStoreNotice).mock.calls[0][0];
    expect(sent.storeId).toBe(STORE_X);
    expect(sent.to).toEqual(["owner@acme.example", "partner@acme.example"]);
    expect(sent.email.subject).toBe(
      "StoreMink has blocked a product on Acme Shoes",
    );
    expect(sent.email.html).toContain("30 Oct 2026");
    expect(sent.email.html).toContain("SM-000123");
    expect(sent.email.html).toContain(
      `https://acme.storemink.com/dashboard/settings/notices/${BLOCK}`,
    );
  });

  it("a whole store gets the suspension notice, named by the store", async () => {
    await tellStoreOfBlock({
      ...block,
      kind: "store",
      itemLabel: "",
      reasonKind: "court_order",
    });
    expect(recorded()[0].subject?.label).toBe("Acme Shoes");
    const sent = vi.mocked(sendStoreNotice).mock.calls[0][0];
    expect(sent.email.subject).toBe("StoreMink has suspended Acme Shoes");
    expect(sent.email.html).not.toContain("/dashboard/settings/notices");
  });

  it("can send one half alone, so a retry never rings twice", async () => {
    await tellStoreOfBlock(block, { bell: false });
    expect(recordEvent).not.toHaveBeenCalled();
    expect(sendStoreNotice).toHaveBeenCalledTimes(1);
    vi.mocked(sendStoreNotice).mockClear();
    const bellOnly = await tellStoreOfBlock(block, { email: false });
    expect(sendStoreNotice).not.toHaveBeenCalled();
    expect(bellOnly.sent).toBe(0);
  });

  it("says so when the store cannot be read", async () => {
    vi.mocked(storeOwnerEmails).mockResolvedValueOnce(null);
    const result = await tellStoreOfBlock(block);
    expect(result.storeFound).toBe(false);
    expect(sendStoreNotice).not.toHaveBeenCalled();
  });

  it("tells a lift and a reply; a suspended store's reply has no button", async () => {
    await tellStoreOfLift({ ...block, liftNote: "We looked again." });
    expect(recorded()[0]).toMatchObject({
      type: "store.content_block_lifted",
      storeId: STORE_X,
    });
    expect(vi.mocked(sendStoreNotice).mock.calls[0][0].email.subject).toBe(
      "StoreMink has lifted the block on your product",
    );

    vi.mocked(storeOwnerEmails).mockResolvedValueOnce({
      emails: ["owner@acme.example"],
      storeName: "Acme Shoes",
      slug: "acme",
      storeStatus: "suspended",
    });
    await tellStoreOfReply({
      blockId: BLOCK,
      storeId: STORE_X,
      kind: "store",
      itemLabel: "",
      reply: "We are reviewing the order.",
    });
    expect(recorded()[1]).toMatchObject({
      type: "store.content_block_reply",
      storeId: STORE_X,
    });
    const reply = vi.mocked(sendStoreNotice).mock.calls[1][0].email;
    expect(reply.subject).toBe("StoreMink replied about your suspended store");
    expect(reply.html).not.toContain("/dashboard/settings/notices");
  });
});

describe("the complainant", () => {
  const complaint = {
    id: COMPLAINT,
    refNo: 123,
    kind: "data_request" as const,
    storeId: STORE_X,
    receivedAt: new Date("2026-10-30T08:35:00Z"),
  };

  it("acknowledges with the time in India and the reference", async () => {
    expect(indiaDateTime(complaint.receivedAt)).toBe("30 Oct 2026, 14:05 IST");
    await acknowledgeComplainant({
      to: "asha@example.com",
      name: "Asha",
      complaint,
      recorded: { summary: "My data.", addresses: [] },
    });
    const call = vi.mocked(sendComplainantEmail).mock.calls[0][0];
    expect(call.to).toBe("asha@example.com");
    expect(call.complaint).toBe(complaint);
    expect(call.email.subject).toBe(
      "We received your complaint (reference SM-000123)",
    );
    expect(call.email.html).toContain("30 Oct 2026, 14:05 IST");
  });

  it("tells the decision", async () => {
    await tellComplainantOutcome({
      to: "asha@example.com",
      name: null,
      complaint,
      outcome: "answered",
      note: "Here is your data.",
    });
    expect(vi.mocked(sendComplainantEmail).mock.calls[0][0].email.subject).toBe(
      "Your complaint SM-000123: our decision",
    );
  });
});
