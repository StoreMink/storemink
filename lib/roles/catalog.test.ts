import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STAFF_ROLES,
  SYSTEM_ROLE_SLUGS,
  dashboardRoles,
  findRole,
  posRoles,
  roleName,
  roleNoun,
  rolePermissionsFrom,
  slugifyRoleName,
  validateRoleInput,
} from "./catalog";
import { SECTIONS } from "@/app/dashboard/lib/permissions";

const MIGRATION = "drizzle/migrations/sql/20261014_0194_fixed_staff_roles.sql";

/** The seeded rows of the migration: slug → { kind, permissions }. */
function seededRoles() {
  const sql = readFileSync(MIGRATION, "utf8");
  const out = new Map<string, { kind: string; permissions: unknown }>();
  const row =
    /\('([a-z-]+)', '([^']+)', '[^']*', '([a-z]+)', '(dashboard|pos)', '(\{.*?\})'::jsonb, true, (\d+)\)/g;
  for (const m of sql.matchAll(row)) {
    out.set(m[1], { kind: m[4], permissions: JSON.parse(m[5]) });
  }
  return out;
}

describe("staff role catalog", () => {
  // ★ THE MIGRATION SEEDS WHAT THE CODE FALLS BACK TO. Until platform_roles
  // exists, lib/roles/platform-roles.ts answers with DEFAULT_STAFF_ROLES; the
  // moment it exists, the seeded rows answer instead. If the two differ, the
  // same staff member has different access before and after a migration that
  // claims to change nothing — so the SQL is read back and compared.
  it("seeds the migration with exactly the default roles", () => {
    const seeded = seededRoles();
    expect([...seeded.keys()]).toEqual([...SYSTEM_ROLE_SLUGS]);
    for (const role of DEFAULT_STAFF_ROLES) {
      const row = seeded.get(role.slug);
      expect(row, role.slug).toBeDefined();
      expect(row?.kind).toBe(role.kind);
      expect(row?.permissions).toEqual(role.permissions);
    }
  });

  it("gives the owner every section and the register roles none", () => {
    const owner = findRole(DEFAULT_STAFF_ROLES, "superadmin")!;
    expect(Object.keys(owner.permissions).sort()).toEqual(
      SECTIONS.map((s) => s.key).sort(),
    );
    for (const role of posRoles(DEFAULT_STAFF_ROLES)) {
      expect(role.permissions).toEqual({});
    }
  });

  it("keeps staff and roles read-only, and the plan absent, for an admin", () => {
    const admin = findRole(DEFAULT_STAFF_ROLES, "admin")!;
    expect(admin.permissions.admins).toEqual(["view"]);
    expect(admin.permissions.roles).toEqual(["view"]);
    expect(admin.permissions.ai).toBeUndefined();
    expect(admin.permissions.settings).toEqual(["view", "manage"]);
  });

  it("splits the list by kind and resolves an unknown slug to nothing", () => {
    expect(dashboardRoles(DEFAULT_STAFF_ROLES).map((r) => r.slug)).toEqual([
      "superadmin",
      "admin",
      "member",
    ]);
    expect(posRoles(DEFAULT_STAFF_ROLES).map((r) => r.slug)).toEqual([
      "manager",
      "cashier",
    ]);
    expect(rolePermissionsFrom(DEFAULT_STAFF_ROLES, "ghost")).toEqual({});
    expect(roleName(DEFAULT_STAFF_ROLES, "member")).toBe("Staff");
    expect(roleName(DEFAULT_STAFF_ROLES, "content-editor")).toBe(
      "Content Editor",
    );
  });

  // "as a staff" reads as a typo; the email needs "as a staff member".
  it("words a role for a sentence", () => {
    expect(roleNoun({ name: "Staff" })).toBe("staff member");
    expect(roleNoun({ name: "Owner" })).toBe("owner");
    expect(roleNoun({ name: "Content editor" })).toBe("content editor");
  });

  it("slugifies a name the way the stored key must look", () => {
    expect(slugifyRoleName("Content editor")).toBe("content-editor");
    expect(slugifyRoleName("  Ops & Fulfilment!  ")).toBe("ops-fulfilment");
    expect(slugifyRoleName("x".repeat(60))).toHaveLength(40);
  });

  it("validates operator input the same way the action does", () => {
    const ok = {
      name: "Content editor",
      description: "",
      color: "blue",
      permissions: {},
    };
    expect(validateRoleInput(ok)).toBeNull();
    expect(validateRoleInput({ ...ok, name: "  " })).toMatch(/name/i);
    expect(validateRoleInput({ ...ok, name: "x".repeat(41) })).toMatch(/40/);
    expect(validateRoleInput({ ...ok, color: "pink" })).toMatch(/colour/i);
    expect(validateRoleInput({ ...ok, description: "d".repeat(201) })).toMatch(
      /200/,
    );
  });
});
