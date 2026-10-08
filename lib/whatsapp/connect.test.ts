/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("@/lib/payments/crypto", () => ({
  encryptSecret: vi.fn((s: string) => `enc(${s})`),
  decryptSecret: vi.fn((s: string) => s.replace(/^enc\((.*)\)$/, "$1")),
}));
vi.mock("./graph", () => ({
  exchangeEmbeddedSignupCode: vi.fn(),
  debugToken: vi.fn(),
  getWaba: vi.fn(),
  getPhoneNumber: vi.fn(),
  subscribeAppToWaba: vi.fn(),
  unsubscribeAppFromWaba: vi.fn(),
  registerPhoneNumber: vi.fn(),
  isTokenError: vi.fn(
    (r: any) => !r.ok && r.outcome === "rejected" && r.code === 190,
  ),
}));

const dbHolder = vi.hoisted(() => ({ insert: null as any, rows: [] as any[] }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => {
    const db: any = {
      insert: vi.fn(() => ({
        values: vi.fn((v: any) => ({
          onConflictDoUpdate: vi.fn(async (c: any) => {
            dbHolder.insert = { values: v, conflict: c };
            if (dbHolder.insert.values.phoneNumberId === "99999999999999") {
              throw new Error(
                'duplicate key value violates unique constraint "store_whatsapp_accounts_phone_number_id_key"',
              );
            }
          }),
        })),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => dbHolder.rows) })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
      delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    };
    return fn(db);
  }),
}));

import {
  debugToken,
  exchangeEmbeddedSignupCode,
  getPhoneNumber,
  getWaba,
  registerPhoneNumber,
  subscribeAppToWaba,
} from "./graph";
import { connectWhatsAppAccount, generatePin } from "./connect";

const ok = (data: any) => ({ ok: true, data });
const input = {
  storeId: "store-1",
  code: "CODE",
  wabaId: "2323545385144849",
  phoneNumberId: "1280649011808874",
  coexistence: false,
};

beforeEach(() => {
  dbHolder.insert = null;
  vi.mocked(exchangeEmbeddedSignupCode).mockResolvedValue(
    ok({ access_token: "BIZ" }) as any,
  );
  vi.mocked(debugToken).mockResolvedValue(
    ok({
      data: {
        is_valid: true,
        granular_scopes: [
          {
            scope: "whatsapp_business_management",
            target_ids: ["2323545385144849"],
          },
        ],
      },
    }) as any,
  );
  vi.mocked(getWaba).mockResolvedValue(
    ok({
      id: "2323545385144849",
      name: "Echos",
      account_review_status: "APPROVED",
    }) as any,
  );
  vi.mocked(getPhoneNumber).mockResolvedValue(
    ok({
      id: "1280649011808874",
      display_phone_number: "+91 98765 43210",
      verified_name: "Echos",
      name_status: "APPROVED",
      quality_rating: "GREEN",
      messaging_limit_tier: "TIER_1K",
    }) as any,
  );
  vi.mocked(subscribeAppToWaba).mockResolvedValue(ok({ success: true }) as any);
  vi.mocked(registerPhoneNumber).mockResolvedValue(
    ok({ success: true }) as any,
  );
});

describe("connectWhatsAppAccount", () => {
  it("exchanges, proves, subscribes, registers and stores — token and PIN encrypted", async () => {
    const r = await connectWhatsAppAccount(input);
    expect(r).toEqual({
      ok: true,
      displayPhone: "+91 98765 43210",
      verifiedName: "Echos",
    });
    expect(exchangeEmbeddedSignupCode).toHaveBeenCalledWith("CODE");
    expect(subscribeAppToWaba).toHaveBeenCalledWith("BIZ", "2323545385144849");
    expect(registerPhoneNumber).toHaveBeenCalledWith(
      "BIZ",
      "1280649011808874",
      expect.stringMatching(/^\d{6}$/),
    );
    const v = dbHolder.insert.values;
    expect(v.storeId).toBe("store-1");
    expect(v.businessTokenEnc).toBe("enc(BIZ)");
    expect(v.twoFaPinEnc).toMatch(/^enc\(\d{6}\)$/);
    expect(v.messagingTier).toBe("TIER_1K");
    expect(v.status).toBe("connected");
    expect(v.enabled).toBe(true);
    expect(v.sendRatePerSec).toBe(80);
    // ★ Never stored in the clear.
    expect(JSON.stringify(v)).not.toContain('"BIZ"');
  });

  it("★★ subscribes OUR app to the WABA — the step Phase 0 found missing", async () => {
    await connectWhatsAppAccount(input);
    expect(subscribeAppToWaba).toHaveBeenCalledTimes(1);
  });

  it("★ a WABA the token was not granted is refused before anything is subscribed or stored", async () => {
    const r = await connectWhatsAppAccount({ ...input, wabaId: "99999999999" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/isn't one this login was granted/);
    expect(subscribeAppToWaba).not.toHaveBeenCalled();
    expect(dbHolder.insert).toBeNull();
  });

  it("Coexistence skips registration and is paced at Meta's cap", async () => {
    const r = await connectWhatsAppAccount({ ...input, coexistence: true });
    expect(r.ok).toBe(true);
    expect(registerPhoneNumber).not.toHaveBeenCalled();
    expect(dbHolder.insert.values.coexistence).toBe(true);
    expect(dbHolder.insert.values.registeredAt).toBeNull();
    expect(dbHolder.insert.values.sendRatePerSec).toBe(20);
  });

  it("a failed subscription refuses rather than storing a connection that cannot receive", async () => {
    vi.mocked(subscribeAppToWaba).mockResolvedValue({
      ok: false,
      outcome: "rejected",
      error: "(#200) Permissions error",
    } as any);
    const r = await connectWhatsAppAccount(input);
    expect(r.ok).toBe(false);
    expect(dbHolder.insert).toBeNull();
    expect(registerPhoneNumber).not.toHaveBeenCalled();
  });

  it("an UNKNOWN outcome tells the merchant nothing was saved and to retry", async () => {
    vi.mocked(exchangeEmbeddedSignupCode).mockResolvedValue({
      ok: false,
      outcome: "unknown",
      error: "Meta 503.",
    } as any);
    const r = await connectWhatsAppAccount(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Nothing was saved/);
  });

  it("a number another store holds is named, not reported as a generic failure", async () => {
    const r = await connectWhatsAppAccount({
      ...input,
      phoneNumberId: "99999999999999",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/already connected to another StoreMink store/);
  });

  it("refuses ids that are not Meta ids before calling Meta at all", async () => {
    const r = await connectWhatsAppAccount({ ...input, wabaId: "abc" });
    expect(r.ok).toBe(false);
    expect(exchangeEmbeddedSignupCode).not.toHaveBeenCalled();
  });
});

describe("generatePin", () => {
  it("is six digits and not a constant", () => {
    const pins = new Set(Array.from({ length: 20 }, () => generatePin()));
    for (const p of pins) expect(p).toMatch(/^\d{6}$/);
    expect(pins.size).toBeGreaterThan(1);
  });
});
