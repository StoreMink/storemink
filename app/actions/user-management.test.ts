/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

vi.mock("@/lib/auth/firebase-users", () => ({
  deleteAuthUser: vi.fn(async () => {}),
  updateAuthUser: vi.fn(async () => {}),
  generatePasswordResetLink: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/firebase-claims", () => ({
  setUserClaims: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getActingStoreId: vi.fn(async () => "store-1"),
  // The caller gate: superadmin of the HOST store (platform operators count).
  isStoreSuperadmin: vi.fn(async () => true),
}));
// Which logins something else on the platform still uses.
vi.mock("@/lib/auth/identity-usage", () => ({
  authIdsInUse: vi.fn(async () => new Set<string>()),
}));
// The password reset is sent through the real builder; only the send itself
// and the store brand are stubbed.
const emailMocks = vi.hoisted(() => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/email/send", () => ({ sendEmail: emailMocks.sendEmail }));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrand: vi.fn(async () => ({
    name: "WholeSip",
    domain: "wholesip.com",
  })),
}));

// The ported data layer: with* runners invoke the callback with the mock db.
// The caller-role gate reads via withUser, target reads/updates via withService
// — both share this one mock db, so selectQueue is consumed in call order.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  changeUserRole,
  deleteUser,
  toggleUserSuspension,
  triggerPasswordReset,
} from "./user-management";
import {
  deleteAuthUser,
  generatePasswordResetLink,
} from "@/lib/auth/firebase-users";
import { setUserClaims } from "@/lib/auth/firebase-claims";
import { getServerUser } from "@/lib/auth/server-user";
import { isStoreSuperadmin } from "@/app/dashboard/lib/access";
import { authIdsInUse } from "@/lib/auth/identity-usage";

const CALLER_ID = "superadmin-123";
const member = [{ role: "member", email: "Staff@Example.com" }];

function setup(selectQueue: any[][], returningQueue?: any[][]) {
  dbHolder.current = makeDbMock({ selectQueue, returningQueue });
}

/** Every bound value in the WHERE of the Nth recorded where() call. */
function whereParams(n: number): unknown[] {
  return sqlParamValues(dbHolder.current.calls.where[n]);
}

describe("User Management Actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: CALLER_ID,
      email: "super@example.com",
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
    vi.mocked(isStoreSuperadmin).mockResolvedValue(true);
    vi.mocked(authIdsInUse).mockResolvedValue(new Set());
    vi.mocked(deleteAuthUser).mockResolvedValue();
    vi.mocked(setUserClaims).mockResolvedValue();
    // Default: the target is a plain member of THIS store.
    setup([member]);
  });

  describe("the caller gate", () => {
    it("refuses a superadmin of ANOTHER store — the gate is the host store's", async () => {
      // isStoreSuperadmin answers for the host store; a superadmin row
      // elsewhere on the platform makes it false here.
      vi.mocked(isStoreSuperadmin).mockResolvedValue(false);

      for (const run of [
        () => deleteUser("user-1"),
        () => changeUserRole("user-1", "superadmin"),
        () => toggleUserSuspension("user-1", true),
      ]) {
        expect((await run()).error).toBe("Unauthorized");
      }
      expect(dbHolder.current.calls.delete).toHaveLength(0);
      expect(dbHolder.current.calls.update).toHaveLength(0);
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });

    it("fails closed when the access lookup throws", async () => {
      vi.mocked(isStoreSuperadmin).mockRejectedValue(new Error("db down"));
      expect((await deleteUser("user-1")).error).toBe("Unauthorized");
    });
  });

  describe("deleteUser", () => {
    it("should fail if caller is not authenticated", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await deleteUser("user-1");
      expect(result.error).toBe("Not authenticated");
    });

    it("should delete a member of this store and their unused login", async () => {
      const result = await deleteUser("user-1");
      expect((result as any).success).toBe(true);
      // The target read AND the delete are both scoped to the host store.
      expect(whereParams(0)).toEqual(
        expect.arrayContaining(["user-1", "store-1"]),
      );
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(whereParams(1)).toEqual(
        expect.arrayContaining(["user-1", "store-1"]),
      );
      expect(authIdsInUse).toHaveBeenCalledWith(
        new Map([["user-1", new Set(["staff@example.com"])]]),
      );
      expect(deleteAuthUser).toHaveBeenCalledWith("user-1");
    });

    it("refuses a uid that is not an admin of this store, touching nothing", async () => {
      // Another store's admin, or a shopper's uid: no row here.
      setup([[]]);
      const result = await deleteUser("someone-elses");
      expect(result.error).toMatch(/isn't a member of this store/);
      expect(dbHolder.current.calls.delete).toHaveLength(0);
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });

    it("refuses when the target cannot be read, rather than assuming", async () => {
      setup([new Error("read failed") as any]);
      const result = await deleteUser("user-1");
      expect(result.error).toMatch(/couldn't load/i);
      expect(dbHolder.current.calls.delete).toHaveLength(0);
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });

    it("keeps a login something else still uses, and drops its role claim", async () => {
      // e.g. the same person shops on a storefront with this login.
      vi.mocked(authIdsInUse).mockResolvedValue(new Set(["user-1"]));
      const result = await deleteUser("user-1");
      expect((result as any).success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(deleteAuthUser).not.toHaveBeenCalled();
      expect(setUserClaims).toHaveBeenCalledWith("user-1", { role: null });
    });

    it("keeps the login when the usage check fails", async () => {
      vi.mocked(authIdsInUse).mockRejectedValue(new Error("db down"));
      const result = await deleteUser("user-1");
      expect((result as any).success).toBe(true);
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });

    it("should not allow deleting your own account", async () => {
      const result = await deleteUser(CALLER_ID);
      expect(result.error).toBe("You cannot delete your own account.");
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });

    it("counts superadmins in THIS store for the last-superadmin guard", async () => {
      // target is superadmin, this store's count = 1.
      setup([[{ role: "superadmin", email: "a@x.com" }], [{ n: 1 }]]);
      const result = await deleteUser("user-1");
      expect(result.error).toBe("Cannot delete the last superadmin.");
      expect(whereParams(1)).toEqual(
        expect.arrayContaining(["superadmin", "store-1"]),
      );
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });
  });

  describe("changeUserRole", () => {
    // The role list is platform data (platform_roles): the lookup is by slug
    // alone, never per store, and only a DASHBOARD role may be assigned.
    it("should fail if role is invalid", async () => {
      // platform_roles lookup empty → unknown role rejected.
      setup([[]]);
      const result = await changeUserRole("user-1", "invalid-role");
      expect(result.error).toBe("Invalid role");
    });

    it("looks the role up in the platform role list", async () => {
      setup([[{ slug: "editor", kind: "dashboard" }], member]);
      await changeUserRole("user-1", "editor");
      expect(whereParams(0)).toEqual(["editor"]);
    });

    // A cashier/manager is a pos_staff row with a PIN: moving someone there is
    // an invite, never a role change on an admins row.
    it("refuses a register role for a dashboard admin", async () => {
      setup([[{ slug: "cashier", kind: "pos" }], member]);
      const result = await changeUserRole("user-1", "cashier");
      expect(result.error).toBe("Invalid role");
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("should change role successfully and sync the claim", async () => {
      setup([[{ slug: "member", kind: "dashboard" }], member]);
      const result = await changeUserRole("user-1", "member");
      expect((result as any).success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toEqual({ role: "member" });
      // target read + update, both store-scoped
      expect(whereParams(2)).toEqual(
        expect.arrayContaining(["user-1", "store-1"]),
      );
      expect(setUserClaims).toHaveBeenCalledWith("user-1", { role: "member" });
    });

    it("refuses to change the role of another store's admin", async () => {
      setup([[{ slug: "member", kind: "dashboard" }], []]);
      const result = await changeUserRole("other-store-owner", "member");
      expect(result.error).toMatch(/isn't a member of this store/);
      expect(dbHolder.current.calls.update).toHaveLength(0);
      expect(setUserClaims).not.toHaveBeenCalled();
    });
  });

  describe("toggleUserSuspension", () => {
    it("should toggle suspension of a member of this store", async () => {
      setup([], [[{ id: "user-1" }]]);
      const result = await toggleUserSuspension("user-1", true);
      expect((result as any).success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toEqual({ isSuspended: true });
      expect(whereParams(0)).toEqual(
        expect.arrayContaining(["user-1", "store-1"]),
      );
    });

    it("reports a uid outside this store as not found", async () => {
      setup([], [[]]);
      const result = await toggleUserSuspension("other-store-owner", true);
      expect(result.error).toMatch(/isn't a member of this store/);
    });
  });

  describe("triggerPasswordReset", () => {
    const LINK =
      "https://auth.example.com/reset?oobCode=abc&mode=resetPassword";

    function withResend(run: () => Promise<void>) {
      return async () => {
        const previous = process.env.RESEND_API_KEY;
        process.env.RESEND_API_KEY = "re_test_key";
        try {
          await run();
        } finally {
          if (previous === undefined) delete process.env.RESEND_API_KEY;
          else process.env.RESEND_API_KEY = previous;
        }
      };
    }

    // Enumeration-safe: an unknown address reports the same success and sends
    // nothing.
    it(
      "reports success without sending when no link could be made",
      withResend(async () => {
        vi.mocked(generatePasswordResetLink).mockResolvedValue(null as any);
        const result = await triggerPasswordReset("ghost@example.com");
        expect(result.success).toBe(true);
        expect(emailMocks.sendEmail).not.toHaveBeenCalled();
      }),
    );

    it(
      "sends the composed reset email as a sensitive, unsuppressed mailer",
      withResend(async () => {
        vi.mocked(generatePasswordResetLink).mockResolvedValue(LINK as any);
        const result = await triggerPasswordReset("ada@example.com");
        expect(result.success).toBe(true);
        expect(emailMocks.sendEmail).toHaveBeenCalledTimes(1);
        const sent = (emailMocks.sendEmail.mock.calls[0] as any[])[0];
        expect(sent).toMatchObject({
          storeId: "store-1",
          to: "ada@example.com",
          subject: "Reset your WholeSip password",
          mailer: "password_reset",
          ignoreSuppression: true,
        });
        expect(sent.from).toContain("wholesip.com");
        // The link is the button target and the plain fallback, HTML-escaped.
        const escaped = LINK.replace(/&/g, "&amp;");
        expect(sent.html.split(`href="${escaped}"`).length - 1).toBe(2);
        expect(`${sent.subject}${sent.html}`).not.toMatch(/[\u2013\u2014]/);
      }),
    );
  });
});
