/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, type DbMock } from "@/app/actions/_test-helpers";

const holder = vi.hoisted(() => ({
  db: null as DbMock | null,
  rolePermissions: vi.fn(),
  brandSoul: vi.fn(),
  access: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(holder.db!.db))),
}));
vi.mock("@/lib/roles/platform-roles", () => ({
  readRolePermissionsWith: holder.rolePermissions,
}));
// ★ Not read any more (B17): the revamp reads the saved guide itself. The
//   mock stays so a test can prove the stand-in voice is never asked for.
vi.mock("@/lib/ai/brand-voice", () => ({
  getBrandSoulForStore: holder.brandSoul,
}));
vi.mock("@/lib/mink/access", () => ({
  getMinkStoreAccess: holder.access,
}));

import { can } from "@/app/dashboard/lib/permissions";
import { rebuildRevampActor } from "./actor";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const LOCATION_ID = "33333333-3333-4333-8333-333333333333";

const job = {
  storeId: STORE_ID,
  adminId: "admin-uid-1",
  requesterEmail: "Owner@Example.com",
  originRunId: RUN_ID,
};

function storeRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "active",
    plan: "basic",
    planExpiresAt: null,
    compPlan: null,
    compExpiresAt: null,
    settings: {
      business: { timeZone: "Asia/Dubai" },
      features: { "inventory.lowStockThreshold": 9 },
    },
    ...overrides,
  };
}

function useDb(tables: Record<string, (any[] | Error)[]>) {
  holder.db = makeDbMock({ selectByTable: tables });
}

beforeEach(() => {
  holder.rolePermissions.mockResolvedValue({
    dashboard: ["view"],
    builder: ["view", "manage"],
  });
  holder.brandSoul.mockResolvedValue("You are the voice of a theme's shop.");
  holder.access.mockResolvedValue({ enabled: true, draftingEnabled: true });
});

describe("rebuildRevampActor", () => {
  it("★ finds a platform operator by the verified email and makes them superadmin", async () => {
    useDb({
      stores: [[storeRow()]],
      platform_admins: [[{ id: "operator-row" }]],
    });
    const actor = await rebuildRevampActor(job, "request-1");
    expect(actor).toMatchObject({
      storeId: STORE_ID,
      adminId: "admin-uid-1",
      email: "owner@example.com",
      roleSlug: "superadmin",
      isSuperadmin: true,
      permissions: {},
      locationIds: null,
      runId: RUN_ID,
      draftingEnabled: true,
      requestId: "request-1",
    });
    // An operator has no admins row to read, and no location scope: the
    // store, the operator list and the saved brand voice.
    expect(holder.db!.calls.select).toHaveLength(3);
    expect(holder.rolePermissions).not.toHaveBeenCalled();
  });

  it("rebuilds a store admin's role, permissions and location scope from the database", async () => {
    useDb({
      stores: [[storeRow()]],
      platform_admins: [[]],
      admins: [
        [{ role: "member", email: "Staff@Example.com", isSuspended: false }],
      ],
      admin_locations: [[{ locationId: LOCATION_ID }]],
    });
    const actor = await rebuildRevampActor(job, "request-2");
    expect(actor).toMatchObject({
      email: "staff@example.com",
      roleSlug: "member",
      isSuperadmin: false,
      locationIds: [LOCATION_ID],
      analyticsTimeZone: "Asia/Dubai",
      currency: "INR",
      defaultLowStockThreshold: 9,
      effectivePlan: "basic",
    });
    expect(holder.rolePermissions).toHaveBeenCalledWith(
      holder.db!.db,
      "member",
    );
    expect(can(actor!.permissions, "builder", "manage")).toBe(true);
  });

  it("treats no location rows as unrestricted, never as no locations", async () => {
    useDb({
      stores: [[storeRow()]],
      platform_admins: [[]],
      admins: [[{ role: "member", email: "s@x.com", isSuspended: false }]],
      admin_locations: [[]],
    });
    const actor = await rebuildRevampActor(job, "r");
    expect(actor?.locationIds).toBeNull();
  });

  it("gives a store superadmin full authority without reading a role", async () => {
    useDb({
      stores: [[storeRow()]],
      platform_admins: [[]],
      admins: [[{ role: "superadmin", email: "o@x.com", isSuspended: false }]],
    });
    const actor = await rebuildRevampActor(job, "r");
    expect(actor).toMatchObject({ isSuperadmin: true, locationIds: null });
    expect(holder.rolePermissions).not.toHaveBeenCalled();
  });

  it("★ returns null for a suspended admin", async () => {
    useDb({
      stores: [[storeRow()]],
      platform_admins: [[]],
      admins: [[{ role: "member", email: "s@x.com", isSuspended: true }]],
    });
    await expect(rebuildRevampActor(job, "r")).resolves.toBeNull();
  });

  it("returns null when the admin is no longer on the store", async () => {
    useDb({ stores: [[storeRow()]], platform_admins: [[]], admins: [[]] });
    await expect(rebuildRevampActor(job, "r")).resolves.toBeNull();
  });

  it("★ keeps a role without Website Builder manage, so the runner can say why it stopped", async () => {
    holder.rolePermissions.mockResolvedValueOnce({ dashboard: ["view"] });
    useDb({
      stores: [[storeRow()]],
      platform_admins: [[]],
      admins: [[{ role: "viewer", email: "v@x.com", isSuspended: false }]],
      admin_locations: [[]],
    });
    const actor = await rebuildRevampActor(job, "r");
    expect(actor).not.toBeNull();
    expect(can(actor!.permissions, "builder", "manage")).toBe(false);
  });

  it("returns null for a role that lost the dashboard altogether", async () => {
    holder.rolePermissions.mockResolvedValueOnce({ orders: ["view"] });
    useDb({
      stores: [[storeRow()]],
      platform_admins: [[]],
      admins: [[{ role: "picker", email: "p@x.com", isSuspended: false }]],
    });
    await expect(rebuildRevampActor(job, "r")).resolves.toBeNull();
  });

  it("★ returns null for a missing store, and for one that is not active", async () => {
    useDb({ stores: [[]] });
    await expect(rebuildRevampActor(job, "r")).resolves.toBeNull();
    useDb({ stores: [[storeRow({ status: "suspended" })]] });
    await expect(rebuildRevampActor(job, "r")).resolves.toBeNull();
  });

  it("★ resolves the plan through effectivePlan: a live comp raises it, a lapsed grant drops it", async () => {
    const inAMonth = new Date(Date.now() + 30 * 86_400_000).toISOString();
    useDb({
      stores: [[storeRow({ compPlan: "pro", compExpiresAt: inAMonth })]],
      platform_admins: [[{ id: "op" }]],
    });
    expect((await rebuildRevampActor(job, "r"))?.effectivePlan).toBe("pro");

    useDb({
      stores: [
        [
          storeRow({
            plan: "pro",
            planExpiresAt: new Date(Date.now() - 60_000).toISOString(),
          }),
        ],
      ],
      platform_admins: [[{ id: "op" }]],
    });
    expect((await rebuildRevampActor(job, "r"))?.effectivePlan).toBe("free");
  });

  it("never trusts the job for a role: an operator email that is no longer listed falls back to the admin row", async () => {
    useDb({ stores: [[storeRow()]], platform_admins: [[]], admins: [[]] });
    await expect(
      rebuildRevampActor({ ...job, requesterEmail: "ex-operator@x.com" }, "r"),
    ).resolves.toBeNull();
  });

  it("skips the operator lookup when the job carries no email", async () => {
    useDb({
      stores: [[storeRow()]],
      admins: [[{ role: "superadmin", email: "o@x.com", isSuspended: false }]],
    });
    const actor = await rebuildRevampActor(
      { ...job, requesterEmail: null },
      "r",
    );
    expect(actor?.email).toBe("o@x.com");
    // The store, the admin row and the saved brand voice.
    expect(holder.db!.calls.select).toHaveLength(3);
  });

  it("omits the run id when the job has none, and reads drafting from the shared access check", async () => {
    holder.access.mockResolvedValueOnce({
      enabled: true,
      draftingEnabled: false,
    });
    useDb({ stores: [[storeRow()]], platform_admins: [[{ id: "op" }]] });
    const actor = await rebuildRevampActor({ ...job, originRunId: null }, "r");
    expect(actor && "runId" in actor).toBe(false);
    expect(actor?.draftingEnabled).toBe(false);
  });

  it("defuses angle brackets in the brand voice and bounds it", async () => {
    useDb({
      stores: [[storeRow()]],
      platform_admins: [[{ id: "op" }]],
      store_brand_profiles: [[{ content: `<b>Bold</b>${"x".repeat(7_000)}` }]],
    });
    const actor = await rebuildRevampActor(job, "r");
    expect(actor?.brandVoice?.startsWith("‹b›Bold‹/b›")).toBe(true);
    expect(actor?.brandVoice?.length).toBeLessThanOrEqual(6_000);
    expect(actor?.brandVoice).not.toMatch(/[<>]/);
  });

  it("★★ carries only the voice the merchant saved, never the theme-built stand-in (B17)", async () => {
    useDb({
      stores: [[storeRow()]],
      platform_admins: [[{ id: "op" }]],
      store_brand_profiles: [[{ content: "  Warm, plain words.  " }]],
    });
    expect((await rebuildRevampActor(job, "r"))?.brandVoice).toBe(
      "Warm, plain words.",
    );

    // Nothing saved (no row, or only spaces): no voice at all.
    useDb({
      stores: [[storeRow()]],
      platform_admins: [[{ id: "op" }]],
      store_brand_profiles: [[]],
    });
    const none = await rebuildRevampActor(job, "r");
    expect(none).not.toBeNull();
    expect(none && "brandVoice" in none).toBe(false);
    useDb({
      stores: [[storeRow()]],
      platform_admins: [[{ id: "op" }]],
      store_brand_profiles: [[{ content: "   " }]],
    });
    const blank = await rebuildRevampActor(job, "r");
    expect(blank && "brandVoice" in blank).toBe(false);
    expect(holder.brandSoul).not.toHaveBeenCalled();
  });

  it("★ lets an error reading the brand voice propagate: an outage is not no voice", async () => {
    useDb({
      stores: [[storeRow()]],
      platform_admins: [[{ id: "op" }]],
      store_brand_profiles: [new Error("voice read failed")],
    });
    await expect(rebuildRevampActor(job, "r")).rejects.toThrow(
      "voice read failed",
    );
  });

  it("★ lets a database error propagate: an outage is not a lost permission", async () => {
    useDb({ stores: [new Error("connection terminated")] });
    await expect(rebuildRevampActor(job, "r")).rejects.toThrow(
      "connection terminated",
    );
  });

  it("returns null without a store or admin id", async () => {
    useDb({});
    await expect(
      rebuildRevampActor({ ...job, storeId: "" }, "r"),
    ).resolves.toBeNull();
    expect(holder.db!.calls.select).toHaveLength(0);
  });
});
