/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("@/lib/auth/firebase-users", () => ({
  verifyPassword: vi.fn(async () => true),
  updateAuthUser: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("@/lib/auth/identity-usage", () => ({
  authIdsInUse: vi.fn(async () => new Set<string>()),
}));
// The Admin SDK: the token check and the cleanup of a just-created identity.
const authMock = vi.hoisted(() => ({
  verifyIdToken: null as any,
  getUser: null as any,
  deleteUser: null as any,
}));
vi.mock("@/lib/auth/firebase-admin", () => ({
  getFirebaseAdminAuth: vi.fn(() => authMock),
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

import {
  updateProfileName,
  changePassword,
  confirmVerifiedPhone,
} from "./account-settings";
import { verifyPassword, updateAuthUser } from "@/lib/auth/firebase-users";
import { getServerUser } from "@/lib/auth/server-user";
import { getFirebaseAdminAuth } from "@/lib/auth/firebase-admin";
import { rateLimit } from "@/lib/rate-limit";
import { authIdsInUse } from "@/lib/auth/identity-usage";
import { admins, storeBillingSettings } from "@/drizzle/schema";

function makeFormData(fields: Record<string, string | null | undefined>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined) fd.set(k, v);
  }
  return fd;
}

const serverUser = (overrides: Record<string, any> = {}) => ({
  id: "user-1",
  email: "admin@example.com",
  // Identity Platform reports E.164 (with a leading "+").
  phone: "+919876543210",
  phoneConfirmed: true,
  metadata: {},
  ...overrides,
});

// account-settings.ts — the signed-in admin editing their own profile row.
// Name/phone are own-row Drizzle updates (withUser); the password change
// re-verifies + updates via Identity Platform.
describe("account-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock();
    vi.mocked(verifyPassword).mockResolvedValue(true);
    vi.mocked(updateAuthUser).mockResolvedValue();
    vi.mocked(getServerUser).mockResolvedValue(serverUser() as any);
  });

  describe("updateProfileName", () => {
    it("rejects empty first name", async () => {
      const result = await updateProfileName(makeFormData({ firstName: "  " }));
      expect(result.error).toMatch(/first name is required/i);
    });

    it("rejects unauthenticated callers", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await updateProfileName(
        makeFormData({ firstName: "Ada" }),
      );
      expect(result.error).toMatch(/not authenticated/i);
    });

    it("updates the name on the caller's own row", async () => {
      const result = await updateProfileName(
        makeFormData({ firstName: "  Ada  ", lastName: "  " }),
      );
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toEqual({
        firstName: "Ada",
        lastName: null,
      });
      expect(dbHolder.current.calls.where).toHaveLength(1);
    });

    it("returns an error when the update fails", async () => {
      dbHolder.current.db.update = vi.fn(() => {
        throw new Error("boom");
      });
      const result = await updateProfileName(
        makeFormData({ firstName: "Ada" }),
      );
      expect(result.error).toMatch(/couldn.?t save your name/i);
    });
  });

  describe("changePassword", () => {
    const validForm = {
      currentPassword: "oldpass123",
      newPassword: "newpass456",
      confirmPassword: "newpass456",
    };

    it("rejects an empty current password", async () => {
      const result = await changePassword(
        makeFormData({ ...validForm, currentPassword: "" }),
      );
      expect(result.error).toMatch(/current password/i);
    });

    it("rejects a new password shorter than 8 characters", async () => {
      const result = await changePassword(
        makeFormData({
          ...validForm,
          newPassword: "short",
          confirmPassword: "short",
        }),
      );
      expect(result.error).toMatch(/at least 8 characters/i);
    });

    it("rejects when the confirmation does not match", async () => {
      const result = await changePassword(
        makeFormData({ ...validForm, confirmPassword: "different1" }),
      );
      expect(result.error).toMatch(/do not match/i);
    });

    it("rejects when the new password equals the current one", async () => {
      const result = await changePassword(
        makeFormData({
          currentPassword: "samepass1",
          newPassword: "samepass1",
          confirmPassword: "samepass1",
        }),
      );
      expect(result.error).toMatch(/different from the current/i);
    });

    it("rejects when the caller has no email/session", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await changePassword(makeFormData(validForm));
      expect(result.error).toMatch(/not authenticated/i);
    });

    it("rejects when the current password is incorrect", async () => {
      vi.mocked(verifyPassword).mockResolvedValue(false);
      const result = await changePassword(makeFormData(validForm));
      expect(result.error).toMatch(/current password is incorrect/i);
    });

    it("returns an error when the password update fails", async () => {
      vi.mocked(updateAuthUser).mockRejectedValue(new Error("weak password"));
      const result = await changePassword(makeFormData(validForm));
      expect(result.error).toMatch(/couldn.?t update your password/i);
    });

    it("re-verifies and updates the password on success", async () => {
      const result = await changePassword(makeFormData(validForm));
      expect(result.success).toBe(true);
      expect(verifyPassword).toHaveBeenCalledWith(
        "admin@example.com",
        "oldpass123",
      );
      expect(updateAuthUser).toHaveBeenCalledWith("user-1", {
        password: "newpass456",
      });
    });
  });

  describe("confirmVerifiedPhone", () => {
    const now = () => Math.floor(Date.now() / 1000);
    // A token from the isolated phone sign-in in VerifyPhoneForm.
    const phoneToken = (overrides: Record<string, any> = {}) => ({
      uid: "phone-identity-1",
      phone_number: "+919876543210",
      auth_time: now() - 30,
      firebase: { sign_in_provider: "phone" },
      ...overrides,
    });
    const newPhoneOnlyRecord = (overrides: Record<string, any> = {}) => ({
      uid: "phone-identity-1",
      email: undefined,
      phoneNumber: "+919876543210",
      metadata: { creationTime: new Date().toUTCString() },
      providerData: [{ providerId: "phone" }],
      ...overrides,
    });

    beforeEach(() => {
      dbHolder.current = makeDbMock({
        returningQueue: [[{ storeId: "store-1", role: "superadmin" }]],
      });
      authMock.verifyIdToken = vi.fn(async () => phoneToken());
      authMock.getUser = vi.fn(async () => newPhoneOnlyRecord());
      authMock.deleteUser = vi.fn(async () => {});
      vi.mocked(getFirebaseAdminAuth).mockReturnValue(authMock as any);
      vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
      vi.mocked(authIdsInUse).mockResolvedValue(new Set());
    });

    it("rejects unauthenticated callers", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await confirmVerifiedPhone({ idToken: "t" });
      expect(result.error).toMatch(/not authenticated/i);
      expect(authMock.verifyIdToken).not.toHaveBeenCalled();
    });

    it("rejects a missing proof", async () => {
      const result = await confirmVerifiedPhone({ idToken: "" });
      expect(result.error).toMatch(/proof is missing/i);
    });

    it("is rate limited per admin", async () => {
      vi.mocked(rateLimit).mockResolvedValue({ allowed: false } as any);
      const result = await confirmVerifiedPhone({ idToken: "t" });
      expect(result.error).toMatch(/too many/i);
      expect(rateLimit).toHaveBeenCalledWith(
        "admin-phone-confirm:user-1",
        expect.anything(),
      );
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("rejects an invalid or revoked token", async () => {
      authMock.verifyIdToken = vi.fn(async () => {
        throw new Error("bad token");
      });
      const result = await confirmVerifiedPhone({ idToken: "t" });
      expect(result.error).toMatch(/invalid or expired/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("★ refuses a proof that is not a recent PHONE sign-in", async () => {
      for (const token of [
        phoneToken({ firebase: { sign_in_provider: "password" } }),
        phoneToken({ auth_time: now() - 10 * 60 }),
        phoneToken({ phone_number: undefined }),
        phoneToken({ phone_number: "9876543210" }),
      ]) {
        authMock.verifyIdToken = vi.fn(async () => token);
        const result = await confirmVerifiedPhone({ idToken: "t" });
        expect(result.error).toMatch(/didn.?t verify a mobile/i);
      }
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("★ saves the number FROM THE TOKEN, verified, on the caller's own row", async () => {
      const result = await confirmVerifiedPhone({ idToken: "t" });
      expect(result).toEqual({ phone: "+919876543210" });
      expect(dbHolder.current.calls.update[0]).toBe(admins);
      expect(dbHolder.current.calls.set[0].phone).toBe("+919876543210");
      // A database clock, not a client one.
      expect(dbHolder.current.calls.set[0].phoneVerifiedAt).toBeTruthy();
    });

    it("fills an owner's empty invoice phone, never a staff member's", async () => {
      await confirmVerifiedPhone({ idToken: "t" });
      expect(dbHolder.current.calls.update[1]).toBe(storeBillingSettings);
      expect(dbHolder.current.calls.set[1]).toEqual({
        contactPhone: "+919876543210",
        updatedBy: "user-1",
      });

      dbHolder.current = makeDbMock({
        returningQueue: [[{ storeId: "store-1", role: "member" }]],
      });
      await confirmVerifiedPhone({ idToken: "t" });
      expect(dbHolder.current.calls.update).toEqual([admins]);
    });

    it("reports an account with no admin row instead of claiming success", async () => {
      dbHolder.current = makeDbMock({ returningQueue: [[]] });
      const result = await confirmVerifiedPhone({ idToken: "t" });
      expect(result.phone).toBeUndefined();
      expect(result.error).toMatch(/no store profile/i);
    });

    it("returns an error when the save fails", async () => {
      dbHolder.current.db.update = vi.fn(() => {
        throw new Error("boom");
      });
      const result = await confirmVerifiedPhone({ idToken: "t" });
      expect(result.error).toMatch(/couldn.?t save your phone/i);
    });

    it("deletes the brand-new phone-only identity the code sign-in created", async () => {
      await confirmVerifiedPhone({
        idToken: "t",
        cleanupCreatedAuthUser: true,
      });
      expect(authMock.deleteUser).toHaveBeenCalledWith("phone-identity-1");
    });

    it("★ never deletes the admin's own login, a shopper's, or one with a role", async () => {
      // The number is already on the admin's own login.
      authMock.verifyIdToken = vi.fn(async () => phoneToken({ uid: "user-1" }));
      await confirmVerifiedPhone({
        idToken: "t",
        cleanupCreatedAuthUser: true,
      });
      // An identity that is not brand new (a shopper who signed in before).
      authMock.verifyIdToken = vi.fn(async () => phoneToken());
      authMock.getUser = vi.fn(async () =>
        newPhoneOnlyRecord({
          metadata: { creationTime: "Mon, 01 Jan 2024 00:00:00 GMT" },
        }),
      );
      await confirmVerifiedPhone({
        idToken: "t",
        cleanupCreatedAuthUser: true,
      });
      // Brand new, but already holds a StoreMink role.
      authMock.getUser = vi.fn(async () => newPhoneOnlyRecord());
      vi.mocked(authIdsInUse).mockResolvedValue(new Set(["phone-identity-1"]));
      await confirmVerifiedPhone({
        idToken: "t",
        cleanupCreatedAuthUser: true,
      });
      // The browser did not say it was new.
      vi.mocked(authIdsInUse).mockResolvedValue(new Set());
      await confirmVerifiedPhone({ idToken: "t" });
      expect(authMock.deleteUser).not.toHaveBeenCalled();
    });
  });
});
