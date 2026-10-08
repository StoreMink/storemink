/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { sqlText } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));

import {
  applyAccountEvent,
  applyMessageStatus,
  explodeWebhook,
  HANDLED_FIELDS,
  STATUS_RANK,
} from "./inbound";

const delivery = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_1",
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "PN_1" },
            contacts: [{ profile: { name: "Rohan" }, wa_id: "919876543210" }],
            messages: [
              { id: "wamid.A", type: "text", text: { body: "hi" } },
              { id: "wamid.B", type: "image", image: { id: "m" } },
            ],
          },
        },
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "PN_1" },
            statuses: [
              { id: "wamid.X", status: "delivered" },
              { id: "wamid.X", status: "read" },
            ],
          },
        },
        {
          field: "message_template_status_update",
          value: {
            event: "APPROVED",
            message_template_id: 777,
            message_template_name: "sm_order_placed_v1",
            message_template_language: "en",
          },
        },
      ],
    },
  ],
};

describe("explodeWebhook", () => {
  const storeFor = ({ phoneNumberId, wabaId }: any) =>
    phoneNumberId === "PN_1" || wabaId === "WABA_1" ? "store-1" : null;

  it("makes one row per message, one per status and one per other change, all routed", () => {
    const rows = explodeWebhook(delivery, storeFor);
    expect(rows.map((r) => r.eventId)).toEqual([
      "msg:wamid.A",
      "msg:wamid.B",
      "status:wamid.X:delivered",
      "status:wamid.X:read",
      expect.stringMatching(/^[0-9a-f]{32}$/),
    ]);
    expect(rows.every((r) => r.storeId === "store-1")).toBe(true);
    expect(rows[0]!.phoneNumberId).toBe("PN_1");
    expect(rows[0]!.wabaId).toBe("WABA_1");
    // Each message row carries its own metadata and contacts.
    expect((rows[0]!.payload as any).kind).toBe("message");
    expect((rows[0]!.payload as any).contacts[0].wa_id).toBe("919876543210");
    expect((rows[2]!.payload as any).kind).toBe("status");
  });

  it("★ the same status redelivered gets the same event id — the UNIQUE makes it a no-op", () => {
    const a = explodeWebhook(delivery, storeFor);
    const b = explodeWebhook(JSON.parse(JSON.stringify(delivery)), storeFor);
    expect(a.map((r) => r.eventId)).toEqual(b.map((r) => r.eventId));
  });

  it("routes an account/template change by WABA id when there is no phone number", () => {
    const rows = explodeWebhook(delivery, ({ phoneNumberId, wabaId }: any) =>
      phoneNumberId ? null : wabaId === "WABA_1" ? "store-1" : null,
    );
    const tpl = rows.find((r) => r.field === "message_template_status_update");
    expect(tpl?.storeId).toBe("store-1");
    expect(tpl?.phoneNumberId).toBeNull();
  });

  it("records a delivery for an unknown number with a null store rather than dropping it", () => {
    const rows = explodeWebhook(delivery, () => null);
    expect(rows.length).toBe(5);
    expect(rows.every((r) => r.storeId === null)).toBe(true);
  });

  it("returns nothing for junk", () => {
    expect(explodeWebhook(null, storeFor)).toEqual([]);
    expect(explodeWebhook({ object: "page", entry: [] }, storeFor)).toEqual([]);
    expect(
      explodeWebhook(
        { object: "whatsapp_business_account", entry: [1, null, {}] },
        storeFor,
      ),
    ).toEqual([]);
  });
});

function fakeDb() {
  const updates: { table: string; set: any; where: any; returning?: any[] }[] =
    [];
  const db: any = {
    update: vi.fn((table: any) => ({
      set: vi.fn((set: any) => ({
        where: vi.fn((where: any) => {
          const rec: {
            table: string;
            set: any;
            where: any;
            returning?: any[];
          } = {
            table: tableName(table),
            set,
            where,
          };
          updates.push(rec);
          const p: any = Promise.resolve(undefined);
          p.returning = vi.fn(async () => {
            rec.returning = [];
            return [];
          });
          return p;
        }),
      })),
    })),
  };
  return { db, updates };
}
function tableName(t: any): string {
  // Drizzle tables carry their SQL name under a symbol; the test only needs to
  // tell the two tables apart.
  const s = Object.getOwnPropertySymbols(t).find((k) =>
    String(k).includes("Name"),
  );
  return s ? String(t[s]) : "unknown";
}

describe("applyAccountEvent", () => {
  it("message_template_status_update by id first, then by (name, language)", async () => {
    const { db, updates } = fakeDb();
    await applyAccountEvent(db, {
      storeId: "s",
      field: "message_template_status_update",
      value: {
        event: "REJECTED",
        reason: "INVALID_FORMAT",
        message_template_id: 777,
        message_template_name: "sm_order_placed_v1",
        message_template_language: "en",
      },
    });
    // The id-match returned no rows, so the name match ran as well.
    expect(updates.length).toBe(2);
    expect(updates[0]!.set).toMatchObject({
      status: "REJECTED",
      rejectionReason: "INVALID_FORMAT",
      providerTemplateId: "777",
    });
    expect(updates[1]!.set.status).toBe("REJECTED");
  });

  it("phone_number_quality_update writes the tier and a flag as a rating", async () => {
    const { db, updates } = fakeDb();
    await applyAccountEvent(db, {
      storeId: "s",
      field: "phone_number_quality_update",
      value: { event: "FLAGGED", current_limit: "TIER_250" },
    });
    expect(updates[0]!.set).toMatchObject({
      messagingTier: "TIER_250",
      qualityRating: "RED",
    });
  });

  it("phone_number_name_update: approval sets the name, rejection explains in lastError", async () => {
    const { db, updates } = fakeDb();
    await applyAccountEvent(db, {
      storeId: "s",
      field: "phone_number_name_update",
      value: { decision: "APPROVED", requested_verified_name: "Echos" },
    });
    expect(updates[0]!.set).toMatchObject({
      nameStatus: "APPROVED",
      verifiedName: "Echos",
    });
    await applyAccountEvent(db, {
      storeId: "s",
      field: "phone_number_name_update",
      value: {
        decision: "REJECTED",
        requested_verified_name: "Best Deals!!!",
        rejection_reason: "NAME_POLICY",
      },
    });
    expect(updates[1]!.set.nameStatus).toBe("DECLINED");
    expect(updates[1]!.set.lastError).toContain("Best Deals!!!");
  });

  it("account_update PARTNER_REMOVED marks the account needs_reauth", async () => {
    const { db, updates } = fakeDb();
    await applyAccountEvent(db, {
      storeId: "s",
      field: "account_update",
      value: { event: "PARTNER_REMOVED" },
    });
    expect(updates[0]!.set).toMatchObject({ status: "needs_reauth" });
  });

  it("an unhandled field writes nothing", async () => {
    const { db, updates } = fakeDb();
    await applyAccountEvent(db, { storeId: "s", field: "messages", value: {} });
    expect(updates).toEqual([]);
  });

  it("★ `messages` is deliberately NOT a handled field in this slice", () => {
    expect(HANDLED_FIELDS).not.toContain("messages");
  });
});

describe("applyMessageStatus", () => {
  // The update chain is captured by fakeDb; `set` holds the timeline columns.
  it("stamps delivered with Meta's timestamp and the conversation it billed to", async () => {
    const { db, updates } = fakeDb();
    await applyMessageStatus(db, {
      storeId: "s",
      value: {
        kind: "status",
        status: {
          id: "wamid.X",
          status: "delivered",
          timestamp: "1759900000",
          conversation: { id: "conv-1" },
          pricing: { category: "utility", billable: true },
        },
      },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set).toMatchObject({
      deliveredAt: new Date(1759900000 * 1000).toISOString(),
      conversationId: "conv-1",
      pricingCategory: "utility",
      billable: true,
    });
    // The status column is a SQL CASE that only moves forward.
    expect(sqlText(updates[0]!.set.status)).toMatch(/when 'read' then 3/);
  });

  it("turns a failure into Meta's code and a readable reason", async () => {
    const { db, updates } = fakeDb();
    await applyMessageStatus(db, {
      storeId: "s",
      value: {
        kind: "status",
        status: {
          id: "wamid.Y",
          status: "failed",
          timestamp: "1759900000",
          errors: [
            {
              code: 131026,
              title: "Message undeliverable",
              error_data: { details: "Recipient is not a WhatsApp user" },
            },
          ],
        },
      },
    });
    expect(updates[0]!.set).toMatchObject({
      errorCode: 131026,
      error: "Message undeliverable: Recipient is not a WhatsApp user",
    });
    expect(updates[0]!.set.failedAt).toBeTruthy();
  });

  it("ignores a status it cannot place", async () => {
    const { db, updates } = fakeDb();
    await applyMessageStatus(db, {
      storeId: "s",
      value: { kind: "status", status: { id: "wamid.Z", status: "warning" } },
    });
    await applyMessageStatus(db, { storeId: "s", value: { kind: "message" } });
    expect(updates).toHaveLength(0);
  });

  it("ranks the timeline so a late delivered cannot demote a read", () => {
    expect(STATUS_RANK.delivered).toBeLessThan(STATUS_RANK.read!);
    expect(STATUS_RANK.failed).toBeGreaterThan(STATUS_RANK.read!);
  });
});
