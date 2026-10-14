import {
  listPlatformRoles,
  platformRoleUsage,
} from "@/lib/roles/platform-roles";
import { canManage, requireOperator } from "../require-operator";
import { RolesConsole } from "../roles-console";

export const metadata = { title: "Roles · StoreMink Admin" };

// The staff roles every store picks from. Platform data since 2026-10-14: a
// merchant's Staff page lists exactly these, and their Roles & permissions
// page shows what each one reaches. Editing a role's map here changes what
// every holder of it, on every store, can open on their next request.
//
// A member operator gets the read-only view; the write actions gate
// themselves on superadmin regardless (app/actions/platform-role-actions.ts).
export default async function PlatformRolesPage() {
  const viewer = await requireOperator();

  const [roles, usage] = await Promise.all([
    // Live, never cached: the panel is about to write these back.
    listPlatformRoles(),
    platformRoleUsage().catch(() => new Map<string, number>()),
  ]);

  return (
    <RolesConsole
      roles={roles.map((r) => ({
        ...r,
        holders: usage.get(r.slug) ?? 0,
      }))}
      canManage={canManage(viewer)}
    />
  );
}
