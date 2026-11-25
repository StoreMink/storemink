/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/firebase-users", () => ({
  deleteAuthUser: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/identity-usage", () => ({
  authIdsInUse: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => "a0000000-0000-4000-8000-000000000001"),
}));

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { updateCustomer, deleteCustomer } from "./customer-actions";
import { deleteAuthUser } from "@/lib/auth/firebase-users";
import { authIdsInUse } from "@/lib/auth/identity-usage";
import { logError } from "@/lib/observability/logger";
import { getManagerUserId } from "@/app/dashboard/lib/access";
import { revalidatePath } from "next/cache";

const validInput = {
  firstName: "  Grace  ",
  lastName: "  Hopper  ",
  email: "grace@example.com",
};

// customer-actions.ts — dashboard CRUD over storefront customers. Table ops run
// in the service scope with an explicit store filter; the Identity Platform
// login is removed via deleteAuthUser. Guarded by the "users" manage permission.
describe("customer-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ownership pre-check finds the in-store customer by default.
    dbHolder.current = makeDbMock({ selectQueue: [[{ id: "cust-1" }]] });
    vi.mocked(deleteAuthUser).mockResolvedValue();
    vi.mocked(authIdsInUse).mockResolvedValue(new Set());
    vi.mocked(getManagerUserId).mockResolvedValue("user-1");
  });

  describe("updateCustomer", () => {
    // Permission gate.
    it("rejects when caller lacks users.manage", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);
      const result = await updateCustomer("id", validInput);
      expect(result.error).toMatch(/permission/i);
    });

    // First name is mandatory — whitespace-only counts as empty.
    it("rejects empty first name", async () => {
      const result = await updateCustomer("id", {
        ...validInput,
        firstName: "   ",
      });
      expect(result.error).toMatch(/first name is required/i);
    });

    // Email, when provided, must be well-formed.
    it("rejects an invalid email", async () => {
      const result = await updateCustomer("id", {
        ...validInput,
        email: "nope",
      });
      expect(result.error).toMatch(/valid email/i);
    });

    // Happy path — trims fields, updates by id + store, revalidates.
    it("updates the customer and revalidates", async () => {
      const result = await updateCustomer("cust-1", validInput);
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toEqual({
        firstName: "Grace",
        lastName: "Hopper",
        email: "grace@example.com",
      });
      expect(dbHolder.current.calls.where).toHaveLength(1);
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/users");
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/users/cust-1");
    });

    // An empty last name / email collapse to null rather than "".
    it("normalises blank last name and email to null", async () => {
      await updateCustomer("cust-1", {
        firstName: "Grace",
        lastName: "  ",
        email: "  ",
      });
      expect(dbHolder.current.calls.set[0]).toEqual({
        firstName: "Grace",
        lastName: null,
        email: null,
      });
    });

    // 23505 unique-violation (email already taken) → specific friendly message.
    it("returns a friendly error on unique-violation", async () => {
      dbHolder.current.db.update = vi.fn(() => {
        throw Object.assign(new Error("dup"), { code: "23505" });
      });
      const result = await updateCustomer("id", validInput);
      expect(result.error).toMatch(/already used by another customer/i);
    });

    // Any other DB error → generic failure message.
    it("returns a generic error on other DB failures", async () => {
      dbHolder.current.db.update = vi.fn(() => {
        throw new Error("boom");
      });
      const result = await updateCustomer("id", validInput);
      expect(result.error).toMatch(/failed to save changes/i);
    });
  });

  describe("deleteCustomer", () => {
    // The three reads deleteCustomer makes, by table: the locked users row,
    // the order counts, the store credit balance.
    const mockDelete = (opts: {
      user?: any[] | Error;
      orders?: any[] | Error;
      credit?: any[] | Error;
    }) => {
      dbHolder.current = makeDbMock({
        selectByTable: {
          users: [
            opts.user ?? [{ id: "cust-1", email: " Grace@Example.com " }],
          ],
          orders: [opts.orders ?? [{ here: 0, total: 0 }]],
          customer_credit_balances: [opts.credit ?? []],
        },
      });
    };

    // Permission gate.
    it("rejects when caller lacks users.manage", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);
      const result = await deleteCustomer("id");
      expect(result.error).toMatch(/permission/i);
    });

    // Cross-store isolation: a customer that isn't in the acting store must not
    // be deletable by id. The service scope bypasses RLS, so the app-layer
    // ownership check is the only thing preventing a cross-tenant account delete.
    it("refuses to delete a customer from another store", async () => {
      mockDelete({ user: [] });
      const result = await deleteCustomer("other-store-cust");
      expect(result.error).toMatch(/not found/i);
      expect(deleteAuthUser).not.toHaveBeenCalled();
      expect(dbHolder.current.calls.delete).toHaveLength(0);
    });

    // The users row is locked before the orders are counted, so an order
    // being placed now is either counted or waits and then fails.
    it("locks the customer row FOR UPDATE", async () => {
      mockDelete({});
      await deleteCustomer("cust-1");
      expect(dbHolder.current.calls.forUpdate).toEqual(["update"]);
    });

    // The cascade would delete every order behind this customer.
    it("refuses a customer with orders in this store, naming the count", async () => {
      mockDelete({ orders: [{ here: 3, total: 3 }] });
      const result = await deleteCustomer("cust-1");
      expect(result.error).toBe(
        "This customer has 3 orders, so they can't be deleted. Their order history is part of your records.",
      );
      expect(dbHolder.current.calls.delete).toHaveLength(0);
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });

    it("says 1 order, not 1 orders", async () => {
      mockDelete({ orders: [{ here: 1, total: 1 }] });
      const result = await deleteCustomer("cust-1");
      expect(result.error).toMatch(/has 1 order,/);
    });

    // The cascade is not store-scoped, so orders elsewhere also refuse, and
    // the message reveals no other store's count.
    it("refuses when the only orders are another store's, without a count", async () => {
      mockDelete({ orders: [{ here: 0, total: 2 }] });
      const result = await deleteCustomer("cust-1");
      expect(result.error).toMatch(/linked to orders/);
      expect(result.error).not.toMatch(/\d/);
      expect(dbHolder.current.calls.delete).toHaveLength(0);
    });

    // The credit ledger has no foreign key: a balance would be orphaned.
    it("refuses a customer holding store credit", async () => {
      mockDelete({ credit: [{ balance: "250.00" }] });
      const result = await deleteCustomer("cust-1");
      expect(result.error).toMatch(/₹250\.00 of store credit/);
      expect(dbHolder.current.calls.delete).toHaveLength(0);
    });

    it("deletes a customer whose credit is zero", async () => {
      mockDelete({ credit: [{ balance: "0" }] });
      const result = await deleteCustomer("cust-1");
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
    });

    // Happy path: the row goes, then the login, once nothing else uses it.
    it("deletes the row, then the unused login, then revalidates", async () => {
      mockDelete({});
      const result = await deleteCustomer("cust-1");
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      // Asked with the trimmed, lowercased email.
      const asked = vi.mocked(authIdsInUse).mock.calls[0][0];
      expect([...asked.get("cust-1")!]).toEqual(["grace@example.com"]);
      expect(deleteAuthUser).toHaveBeenCalledWith("cust-1");
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/users");
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/users/cust-1");
    });

    // An owner who shopped at their own store shares the login.
    it("keeps a login that something else still uses", async () => {
      mockDelete({});
      vi.mocked(authIdsInUse).mockResolvedValue(new Set(["cust-1"]));
      const result = await deleteCustomer("cust-1");
      expect(result.success).toBe(true);
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });

    // A failed in-use check keeps the login (fail toward keeping).
    it("keeps the login when the in-use check fails", async () => {
      mockDelete({});
      vi.mocked(authIdsInUse).mockRejectedValue(new Error("db down"));
      const result = await deleteCustomer("cust-1");
      expect(result.success).toBe(true);
      expect(deleteAuthUser).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledWith(
        "customers.login_use_check_failed",
        expect.anything(),
        expect.anything(),
      );
    });

    // A till customer has no login at all.
    it("never touches logins for a till (pos_) customer", async () => {
      mockDelete({ user: [{ id: "pos_abc", email: null }] });
      const result = await deleteCustomer("pos_abc");
      expect(result.success).toBe(true);
      expect(authIdsInUse).not.toHaveBeenCalled();
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });

    // The customer is gone; a failed login delete is logged, not reported.
    it("still succeeds when the login delete fails", async () => {
      mockDelete({});
      vi.mocked(deleteAuthUser).mockRejectedValue(new Error("on fire"));
      const result = await deleteCustomer("cust-1");
      expect(result.success).toBe(true);
      expect(logError).toHaveBeenCalledWith(
        "customers.login_delete_failed",
        expect.anything(),
        expect.anything(),
      );
    });

    // Fail closed: a check that could not run never reads as "not found"
    // and never deletes.
    it("refuses with a retry message when the order check throws", async () => {
      mockDelete({ orders: new Error("connection reset") });
      const result = await deleteCustomer("cust-1");
      expect(result.error).toBe(
        "We couldn't check this customer's orders, so nothing was deleted. Please try again.",
      );
      expect(dbHolder.current.calls.delete).toHaveLength(0);
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });

    it("refuses with the retry message when the row delete fails", async () => {
      mockDelete({});
      dbHolder.current.db.delete = vi.fn(() => {
        throw new Error("still here");
      });
      const result = await deleteCustomer("cust-1");
      expect(result.error).toMatch(/nothing was deleted/);
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });
  });
});
