// ---------------------------------------------------------------------------
// Staff roles: the vocabulary, the defaults, and the pure helpers.
//
// Roles are PLATFORM data (2026-10-14, owner's decision, twice over):
//   • a store cannot create its own roles — a merchant picks from a list whose
//     meaning is the same in every store, the way they pick a plan;
//   • that list is OWNED BY STOREMINK OPERATORS, who add roles and change what
//     an existing role may reach from the platform console (/dashboard/roles
//     on storemink.com). The table is `platform_roles`, read by
//     lib/roles/platform-roles.ts (server-only).
//
// This module holds everything that needs no database: the shape, the five
// roles every environment starts with (the migration's seed, and the fallback
// until that migration has run), input validation shared by the console form
// and its server action, and list helpers for client components, which are
// handed the role list as a prop rather than reading it.
//
// Two kinds of role, and the kind decides where the person signs in:
//   dashboard  superadmin (Owner) · admin · member (shown as "Staff") · any
//              role an operator adds — an `admins` row, email + password.
//   pos        manager · cashier — a `pos_staff` row with a PIN, /pos only.
//              Their dashboard permissions are EMPTY on purpose: proxy.ts sends
//              a cashier/manager claim straight from /dashboard to /pos, and
//              their register capabilities are the code table in
//              lib/pos/permissions.ts. Operators may rename or describe them,
//              never widen them, and cannot add a third register role.
//
// ★ THE SLUG `member` STAYS THOUGH THE LABEL IS "Staff". Roles are stored by
// slug on admins.role and in Firebase claims, so renaming it would mean a data
// rewrite in the same release as the code that reads it — the precedent is
// `themes`, `promotions` and `activity`, which all kept their keys when their
// labels moved. Change the name in the table; leave the slug alone.
// ---------------------------------------------------------------------------

import {
  SECTIONS,
  SUPERADMIN_SLUG,
  ROLE_COLORS,
  normalizePermissions,
  type RoleColor,
  type RolePermissions,
} from "@/app/dashboard/lib/permissions";
import { isPosRole } from "@/lib/pos/permissions";

export type StaffRoleKind = "dashboard" | "pos";

export interface StaffRole {
  /** Stored on admins.role / pos_staff.role and in Firebase claims. Immutable. */
  slug: string;
  /** Merchant-facing name: "Owner", "Staff", "Cashier". */
  name: string;
  /** One line on who the role is for, shown beside the picker. */
  description: string;
  color: RoleColor;
  kind: StaffRoleKind;
  /**
   * Dashboard sections the role may view or manage, normalised against
   * SECTIONS so callers can hand it to `can()` directly. `{}` for a POS role.
   * The owner's map is complete for DISPLAY only — every gate still bypasses
   * the map for `superadmin` (`can(..., isSuperadmin)`).
   */
  permissions: RolePermissions;
  /** Seeded by StoreMink: cannot be deleted, and its slug and kind are fixed. */
  isSystem: boolean;
  /** Display order, lowest first. */
  position: number;
}

/** The five slugs every environment is seeded with. */
export const SYSTEM_ROLE_SLUGS = [
  SUPERADMIN_SLUG,
  "admin",
  "member",
  "manager",
  "cashier",
] as const;

/** The only roles a register account can hold — a code table, not a list. */
export const POS_ROLE_SLUGS = ["manager", "cashier"] as const;

export const ROLE_NAME_MAX = 40;
export const ROLE_DESCRIPTION_MAX = 200;
export const ROLE_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * The dashboard sections that existed when `platform_roles` was seeded
 * (migration 20261014_0207). DEFAULT_STAFF_ROLES is what that migration wrote,
 * so it is frozen to this list, not to the live SECTIONS: a section added later
 * reaches the stored roles only through a migration of its own, and
 * lib/roles/catalog.test.ts fails until one grants it. Never edit this list.
 */
export const ROLE_SEED_SECTION_KEYS = [
  "dashboard",
  "orders",
  "products",
  "categories",
  "colors",
  "inventory",
  "users",
  "enquiries",
  "analytics",
  "locations",
  "pos",
  "themes",
  "builder",
  "navigation",
  "blogs",
  "branding",
  "media",
  "marketing",
  "promotions",
  "settings",
  "admins",
  "roles",
  "ai",
  "channels",
  "billing",
  "notifications",
  "activity",
] as const;

/** Every seeded section with every action it supports. */
function everything(): RolePermissions {
  const seeded = new Set<string>(ROLE_SEED_SECTION_KEYS);
  return normalizePermissions(
    Object.fromEntries(
      SECTIONS.filter((s) => seeded.has(s.key)).map((s) => [
        s.key,
        [...s.actions],
      ]),
    ),
  );
}

/**
 * Admin: runs the whole store, but does not decide WHO runs it or what it
 * pays for. Staff and roles are read-only, and Plan & billing (`ai`) is absent.
 */
function adminPermissions(): RolePermissions {
  const map = everything();
  delete map.ai;
  map.admins = ["view"];
  map.roles = ["view"];
  return map;
}

/**
 * Staff: the day-to-day loop. The old built-in "member" role's grant set,
 * carried over so nobody who held it lost a page in the switch, plus Enquiries
 * (which nests under Customers and did not exist when that set was written).
 * Nothing configuration-shaped: no Settings, no storefront design, no money
 * settings.
 */
function memberPermissions(): RolePermissions {
  return normalizePermissions({
    dashboard: ["view"],
    orders: ["view", "manage"],
    products: ["view", "manage"],
    categories: ["view", "manage"],
    colors: ["view", "manage"],
    inventory: ["view", "manage"],
    users: ["view"],
    enquiries: ["view", "manage"],
    analytics: ["view"],
    blogs: ["view", "manage"],
    marketing: ["view", "manage"],
    promotions: ["view", "manage"],
    media: ["view", "manage"],
  });
}

/**
 * What a fresh environment starts with. The migration that creates
 * `platform_roles` seeds exactly these rows (lib/roles/catalog.test.ts holds
 * the two in step), and lib/roles/platform-roles.ts falls back to them only
 * while that table does not exist yet.
 */
export const DEFAULT_STAFF_ROLES: readonly StaffRole[] = [
  {
    slug: SUPERADMIN_SLUG,
    name: "Owner",
    description:
      "Full access to everything, including staff, roles, the plan and billing.",
    color: "violet",
    kind: "dashboard",
    permissions: everything(),
    isSystem: true,
    position: 0,
  },
  {
    slug: "admin",
    name: "Admin",
    description:
      "Runs the whole store: orders, catalogue, storefront, locations, POS and settings. Cannot invite staff or change the plan.",
    color: "blue",
    kind: "dashboard",
    permissions: adminPermissions(),
    isSystem: true,
    position: 1,
  },
  {
    slug: "member",
    name: "Staff",
    description:
      "Day-to-day work: orders, products, inventory, customers, enquiries, offers, blogs and media.",
    color: "green",
    kind: "dashboard",
    permissions: memberPermissions(),
    isSystem: true,
    position: 2,
  },
  {
    slug: "manager",
    name: "Manager",
    description:
      "Uses POS at their shops: sells, takes returns, moves stock, runs the cash drawer and approves cashier discounts.",
    color: "amber",
    kind: "pos",
    permissions: {},
    isSystem: true,
    position: 3,
  },
  {
    slug: "cashier",
    name: "Cashier",
    description:
      "Uses POS at their shops: rings up sales, takes payments and hands over pickup orders.",
    color: "grey",
    kind: "pos",
    permissions: {},
    isSystem: true,
    position: 4,
  },
];

/** `isPosRole` from lib/pos/permissions, re-exported so one import answers both kinds. */
export { isPosRole };

// ── List helpers (pure; client components get the list as a prop) ──────────

export function findRole(
  roles: readonly StaffRole[],
  slug: string | null | undefined,
): StaffRole | undefined {
  return slug ? roles.find((r) => r.slug === slug) : undefined;
}

export function dashboardRoles(roles: readonly StaffRole[]): StaffRole[] {
  return roles.filter((r) => r.kind === "dashboard");
}

export function posRoles(roles: readonly StaffRole[]): StaffRole[] {
  return roles.filter((r) => r.kind === "pos");
}

/**
 * The permission map for a stored slug. An unknown slug — a value no current
 * release writes — gets NOTHING, which is the right side to fail on: it cannot
 * widen anyone's access, and the Staff page shows the raw slug so an owner can
 * see what to reassign.
 */
export function rolePermissionsFrom(
  roles: readonly StaffRole[],
  slug: string | null | undefined,
): RolePermissions {
  return findRole(roles, slug)?.permissions ?? {};
}

/** "Owner", "Staff", … — or the slug itself, title-cased, for an unknown value. */
export function roleName(
  roles: readonly StaffRole[],
  slug: string | null | undefined,
): string {
  const role = findRole(roles, slug);
  if (role) return role.name;
  return titleCaseSlug(slug);
}

export function titleCaseSlug(slug: string | null | undefined): string {
  if (!slug) return "";
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * The role as it reads inside a sentence: "an owner", "a staff member", "a
 * content editor". The invitation email uses it ("You've been invited … as a
 * staff member"); the article is the email builder's job.
 */
export function roleNoun(role: Pick<StaffRole, "name">): string {
  const lower = role.name.trim().toLowerCase();
  return lower === "staff" ? "staff member" : lower;
}

// ── Operator input (shared by the console form and its server action) ──────

export interface RoleInput {
  name: string;
  description: string;
  color: string;
  permissions: RolePermissions;
}

/** "Content editor" → "content-editor". */
export function slugifyRoleName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Null when valid, else the sentence to show. Pure, so the form cannot
 *  accept what the action then refuses. */
export function validateRoleInput(input: RoleInput): string | null {
  const name = input.name.trim();
  if (!name) return "Role name is required.";
  if (name.length > ROLE_NAME_MAX)
    return `Role name must be ${ROLE_NAME_MAX} characters or fewer.`;
  if (input.description.trim().length > ROLE_DESCRIPTION_MAX)
    return `Description must be ${ROLE_DESCRIPTION_MAX} characters or fewer.`;
  if (!ROLE_COLORS.includes(input.color as RoleColor)) return "Invalid colour.";
  return null;
}
