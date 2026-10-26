/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const viewer = vi.hoisted(() => ({
  current: { email: "ops@storemink.com", role: "superadmin" } as any,
}));
vi.mock("@/app/actions/platform", () => ({
  getPlatformViewer: vi.fn(async () => viewer.current),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  createPlatformRole,
  updatePlatformRole,
  deletePlatformRole,
} from "./platform-role-actions";
import { revalidatePath } from "next/cache";

const validForm = {
  name: "Content editor",
  description: "Writes blogs",
  color: "blue",
  permissions: {
    blogs: ["view", "manage"] as ("view" | "manage")[],
    // Not a real section: must be dropped, never stored.
    ghost: ["manage"] as ("view" | "manage")[],
  },
};

function setup(selectQueue: any[][]) {
  dbHolder.current = makeDbMock({ selectQueue });
}

// platform-role-actions.ts — the only place a staff role is created, changed
// or deleted. Superadmin operators only; every store reads the result.
describe("platform role actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    viewer.current = { email: "ops@storemink.com", role: "superadmin" };
    setup([[], [{ last: 4 }]]);
  });

  describe("gate", () => {
    it("refuses a member operator", async () => {
      viewer.current = { email: "m@storemink.com", role: "member" };
      expect((await createPlatformRole(validForm)).error).toMatch(
        /superadmin/i,
      );
      expect((await updatePlatformRole("admin", validForm)).error).toMatch(
        /superadmin/i,
      );
      expect((await deletePlatformRole("x")).error).toMatch(/superadmin/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    it("refuses when nobody is signed in as an operator", async () => {
      viewer.current = null;
      expect((await createPlatformRole(validForm)).error).toMatch(
        /superadmin/i,
      );
    });
  });

  describe("createPlatformRole", () => {
    it("creates a dashboard role under a slug derived from its name", async () => {
      const result = await createPlatformRole(validForm);
      expect(result).toEqual({ success: true, slug: "content-editor" });
      expect(dbHolder.current.calls.values[0]).toMatchObject({
        slug: "content-editor",
        name: "Content editor",
        kind: "dashboard",
        isSystem: false,
        position: 5,
        updatedBy: "ops@storemink.com",
        // Normalised against the section catalog: `ghost` is gone.
        permissions: { blogs: ["view", "manage"] },
      });
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/roles");
    });

    it("picks the next free slug when the name slugifies to a taken one", async () => {
      setup([
        [{ slug: "content-editor" }, { slug: "content-editor-2" }],
        [{ last: 6 }],
      ]);
      const result = await createPlatformRole(validForm);
      expect(result.slug).toBe("content-editor-3");
    });

    it("refuses a name that is a POS role", async () => {
      const result = await createPlatformRole({
        ...validForm,
        name: "Cashier",
      });
      expect(result.error).toMatch(/POS role/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    it("validates the form", async () => {
      expect(
        (await createPlatformRole({ ...validForm, name: "" })).error,
      ).toMatch(/name/i);
      expect(
        (await createPlatformRole({ ...validForm, color: "pink" })).error,
      ).toMatch(/colour/i);
    });
  });

  describe("updatePlatformRole", () => {
    it("saves name, description, colour and permissions for a dashboard role", async () => {
      setup([[{ kind: "dashboard" }]]);
      const result = await updatePlatformRole("member", validForm);
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toMatchObject({
        name: "Content editor",
        color: "blue",
        permissions: { blogs: ["view", "manage"] },
      });
    });

    // The owner bypasses the map in code; an edit here would only make the
    // Roles page lie about it.
    it("never changes the owner's permissions", async () => {
      setup([[{ kind: "dashboard" }]]);
      await updatePlatformRole("superadmin", { ...validForm, name: "Owner" });
      expect(dbHolder.current.calls.set[0]).not.toHaveProperty("permissions");
      expect(dbHolder.current.calls.set[0]).toMatchObject({ name: "Owner" });
    });

    // A register role's capabilities are the code table in lib/pos/permissions.
    it("never changes a register role's permissions", async () => {
      setup([[{ kind: "pos" }]]);
      await updatePlatformRole("cashier", {
        ...validForm,
        name: "Till operator",
      });
      expect(dbHolder.current.calls.set[0]).not.toHaveProperty("permissions");
      expect(dbHolder.current.calls.set[0]).toMatchObject({
        name: "Till operator",
      });
    });

    it("reports an unknown slug", async () => {
      setup([[]]);
      expect((await updatePlatformRole("ghost", validForm)).error).toMatch(
        /not found/i,
      );
    });
  });

  describe("deletePlatformRole", () => {
    it("refuses a standard role", async () => {
      setup([[{ isSystem: true }], [{ n: 0 }]]);
      expect((await deletePlatformRole("member")).error).toMatch(
        /standard roles cannot be deleted/i,
      );
      expect(dbHolder.current.calls.delete).toHaveLength(0);
    });

    // Across the platform, not one store: a role is platform data.
    it("refuses a role somebody still holds", async () => {
      setup([[{ isSystem: false }], [{ n: 3 }]]);
      expect((await deletePlatformRole("content-editor")).error).toMatch(
        /3 staff members across the platform/i,
      );
      expect(dbHolder.current.calls.delete).toHaveLength(0);
    });

    it("deletes an unused custom role", async () => {
      setup([[{ isSystem: false }], [{ n: 0 }]]);
      expect(await deletePlatformRole("content-editor")).toEqual({
        success: true,
      });
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/roles");
    });

    it("reports an unknown slug", async () => {
      setup([[], [{ n: 0 }]]);
      expect((await deletePlatformRole("ghost")).error).toMatch(/not found/i);
    });
  });
});
