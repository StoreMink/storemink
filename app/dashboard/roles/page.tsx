import { count, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { admins, posStaff } from "@/drizzle/schema";
import { requireSectionAccess, getActingStoreId } from "../lib/access";
import { getPlatformRoles } from "@/lib/roles/platform-roles";
import { RolesManagementView } from "./roles-management-view";

// The platform's role list (lib/roles/platform-roles.ts — StoreMink operators
// define it, every store picks from it) and how many people here hold each.
// Read-only for a store since 2026-10-14: there is nothing to create, edit or
// delete from this dashboard.
export default async function RolesPage() {
  await requireSectionAccess("roles", "view");
  const storeId = await getActingStoreId();
  const roles = await getPlatformRoles();

  // How many people hold each role — admins for the dashboard roles, pos_staff
  // for the register ones. A failed count is shown as zero rather than taking
  // the page down: the roles themselves need no database at all.
  const counts = new Map<string, number>();
  try {
    const { adminRows, posRows } = await withService(async (db) => {
      const adminRows = await db
        .select({ role: admins.role, n: count() })
        .from(admins)
        .where(eq(admins.storeId, storeId))
        .groupBy(admins.role);
      const posRows = await db
        .select({ role: posStaff.role, n: count() })
        .from(posStaff)
        .where(eq(posStaff.storeId, storeId))
        .groupBy(posStaff.role);
      return { adminRows, posRows };
    });
    for (const r of [...adminRows, ...posRows]) {
      if (r.role) counts.set(r.role, (counts.get(r.role) ?? 0) + Number(r.n));
    }
  } catch (err) {
    console.error("Failed to count role holders:", err);
  }

  return (
    <RolesManagementView
      roles={roles.map((r) => ({
        ...r,
        member_count: counts.get(r.slug) ?? 0,
      }))}
    />
  );
}
