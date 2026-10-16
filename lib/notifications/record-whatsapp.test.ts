/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// The WhatsApp branch of the fan-out, and the ONE-MESSAGE-PER-PERSON rule it
// shares with SMS (docs/whatsapp-commerce-plan.md §8, §19.3). The channel
// loaders are mocked so each case states its four conditions outright —
// sender, switch, approved template, consent — and the rows pushed onto the
// two queues are what is asserted.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("next/server", () => ({ after: vi.fn((fn: any) => fn()) }));
vi.mock("@/lib/sms/channel", () => ({
  loadSmsSender: vi.fn(),
  loadSmsTemplates: vi.fn(),
  phonesForRecipients: vi.fn(),
}));
vi.mock("@/lib/whatsapp/channel", () => ({
  loadWhatsAppSender: vi.fn(),
  loadWhatsAppTemplates: vi.fn(),
  whatsAppConsentFor: vi.fn(),
}));
vi.mock("@/lib/email/trigger-worker", () => ({
  triggerEmailWorker: vi.fn(async () => {}),
}));

import { recordEvent } from "./record";
import {
  loadSmsSender,
  loadSmsTemplates,
  phonesForRecipients,
} from "@/lib/sms/channel";
import {
  loadWhatsAppSender,
  loadWhatsAppTemplates,
  whatsAppConsentFor,
} from "@/lib/whatsapp/channel";
import { triggerEmailWorker } from "@/lib/email/trigger-worker";
import {
  notificationEmailQueue,
  notificationSmsQueue,
  notificationWhatsappQueue,
} from "@/drizzle/schema";

const STORE = "store-1";
const EVENT_ID = "event-1";
const CUSTOMER = "uid-cust";
const PHONE = "+919876543210";

function setupDb() {
  dbHolder.current = makeDbMock({
    returning: [{ id: EVENT_ID }],
    selectQueue: [
      [], // notification_definitions
      [
        {
          eventKey: "order.placed",
          channels: { customer: { whatsapp: true, sms: true } },
          routing: "permission",
          targetRoles: [],
          targetAdmins: [],
          templates: {},
          digest: "instant",
          isEnabled: true,
          storeName: "Acme",
        },
      ],
      [], // staff
      [], // roles
      [], // admin_locations
      [], // prefs
      [], // customer email
    ],
  });
  return dbHolder.current;
}

function queued(mock: any, table: any) {
  const idx = mock.calls.insert.findIndex((t: any) => t === table);
  if (idx === -1) return [];
  const rows = mock.calls.values[idx];
  return Array.isArray(rows) ? rows : [rows];
}

const WA_SENDER = (
  precedence: "whatsapp_first" | "sms_first" | "both",
  codConfirmation = false,
) => ({
  token: "t",
  wabaId: "W",
  phoneNumberId: "P",
  displayPhone: "+91",
  precedence,
  codConfirmation,
});
const WA_TEMPLATE = {
  id: "wt-1",
  audience: "customer",
  name: "sm_order_placed_customer_v1",
  language: "en",
  variables: ["store_name", "subject_label", "total", "payment_method"],
  body: "x",
};
const SMS_TEMPLATE = {
  audience: "customer",
  dltTemplateId: "1107",
  body: "Order {#var#} at {#var#}.",
  variables: ["subject_label", "store_name"],
};

async function placeOrder() {
  return recordEvent({
    type: "order.placed",
    storeId: STORE,
    customerId: CUSTOMER,
    subject: { label: "ORD1" },
    payload: { total: 1240, payment_method: "cod" },
  });
}

beforeEach(() => {
  vi.mocked(phonesForRecipients).mockResolvedValue(
    new Map([[CUSTOMER, PHONE]]),
  );
  vi.mocked(loadWhatsAppSender).mockResolvedValue(WA_SENDER("whatsapp_first"));
  vi.mocked(loadWhatsAppTemplates).mockResolvedValue(
    new Map([["customer", WA_TEMPLATE]]),
  );
  vi.mocked(whatsAppConsentFor).mockResolvedValue(
    new Map([[PHONE, { updates: true, marketing: false }]]),
  );
  vi.mocked(loadSmsSender).mockResolvedValue({
    creds: { accountSid: "AC", authToken: "x" },
    senderHeader: "ACMEJU",
    dltEntityId: "1",
  });
  vi.mocked(loadSmsTemplates).mockResolvedValue(
    new Map([["customer", SMS_TEMPLATE]]),
  );
});

describe("WhatsApp fan-out", () => {
  it("queues a template message with positional values for a consenting customer", async () => {
    const mock = setupDb();
    await placeOrder();
    const rows = queued(mock, notificationWhatsappQueue);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      storeId: STORE,
      eventId: EVENT_ID,
      recipientId: CUSTOMER,
      recipientType: "customer",
      phone: PHONE,
      eventKey: "order.placed",
      audience: "customer",
      templateId: "wt-1",
    });
    // Formatted once, by the same formatter the email path uses.
    expect(rows[0].values).toEqual([
      "Acme",
      "ORD1",
      "₹1,240.00",
      "Cash on delivery",
    ]);
  });

  it("★ WhatsApp first: the SMS is NOT queued for someone who got the WhatsApp", async () => {
    const mock = setupDb();
    await placeOrder();
    expect(queued(mock, notificationWhatsappQueue)).toHaveLength(1);
    expect(queued(mock, notificationSmsQueue)).toHaveLength(0);
  });

  it("★ …but the SMS IS the fallback when the customer never opted in", async () => {
    vi.mocked(whatsAppConsentFor).mockResolvedValue(new Map());
    const mock = setupDb();
    await placeOrder();
    expect(queued(mock, notificationWhatsappQueue)).toHaveLength(0);
    expect(queued(mock, notificationSmsQueue)).toHaveLength(1);
  });

  it("…and when the template is not approved", async () => {
    vi.mocked(loadWhatsAppTemplates).mockResolvedValue(new Map());
    const mock = setupDb();
    await placeOrder();
    expect(queued(mock, notificationWhatsappQueue)).toHaveLength(0);
    expect(queued(mock, notificationSmsQueue)).toHaveLength(1);
  });

  it("…and when the number is paused, lapsed or disconnected", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(null);
    const mock = setupDb();
    await placeOrder();
    expect(queued(mock, notificationWhatsappQueue)).toHaveLength(0);
    expect(queued(mock, notificationSmsQueue)).toHaveLength(1);
    // Nothing further was asked of the WhatsApp side.
    expect(loadWhatsAppTemplates).not.toHaveBeenCalled();
  });

  it("SMS first: the WhatsApp is the fallback", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(WA_SENDER("sms_first"));
    const mock = setupDb();
    await placeOrder();
    expect(queued(mock, notificationSmsQueue)).toHaveLength(1);
    expect(queued(mock, notificationWhatsappQueue)).toHaveLength(0);

    vi.mocked(loadSmsSender).mockResolvedValue(null);
    const mock2 = setupDb();
    await placeOrder();
    expect(queued(mock2, notificationSmsQueue)).toHaveLength(0);
    expect(queued(mock2, notificationWhatsappQueue)).toHaveLength(1);
  });

  it("both: the deliberate duplicate", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(WA_SENDER("both"));
    const mock = setupDb();
    await placeOrder();
    expect(queued(mock, notificationSmsQueue)).toHaveLength(1);
    expect(queued(mock, notificationWhatsappQueue)).toHaveLength(1);
  });

  it("asks for phones ONCE for both channels", async () => {
    setupDb();
    await placeOrder();
    expect(phonesForRecipients).toHaveBeenCalledTimes(1);
  });

  it("loads nothing when neither switch is on", async () => {
    dbHolder.current = makeDbMock({
      returning: [{ id: EVENT_ID }],
      selectQueue: [[], [], [], [], [], [], []],
    });
    await placeOrder();
    expect(loadWhatsAppSender).not.toHaveBeenCalled();
    expect(loadSmsSender).not.toHaveBeenCalled();
  });
});

// The fixture switches WhatsApp and SMS on with NO email channel, which is
// exactly the event that used to sit in its queue: only an instant email
// kicked the worker, and dev has no scheduler to drain it otherwise.
describe("kicking the worker", () => {
  it("★ a WhatsApp-only event kicks the worker after it commits", async () => {
    const mock = setupDb();
    await placeOrder();
    expect(queued(mock, notificationWhatsappQueue)).toHaveLength(1);
    expect(queued(mock, notificationEmailQueue)).toHaveLength(0);
    expect(triggerEmailWorker).toHaveBeenCalledTimes(1);
  });

  it("★ an SMS-only event kicks it too", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(null);
    const mock = setupDb();
    await placeOrder();
    expect(queued(mock, notificationSmsQueue)).toHaveLength(1);
    expect(queued(mock, notificationWhatsappQueue)).toHaveLength(0);
    expect(queued(mock, notificationEmailQueue)).toHaveLength(0);
    expect(triggerEmailWorker).toHaveBeenCalledTimes(1);
  });

  it("one kick for both channels, not one each", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(WA_SENDER("both"));
    setupDb();
    await placeOrder();
    expect(triggerEmailWorker).toHaveBeenCalledTimes(1);
  });

  it("no kick when nothing was queued for sending", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(null);
    vi.mocked(loadSmsSender).mockResolvedValue(null);
    const mock = setupDb();
    await placeOrder();
    expect(queued(mock, notificationWhatsappQueue)).toHaveLength(0);
    expect(queued(mock, notificationSmsQueue)).toHaveLength(0);
    expect(triggerEmailWorker).not.toHaveBeenCalled();
  });
});

// ★ COD confirmation (Phase 2, slice 1): a website cash-on-delivery order on a
// store that asks gets the button variant INSTEAD of the plain order message.
describe("COD confirmation", () => {
  const ORDER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const COD_TEMPLATE = {
    id: "wt-cod",
    audience: "customer",
    name: "sm_order_placed_customer_cod_confirm_v1",
    language: "en",
    variables: ["subject_label", "store_name", "total"],
    body: "x",
  };

  async function codOrder(payload: Record<string, unknown> = {}) {
    return recordEvent({
      type: "order.placed",
      storeId: STORE,
      customerId: CUSTOMER,
      subject: { type: "order", id: ORDER_ID, label: "ORD1" },
      payload: { total: 1240, paymentMethod: "cod", ...payload },
    });
  }

  function withCodTemplate() {
    vi.mocked(loadWhatsAppTemplates).mockImplementation(
      async (_db: any, _store: string, _key: string, variant?: string) =>
        new Map([["customer", variant ? COD_TEMPLATE : WA_TEMPLATE]]) as any,
    );
  }

  beforeEach(() => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(
      WA_SENDER("whatsapp_first", true),
    );
    withCodTemplate();
  });

  it("★ sends the button variant, with both payloads naming the order", async () => {
    const mock = setupDb();
    await codOrder();
    const rows = queued(mock, notificationWhatsappQueue);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      templateId: "wt-cod",
      buttonPayloads: [`cod:confirm:${ORDER_ID}`, `cod:cancel:${ORDER_ID}`],
    });
    expect(rows[0].values).toEqual(["ORD1", "Acme", "₹1,240.00"]);
  });

  it("★ never both: the plain order message is not also queued", async () => {
    const mock = setupDb();
    await codOrder();
    const rows = queued(mock, notificationWhatsappQueue);
    expect(rows.map((r: any) => r.templateId)).toEqual(["wt-cod"]);
  });

  it("falls back to the plain message while Meta has not approved the variant", async () => {
    vi.mocked(loadWhatsAppTemplates).mockImplementation(
      async (_db: any, _store: string, _key: string, variant?: string) =>
        (variant ? new Map() : new Map([["customer", WA_TEMPLATE]])) as any,
    );
    const mock = setupDb();
    await codOrder();
    const rows = queued(mock, notificationWhatsappQueue);
    expect(rows).toHaveLength(1);
    expect(rows[0].templateId).toBe("wt-1");
    expect(rows[0].buttonPayloads).toBeUndefined();
  });

  it("not when the store has the setting off", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(
      WA_SENDER("whatsapp_first", false),
    );
    const mock = setupDb();
    await codOrder();
    expect(queued(mock, notificationWhatsappQueue)[0].templateId).toBe("wt-1");
    expect(loadWhatsAppTemplates).not.toHaveBeenCalledWith(
      expect.anything(),
      STORE,
      "order.placed",
      "cod_confirm",
    );
  });

  it("not for a prepaid order", async () => {
    const mock = setupDb();
    await codOrder({ paymentMethod: "razorpay" });
    expect(queued(mock, notificationWhatsappQueue)[0].templateId).toBe("wt-1");
  });

  it("not for a collection, which is paid at the counter", async () => {
    const mock = setupDb();
    await codOrder({ fulfilment: "pickup" });
    expect(queued(mock, notificationWhatsappQueue)[0].templateId).toBe("wt-1");
  });

  it("not without an order id to put on the buttons", async () => {
    const mock = setupDb();
    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      customerId: CUSTOMER,
      subject: { label: "ORD1" },
      payload: { total: 1240, paymentMethod: "cod" },
    });
    expect(queued(mock, notificationWhatsappQueue)[0].templateId).toBe("wt-1");
  });

  it("still needs the customer's own yes", async () => {
    vi.mocked(whatsAppConsentFor).mockResolvedValue(new Map());
    const mock = setupDb();
    await codOrder();
    expect(queued(mock, notificationWhatsappQueue)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The PR #283 review fixes (migration 0211).
// ---------------------------------------------------------------------------

/** A savepoint the fan-out's isolated reads run in, answering with `rows`. */
function withTransaction(
  mock: any,
  answers: { order?: any[]; stopped?: string[] } = {},
) {
  const tx: any = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => answers.order ?? []),
        })),
      })),
    })),
    execute: vi.fn(async () => ({
      rows: (answers.stopped ?? []).map((phone) => ({ phone })),
    })),
  };
  mock.db.transaction = vi.fn(async (fn: any) => fn(tx));
  return tx;
}

describe("the SMS held behind the WhatsApp (0211)", () => {
  it("★★ WhatsApp first: the SMS rides on the WhatsApp row, held, not dropped", async () => {
    const mock = setupDb();
    await placeOrder();
    const [row] = queued(mock, notificationWhatsappQueue);
    expect(row.fallbackState).toBe("held");
    expect(row.fallbackSms).toEqual({
      recipientId: CUSTOMER,
      recipientType: "customer",
      phone: PHONE,
      eventKey: "order.placed",
      values: ["ORD1", "Acme"],
    });
    expect(queued(mock, notificationSmsQueue)).toHaveLength(0);
  });

  it("nothing is held when the store has no SMS to send", async () => {
    vi.mocked(loadSmsSender).mockResolvedValue(null);
    const mock = setupDb();
    await placeOrder();
    const [row] = queued(mock, notificationWhatsappQueue);
    expect(row.fallbackState).toBeUndefined();
    expect(row.fallbackSms).toBeUndefined();
  });

  it("both: two messages, nothing held", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(WA_SENDER("both"));
    const mock = setupDb();
    await placeOrder();
    expect(queued(mock, notificationWhatsappQueue)[0].fallbackState).toBe(
      undefined,
    );
    expect(queued(mock, notificationSmsQueue)).toHaveLength(1);
  });
});

describe("a WhatsApp-only audience", () => {
  it("★★ queues the WhatsApp although web and email are off", async () => {
    dbHolder.current = makeDbMock({
      returning: [{ id: EVENT_ID }],
      selectQueue: [
        [],
        [
          {
            eventKey: "order.placed",
            channels: {
              customer: { web: false, email: false, whatsapp: true },
            },
            routing: "permission",
            targetRoles: [],
            targetAdmins: [],
            templates: {},
            digest: "instant",
            isEnabled: true,
            storeName: "Acme",
          },
        ],
        [],
        [],
        [],
        [],
        [],
      ],
    });
    await placeOrder();
    expect(queued(dbHolder.current, notificationWhatsappQueue)).toHaveLength(1);
  });
});

describe("STOP and SMS precedence", () => {
  it("★ under SMS first, a number that said STOP is not 'reached by SMS'", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(WA_SENDER("sms_first"));
    const mock = setupDb();
    const tx = withTransaction(mock, { stopped: ["9876543210"] });
    await placeOrder();
    expect(queued(mock, notificationSmsQueue)).toHaveLength(0);
    expect(queued(mock, notificationWhatsappQueue)).toHaveLength(1);
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });
});

describe("an order's WhatsApp goes to its own phone", () => {
  const ORDER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const DELIVERY = "+919123456789";
  async function orderEvent() {
    return recordEvent({
      type: "order.placed",
      storeId: STORE,
      customerId: CUSTOMER,
      subject: { type: "order", id: ORDER_ID, label: "ORD1" },
      payload: { total: 1240, paymentMethod: "razorpay" },
    });
  }

  it("★★ the phone typed at checkout, with ITS consent", async () => {
    vi.mocked(whatsAppConsentFor).mockResolvedValue(
      new Map([[DELIVERY, { updates: true, marketing: false }]]),
    );
    const mock = setupDb();
    withTransaction(mock, {
      order: [{ phone: "9123456789", updates: true }],
    });
    await orderEvent();
    const [row] = queued(mock, notificationWhatsappQueue);
    expect(row.phone).toBe(DELIVERY);
    expect(whatsAppConsentFor).toHaveBeenCalledWith(expect.anything(), STORE, [
      DELIVERY,
    ]);
  });

  it("★★ the box unticked for this order wins over the number's consent", async () => {
    const mock = setupDb();
    withTransaction(mock, { order: [{ phone: PHONE, updates: false }] });
    await orderEvent();
    expect(queued(mock, notificationWhatsappQueue)).toHaveLength(0);
    // …and the customer still gets the SMS instead.
    expect(queued(mock, notificationSmsQueue)).toHaveLength(1);
  });

  it("no delivery phone (a till sale): the account phone", async () => {
    const mock = setupDb();
    withTransaction(mock, { order: [{ phone: null, updates: null }] });
    await orderEvent();
    expect(queued(mock, notificationWhatsappQueue)[0].phone).toBe(PHONE);
  });
});

describe("the COD confirmation is its own message", () => {
  const ORDER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const COD_TEMPLATE = {
    id: "wt-cod",
    audience: "customer",
    name: "sm_order_placed_customer_cod_confirm_v1",
    language: "en",
    variables: ["subject_label", "store_name", "total"],
    body: "x",
  };
  async function codOrder() {
    return recordEvent({
      type: "order.placed",
      storeId: STORE,
      customerId: CUSTOMER,
      subject: { type: "order", id: ORDER_ID, label: "ORD1" },
      payload: { total: 1240, paymentMethod: "cod" },
    });
  }
  function codConfig(whatsapp: boolean) {
    dbHolder.current = makeDbMock({
      returning: [{ id: EVENT_ID }],
      selectQueue: [
        [],
        [
          {
            eventKey: "order.placed",
            channels: { customer: { whatsapp, sms: true } },
            routing: "permission",
            targetRoles: [],
            targetAdmins: [],
            templates: {},
            digest: "instant",
            isEnabled: true,
            storeName: "Acme",
          },
        ],
        [],
        [],
        [],
        [],
        [],
      ],
    });
    return dbHolder.current;
  }

  beforeEach(() => {
    vi.mocked(loadWhatsAppTemplates).mockImplementation(
      async (_db: any, _store: string, _key: string, variant?: string) =>
        new Map([["customer", variant ? COD_TEMPLATE : WA_TEMPLATE]]) as any,
    );
  });

  it("★★ under SMS first the SMS goes AND the buttons go", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(
      WA_SENDER("sms_first", true),
    );
    const mock = codConfig(true);
    await codOrder();
    expect(queued(mock, notificationSmsQueue)).toHaveLength(1);
    const wa = queued(mock, notificationWhatsappQueue);
    expect(wa.map((r: any) => r.templateId)).toEqual(["wt-cod"]);
  });

  it("★★ with WhatsApp unticked for Order placed, the buttons still go", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(
      WA_SENDER("whatsapp_first", true),
    );
    const mock = codConfig(false);
    await codOrder();
    const wa = queued(mock, notificationWhatsappQueue);
    expect(wa.map((r: any) => r.templateId)).toEqual(["wt-cod"]);
  });

  it("…but never the plain order message in its place", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(
      WA_SENDER("whatsapp_first", true),
    );
    vi.mocked(loadWhatsAppTemplates).mockImplementation(
      async (_db: any, _store: string, _key: string, variant?: string) =>
        (variant ? new Map() : new Map([["customer", WA_TEMPLATE]])) as any,
    );
    const mock = codConfig(false);
    await codOrder();
    expect(queued(mock, notificationWhatsappQueue)).toHaveLength(0);
    expect(queued(mock, notificationSmsQueue)).toHaveLength(1);
  });

  it("nothing extra when the store does not ask for confirmation", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(
      WA_SENDER("whatsapp_first", false),
    );
    const mock = codConfig(false);
    await codOrder();
    expect(queued(mock, notificationWhatsappQueue)).toHaveLength(0);
  });
});
