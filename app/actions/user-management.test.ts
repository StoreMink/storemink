/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

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

const CALLER_ID = "superadmin-123";
const superadmin = [{ role: "superadmin" }];

function setup(selectQueue: any[][]) {
  dbHolder.current = makeDbMock({ selectQueue });
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
    vi.mocked(deleteAuthUser).mockResolvedValue();
    vi.mocked(setUserClaims).mockResolvedValue();
    // Default: caller is superadmin, target is a plain member.
    setup([superadmin, [{ role: "member" }]]);
  });

  describe("deleteUser", () => {
    it("should fail if caller is not authenticated", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await deleteUser("user-1");
      expect(result.error).toBe("Not authenticated");
    });

    it("should fail if caller is not superadmin", async () => {
      setup([[{ role: "member" }]]); // caller gate → member
      const result = await deleteUser("user-1");
      expect(result.error).toBe("Unauthorized");
    });

    it("should delete user if caller is superadmin", async () => {
      const result = await deleteUser("user-1");
      expect((result as any).success).toBe(true);
      // Profile row removed (Cloud SQL) AND the login (Identity Platform).
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(deleteAuthUser).toHaveBeenCalledWith("user-1");
    });

    it("should not allow deleting your own account", async () => {
      setup([superadmin]); // only the gate read happens before the self-check
      const result = await deleteUser(CALLER_ID);
      expect(result.error).toBe("You cannot delete your own account.");
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });

    it("should not allow deleting the last superadmin", async () => {
      // gate, target is superadmin, count = 1.
      setup([superadmin, [{ role: "superadmin" }], [{ n: 1 }]]);
      const result = await deleteUser("user-1");
      expect(result.error).toBe("Cannot delete the last superadmin.");
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });
  });

  describe("changeUserRole", () => {
    it("should fail if role is invalid", async () => {
      // gate, roles-table lookup empty → unknown non-builtin role rejected.
      setup([superadmin, []]);
      const result = await changeUserRole("user-1", "invalid-role");
      expect(result.error).toBe("Invalid role");
    });

    it("should change role successfully and sync the claim", async () => {
      // gate, roles lookup (member is builtin so [] is fine), target=member.
      setup([superadmin, [], [{ role: "member" }]]);
      const result = await changeUserRole("user-1", "member");
      expect((result as any).success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toEqual({ role: "member" });
      expect(setUserClaims).toHaveBeenCalledWith("user-1", { role: "member" });
    });
  });

  describe("toggleUserSuspension", () => {
    it("should toggle suspension successfully", async () => {
      setup([superadmin]);
      const result = await toggleUserSuspension("user-1", true);
      expect((result as any).success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toEqual({ isSuspended: true });
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
