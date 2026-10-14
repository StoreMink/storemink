import { desc, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { admins } from "@/drizzle/schema";
import { requireSectionAccess, getActingStoreId } from "../lib/access";
import { UsersManagementView } from "./users-management-view";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState, getStoreLocations } from "@/lib/pos/locations";
import { listAdminLocations } from "@/app/actions/location-actions";
import { listStaff } from "@/app/actions/pos-staff-actions";
import { getStorePlanContext } from "@/lib/plans/entitlements";
import { posStaffToRow, type StaffRow } from "./shared";
import { getPlatformRoles } from "@/lib/roles/platform-roles";

// ★ ONE STAFF LIST (2026-10-14). Dashboard admins (`admins`) and register
// staff (`pos_staff`) render together, each with a role from the platform's
// list (lib/roles/platform-roles.ts — StoreMink defines the roles; a store
// picks). They are still two tables, because they sign in differently
// (password vs PIN on an authorised device), but a merchant has one place to
// look and one invite dialog.
export default async function UsersPage() {
  const access = await requireSectionAccess("admins", "view");
  const canManage = access.can("admins", "manage");
  const storeId = await getActingStoreId();
  const [store, planContext] = await Promise.all([
    getCurrentStore(),
    getStorePlanContext(storeId),
  ]);
  const posState = getPosState(store);

  // The admins (staff) table is RLS-scoped to own-row reads, so cross-row
  // listing goes through the service scope with an explicit store filter —
  // same pattern as the Users (customers) list. The page is already gated by
  // requireSectionAccess("admins", "view") above.
  let adminRows: {
    id: string;
    email: string;
    first_name: string;
    last_name: string | null;
    role: string;
    force_password_reset: boolean;
    is_suspended: boolean | null;
    created_at: string;
  }[];
  try {
    adminRows = await withService((db) =>
      db
        .select({
          id: admins.id,
          email: admins.email,
          first_name: admins.firstName,
          last_name: admins.lastName,
          role: admins.role,
          force_password_reset: admins.forcePasswordReset,
          is_suspended: admins.isSuspended,
          created_at: admins.createdAt,
        })
        .from(admins)
        .where(eq(admins.storeId, storeId))
        .orderBy(desc(admins.createdAt)),
    );
  } catch (err) {
    console.error("Failed to load admins:", err);
    return (
      <div className="max-w-md border border-destructive/20 bg-destructive/5 p-6 text-sm text-destructive">
        <div className="mb-1 flex items-center gap-2 font-semibold">
          <span>⚠️</span> Failed to load staff
        </div>
        <p className="leading-relaxed text-destructive/80">
          Could not load the staff list. Please try again.
        </p>
      </div>
    );
  }

  // Who is currently restricted to what, so the editor opens on today's answer
  // rather than resetting anyone to unrestricted on save. Register staff carry
  // their assignments on the row already.
  const [{ bindings }, locations, pos, roles] = await Promise.all([
    listAdminLocations(),
    getStoreLocations(storeId).catch(() => []),
    // The register roles exist only on a plan that has POS. `listStaff` gates
    // itself on the `pos` permission and answers an error rather than throw;
    // either way the dashboard half of the list still renders.
    posState.posAvailable ? listStaff() : Promise.resolve({ staff: [] }),
    getPlatformRoles(),
  ]);

  const staff: StaffRow[] = [
    ...adminRows.map(
      (p): StaffRow => ({
        kind: "admin",
        id: p.id,
        email: p.email,
        first_name: p.first_name,
        last_name: p.last_name,
        role: p.role,
        created_at: p.created_at,
        locationIds: bindings[p.id] ?? [],
        force_password_reset: p.force_password_reset,
        is_suspended: p.is_suspended ?? false,
        pos_status: null,
        pos_active: true,
      }),
    ),
    ...pos.staff.map(posStaffToRow),
  ];

  return (
    <UsersManagementView
      currentUserId={access.userId}
      staff={staff}
      roles={roles}
      canManage={canManage}
      locations={locations.map((l) => ({ id: l.id, name: l.name }))}
      posEnabled={posState.posEnabled}
      // The plan's staff cap counts DASHBOARD accounts (the owner included);
      // register staff come with POS, which is Pro and uncapped.
      canInvite={
        canManage &&
        (planContext.limits.maxStaff === null ||
          adminRows.length < planContext.limits.maxStaff)
      }
      staffLimit={planContext.limits.maxStaff}
    />
  );
}
