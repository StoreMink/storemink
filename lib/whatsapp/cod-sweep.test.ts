/* eslint-disable @typescript-eslint/no-explicit-any */
// The COD follow-up sweep: one reminder, then (only where switched on) the
// automatic cancellation. Every case below defends "never twice, never an
// order the shop or the customer has already moved on".

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));
vi.mock("@/lib/orders/approve-cancellation", () => ({
  approveCancellation: vi.fn(async () => ({ success: true, refundDue: 0 })),
}));
vi.mock("@/lib/email/trigger-worker", () => ({
  triggerEmailWorker: vi.fn(async () => {}),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { sweepCodConfirmations } from "./cod-sweep";
import { approveCancellation } from "@/lib/orders/approve-cancellation";
import { triggerEmailWorker } from "@/lib/email/trigger-worker";
import { codButtonPayloads } from "./cod-payload";
import { notificationWhatsappQueue, orders } from "@/drizzle/schema";

const STORE = "11111111-1111-4111-8111-111111111111";
const ORDER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CANDIDATE = { id: ORDER, store_id: STORE, customer_id: "cust-1" };
const SENT = {
  event_id: "evt-1",
  recipient_id: "cust-1",
  recipient_type: "customer",
  phone: "+919876543210",
  event_key: "order.placed",
  audience: "customer",
  template_id: "tpl-cod",
  values: ["Rohan", "ORD1", "₹500"],
  button_payloads: codButtonPayloads(ORDER),
};

const dialect = new PgDialect();
const sqlText = (q: any) => dialect.sqlToQuery(q).sql.replace(/\s+/g, " ");

/** `remind` and `cancel` are the two candidate reads, in sweep order. */
function setup(opts: {
  remind?: any[];
  original?: any[];
  cancel?: any[];
  claims?: any[][];
}) {
  const executeQueue: any[][] = [opts.remind ?? []];
  if ((opts.remind ?? []).length) executeQueue.push(opts.original ?? [SENT]);
  executeQueue.push(opts.cancel ?? []);
  dbHolder.current = makeDbMock({
    executeQueue,
    returningQueue: opts.claims ?? [[{ id: ORDER }]],
  });
  return dbHolder.current;
}

beforeEach(() => {
  setup({});
});

describe("sweepCodConfirmations: the reminder", () => {
  it("★ claims the one reminder and queues a copy of the message that went out", async () => {
    const mock = setup({ remind: [CANDIDATE] });
    const r = await sweepCodConfirmations();
    expect(r).toEqual({ reminded: 1, cancelled: 0, failed: 0 });
    expect(mock.calls.update).toContain(orders);
    expect(mock.calls.set[0]).toHaveProperty("codRemindedAt");
    expect(mock.calls.insert).toContain(notificationWhatsappQueue);
    expect(mock.calls.values[0]).toEqual({
      storeId: STORE,
      eventId: "evt-1",
      recipientId: "cust-1",
      recipientType: "customer",
      phone: "+919876543210",
      eventKey: "order.placed",
      audience: "customer",
      templateId: "tpl-cod",
      values: ["Rohan", "ORD1", "₹500"],
      buttonPayloads: SENT.button_payloads,
    });
    // The resend is drained now, not at the next heartbeat.
    expect(triggerEmailWorker).toHaveBeenCalledTimes(1);
    expect(approveCancellation).not.toHaveBeenCalled();
  });

  it("★★ the claim re-checks, inside the update, that nothing has moved on", async () => {
    const mock = setup({ remind: [CANDIDATE] });
    await sweepCodConfirmations();
    const where = sqlText(mock.calls.where[0]);
    expect(where).toMatch(/"cod_reminded_at" is null/);
    expect(where).toMatch(/"cod_confirmation" = \$\d/);
    expect(where).toMatch(/"status" = \$\d/);
    expect(dialect.sqlToQuery(mock.calls.where[0]).params).toEqual(
      expect.arrayContaining(["requested", "pending"]),
    );
  });

  it("★★ queues nothing when another run already claimed the reminder", async () => {
    const mock = setup({ remind: [CANDIDATE], claims: [[]] });
    const r = await sweepCodConfirmations();
    expect(r.reminded).toBe(0);
    expect(mock.calls.insert).toHaveLength(0);
    expect(triggerEmailWorker).not.toHaveBeenCalled();
  });

  it("finds the sent message by this order's own button payload", async () => {
    const mock = setup({ remind: [CANDIDATE] });
    await sweepCodConfirmations();
    const q = dialect.sqlToQuery(mock.calls.execute[1]);
    expect(q.sql).toMatch(/status = 'sent'/);
    expect(q.sql).toMatch(/button_payloads @>/);
    expect(q.params).toContain(JSON.stringify([`cod:confirm:${ORDER}`]));
  });

  it("with no sent message to repeat, keeps the claim and queues nothing", async () => {
    const mock = setup({ remind: [CANDIDATE], original: [] });
    const r = await sweepCodConfirmations();
    expect(r.reminded).toBe(0);
    expect(mock.calls.set[0]).toHaveProperty("codRemindedAt");
    expect(mock.calls.insert).toHaveLength(0);
  });

  it("★ reads only pending orders still awaiting an answer, not yet reminded, in a 24-hour window", async () => {
    const mock = setup({});
    await sweepCodConfirmations();
    const remind = sqlText(mock.calls.execute[0]);
    expect(remind).toMatch(/o\.cod_confirmation = 'requested'/);
    expect(remind).toMatch(/o\.status = 'pending'/);
    expect(remind).toMatch(/o\.cod_reminded_at is null/);
    expect(remind).toMatch(/'whatsapp\.codConfirmation'\) = 'true'::jsonb/);
    // On by default: only an explicit false turns the reminder off.
    expect(remind).toMatch(
      /'whatsapp\.codReminder'\) is distinct from 'false'::jsonb/,
    );
    const params = dialect.sqlToQuery(mock.calls.execute[0]).params;
    expect(params).toEqual(expect.arrayContaining([24, 48]));
  });
});

describe("sweepCodConfirmations: the automatic cancellation", () => {
  it("★ cancels through the one cancellation, as the system, moving no money", async () => {
    const mock = setup({ cancel: [CANDIDATE] });
    const r = await sweepCodConfirmations();
    expect(r).toEqual({ reminded: 0, cancelled: 1, failed: 0 });
    expect(approveCancellation).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: STORE,
        orderId: ORDER,
        customerId: "cust-1",
        refundDestination: "later",
        reasonCode: "not_confirmed",
        restock: true,
        notify: true,
        bySystem: true,
        onlyWhileCodAwaited: true,
        notifyInline: true,
      }),
    );
    expect(mock.calls.set).toContainEqual(
      expect.objectContaining({ codConfirmation: "expired" }),
    );
  });

  it("★★ an order confirmed a moment before is left alone and not labelled", async () => {
    vi.mocked(approveCancellation).mockResolvedValue({ error: "moved on" });
    const mock = setup({ cancel: [CANDIDATE] });
    const r = await sweepCodConfirmations();
    expect(r.cancelled).toBe(0);
    expect(mock.calls.set).not.toContainEqual(
      expect.objectContaining({ codConfirmation: "expired" }),
    );
  });

  it("★ only where the store switched it on, and 48 to 72 hours after the message", async () => {
    const mock = setup({});
    await sweepCodConfirmations();
    const cancel = sqlText(mock.calls.execute[1]);
    expect(cancel).toMatch(/'whatsapp\.codAutoCancel'\) = 'true'::jsonb/);
    expect(cancel).toMatch(/o\.status = 'pending'/);
    expect(cancel).not.toMatch(/cod_reminded_at/);
    const params = dialect.sqlToQuery(mock.calls.execute[1]).params;
    expect(params).toEqual(expect.arrayContaining([48, 72]));
  });
});

describe("sweepCodConfirmations: failures", () => {
  it("never throws: a failed read is counted and the other half still runs", async () => {
    const mock = setup({ cancel: [CANDIDATE] });
    let first = true;
    mock.db.execute.mockImplementation(async (q: any) => {
      mock.calls.execute.push(q);
      if (first) {
        first = false;
        throw new Error("db down");
      }
      return { rows: [CANDIDATE] };
    });
    const r = await sweepCodConfirmations();
    expect(r.failed).toBe(1);
    expect(r.cancelled).toBe(1);
  });

  it("a cancellation that throws is counted, not raised", async () => {
    vi.mocked(approveCancellation).mockRejectedValue(new Error("boom"));
    setup({ cancel: [CANDIDATE] });
    await expect(sweepCodConfirmations()).resolves.toEqual({
      reminded: 0,
      cancelled: 0,
      failed: 1,
    });
  });
});
