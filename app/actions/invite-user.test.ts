/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("@/lib/auth/firebase-users", () => ({
  createAuthUser: vi.fn(async () => "new-user"),
  deleteAuthUser: vi.fn(async () => {}),
  authErrorCode: vi.fn(() => undefined),
}));
vi.mock("@/lib/auth/firebase-claims", () => ({
  setUserClaims: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
const planMocks = vi.hoisted(() => ({ assertCanInviteStaff: vi.fn() }));
vi.mock("@/lib/plans/entitlements", () => ({
  assertCanInviteStaff: planMocks.assertCanInviteStaff,
  PlanEntitlementError: class PlanEntitlementError extends Error {},
}));
vi.mock("./location-actions", () => ({ setAdminLocations: vi.fn() }));
// The register half of an invite: a cashier/manager becomes a pos_staff row
// through the POS staff flow, gated on the store having POS switched on.
const posMocks = vi.hoisted(() => ({
  inviteStaff: vi.fn(async () => ({ id: "pos-1" })),
  getPosState: vi.fn(() => ({ posEnabled: true, posAvailable: true })),
  getStoreLocations: vi.fn(async () => [
    { id: "loc-1", name: "Delhi" },
    { id: "loc-2", name: "Jaipur" },
  ]),
}));
vi.mock("./pos-staff-actions", () => ({ inviteStaff: posMocks.inviteStaff }));
vi.mock("@/lib/pos/locations", () => ({
  getPosState: posMocks.getPosState,
  getStoreLocations: posMocks.getStoreLocations,
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStore: vi.fn(async () => ({ id: "store-1" })),
}));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrandById: vi.fn(async () => ({
    name: "WholeSip",
    domain: "wholesip.com",
  })),
}));
// vi.hoisted ensures `resendSend` exists at the moment the `vi.mock("resend")`
// factory runs (mocks are hoisted above imports). The factory must return a
// real constructor (class), because invite-user.ts uses `new Resend(...)`.
const { resendSend } = vi.hoisted(() => ({
  resendSend: vi.fn().mockResolvedValue({}),
}));
vi.mock("resend", () => {
  class Resend {
    emails: { send: typeof resendSend };
    constructor() {
      this.emails = { send: resendSend };
    }
  }
  return { Resend };
});

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { inviteUser } from "./invite-user";
import { createAuthUser, deleteAuthUser } from "@/lib/auth/firebase-users";
import { setUserClaims } from "@/lib/auth/firebase-claims";
import { getServerUser } from "@/lib/auth/server-user";
import { setAdminLocations } from "./location-actions";
import { PlanEntitlementError } from "@/lib/plans/entitlements";

function makeFormData(fields: Record<string, string | null | undefined>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined) fd.set(k, v);
  }
  return fd;
}

type RoleRow = { slug: string; kind: "dashboard" | "pos"; name: string };
const STAFF_ROLE: RoleRow = {
  slug: "member",
  kind: "dashboard",
  name: "Staff",
};

// The caller-role gate reads via withUser (select #1 = role + store_id), the
// platform_roles lookup via withService (select #2 — the role list is
// platform data, so the invite asks it what `role` is), then the
// email-collision check (select #3). superadmin, in-store.
function superadminCaller(
  existingEmail = false,
  role: RoleRow | null = STAFF_ROLE,
) {
  dbHolder.current = makeDbMock({
    selectQueue: [
      [{ role: "superadmin", store_id: "store-1" }],
      role ? [role] : [],
      existingEmail ? [{ id: "existing" }] : [],
    ],
  });
}

// invite-user.ts — superadmin-only action that creates a new dashboard user.
// Profile reads/writes are on Drizzle; the auth account (Identity Platform) +
// custom claims + the Resend email stay on their providers.
describe("inviteUser", () => {
  const validForm = {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    role: "member",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    planMocks.assertCanInviteStaff.mockResolvedValue(undefined);
    resendSend.mockClear();
    resendSend.mockResolvedValue({});
    process.env.RESEND_API_KEY = "re_actual_key";
    superadminCaller();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "caller-1",
      email: "super@example.com",
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
    vi.mocked(createAuthUser).mockResolvedValue("new-user");
    vi.mocked(deleteAuthUser).mockResolvedValue();
    vi.mocked(setUserClaims).mockResolvedValue();
    // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS.
    vi.mocked(setAdminLocations).mockResolvedValue({ success: true });
  });

  it("rejects empty first name", async () => {
    const result = await inviteUser(
      makeFormData({ ...validForm, firstName: "" }),
    );
    expect(result.error).toMatch(/first name/i);
  });

  it("rejects malformed email", async () => {
    const result = await inviteUser(makeFormData({ ...validForm, email: "x" }));
    expect(result.error).toMatch(/valid email/i);
  });

  it("rejects unknown role", async () => {
    superadminCaller(false, null);
    const result = await inviteUser(
      makeFormData({ ...validForm, role: "ghost" }),
    );
    expect(result.error).toMatch(/invalid role/i);
    expect(createAuthUser).not.toHaveBeenCalled();
  });

  it("accepts any dashboard role on the platform list, including one an operator added", async () => {
    const rows: RoleRow[] = [
      { slug: "superadmin", kind: "dashboard", name: "Owner" },
      { slug: "admin", kind: "dashboard", name: "Admin" },
      { slug: "content-editor", kind: "dashboard", name: "Content editor" },
    ];
    for (const row of rows) {
      superadminCaller(false, row);
      const result = await inviteUser(
        makeFormData({ ...validForm, role: row.slug }),
      );
      expect(result.error).toBeUndefined();
    }
    expect(createAuthUser).toHaveBeenCalledTimes(3);
    expect(setUserClaims).toHaveBeenLastCalledWith("new-user", {
      role: "content-editor",
      forcePasswordReset: true,
    });
  });

  // The email says what the role is CALLED, never the stored slug: a `member`
  // row is "a staff member" to the person reading the invitation.
  it("names the role in the role's own words", async () => {
    await inviteUser(makeFormData(validForm));
    const sent = resendSend.mock.calls[0][0];
    expect(sent.html).toContain("a staff member");
    expect(sent.html).not.toMatch(/\ba member\b/);
  });

  it("rejects unauthenticated callers", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    const result = await inviteUser(makeFormData(validForm));
    expect(result.error).toMatch(/not authenticated/i);
  });

  it("rejects non-superadmin callers", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ role: "member", store_id: "store-1" }]],
    });
    const result = await inviteUser(makeFormData(validForm));
    expect(result.error).toMatch(/unauthorized|superadmin/i);
  });

  it("rejects when a profile with that email already exists", async () => {
    superadminCaller(true);
    const result = await inviteUser(makeFormData(validForm));
    expect(result.error).toMatch(/already exists/i);
    expect(createAuthUser).not.toHaveBeenCalled();
  });

  it("checks the staff cap before creating an auth identity", async () => {
    planMocks.assertCanInviteStaff.mockRejectedValueOnce(
      new PlanEntitlementError("Free includes 1 staff account."),
    );
    const result = await inviteUser(makeFormData(validForm));
    expect(result.error).toMatch(/1 staff account/i);
    expect(createAuthUser).not.toHaveBeenCalled();
  });

  it("creates the auth user + profile, sets claims, and sends invite email", async () => {
    const result = await inviteUser(makeFormData(validForm));
    expect(result.success).toBe(true);
    expect(createAuthUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "ada@example.com",
        emailVerified: true,
      }),
    );
    // Profile upserted with the new auth id + inviter's store.
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      id: "new-user",
      email: "ada@example.com",
      storeId: "store-1",
      invitedBy: "caller-1",
    });
    // Role + force-reset mirrored into the auth token as custom claims.
    expect(setUserClaims).toHaveBeenCalledWith("new-user", {
      role: "member",
      forcePasswordReset: true,
    });
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it("cleans up the auth user if profile insert fails", async () => {
    superadminCaller();
    dbHolder.current.db.insert = vi.fn(() => {
      throw new Error("no");
    });
    const result = await inviteUser(makeFormData(validForm));
    expect(result.error).toMatch(/failed to create user profile/i);
    expect(deleteAuthUser).toHaveBeenCalledWith("new-user");
  });

  it("falls back gracefully without RESEND_API_KEY (dev mode)", async () => {
    process.env.RESEND_API_KEY = "placeholder";
    const result = await inviteUser(makeFormData(validForm));
    expect(result.success).toBe(true);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("escapes HTML in the invitee name within the email body", async () => {
    await inviteUser(
      makeFormData({ ...validForm, firstName: "<img/onerror=x>" }),
    );
    const sentHtml = resendSend.mock.calls[0][0].html as string;
    expect(sentHtml).not.toContain("<img/onerror");
    expect(sentHtml).toContain("&lt;img");
  });

  // The invitation is the standard composed email: one document, the store's
  // name in a sentence-case subject, the temporary password and sign-in email
  // in the body, and a button to the store's own dashboard.
  it("sends the composed invitation with the credentials and sign-in link", async () => {
    await inviteUser(makeFormData(validForm));
    const sent = resendSend.mock.calls[0][0];
    expect(sent.subject).toBe("You're invited to the WholeSip dashboard");
    expect(sent.html.match(/<!DOCTYPE html>/g)).toHaveLength(1);
    expect(sent.html).toContain("Temporary password");
    expect(sent.html).toContain("ada@example.com");
    expect(sent.html).toMatch(/href="https?:\/\/[^"]*\/dashboard"/);
    expect(sent.html).not.toContain("🎉");
    expect(`${sent.subject}${sent.html}`).not.toMatch(/[\u2013\u2014]/);
  });

  // Never print a working password to the logs when it was actually emailed.
  it("does not log the temporary password when the email was sent", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await inviteUser(makeFormData(validForm));
      const logged = log.mock.calls.flat().join("\n");
      expect(logged).not.toMatch(/Temporary Password/i);
    } finally {
      log.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // Location scope at invite time. The machinery (admin_locations,
  // getViewerLocations, setAdminLocations) already existed — but the only way to
  // set it was an action with no caller, so in practice every invited admin saw
  // every shop.
  // ---------------------------------------------------------------------------
  describe("inviteUser — location scope", () => {
    function formWith(locationIds: string[], role = "member") {
      const fd = new FormData();
      fd.set("firstName", "Ada");
      fd.set("email", "ada@example.com");
      fd.set("role", role);
      // ★ append, not set — the field is multi-value: one person can cover
      // several shops.
      for (const id of locationIds) fd.append("locationIds", id);
      return fd;
    }

    it("restricts the new admin to the locations given", async () => {
      await inviteUser(formWith(["loc-1", "loc-2"]));
      expect(setAdminLocations).toHaveBeenCalledWith("new-user", [
        "loc-1",
        "loc-2",
      ]);
    });

    // ★ EMPTY = UNRESTRICTED, the existing contract (null = all). So the field
    // being ignored invites exactly the admin this form always did — no
    // behaviour change for anyone who never touches it.
    it("leaves an admin unrestricted when none are given", async () => {
      await inviteUser(formWith([]));
      expect(setAdminLocations).not.toHaveBeenCalled();
    });

    // A superadmin sees everything by definition; writing a scope for one would
    // store a restriction that getViewerLocations then ignores, which is worse
    // than storing nothing — the staff list would show a limit that isn't real.
    it("never scopes a superadmin", async () => {
      await inviteUser(formWith(["loc-1"], "superadmin"));
      expect(setAdminLocations).not.toHaveBeenCalled();
    });

    // ⚠ Best-effort: a failure here leaves them unrestricted, which is visible
    // on the staff list and fixable in one click. Failing the invite would leave
    // an orphaned auth user instead.
    it("still creates the admin when the scope write fails", async () => {
      vi.mocked(setAdminLocations).mockRejectedValue(new Error("db down"));
      const r = await inviteUser(formWith(["loc-1"]));
      expect(r.error).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Register roles. A cashier or manager is a pos_staff row with a PIN, not a
  // dashboard account: the one invite dialog routes them to the POS staff flow
  // and never creates an auth user or an admins row for them.
  // ---------------------------------------------------------------------------
  describe("inviteUser — register roles", () => {
    function posForm(role: "cashier" | "manager", locationIds: string[] = []) {
      const fd = new FormData();
      fd.set("firstName", "Priya");
      fd.set("lastName", "Sharma");
      fd.set("email", "Priya@Example.com");
      fd.set("role", role);
      for (const id of locationIds) fd.append("locationIds", id);
      return fd;
    }

    const CASHIER: RoleRow = { slug: "cashier", kind: "pos", name: "Cashier" };
    const MANAGER: RoleRow = { slug: "manager", kind: "pos", name: "Manager" };

    it("routes a cashier to the POS staff flow with a composed name", async () => {
      superadminCaller(false, CASHIER);
      const r = await inviteUser(posForm("cashier", ["loc-2"]));
      expect(r).toEqual({ success: true });
      expect(posMocks.inviteStaff).toHaveBeenCalledWith({
        name: "Priya Sharma",
        email: "priya@example.com",
        role: "cashier",
        locationIds: ["loc-2"],
      });
      expect(createAuthUser).not.toHaveBeenCalled();
      expect(dbHolder.current.calls.insert).toHaveLength(0);
      expect(setAdminLocations).not.toHaveBeenCalled();
    });

    // "Nothing ticked" means every shop, the same reading the dashboard
    // location picker gives — and the POS flow refuses an empty assignment,
    // so the action fills it in rather than failing the invite.
    it("assigns every location when none is ticked", async () => {
      superadminCaller(false, MANAGER);
      await inviteUser(posForm("manager"));
      expect(posMocks.inviteStaff).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "manager",
          locationIds: ["loc-1", "loc-2"],
        }),
      );
    });

    it("refuses a register role while Point of Sale is off", async () => {
      superadminCaller(false, CASHIER);
      posMocks.getPosState.mockReturnValueOnce({
        posEnabled: false,
        posAvailable: true,
      });
      const r = await inviteUser(posForm("cashier"));
      expect(r.error).toMatch(/switch on point of sale/i);
      expect(posMocks.inviteStaff).not.toHaveBeenCalled();
    });

    it("surfaces the POS flow's own refusal", async () => {
      superadminCaller(false, CASHIER);
      posMocks.inviteStaff.mockResolvedValueOnce({
        error: "A staff member with this email already exists.",
      } as any);
      const r = await inviteUser(posForm("cashier"));
      expect(r.error).toMatch(/already exists/i);
    });

    // Still the owner's call: the caller gate runs before the branch.
    it("still requires the owner", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ role: "admin", store_id: "store-1" }]],
      });
      const r = await inviteUser(posForm("cashier"));
      expect(r.error).toMatch(/unauthorized|superadmin/i);
      expect(posMocks.inviteStaff).not.toHaveBeenCalled();
    });
  });
});
