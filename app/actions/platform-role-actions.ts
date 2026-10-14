"use server";

// ---------------------------------------------------------------------------
// Operator-side management of the platform's staff roles (`platform_roles`).
//
// This is the only place a role is ever created, changed or deleted: a store's
// superadmin picks from the list and cannot add to it (lib/roles/catalog.ts).
// Superadmin-only, like pricing — a role's permission map reaches every store
// on the platform the moment it is saved, which is exactly the blast radius
// that keeps this off a member operator's screen.
//
// Three invariants, each enforced here AND at the database:
//   • the five seeded roles cannot be deleted (is_system; the database refuses
//     to delete any role an admins row references, so "in use" is a foreign
//     key as well as a count);
//   • the owner's map cannot be narrowed — `superadmin` bypasses the map in
//     code, so an edit here would only make the Roles page LIE about it;
//   • the two register roles keep an EMPTY dashboard map — their capabilities
//     are the code table in lib/pos/permissions.ts, and a third register role
//     cannot be added (pos_staff.role is a two-value CHECK).
// ---------------------------------------------------------------------------

import { count, eq, like, max } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService, type Db } from "@/lib/db/client";
import {
  dbErrorMessage,
  isForeignKeyViolation,
  isUniqueViolation,
} from "@/lib/db/errors";
import { admins, platformRoles } from "@/drizzle/schema";
import { getPlatformViewer } from "@/app/actions/platform";
import {
  normalizePermissions,
  SUPERADMIN_SLUG,
} from "@/app/dashboard/lib/permissions";
import {
  POS_ROLE_SLUGS,
  ROLE_SLUG_PATTERN,
  slugifyRoleName,
  validateRoleInput,
  type RoleInput,
} from "@/lib/roles/catalog";

export interface RoleActionResult {
  success?: boolean;
  error?: string;
  /** The slug the new role was stored under. */
  slug?: string;
}

const NOT_ALLOWED = "Only a platform superadmin can change roles.";

async function requireSuperadminOperator(): Promise<
  { email: string } | { error: string }
> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") return { error: NOT_ALLOWED };
  return { email: viewer.email };
}

/**
 * The first free slug for `base`. Slugs are permanent (admins.role stores
 * them; a rename never moves one), so a collision picks `-2`, `-3`, … rather
 * than failing the save on a name that merely slugifies the same way.
 */
async function resolveUniqueSlug(db: Db, base: string): Promise<string> {
  const safeBase = ROLE_SLUG_PATTERN.test(base) ? base : "role";
  const rows = await db
    .select({ slug: platformRoles.slug })
    .from(platformRoles)
    .where(like(platformRoles.slug, `${safeBase}%`));
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(safeBase)) return safeBase;
  let n = 2;
  while (taken.has(`${safeBase}-${n}`)) n++;
  return `${safeBase}-${n}`;
}

// ---------------------------------------------------------------------------
// Create — dashboard roles only.
// ---------------------------------------------------------------------------

export async function createPlatformRole(
  form: RoleInput,
): Promise<RoleActionResult> {
  const gate = await requireSuperadminOperator();
  if ("error" in gate) return gate;

  const invalid = validateRoleInput(form);
  if (invalid) return { error: invalid };

  const base = slugifyRoleName(form.name);
  // A register slug is a code table; a dashboard role may not shadow one.
  if ((POS_ROLE_SLUGS as readonly string[]).includes(base)) {
    return { error: "That name belongs to a register role." };
  }

  let slug: string;
  try {
    slug = await withService(async (db) => {
      const slug = await resolveUniqueSlug(db, base);
      const [{ last }] = await db
        .select({ last: max(platformRoles.position) })
        .from(platformRoles);
      await db.insert(platformRoles).values({
        slug,
        name: form.name.trim(),
        description: form.description.trim(),
        color: form.color,
        kind: "dashboard",
        permissions: normalizePermissions(form.permissions),
        isSystem: false,
        position: Number(last ?? 0) + 1,
        updatedBy: gate.email,
      });
      return slug;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: "A role with that name already exists." };
    }
    console.error("createPlatformRole error:", err);
    return { error: dbErrorMessage(err, "Failed to create the role.") };
  }

  revalidatePath("/dashboard/roles");
  return { success: true, slug };
}

// ---------------------------------------------------------------------------
// Update — name, description and colour for every role; the permission map
// only for a dashboard role other than the owner.
// ---------------------------------------------------------------------------

export async function updatePlatformRole(
  slug: string,
  form: RoleInput,
): Promise<RoleActionResult> {
  const gate = await requireSuperadminOperator();
  if ("error" in gate) return gate;
  if (typeof slug !== "string" || !slug) return { error: "Role not found." };

  const invalid = validateRoleInput(form);
  if (invalid) return { error: invalid };

  let existing: { kind: string } | undefined;
  try {
    const rows = await withService((db) =>
      db
        .select({ kind: platformRoles.kind })
        .from(platformRoles)
        .where(eq(platformRoles.slug, slug))
        .limit(1),
    );
    existing = rows[0];
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't load that role.") };
  }
  if (!existing) return { error: "Role not found." };

  const permissionsLocked = slug === SUPERADMIN_SLUG || existing.kind === "pos";
  const set = {
    name: form.name.trim(),
    description: form.description.trim(),
    color: form.color,
    updatedAt: new Date().toISOString(),
    updatedBy: gate.email,
    ...(permissionsLocked
      ? {}
      : { permissions: normalizePermissions(form.permissions) }),
  };

  try {
    await withService((db) =>
      db.update(platformRoles).set(set).where(eq(platformRoles.slug, slug)),
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: "A role with that name already exists." };
    }
    console.error("updatePlatformRole error:", err);
    return { error: dbErrorMessage(err, "Failed to update the role.") };
  }

  revalidatePath("/dashboard/roles");
  return { success: true, slug };
}

// ---------------------------------------------------------------------------
// Delete — custom roles nobody holds.
// ---------------------------------------------------------------------------

export async function deletePlatformRole(
  slug: string,
): Promise<RoleActionResult> {
  const gate = await requireSuperadminOperator();
  if ("error" in gate) return gate;
  if (typeof slug !== "string" || !slug) return { error: "Role not found." };

  let role: { isSystem: boolean } | undefined;
  let holders = 0;
  try {
    ({ role, holders } = await withService(async (db) => {
      const rows = await db
        .select({ isSystem: platformRoles.isSystem })
        .from(platformRoles)
        .where(eq(platformRoles.slug, slug))
        .limit(1);
      // Across EVERY store: a role is platform data, so a merchant in another
      // store holding it is exactly who would lose access.
      const counts = await db
        .select({ n: count() })
        .from(admins)
        .where(eq(admins.role, slug));
      return { role: rows[0], holders: Number(counts[0]?.n ?? 0) };
    }));
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't load that role.") };
  }
  if (!role) return { error: "Role not found." };
  if (role.isSystem) return { error: "Standard roles cannot be deleted." };
  if (holders > 0) {
    return {
      error: `${holders} staff member${holders === 1 ? "" : "s"} across the platform still hold${holders === 1 ? "s" : ""} this role. Move them to another role first.`,
    };
  }

  try {
    await withService((db) =>
      db.delete(platformRoles).where(eq(platformRoles.slug, slug)),
    );
  } catch (err) {
    // The foreign key is the backstop for the count above racing an assignment.
    if (isForeignKeyViolation(err)) {
      return {
        error:
          "Someone was given this role while you were deleting it. Move them to another role first.",
      };
    }
    console.error("deletePlatformRole error:", err);
    return { error: dbErrorMessage(err, "Failed to delete the role.") };
  }

  revalidatePath("/dashboard/roles");
  return { success: true };
}
