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
vi.mock("@/lib/payments/crypto", () => ({
  decryptSecret: vi.fn((v: string) => `plain:${v}`),
  encryptSecret: vi.fn((v: string) => `enc:${v}`),
}));
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  bodyFromComponents,
  consented,
  loadWhatsAppSender,
  loadWhatsAppTemplates,
  storeCanSendWhatsApp,
  whatsAppConsentFor,
} from "./channel";

const ACCOUNT = {
  enabled: true,
  status: "connected",
  wabaId: "W",
  phoneNumberId: "P",
  displayPhone: "+91 98765 43210",
  tokenEnc: "tok",
  plan: "basic",
  planExpiresAt: null,
  compPlan: null,
  compExpiresAt: null,
  settings: {},
};

function db(rows: any[]) {
  dbHolder.current = makeDbMock({ selectQueue: [rows] });
  return dbHolder.current.db;
}

beforeEach(() => {
  dbHolder.current = makeDbMock({});
});

describe("loadWhatsAppSender", () => {
  it("returns the decrypted sender with the default precedence", async () => {
    const s = await loadWhatsAppSender(db([ACCOUNT]), "store-1");
    expect(s).toEqual({
      token: "plain:tok",
      wabaId: "W",
      phoneNumberId: "P",
      displayPhone: "+91 98765 43210",
      precedence: "whatsapp_first",
    });
  });

  it("reads the merchant's precedence from the store's settings", async () => {
    const s = await loadWhatsAppSender(
      db([
        {
          ...ACCOUNT,
          settings: { features: { "whatsapp.updatePrecedence": "sms_first" } },
        },
      ]),
      "store-1",
    );
    expect(s?.precedence).toBe("sms_first");
  });

  it.each([
    ["paused", { enabled: false }],
    ["needs reconnecting", { status: "needs_reauth" }],
    ["a plan without WhatsApp", { plan: "free" }],
    [
      "a lapsed plan",
      { plan: "basic", planExpiresAt: "2020-01-01T00:00:00.000Z" },
    ],
  ])("is null for %s", async (_n, patch) => {
    expect(
      await loadWhatsAppSender(db([{ ...ACCOUNT, ...patch }]), "store-1"),
    ).toBeNull();
  });

  it("is null, not thrown, when the read fails", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [new Error("boom")] });
    expect(await loadWhatsAppSender(dbHolder.current.db, "store-1")).toBeNull();
  });
});

describe("loadWhatsAppTemplates", () => {
  it("keys approved rows by audience and lifts the body out of the components", async () => {
    const rows = [
      {
        id: "t1",
        audience: "customer",
        name: "sm_order_placed_customer_v1",
        language: "en",
        variables: ["store_name"],
        components: [{ type: "BODY", text: "Hi from {{1}}." }],
      },
      {
        id: "t2",
        audience: null, // a merchant-authored template with no audience
        name: "promo",
        language: "en",
        variables: [],
        components: [],
      },
    ];
    const map = await loadWhatsAppTemplates(
      db(rows),
      "store-1",
      "order.placed",
    );
    expect([...map.keys()]).toEqual(["customer"]);
    expect(map.get("customer")).toMatchObject({
      id: "t1",
      body: "Hi from {{1}}.",
      variables: ["store_name"],
    });
  });

  it("★ two approved versions of one template: the current catalogue name wins", async () => {
    const tpl = (name: string, id: string) => ({
      id,
      audience: "customer",
      name,
      language: "en",
      status: "APPROVED",
      variables: [],
      components: [{ type: "BODY", text: name }],
    });
    // v3 is the current catalogue name; v1 is an older approved version.
    const v1 = tpl("sm_order_ready_for_pickup_customer_v1", "t1");
    const v2 = tpl("sm_order_ready_for_pickup_customer_v3", "t2");
    for (const rows of [
      [v2, v1],
      [v1, v2],
    ]) {
      const map = await loadWhatsAppTemplates(
        db(rows),
        "store-1",
        "order.ready_for_pickup",
      );
      expect(map.get("customer")?.id).toBe("t2");
    }
    // Until v3 is approved, the approved v1 keeps sending.
    const map = await loadWhatsAppTemplates(
      db([v1]),
      "store-1",
      "order.ready_for_pickup",
    );
    expect(map.get("customer")?.id).toBe("t1");
  });

  it("only ever asks for APPROVED, enabled rows", async () => {
    const d = db([]);
    await loadWhatsAppTemplates(d, "store-1", "order.placed");
    const where = dbHolder.current.calls.where[0];
    const params = sqlParamValues(where);
    expect(params).toContain("APPROVED");
    expect(params).toContain(true); // enabled = true
    expect(sqlText(where)).toBeTruthy();
  });
});

describe("whatsAppConsentFor", () => {
  it("normalises every number to E.164 before asking, and keys the answer by it", async () => {
    const d = db([
      {
        phone: "+919876543210",
        updatesIn: "2026-10-01T00:00:00.000Z",
        updatesOut: null,
        marketingIn: null,
        marketingOut: null,
      },
    ]);
    const map = await whatsAppConsentFor(d, "store-1", [
      "9876543210",
      "+919876543210",
      "8888888888", // a placeholder is never textable
    ]);
    expect(map.get("+919876543210")).toEqual({
      updates: true,
      marketing: false,
    });
    const asked = sqlParamValues(dbHolder.current.calls.where[0]).flat();
    expect(asked).toContain("+919876543210");
    expect(asked).not.toContain("8888888888");
  });

  it("asks nothing when no number is textable", async () => {
    const d = db([]);
    const map = await whatsAppConsentFor(d, "store-1", ["", "8888888888"]);
    expect(map.size).toBe(0);
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });
});

describe("consented", () => {
  it("is true only for an opt-in that has not been withdrawn since", () => {
    expect(consented(null, null)).toBe(false);
    expect(consented("2026-10-01T00:00:00Z", null)).toBe(true);
    expect(consented("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z")).toBe(
      false,
    );
    // Re-opted in after an earlier withdrawal.
    expect(consented("2026-10-03T00:00:00Z", "2026-10-02T00:00:00Z")).toBe(
      true,
    );
  });
});

describe("storeCanSendWhatsApp", () => {
  it("is a plan-aware yes/no that fails closed", async () => {
    db([ACCOUNT]);
    expect(await storeCanSendWhatsApp("store-1")).toBe(true);
    db([{ ...ACCOUNT, plan: "free" }]);
    expect(await storeCanSendWhatsApp("store-1")).toBe(false);
    dbHolder.current = makeDbMock({ selectQueue: [new Error("down")] });
    expect(await storeCanSendWhatsApp("store-1")).toBe(false);
  });
});

describe("bodyFromComponents", () => {
  it("returns the BODY text or an empty string", () => {
    expect(
      bodyFromComponents([{ type: "HEADER" }, { type: "BODY", text: "x" }]),
    ).toBe("x");
    expect(bodyFromComponents("junk")).toBe("");
    expect(bodyFromComponents([])).toBe("");
  });
});
