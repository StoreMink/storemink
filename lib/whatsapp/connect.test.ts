/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import { makeDbMock } from "@/app/actions/_test-helpers";

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
  listWabaPhoneNumbers: vi.fn(),
  subscribeAppToWaba: vi.fn(),
  unsubscribeAppFromWaba: vi.fn(),
  registerPhoneNumber: vi.fn(),
  isTokenError: vi.fn(
    (r: any) => !r.ok && r.outcome === "rejected" && r.code === 190,
  ),
}));
// The reset itself is templates.test.ts's subject; here, only that connect
// runs it in the commit that moves the account.
vi.mock("./templates", () => ({
  resetTemplatesForWaba: vi.fn(async () => 0),
}));

// Each withService call is its own transaction; `txn` says which one a
// statement ran in.
const dbHolder = vi.hoisted(() => ({ current: null as any, txn: 0 }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => {
    dbHolder.txn++;
    return Promise.resolve(fn(dbHolder.current.db));
  }),
}));

import {
  debugToken,
  exchangeEmbeddedSignupCode,
  getPhoneNumber,
  getWaba,
  listWabaPhoneNumbers,
  registerPhoneNumber,
  subscribeAppToWaba,
  unsubscribeAppFromWaba,
} from "./graph";
import { decryptSecret } from "@/lib/payments/crypto";
import { resetTemplatesForWaba } from "./templates";
import {
  connectWhatsAppAccount,
  disconnectWhatsAppAccount,
  generatePin,
} from "./connect";
import { storeWhatsappAccounts, whatsappNumberPins } from "@/drizzle/schema";

const ok = (data: any) => ({ ok: true, data });
const WABA = "2323545385144849";
const NUMBER = "1280649011808874";
const input = {
  storeId: "store-1",
  code: "CODE",
  wabaId: WABA,
  phoneNumberId: NUMBER,
  coexistence: false,
};

/**
 * The connect flow's database: who else holds the number, the number's PIN
 * row, the account upsert. The PIN upsert answers like PostgreSQL does (the
 * existing PIN wins over the candidate; verified against a real database),
 * and the account upsert can be made to fail.
 */
function setup(
  opts: {
    heldBy?: string | null;
    pin?: string | null;
    accountError?: unknown;
    pinError?: unknown;
  } = {},
) {
  const mock = makeDbMock({
    selectByTable: {
      store_whatsapp_accounts: [opts.heldBy ? [{ storeId: opts.heldBy }] : []],
      whatsapp_number_pins: [opts.pin ? [{ pinEnc: opts.pin }] : []],
    },
  });
  const insert = mock.db.insert;
  const writes: { table: any; values: any; conflict?: any; txn: number }[] = [];
  mock.db.insert = vi.fn((table: any) => {
    if (table === whatsappNumberPins) {
      return {
        values: (values: any) => ({
          onConflictDoUpdate: (conflict: any) => {
            writes.push({ table, values, conflict, txn: dbHolder.txn });
            return {
              returning: async () => {
                if (opts.pinError) throw opts.pinError;
                return [{ pinEnc: opts.pin ?? values.pinEnc }];
              },
            };
          },
        }),
      };
    }
    if (table === storeWhatsappAccounts) {
      return {
        values: (values: any) => ({
          onConflictDoUpdate: async (conflict: any) => {
            writes.push({ table, values, conflict, txn: dbHolder.txn });
            if (opts.accountError) throw opts.accountError;
          },
        }),
      };
    }
    return insert(table);
  });
  dbHolder.current = mock;
  return { mock, writes };
}

const pinWrite = (w: { table: any }[]) =>
  w.find((x: any) => x.table === whatsappNumberPins) as any;
const accountWrite = (w: { table: any }[]) =>
  w.find((x: any) => x.table === storeWhatsappAccounts) as any;

/** What Drizzle 0.45 throws for a unique violation: a DrizzleQueryError
 *  whose message names the SQL, with the pg error on `cause`. */
function uniqueViolation(constraint?: string) {
  const pg = Object.assign(
    new Error(
      'duplicate key value violates unique constraint "store_whatsapp_accounts_phone_number_id_key"',
    ),
    { code: "23505", ...(constraint ? { constraint } : {}) },
  );
  return new DrizzleQueryError(
    'insert into "store_whatsapp_accounts" ("store_id", "phone_number_id") values ($1, $2) on conflict ("store_id") do update set "phone_number_id" = $3',
    ["store-1", NUMBER, NUMBER],
    pg,
  );
}

beforeEach(() => {
  dbHolder.txn = 0;
  setup();
  vi.mocked(exchangeEmbeddedSignupCode).mockResolvedValue(
    ok({ access_token: "BIZ" }) as any,
  );
  vi.mocked(debugToken).mockResolvedValue(
    ok({
      data: {
        is_valid: true,
        granular_scopes: [
          { scope: "whatsapp_business_management", target_ids: [WABA] },
        ],
      },
    }) as any,
  );
  vi.mocked(getWaba).mockResolvedValue(
    ok({ id: WABA, name: "Echos", account_review_status: "APPROVED" }) as any,
  );
  vi.mocked(getPhoneNumber).mockResolvedValue(
    ok({
      id: NUMBER,
      display_phone_number: "+91 98765 43210",
      verified_name: "Echos",
      name_status: "APPROVED",
      quality_rating: "GREEN",
      messaging_limit_tier: "TIER_1K",
    }) as any,
  );
  vi.mocked(listWabaPhoneNumbers).mockResolvedValue(
    ok({ data: [{ id: NUMBER }], more: false }) as any,
  );
  vi.mocked(subscribeAppToWaba).mockResolvedValue(ok({ success: true }) as any);
  vi.mocked(unsubscribeAppFromWaba).mockResolvedValue(
    ok({ success: true }) as any,
  );
  vi.mocked(registerPhoneNumber).mockResolvedValue(
    ok({ success: true }) as any,
  );
});

describe("connectWhatsAppAccount", () => {
  it("exchanges, proves, subscribes, registers and stores, token and PIN encrypted", async () => {
    const { writes } = setup();
    const r = await connectWhatsAppAccount(input);
    expect(r).toEqual({
      ok: true,
      displayPhone: "+91 98765 43210",
      verifiedName: "Echos",
    });
    expect(exchangeEmbeddedSignupCode).toHaveBeenCalledWith("CODE");
    expect(subscribeAppToWaba).toHaveBeenCalledWith("BIZ", WABA);
    expect(registerPhoneNumber).toHaveBeenCalledWith(
      "BIZ",
      NUMBER,
      expect.stringMatching(/^\d{6}$/),
    );
    const v = accountWrite(writes).values;
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

  it("★★ subscribes OUR app to the WABA: the step Phase 0 found missing", async () => {
    await connectWhatsAppAccount(input);
    expect(subscribeAppToWaba).toHaveBeenCalledTimes(1);
  });

  it("★ a WABA the token was not granted is refused before anything is subscribed or stored", async () => {
    const { writes } = setup();
    const r = await connectWhatsAppAccount({ ...input, wabaId: "99999999999" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/isn't one this login was granted/);
    expect(subscribeAppToWaba).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("Coexistence skips registration and the number's PIN row, and is paced at Meta's cap", async () => {
    const { mock, writes } = setup();
    const r = await connectWhatsAppAccount({ ...input, coexistence: true });
    expect(r.ok).toBe(true);
    expect(registerPhoneNumber).not.toHaveBeenCalled();
    // The app owns the number's PIN: nothing is read or written for it.
    expect(pinWrite(writes)).toBeUndefined();
    expect(
      mock.db.select.mock.calls.length,
      "only the who-holds-the-number read",
    ).toBe(1);
    const v = accountWrite(writes).values;
    expect(v.coexistence).toBe(true);
    expect(v.registeredAt).toBeNull();
    expect(v.sendRatePerSec).toBe(20);
    // The column is NOT NULL, so it still holds an (unused) encrypted PIN.
    expect(v.twoFaPinEnc).toMatch(/^enc\(\d{6}\)$/);
  });

  it("a failed subscription refuses rather than storing a connection that cannot receive", async () => {
    const { writes } = setup();
    vi.mocked(subscribeAppToWaba).mockResolvedValue({
      ok: false,
      outcome: "rejected",
      error: "(#200) Permissions error",
    } as any);
    const r = await connectWhatsAppAccount(input);
    expect(r.ok).toBe(false);
    expect(writes).toHaveLength(0);
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

  it("refuses ids that are not Meta ids before calling Meta at all", async () => {
    const r = await connectWhatsAppAccount({ ...input, wabaId: "abc" });
    expect(r.ok).toBe(false);
    expect(exchangeEmbeddedSignupCode).not.toHaveBeenCalled();
  });
});

describe("the number's two-step verification PIN", () => {
  it("★ a number with no PIN gets one, stored for this store BEFORE register is called", async () => {
    const { writes } = setup();
    let storedAtRegister: any;
    vi.mocked(registerPhoneNumber).mockImplementation(async () => {
      storedAtRegister = pinWrite(writes);
      return ok({ success: true }) as any;
    });
    await connectWhatsAppAccount(input);
    const pin = vi.mocked(registerPhoneNumber).mock.calls[0]![2];
    expect(pin).toMatch(/^\d{6}$/);
    expect(storedAtRegister, "the PIN row was written first").toBeTruthy();
    expect(storedAtRegister.values).toMatchObject({
      phoneNumberId: NUMBER,
      storeId: "store-1",
      pinEnc: `enc(${pin})`,
    });
    // ★ The upsert claims the number for this store and never replaces a
    // PIN Meta already holds.
    expect(storedAtRegister.conflict.target).toBe(
      whatsappNumberPins.phoneNumberId,
    );
    expect(storedAtRegister.conflict.set).toEqual({
      storeId: "store-1",
      updatedAt: expect.any(String),
    });
    // The account keeps the same value in its own NOT NULL column.
    expect(accountWrite(writes).values.twoFaPinEnc).toBe(`enc(${pin})`);
  });

  it("★★ Disconnect then Connect registers with the PIN the number already has", async () => {
    const { writes } = setup({ pin: "enc(654321)" });
    const r = await connectWhatsAppAccount(input);
    expect(r.ok).toBe(true);
    expect(registerPhoneNumber).toHaveBeenCalledWith("BIZ", NUMBER, "654321");
    // No new PIN is generated for a number that has one.
    expect(pinWrite(writes).values.pinEnc).toBe("enc(654321)");
    expect(accountWrite(writes).values.twoFaPinEnc).toBe("enc(654321)");
  });

  it("★ the PIN row moves to the connecting store when another store registered the number before", async () => {
    const { writes } = setup({ pin: "enc(654321)" });
    await connectWhatsAppAccount({ ...input, storeId: "store-2" });
    expect(pinWrite(writes).values.storeId).toBe("store-2");
    expect(pinWrite(writes).conflict.set.storeId).toBe("store-2");
    expect(registerPhoneNumber).toHaveBeenCalledWith("BIZ", NUMBER, "654321");
  });

  it("★★ a register that timed out (it may have landed) is retried with the SAME PIN", async () => {
    vi.mocked(registerPhoneNumber).mockResolvedValueOnce({
      ok: false,
      outcome: "unknown",
      error: "Couldn't reach Meta.",
    } as any);
    const first = setup();
    const r1 = await connectWhatsAppAccount(input);
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.error).toMatch(/didn't answer while registering/);
    expect(accountWrite(first.writes)).toBeUndefined();
    const pinRow = pinWrite(first.writes).values.pinEnc;

    // The retry reads the PIN the first attempt stored.
    setup({ pin: pinRow });
    const r2 = await connectWhatsAppAccount(input);
    expect(r2.ok).toBe(true);
    const calls = vi.mocked(registerPhoneNumber).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![2]).toBe(calls[0]![2]);
  });

  it("a PIN that cannot be stored refuses before register; nothing at Meta changes", async () => {
    const { writes } = setup({ pinError: new Error("connection reset") });
    const r = await connectWhatsAppAccount(input);
    expect(r).toEqual({
      ok: false,
      error: expect.stringMatching(/Nothing was saved/),
    });
    expect(registerPhoneNumber).not.toHaveBeenCalled();
    expect(accountWrite(writes)).toBeUndefined();
  });

  it("a stored PIN that cannot be read refuses rather than registering with another", async () => {
    setup({ pin: "enc(654321)" });
    vi.mocked(decryptSecret).mockImplementationOnce(() => {
      throw new Error("bad tag");
    });
    const r = await connectWhatsAppAccount(input);
    expect(r).toEqual({
      ok: false,
      error: expect.stringMatching(/PIN stored for this number can't be read/),
    });
    expect(registerPhoneNumber).not.toHaveBeenCalled();
  });
});

describe("Coexistence that names only the WABA", () => {
  const coex = { ...input, coexistence: true, phoneNumberId: "" };

  it("★ reads the WABA's one number under the proven token, and connects it", async () => {
    const { writes } = setup();
    const r = await connectWhatsAppAccount(coex);
    expect(r.ok).toBe(true);
    expect(listWabaPhoneNumbers).toHaveBeenCalledWith("BIZ", WABA);
    expect(getPhoneNumber).toHaveBeenCalledWith("BIZ", NUMBER);
    expect(accountWrite(writes).values.phoneNumberId).toBe(NUMBER);
    // ★ The proof ran first: the list is asked for only under a proven token.
    expect(vi.mocked(debugToken).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(listWabaPhoneNumbers).mock.invocationCallOrder[0]!,
    );
  });

  it("★ the WABA proof is as strict as ever: an ungranted WABA is refused before its numbers are read", async () => {
    const r = await connectWhatsAppAccount({ ...coex, wabaId: "99999999999" });
    expect(r.ok).toBe(false);
    expect(listWabaPhoneNumbers).not.toHaveBeenCalled();
  });

  it("a WABA with no number refuses, and nothing is saved", async () => {
    const { writes } = setup();
    vi.mocked(listWabaPhoneNumbers).mockResolvedValue(
      ok({ data: [], more: false }) as any,
    );
    const r = await connectWhatsAppAccount(coex);
    expect(r).toEqual({
      ok: false,
      error: expect.stringMatching(/without a phone number/),
    });
    expect(subscribeAppToWaba).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it.each([
    [
      "two numbers",
      { data: [{ id: NUMBER }, { id: "1280649011800000" }], more: false },
    ],
    ["a further page", { data: [{ id: NUMBER }], more: true }],
  ])(
    "★ %s: there is no telling which one, so nothing is guessed",
    async (_n, listed) => {
      const { writes } = setup();
      vi.mocked(listWabaPhoneNumbers).mockResolvedValue(ok(listed) as any);
      const r = await connectWhatsAppAccount(coex);
      expect(r).toEqual({
        ok: false,
        error: expect.stringMatching(/more than one phone number/),
      });
      expect(subscribeAppToWaba).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
    },
  );

  it("an empty number outside Coexistence is refused before Meta is asked", async () => {
    const r = await connectWhatsAppAccount({ ...input, phoneNumberId: "" });
    expect(r).toEqual({
      ok: false,
      error: "Meta's popup didn't return a valid account.",
    });
    expect(exchangeEmbeddedSignupCode).not.toHaveBeenCalled();
  });
});

describe("a number another store holds", () => {
  it("★ is refused before anything changes at Meta", async () => {
    const { writes } = setup({ heldBy: "store-9" });
    const r = await connectWhatsAppAccount(input);
    expect(r).toEqual({
      ok: false,
      error: expect.stringMatching(
        /already connected to another StoreMink store/,
      ),
    });
    expect(subscribeAppToWaba).not.toHaveBeenCalled();
    expect(registerPhoneNumber).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("★★ the race past that read is named from the pg error Drizzle keeps on `cause`", async () => {
    setup({
      accountError: uniqueViolation(
        "store_whatsapp_accounts_phone_number_id_key",
      ),
    });
    const r = await connectWhatsAppAccount(input);
    expect(r).toEqual({
      ok: false,
      error:
        "That WhatsApp number is already connected to another StoreMink store. Disconnect it there first.",
    });
  });

  it("a unique violation on another constraint is not reported as the number", async () => {
    setup({ accountError: uniqueViolation("some_other_key") });
    const r = await connectWhatsAppAccount(input);
    expect(r).toEqual({
      ok: false,
      error: "Couldn't save the connection. Please try again.",
    });
  });

  it("any other failure stays generic", async () => {
    setup({ accountError: new Error("connection reset") });
    const r = await connectWhatsAppAccount(input);
    expect(r).toEqual({
      ok: false,
      error: "Couldn't save the connection. Please try again.",
    });
  });
});

describe("templates from another WABA", () => {
  it("★ are reset in the same commit that moves the account to this WABA", async () => {
    const { writes, mock } = setup();
    let resetTxn = -1;
    vi.mocked(resetTemplatesForWaba).mockImplementationOnce(async () => {
      resetTxn = dbHolder.txn;
      return 3;
    });
    const r = await connectWhatsAppAccount(input);
    expect(r.ok).toBe(true);
    expect(resetTemplatesForWaba).toHaveBeenCalledWith(
      mock.db,
      "store-1",
      WABA,
      accountWrite(writes).values.updatedAt,
    );
    expect(resetTxn).toBe(accountWrite(writes).txn);
  });

  it("a failed reset rolls back the connection with it", async () => {
    setup();
    vi.mocked(resetTemplatesForWaba).mockRejectedValueOnce(new Error("boom"));
    const r = await connectWhatsAppAccount(input);
    expect(r).toEqual({
      ok: false,
      error: "Couldn't save the connection. Please try again.",
    });
  });
});

describe("disconnectWhatsAppAccount", () => {
  function disconnectSetup(others: any[] | Error) {
    dbHolder.current = makeDbMock({
      selectByTable: {
        store_whatsapp_accounts: [
          [{ wabaId: WABA, tokenEnc: "enc(BIZ)" }],
          others,
        ],
      },
    });
    return dbHolder.current;
  }

  it("unsubscribes our app when no other store uses the WABA, and deletes the row", async () => {
    const mock = disconnectSetup([]);
    await disconnectWhatsAppAccount("store-1");
    expect(unsubscribeAppFromWaba).toHaveBeenCalledWith("BIZ", WABA);
    expect(mock.calls.delete).toEqual([storeWhatsappAccounts]);
  });

  it("★★ keeps the WABA subscribed while another store has a number on it", async () => {
    const mock = disconnectSetup([{ storeId: "store-2" }]);
    await disconnectWhatsAppAccount("store-1");
    expect(unsubscribeAppFromWaba).not.toHaveBeenCalled();
    expect(mock.calls.delete).toEqual([storeWhatsappAccounts]);
  });

  it("★ a failed read of the other stores keeps the subscription (webhooks keep flowing)", async () => {
    const mock = disconnectSetup(new Error("connection reset"));
    await disconnectWhatsAppAccount("store-1");
    expect(unsubscribeAppFromWaba).not.toHaveBeenCalled();
    expect(mock.calls.delete).toEqual([storeWhatsappAccounts]);
  });

  it("★ never deletes the number's PIN row: Meta still holds that PIN", async () => {
    const mock = disconnectSetup([]);
    await disconnectWhatsAppAccount("store-1");
    expect(mock.calls.delete).not.toContain(whatsappNumberPins);
  });

  it("with nothing connected there is nothing to unsubscribe", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: { store_whatsapp_accounts: [[]] },
    });
    await disconnectWhatsAppAccount("store-1");
    expect(unsubscribeAppFromWaba).not.toHaveBeenCalled();
  });
});

describe("generatePin", () => {
  it("is six digits and not a constant", () => {
    const pins = new Set(Array.from({ length: 20 }, () => generatePin()));
    for (const p of pins) expect(p).toMatch(/^\d{6}$/);
    expect(pins.size).toBeGreaterThan(1);
  });
});
