import "server-only";

// ---------------------------------------------------------------------------
// The platform's role list, as stored in `platform_roles` (migration 0207).
//
// Operators own it (app/actions/platform-role-actions.ts); every seller
// dashboard READS it: the access gates, the notification fan-out, the Staff
// page and its invite dialog, Mink's workflow re-check. It is one small
// platform-global table (no store_id), so every reader takes the whole list or
// one row by slug — never a per-store query.
//
// ★ FALLS BACK TO THE CODE DEFAULTS ONLY WHILE THE TABLE DOES NOT EXIST. The
// deploy pipeline migrates before it deploys, but local development and a
// hand-run environment can briefly run this code against a database without
// the table; the five seeded roles are what that table would hold, so answering
// with them changes nothing. Any OTHER failure propagates: an unreachable
// database is not an access decision (app/dashboard/lib/access.ts), and
// answering "no permissions" to a network blip would strip a staff member down
// to an empty dashboard and blame their role for it.
//
// ⚠ The `…With(db)` variants run INSIDE a caller's transaction and never fall
// back: a failed statement has already aborted that transaction in PostgreSQL,
// so catching the error and carrying on would fail the next statement with
// "current transaction is aborted" instead.
// ---------------------------------------------------------------------------

import { cache } from "react";
import { asc, eq, count } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { admins, platformRoles, posStaff } from "@/drizzle/schema";
import { isSchemaNotReady } from "@/lib/db/errors";
import { logWarn } from "@/lib/observability/logger";
import { normalizePermissions } from "@/app/dashboard/lib/permissions";
import type {
  RoleColor,
  RolePermissions,
} from "@/app/dashboard/lib/permissions";
import {
  DEFAULT_STAFF_ROLES,
  findRole,
  rolePermissionsFrom,
  type StaffRole,
  type StaffRoleKind,
} from "./catalog";

export interface PlatformRoleRow {
  slug: string;
  name: string;
  description: string | null;
  color: string;
  kind: string;
  permissions: unknown;
  isSystem: boolean;
  position: number;
}

const ROLE_COLUMNS = {
  slug: platformRoles.slug,
  name: platformRoles.name,
  description: platformRoles.description,
  color: platformRoles.color,
  kind: platformRoles.kind,
  permissions: platformRoles.permissions,
  isSystem: platformRoles.isSystem,
  position: platformRoles.position,
};

/** A stored row as the shape every reader uses. A POS role's dashboard map is
 *  EMPTY whatever the row says: the register's capabilities are code. */
export function mapRoleRow(row: PlatformRoleRow): StaffRole {
  const kind: StaffRoleKind = row.kind === "pos" ? "pos" : "dashboard";
  return {
    slug: row.slug,
    name: row.name,
    description: row.description ?? "",
    color: row.color as RoleColor,
    kind,
    permissions: kind === "pos" ? {} : normalizePermissions(row.permissions),
    isSystem: !!row.isSystem,
    position: Number(row.position ?? 0),
  };
}

export async function listPlatformRolesWith(db: Db): Promise<StaffRole[]> {
  const rows = await db
    .select(ROLE_COLUMNS)
    .from(platformRoles)
    .orderBy(asc(platformRoles.position), asc(platformRoles.name));
  return rows.map(mapRoleRow);
}

/** Every role, in display order. Uncached: a server action's read. */
export async function listPlatformRoles(): Promise<StaffRole[]> {
  try {
    return await withService(listPlatformRolesWith);
  } catch (error) {
    if (isSchemaNotReady(error)) {
      logWarn("platform roles: table missing, using code defaults");
      return [...DEFAULT_STAFF_ROLES];
    }
    throw error;
  }
}

/**
 * Request-memoised for render: the layout (topbar label), the Staff page and
 * the Roles page share one read per request.
 */
export const getPlatformRoles = cache(listPlatformRoles);

/** One role by slug, or null. Uncached. */
export async function getPlatformRole(
  slug: string | null | undefined,
): Promise<StaffRole | null> {
  if (!slug) return null;
  try {
    const rows = await withService((db) =>
      db
        .select(ROLE_COLUMNS)
        .from(platformRoles)
        .where(eq(platformRoles.slug, slug))
        .limit(1),
    );
    return rows[0] ? mapRoleRow(rows[0]) : null;
  } catch (error) {
    if (isSchemaNotReady(error)) {
      logWarn("platform roles: table missing, using code defaults");
      return findRole(DEFAULT_STAFF_ROLES, slug) ?? null;
    }
    throw error;
  }
}

/** The dashboard permission map for a stored slug; `{}` when unknown. */
export async function platformRolePermissions(
  slug: string | null | undefined,
): Promise<RolePermissions> {
  return (await getPlatformRole(slug))?.permissions ?? {};
}

/** slug → role, read inside the caller's transaction (no fallback — see above). */
export async function loadRoleMapWith(db: Db): Promise<Map<string, StaffRole>> {
  const roles = await listPlatformRolesWith(db);
  return new Map(roles.map((r) => [r.slug, r]));
}

/** One slug's map, read inside the caller's transaction (no fallback). */
export async function readRolePermissionsWith(
  db: Db,
  slug: string | null | undefined,
): Promise<RolePermissions> {
  if (!slug) return {};
  const rows = await db
    .select(ROLE_COLUMNS)
    .from(platformRoles)
    .where(eq(platformRoles.slug, slug))
    .limit(1);
  return rows[0] ? mapRoleRow(rows[0]).permissions : {};
}

/**
 * How many people hold each role ACROSS THE PLATFORM — admins for dashboard
 * roles, pos_staff for register ones. Read by the operator console, which
 * needs it to say whether a role can be deleted and what deleting would cost.
 */
export async function platformRoleUsage(): Promise<Map<string, number>> {
  const { adminRows, posRows } = await withService(async (db) => {
    const adminRows = await db
      .select({ role: admins.role, n: count() })
      .from(admins)
      .groupBy(admins.role);
    const posRows = await db
      .select({ role: posStaff.role, n: count() })
      .from(posStaff)
      .groupBy(posStaff.role);
    return { adminRows, posRows };
  });
  const out = new Map<string, number>();
  for (const r of [...adminRows, ...posRows]) {
    if (r.role) out.set(r.role, (out.get(r.role) ?? 0) + Number(r.n));
  }
  return out;
}

/** Re-exported for callers that already hold the list. */
export { rolePermissionsFrom };
