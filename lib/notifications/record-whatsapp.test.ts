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
import {
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

const WA_SENDER = (precedence: "whatsapp_first" | "sms_first" | "both") => ({
  token: "t",
  wabaId: "W",
  phoneNumberId: "P",
  displayPhone: "+91",
  precedence,
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
