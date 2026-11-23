/* eslint-disable @typescript-eslint/no-explicit-any */
// Is a merchant's autopay mandate still chargeable, by the gateway's word?
//
// StoreMink's record said `active` from the day a mandate was authorised, and
// nothing asked the gateway again. A customer can cancel or pause a mandate at
// their bank at any time, and only a `confirmed` token may be debited. The
// rules these tests hold:
//
//   • the record follows the gateway's answer, in one conditional write;
//   • "could not be asked" changes nothing and is never read as yes or no;
//   • `changed` is true exactly once, for the call that took the mandate off
//     `active`: that is the one moment the merchant is told.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock } from "@/app/actions/_test-helpers";

const logger = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/observability/logger", () => logger);

const dbHolder = vi.hoisted(() => ({ current: null as any }));
const client = vi.hoisted(() => ({ fail: null as Error | null }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => {
    if (client.fail) throw client.fail;
    return fn(dbHolder.current.db);
  }),
}));

import {
  isVerifiable,
  loadMandateRecord,
  verifyMandate,
  type MandateRecord,
} from "./mandate-check";

const NOW = new Date("2026-09-01T12:00:00.000Z");

function mandate(over: Partial<MandateRecord> = {}): MandateRecord {
  return {
    id: "man-1",
    status: "active",
    maxAmountPaise: 5_000_00,
    providerTokenId: "token_1",
    providerCustomerId: "cust_1",
    method: "card",
    ...over,
  };
}

function gatewaySaying(check: unknown) {
  return {
    checkMandate: vi.fn(async () => check),
    notify: vi.fn(),
    readNotice: vi.fn(),
    debit: vi.fn(),
  } as any;
}

/** One `.returning()` result for the status write (a row = it moved). */
function seed(moved: unknown[] = [{ id: "man-1" }]) {
  dbHolder.current = makeDbMock({ returning: moved });
}

function render(query: unknown) {
  const q = new PgDialect().sqlToQuery(query as any);
  return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
}

beforeEach(() => {
  vi.clearAllMocks();
  client.fail = null;
  seed();
});

describe("isVerifiable: which mandates are worth asking about", () => {
  it("a live mandate, and one waiting to be read again", () => {
    expect(isVerifiable(mandate())).toBe(true);
    expect(isVerifiable(mandate({ status: "unknown" }))).toBe(true);
  });

  it.each(["pending", "revoked", "expired", "failed"] as const)(
    "never a %s one",
    (status) => {
      expect(isVerifiable(mandate({ status }))).toBe(false);
    },
  );

  it("never one with no token or no customer, and never none at all", () => {
    expect(isVerifiable(mandate({ providerTokenId: null }))).toBe(false);
    expect(isVerifiable(mandate({ providerCustomerId: null }))).toBe(false);
    expect(isVerifiable(null)).toBe(false);
  });
});

describe("verifyMandate", () => {
  it("asks about this mandate's customer and token", async () => {
    const gateway = gatewaySaying({ state: "chargeable" });
    await verifyMandate(mandate(), gateway, NOW);
    expect(gateway.checkMandate).toHaveBeenCalledWith({
      providerCustomerId: "cust_1",
      providerTokenId: "token_1",
    });
  });

  it("★ confirmed and already active: usable, and nothing is written", async () => {
    const verdict = await verifyMandate(
      mandate(),
      gatewaySaying({ state: "chargeable" }),
      NOW,
    );
    expect(verdict).toEqual({ result: "usable", mandate: mandate() });
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  describe("★★ the gateway could not be asked", () => {
    it("an unknown answer changes nothing", async () => {
      const verdict = await verifyMandate(
        mandate(),
        gatewaySaying({ state: "unknown" }),
        NOW,
      );
      expect(verdict).toEqual({ result: "unknown" });
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("a throw is an unknown too, never a no", async () => {
      const gateway = gatewaySaying(null);
      gateway.checkMandate.mockRejectedValue(new Error("socket hang up"));
      const verdict = await verifyMandate(mandate(), gateway, NOW);
      expect(verdict).toEqual({ result: "unknown" });
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });
  });

  describe("★★ a mandate the customer cancelled", () => {
    it("is recorded as revoked, and this call is the one that changed it", async () => {
      const verdict = await verifyMandate(
        mandate(),
        gatewaySaying({ state: "ended", detail: "cancelled" }),
        NOW,
      );
      expect(verdict).toEqual({
        result: "unusable",
        mandate: mandate({ status: "revoked" }),
        changed: true,
        reason: "ended",
      });
      expect(dbHolder.current.calls.set[0]).toEqual({
        status: "revoked",
        updatedAt: NOW.toISOString(),
        revokedAt: NOW.toISOString(),
      });
    });

    it("★ the write is a claim on the status it was read with", async () => {
      await verifyMandate(
        mandate(),
        gatewaySaying({ state: "ended", detail: "cancelled" }),
        NOW,
      );
      const where = render(dbHolder.current.calls.where[0]);
      expect(where.sql).toBe(
        '("billing_mandates"."id" = $1 and "billing_mandates"."status" in ($2, $3))',
      );
      expect(where.params).toEqual(["man-1", "active", "unknown"]);
    });

    it("★★ a write that moved nothing reports no change: someone else got there first", async () => {
      seed([]);
      const verdict = await verifyMandate(
        mandate(),
        gatewaySaying({ state: "ended", detail: "cancelled" }),
        NOW,
      );
      expect(verdict).toMatchObject({
        result: "unusable",
        changed: false,
        // What StoreMink holds is unchanged by this call.
        mandate: { status: "active" },
      });
    });

    it.each([
      ["expired", "expired"],
      ["rejected", "failed"],
      ["rejected: bank declined", "failed"],
      ["cancellation_initiated", "revoked"],
    ])("a mandate that is %s is recorded as %s", async (detail, status) => {
      const verdict = await verifyMandate(
        mandate(),
        gatewaySaying({ state: "ended", detail }),
        NOW,
      );
      expect(dbHolder.current.calls.set[0].status).toBe(status);
      expect(verdict).toMatchObject({ result: "unusable", reason: "ended" });
    });
  });

  describe("★★ a mandate the customer paused", () => {
    it("is set aside as unknown, not ended: it can be resumed", async () => {
      const verdict = await verifyMandate(
        mandate(),
        gatewaySaying({ state: "paused", detail: "paused" }),
        NOW,
      );
      expect(verdict).toEqual({
        result: "unusable",
        mandate: mandate({ status: "unknown" }),
        changed: true,
        reason: "paused",
      });
      // Not stamped as revoked: it has not ended.
      expect(dbHolder.current.calls.set[0]).toEqual({
        status: "unknown",
        updatedAt: NOW.toISOString(),
      });
      // Only an active mandate is set aside.
      expect(render(dbHolder.current.calls.where[0]).params).toEqual([
        "man-1",
        "active",
      ]);
    });

    it("★ one already set aside is not announced again", async () => {
      // The conditional write matches nothing: it is not `active` any more.
      seed([]);
      const verdict = await verifyMandate(
        mandate({ status: "unknown" }),
        gatewaySaying({ state: "paused", detail: "paused" }),
        NOW,
      );
      expect(verdict).toMatchObject({ result: "unusable", changed: false });
    });

    it("★ one set aside that has now ENDED is recorded as ended, and still not announced again", async () => {
      const verdict = await verifyMandate(
        mandate({ status: "unknown" }),
        gatewaySaying({ state: "ended", detail: "cancelled" }),
        NOW,
      );
      expect(verdict).toMatchObject({
        result: "unusable",
        changed: false,
        mandate: { status: "revoked" },
      });
    });

    it("★★ one the customer RESUMED is live again", async () => {
      const verdict = await verifyMandate(
        mandate({ status: "unknown" }),
        gatewaySaying({ state: "chargeable" }),
        NOW,
      );
      expect(verdict).toEqual({
        result: "usable",
        mandate: mandate({ status: "active" }),
      });
      expect(dbHolder.current.calls.set[0]).toEqual({
        status: "active",
        updatedAt: NOW.toISOString(),
      });
      expect(render(dbHolder.current.calls.where[0]).params).toEqual([
        "man-1",
        "unknown",
      ]);
    });

    it("★★ never revived over the merchant's own cancel, or beside a newer mandate", async () => {
      // The row is `revoked` by now (no row moves)...
      seed([]);
      expect(
        await verifyMandate(
          mandate({ status: "unknown" }),
          gatewaySaying({ state: "chargeable" }),
          NOW,
        ),
      ).toMatchObject({ result: "unusable", changed: false });

      // ...or the store already has another active mandate: the one-active
      // index refuses the write, and that refusal is the answer.
      dbHolder.current.db.update = vi.fn(() => {
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      });
      expect(
        await verifyMandate(
          mandate({ status: "unknown" }),
          gatewaySaying({ state: "chargeable" }),
          NOW,
        ),
      ).toMatchObject({ result: "unusable", changed: false });
    });
  });

  describe("★★ a status that could not be written", () => {
    it("the gateway said NO: still not charged, and nobody is told yet", async () => {
      client.fail = new Error("db down");
      const verdict = await verifyMandate(
        mandate(),
        gatewaySaying({ state: "ended", detail: "cancelled" }),
        NOW,
      );
      expect(verdict).toEqual({
        result: "unusable",
        mandate: mandate(),
        changed: false,
        reason: "ended",
      });
    });

    it("the gateway said YES for a mandate set aside: left for the next run", async () => {
      client.fail = new Error("db down");
      const verdict = await verifyMandate(
        mandate({ status: "unknown" }),
        gatewaySaying({ state: "chargeable" }),
        NOW,
      );
      expect(verdict).toEqual({ result: "unknown" });
    });
  });

  it("a mandate with no token is unusable without asking anyone", async () => {
    const gateway = gatewaySaying({ state: "chargeable" });
    const verdict = await verifyMandate(
      mandate({ providerTokenId: null }),
      gateway,
      NOW,
    );
    expect(gateway.checkMandate).not.toHaveBeenCalled();
    expect(verdict).toMatchObject({ result: "unusable", changed: false });
  });
});

describe("loadMandateRecord", () => {
  it("reads one mandate, with its rail", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "man-1",
            status: "active",
            maxAmountPaise: 5_000_00,
            providerTokenId: "token_1",
            providerCustomerId: "cust_1",
            method: "upi",
          },
        ],
      ],
    });
    expect(await loadMandateRecord("man-1")).toEqual(
      mandate({ method: "upi" }),
    );
  });

  it("a mandate with no recorded rail reads as unknown", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...mandate(), method: null }]],
    });
    expect((await loadMandateRecord("man-1"))?.method).toBe("unknown");
  });

  it("null for no id, a missing row, or a failed read", async () => {
    expect(await loadMandateRecord(null)).toBeNull();
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await loadMandateRecord("man-1")).toBeNull();
    client.fail = new Error("db down");
    expect(await loadMandateRecord("man-1")).toBeNull();
  });
});
