import { getActingStoreId, requireSectionAccess } from "../../lib/access";
import { getUserGroupsData } from "./data";
import { GroupsManagementView } from "./groups-management-view";
import { getStorePlanContext } from "@/lib/plans/entitlements";

export default async function UserGroupsPage() {
  const access = await requireSectionAccess("users", "view");
  const canManage = access.can("users", "manage");
  const storeId = await getActingStoreId();
  const { limits } = await getStorePlanContext(storeId);

  const { groups, error } = await getUserGroupsData();

  if (error) {
    return (
      <div className="max-w-md border border-destructive/20 bg-destructive/5 p-6 text-sm text-destructive">
        <div className="mb-1 flex items-center gap-2 font-semibold">
          <span>⚠️</span> Failed to load user groups
        </div>
        <p className="leading-relaxed text-destructive/80">
          Refresh the page to try again.
        </p>
      </div>
    );
  }

  return (
    <GroupsManagementView
      groups={groups}
      canManage={canManage}
      canCreate={canManage && limits.customerGroups}
      planLocked={!limits.customerGroups}
    />
  );
}
