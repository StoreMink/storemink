/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sqlParamValues, sqlText } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("./templates", () => ({
  syncWhatsAppTemplates: vi.fn(async () => ({ ok: true, updated: 1 })),
}));
vi.mock("./connect", () => ({
  refreshWhatsAppAccount: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./sms-fallback", () => ({
  releaseHeldSms: vi.fn(async () => true),
  dropHeldSms: vi.fn(async () => true),
}));

import {
  applyAccountEvent,
  applyMessageStatus,
  explodeWebhook,
  HANDLED_FIELDS,
  HANDLED_MESSAGE_KINDS,
  MAX_INBOUND_ATTEMPTS,
  processPendingInboundEvents,
  routeInboundEvent,
  STATUS_RANK,
} from "./inbound";
import { withService } from "@/lib/db/client";
import { syncWhatsAppTemplates } from "./templates";
import { refreshWhatsAppAccount } from "./connect";
import { dropHeldSms, releaseHeldSms } from "./sms-fallback";

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

describe("routeInboundEvent", () => {
  const byPhone = new Map([
    ["PN_1", "store-1"],
    ["PN_2", "store-2"],
  ]);
  const byWaba = new Map([["WABA_1", new Set(["store-2", "store-1"])]]);

  it("★★ a row naming a number goes to that number's store or to nobody", () => {
    expect(
      routeInboundEvent(
        { phoneNumberId: "PN_1", wabaId: "WABA_1" },
        byPhone,
        byWaba,
      ),
    ).toEqual(["store-1"]);
    // A number no store holds on a WABA a store does hold: NOT that store.
    expect(
      routeInboundEvent(
        { phoneNumberId: "PN_9", wabaId: "WABA_1" },
        byPhone,
        byWaba,
      ),
    ).toEqual([]);
  });

  it("★ a change naming no number goes to every store holding the WABA", () => {
    expect(
      routeInboundEvent(
        { phoneNumberId: null, wabaId: "WABA_1" },
        byPhone,
        byWaba,
      ),
    ).toEqual(["store-1", "store-2"]);
    expect(
      routeInboundEvent(
        { phoneNumberId: null, wabaId: "WABA_X" },
        byPhone,
        byWaba,
      ),
    ).toEqual([]);
    expect(
      routeInboundEvent({ phoneNumberId: null, wabaId: null }, byPhone, byWaba),
    ).toEqual([]);
  });
});

function fakeDb(queueRows: any[] = []) {
  const updates: { table: string; set: any; where: any; returning?: any[] }[] =
    [];
  const db: any = {
    // Slice 3's thread update (applyStatusToMessage) is raw SQL; it is not
    // what these tests assert, so it answers with no rows.
    execute: vi.fn(async () => ({ rows: [] })),
    // The queue rows a status settles (0211).
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => queueRows) })),
    })),
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
  it("★ a template or number change is never applied from its payload", async () => {
    const { db, updates } = fakeDb();
    for (const field of [
      "message_template_status_update",
      "message_template_quality_update",
      "template_category_update",
      "phone_number_quality_update",
      "phone_number_name_update",
    ]) {
      await applyAccountEvent(db, {
        storeId: "s",
        field,
        value: { event: "REJECTED", message_template_id: 777 },
      });
    }
    expect(updates).toEqual([]);
  });

  it("a restriction is recorded in the card's words", async () => {
    const { db, updates } = fakeDb();
    await applyAccountEvent(db, {
      storeId: "s",
      field: "account_update",
      value: {
        event: "ACCOUNT_RESTRICTION",
        restriction_info: { waba_ban_state: "SCHEDULE_FOR_DISABLE" },
      },
    });
    expect(updates[0]!.set.lastError).toContain("account restriction");
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

  it("★★ a failed status releases the SMS held behind the notification", async () => {
    const { db } = fakeDb([{ id: "q1", buttonPayloads: null }]);
    const r = await applyMessageStatus(db, {
      storeId: "s",
      value: {
        kind: "status",
        status: { id: "wamid.Y", status: "failed", timestamp: "1759900000" },
      },
    });
    expect(releaseHeldSms).toHaveBeenCalledWith(db, "q1");
    expect(dropHeldSms).not.toHaveBeenCalled();
    expect(r.smsReleased).toBe(1);
  });

  it("★ delivered or read drops it: the WhatsApp reached them", async () => {
    const { db } = fakeDb([{ id: "q1", buttonPayloads: null }]);
    await applyMessageStatus(db, {
      storeId: "s",
      value: { kind: "status", status: { id: "wamid.Y", status: "read" } },
    });
    expect(dropHeldSms).toHaveBeenCalledWith(db, "q1");
    expect(releaseHeldSms).not.toHaveBeenCalled();
  });

  it("a plain `sent` settles nothing", async () => {
    const { db } = fakeDb([{ id: "q1", buttonPayloads: null }]);
    await applyMessageStatus(db, {
      storeId: "s",
      value: { kind: "status", status: { id: "wamid.Y", status: "sent" } },
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("★★ a failed COD confirmation marks the order undelivered, never 'not confirmed'", async () => {
    const ORDER = "11111111-2222-4333-8444-555555555555";
    const { db } = fakeDb([
      {
        id: "q1",
        buttonPayloads: [`cod:confirm:${ORDER}`, `cod:cancel:${ORDER}`],
      },
    ]);
    await applyMessageStatus(db, {
      storeId: "s",
      value: {
        kind: "status",
        status: { id: "wamid.Y", status: "failed", timestamp: "1759900000" },
      },
    });
    const cod = db.execute.mock.calls
      .map(([q]: any) => q)
      .find((q: any) => /cod_confirmation = 'undelivered'/.test(sqlText(q)));
    expect(cod).toBeTruthy();
    const text = sqlText(cod).replace(/\s+/g, " ");
    // Only from 'requested', and not when an earlier copy was delivered.
    expect(text).toMatch(/o\.cod_confirmation = 'requested'/);
    expect(text).toMatch(/l\.status in \('delivered', 'read'\)/);
    expect(sqlParamValues(cod)).toEqual(
      expect.arrayContaining([ORDER, "s", `cod:confirm:${ORDER}`]),
    );
  });

  it("ranks the timeline so a late delivered cannot demote a read", () => {
    expect(STATUS_RANK.delivered).toBeLessThan(STATUS_RANK.read!);
    expect(STATUS_RANK.failed).toBeGreaterThan(STATUS_RANK.read!);
  });
});

describe("slice 3: echoes and the message selector", () => {
  it("explodes a Coexistence echo into one row per message, keyed on its id", () => {
    const rows = explodeWebhook(
      {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WABA_1",
            changes: [
              {
                field: "smb_message_echoes",
                value: {
                  metadata: { phone_number_id: "PN_1" },
                  message_echoes: [
                    {
                      from: "919000000000",
                      to: "919876543210",
                      id: "wamid.e1",
                      type: "text",
                      text: { body: "Yes" },
                    },
                    {
                      from: "919000000000",
                      to: "919876543210",
                      id: "wamid.e2",
                      type: "image",
                      image: { id: "m" },
                    },
                    { from: "919000000000", to: "919876543210", type: "text" },
                  ],
                },
              },
            ],
          },
        ],
      },
      ({ phoneNumberId }: any) => (phoneNumberId === "PN_1" ? "store-1" : null),
    );
    expect(rows.map((r) => r.eventId)).toEqual([
      "echo:wamid.e1",
      "echo:wamid.e2",
    ]);
    expect(rows[0]!.field).toBe("smb_message_echoes");
    expect((rows[0]!.payload as any).kind).toBe("echo");
    expect((rows[0]!.payload as any).message.to).toBe("919876543210");
    expect(rows[0]!.storeId).toBe("store-1");
  });

  it("★ inbound messages and echoes are now claimed; nothing else new is", () => {
    expect(HANDLED_FIELDS).toContain("smb_message_echoes");
    expect(HANDLED_MESSAGE_KINDS).toEqual(["status", "message"]);
    // Contact/history sync under Coexistence waits for its own handler.
    expect(HANDLED_FIELDS).not.toContain("smb_app_state_sync");
  });
});

describe("processPendingInboundEvents", () => {
  function claimDb(rows: any[]) {
    const executed: any[] = [];
    const updates: any[] = [];
    const db: any = {
      execute: vi.fn(async (q: any) => {
        executed.push(q);
        // The first statement is the claim; the rest answer with nothing.
        return { rows: executed.length === 1 ? rows : [] };
      }),
      update: vi.fn(() => ({
        set: vi.fn((set: any) => ({
          where: vi.fn(async () => {
            updates.push(set);
          }),
        })),
      })),
    };
    vi.mocked(withService).mockImplementation((async (fn: any) =>
      fn(db)) as any);
    return { db, executed, updates };
  }
  const row = (over: Record<string, unknown> = {}) => ({
    id: "e1",
    store_id: "s",
    waba_id: "WABA_1",
    phone_number_id: null,
    field: "message_template_status_update",
    payload: { event: "APPROVED", message_template_id: 777 },
    attempts: 1,
    received_at: "2026-10-16 10:00:00+00",
    ...over,
  });

  beforeEach(() => {
    vi.mocked(syncWhatsAppTemplates).mockResolvedValue({
      ok: true,
      updated: 1,
    });
    vi.mocked(refreshWhatsAppAccount).mockResolvedValue({ ok: true });
  });

  it("★★ claims with a lease and an attempt, in one statement", async () => {
    const { executed } = claimDb([]);
    await processPendingInboundEvents();
    const claim = sqlText(executed[0]).replace(/\s+/g, " ");
    expect(claim).toMatch(/set attempts = e\.attempts \+ 1/);
    expect(claim).toMatch(
      /next_attempt_at is null or next_attempt_at <= now\(\)/,
    );
    expect(claim).toMatch(/for update skip locked/);
  });

  it("★★ re-reads a template change from Meta, once per store per batch", async () => {
    const { updates } = claimDb([row(), row({ id: "e2" })]);
    const r = await processPendingInboundEvents();
    expect(syncWhatsAppTemplates).toHaveBeenCalledTimes(1);
    expect(syncWhatsAppTemplates).toHaveBeenCalledWith("s");
    expect(r).toMatchObject({ claimed: 2, processed: 2 });
    // Both marked processed, neither from its payload.
    expect(updates.filter((u) => u.processedAt)).toHaveLength(2);
  });

  it("★★ a redelivered PARTNER_REMOVED does not flip an account Meta still accepts", async () => {
    const { updates } = claimDb([
      row({ field: "account_update", payload: { event: "PARTNER_REMOVED" } }),
    ]);
    await processPendingInboundEvents();
    expect(refreshWhatsAppAccount).toHaveBeenCalledWith("s");
    expect(updates.some((u) => u.status === "needs_reauth")).toBe(false);
  });

  it("…but stands when Meta will not confirm the account", async () => {
    vi.mocked(refreshWhatsAppAccount).mockResolvedValue({
      ok: false,
      error: "Meta no longer accepts this connection. Reconnect WhatsApp.",
    });
    const { updates } = claimDb([
      row({ field: "account_update", payload: { event: "PARTNER_REMOVED" } }),
    ]);
    await processPendingInboundEvents();
    expect(updates.some((u) => u.status === "needs_reauth")).toBe(true);
  });

  it("★★ a failure is retried with a backoff, not marked processed", async () => {
    vi.mocked(syncWhatsAppTemplates).mockResolvedValue({
      ok: false,
      updated: 0,
      error: "Meta didn't answer. Try again in a minute.",
    });
    const { executed } = claimDb([row()]);
    const r = await processPendingInboundEvents();
    expect(r).toMatchObject({ retrying: 1, failed: 0, processed: 0 });
    const failed = executed
      .map((q) => sqlText(q).replace(/\s+/g, " "))
      .find((t) => /set error =/.test(t));
    expect(failed).toMatch(/processed_at = null/);
    expect(failed).toMatch(/next_attempt_at = now\(\) \+ make_interval/);
  });

  it("…and given up on, with its error kept, after the last attempt", async () => {
    vi.mocked(syncWhatsAppTemplates).mockResolvedValue({
      ok: false,
      updated: 0,
      error: "Meta refused: nope",
    });
    const { executed } = claimDb([row({ attempts: MAX_INBOUND_ATTEMPTS })]);
    const r = await processPendingInboundEvents();
    expect(r).toMatchObject({ retrying: 0, failed: 1 });
    const failed = executed
      .map((q) => sqlText(q).replace(/\s+/g, " "))
      .find((t) => /set error =/.test(t));
    expect(failed).toMatch(/processed_at = now\(\)/);
  });
});
