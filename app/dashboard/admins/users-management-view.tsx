"use client";

import { ResponsiveTable } from "@/app/dashboard/components/responsive-table";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  KeyRound,
  Mail,
  MapPin,
  MoreHorizontal,
  ScanLine,
  Trash2,
  UserCog,
  UserX,
  Zap,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { InviteUserDialog } from "./invite-user-dialog";
import { setAdminLocations } from "@/app/actions/location-actions";
import { roleBadgeClass } from "../lib/permissions";
import {
  dashboardRoles,
  findRole,
  posRoles,
  titleCaseSlug,
  type StaffRole,
} from "@/lib/roles/catalog";
import { fullName, staffStatus, type StaffRow } from "./shared";
import {
  deleteUser,
  changeUserRole,
  toggleUserSuspension,
} from "@/app/actions/user-management";
import {
  deleteStaff,
  resendInvite,
  setStaffActive,
  updateStaff,
} from "@/app/actions/pos-staff-actions";
import {
  formatDisplayName,
  getAvatarBackground,
  getInitials,
  getLastActiveLabel,
} from "../lib/dashboard-user-display";

type Props = {
  currentUserId: string;
  staff: StaffRow[];
  /** The platform's role list, in display order. */
  roles: StaffRole[];
  canManage?: boolean;
  /** The store's shops, for the location pickers. */
  locations?: { id: string; name: string }[];
  /** Whether the register roles can be invited at all. */
  posEnabled: boolean;
  canInvite?: boolean;
  staffLimit?: number | null;
};

type ActionType = "delete" | "role" | "suspend" | "locations" | null;

type ActionResult = { error?: string; success?: boolean; warning?: string };

export function UsersManagementView({
  currentUserId,
  staff,
  roles,
  canManage = true,
  locations = [],
  posEnabled,
  canInvite = true,
  staffLimit = null,
}: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<StaffRow | null>(null);
  const [actionType, setActionType] = useState<ActionType>(null);
  const [newRole, setNewRole] = useState<string>("member");
  const [newLocations, setNewLocations] = useState<string[]>([]);
  const [isPending, startTransition] = useTransition();

  const sorted = useMemo(
    () =>
      [...staff].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    [staff],
  );

  const locationName = (id: string) =>
    locations.find((l) => l.id === id)?.name ?? "";

  const roleDisplay = (slug: string) => {
    const r = findRole(roles, slug);
    if (r) {
      return {
        label: r.name,
        pillClass: roleBadgeClass(r.color),
        Icon:
          r.slug === "superadmin"
            ? Zap
            : r.kind === "pos"
              ? ScanLine
              : KeyRound,
      };
    }
    // A slug no release writes: shown as it is so an owner can reassign it.
    return {
      label: titleCaseSlug(slug) || "-",
      pillClass: "dash-badge-grey",
      Icon: KeyRound,
    };
  };

  // The roles a person can be MOVED to never cross kinds: a dashboard admin
  // and a register account sign in differently, so changing one into the
  // other is a new invite, not a dropdown.
  const roleOptionsFor = (row: StaffRow) =>
    row.kind === "pos" ? posRoles(roles) : dashboardRoles(roles);

  // Where someone may work. Empty means every shop for both kinds (an admin is
  // unrestricted; register staff are assigned everywhere), and an owner is
  // never limited at all.
  const whereLabel = (row: StaffRow) => {
    if (row.role === "superadmin" || row.locationIds.length === 0) {
      return "All locations";
    }
    return row.locationIds.map(locationName).filter(Boolean).join(", ");
  };

  const closeDialog = () => {
    setActionType(null);
    setSelected(null);
  };

  const openDialog = (row: StaffRow, type: ActionType) => {
    setSelected(row);
    setActionType(type);
    if (type === "role") setNewRole(row.role);
    // Ticked to what they have today, so opening the dialog and saving is a
    // no-op rather than a silent reset.
    if (type === "locations") setNewLocations(row.locationIds);
  };

  const finish = (result: ActionResult, successMessage: string) => {
    if (result.error) {
      toast.error(result.error);
      return;
    }
    // A warning is not an error: the thing asked for HAPPENED, but an
    // operator never told about a leftover sign-in account cannot clean it up.
    if (result.warning) toast.warning(result.warning, { duration: 12000 });
    else toast.success(successMessage);
    closeDialog();
    router.refresh();
  };

  const handleAction = () => {
    if (!selected || !actionType) return;
    const row = selected;

    startTransition(async () => {
      let result: ActionResult = {};
      switch (actionType) {
        case "delete":
          result =
            row.kind === "admin"
              ? await deleteUser(row.id)
              : await deleteStaff(row.id);
          break;
        case "role":
          result =
            row.kind === "admin"
              ? await changeUserRole(row.id, newRole)
              : await updateStaff(row.id, {
                  name: fullName(row),
                  role: newRole,
                  locationIds: row.locationIds,
                });
          break;
        case "suspend":
          result =
            row.kind === "admin"
              ? await toggleUserSuspension(row.id, !row.is_suspended)
              : await setStaffActive(row.id, !row.pos_active);
          break;
        case "locations":
          result =
            row.kind === "admin"
              ? await setAdminLocations(row.id, newLocations)
              : await updateStaff(row.id, {
                  name: fullName(row),
                  role: row.role,
                  // Register staff must be assigned somewhere; "nothing
                  // ticked" means every shop, the same reading as an admin.
                  locationIds: newLocations.length
                    ? newLocations
                    : locations.map((l) => l.id),
                });
          break;
      }
      finish(result, actionType === "delete" ? "Removed" : "Updated");
    });
  };

  const resend = (row: StaffRow) =>
    startTransition(async () => {
      const result = await resendInvite(row.id);
      if (result.error) toast.error(result.error);
      else toast.success("Invitation resent");
    });

  const isInactive = (row: StaffRow) =>
    row.kind === "admin" ? row.is_suspended : !row.pos_active;

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <h1>Staff</h1>
          <p>
            Everyone who works in your store, on the dashboard or at the
            register. Each person has one of the roles StoreMink defines.
          </p>
        </div>
        {canManage && canInvite && (
          <InviteUserDialog
            className="dash-btn dash-btn-primary shrink-0"
            label="Invite user"
            locations={locations}
            roles={roles}
            posEnabled={posEnabled}
          />
        )}
      </header>

      {canManage && !canInvite && staffLimit !== null ? (
        <div className="dash-card mb-3.5 flex items-center justify-between gap-3 px-4 py-3.5 text-[13px]">
          <span>
            Your plan includes {staffLimit} staff account
            {staffLimit === 1 ? "" : "s"}, including the owner. Existing staff
            and their assignments remain safe; upgrade to invite someone new.
          </span>
          <Link
            href="/dashboard/plans"
            className="dash-btn dash-btn-primary shrink-0"
          >
            View plans
          </Link>
        </div>
      ) : null}

      <div className="dash-card">
        <div className="dash-card-header">
          <div>
            <div className="dash-card-title">People</div>
            <div className="dash-card-sub">
              {staff.length} {staff.length === 1 ? "person" : "people"} ·{" "}
              <Link href="/dashboard/roles" className="underline">
                what each role can do
              </Link>
            </div>
          </div>
        </div>
        <ResponsiveTable className="dash-table dash-table-wide">
          <thead>
            <tr>
              <th>User</th>
              <th>Email</th>
              <th>Role</th>
              {locations.length > 1 && <th>Where</th>}
              <th>Last Active</th>
              <th>Status</th>
              <th className="dash-col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const displayName = formatDisplayName(
                row.email,
                row.first_name,
                row.last_name,
              );
              const role = roleDisplay(row.role);
              const status = staffStatus(row);
              const isSelf = row.kind === "admin" && row.id === currentUserId;
              const key = `${row.kind}:${row.id}`;

              return (
                <tr key={key}>
                  <td>
                    <div className="dash-flex-row">
                      <div
                        className="dash-user-avatar"
                        style={{
                          background: getAvatarBackground(row.email),
                        }}
                      >
                        {getInitials(row.email, row.first_name, row.last_name)}
                      </div>
                      {displayName}
                    </div>
                  </td>
                  <td className="text-muted">{row.email}</td>
                  <td>
                    <span className={`dash-role-pill ${role.pillClass}`}>
                      <role.Icon className="h-3.5 w-3.5" />
                      {role.label}
                    </span>
                  </td>
                  {locations.length > 1 && (
                    <td className="text-muted">{whereLabel(row)}</td>
                  )}
                  <td className="text-dim font-mono-dash">
                    {row.kind === "admin"
                      ? getLastActiveLabel(
                          {
                            id: row.id,
                            created_at: row.created_at,
                            force_password_reset: row.force_password_reset,
                          },
                          currentUserId,
                        )
                      : "-"}
                  </td>
                  <td>
                    <span className={`dash-badge ${status.badgeClass}`}>
                      {status.label}
                    </span>
                  </td>
                  <td className="dash-col-actions">
                    {isSelf || !canManage ? (
                      <span className="text-dim text-[12px]">-</span>
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger className="dash-row-menu">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Actions</span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="min-w-[180px]"
                        >
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() => openDialog(row, "role")}
                          >
                            <UserCog className="mr-2 h-4 w-4" />
                            Change role
                          </DropdownMenuItem>
                          {/* Only where there is a choice to make, and never
                              for an owner — they are unrestricted by
                              definition, so a scope editor there would imply a
                              limit that does not apply. */}
                          {locations.length > 1 &&
                            row.role !== "superadmin" && (
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={() => openDialog(row, "locations")}
                              >
                                <MapPin className="mr-2 h-4 w-4" />
                                Locations
                              </DropdownMenuItem>
                            )}
                          {row.kind === "pos" &&
                            row.pos_status === "invited" && (
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={() => resend(row)}
                              >
                                <Mail className="mr-2 h-4 w-4" />
                                Resend invitation
                              </DropdownMenuItem>
                            )}
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() => openDialog(row, "suspend")}
                          >
                            <UserX className="mr-2 h-4 w-4" />
                            {row.kind === "admin"
                              ? row.is_suspended
                                ? "Un-suspend user"
                                : "Suspend user"
                              : row.pos_active
                                ? "Deactivate"
                                : "Activate"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            className="cursor-pointer"
                            onClick={() => openDialog(row, "delete")}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Remove user
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </ResponsiveTable>
      </div>

      <Dialog
        open={actionType !== null}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>
              {actionType === "delete" && "Remove user"}
              {actionType === "role" && "Change role"}
              {actionType === "locations" && "Location access"}
              {actionType === "suspend" &&
                selected &&
                (isInactive(selected)
                  ? selected.kind === "admin"
                    ? "Un-suspend user"
                    : "Activate"
                  : selected.kind === "admin"
                    ? "Suspend user"
                    : "Deactivate")}
            </DialogTitle>
            <DialogDescription>
              {actionType === "delete" &&
                (selected?.kind === "pos"
                  ? "Are you sure you want to remove this person? Their register sign-in will be deleted. This cannot be undone."
                  : "Are you sure you want to remove this user? This cannot be undone.")}
              {actionType === "role" &&
                (selected?.kind === "pos"
                  ? "Select a new register role for this person."
                  : "Select a new role for this user.")}
              {actionType === "locations" &&
                (selected?.kind === "pos"
                  ? "Which shops this person can work at. Untick everything to assign them to every location."
                  : "Which shops this person can see. Untick everything for full access to all locations.")}
              {actionType === "suspend" &&
                selected &&
                (isInactive(selected)
                  ? "This person will regain access."
                  : selected.kind === "pos"
                    ? "This person will no longer be able to sign in at the register."
                    : "This user will lose access immediately.")}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            {actionType === "locations" && (
              <div className="flex flex-col gap-2">
                {locations.map((l) => {
                  const checked = newLocations.includes(l.id);
                  return (
                    <label
                      key={l.id}
                      className="flex cursor-pointer items-center gap-2.5 text-[14px]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isPending}
                        onChange={(e) =>
                          setNewLocations((ids) =>
                            e.target.checked
                              ? [...ids, l.id]
                              : ids.filter((id) => id !== l.id),
                          )
                        }
                        className="h-4 w-4 accent-[var(--dash-text)]"
                      />
                      {l.name}
                    </label>
                  );
                })}
                {/* ★ Said out loud, because "none ticked" reading as "sees
                    everything" is the opposite of what a merchant expects from
                    an empty checkbox list. It is the existing contract —
                    absence is not restriction — so the UI has to explain it
                    rather than quietly rely on it. */}
                {newLocations.length === 0 && (
                  <p className="mt-1 text-[12.5px] text-[var(--dash-text-3)]">
                    Nothing ticked - this person gets every location.
                  </p>
                )}
              </div>
            )}

            {actionType === "role" && selected && (
              <div className="flex flex-col gap-2">
                <Select
                  value={newRole}
                  onValueChange={(val) => val && setNewRole(val)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a role" />
                  </SelectTrigger>
                  <SelectContent>
                    {roleOptionsFor(selected).map((r) => (
                      <SelectItem key={r.slug} value={r.slug}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[12.5px] text-[var(--dash-text-3)]">
                  {findRole(roles, newRole)?.description}
                </p>
                {selected.kind === "pos" ? (
                  <p className="text-[12.5px] text-[var(--dash-text-3)]">
                    To give this person the dashboard instead, invite them again
                    with a dashboard role.
                  </p>
                ) : (
                  <p className="text-[12.5px] text-[var(--dash-text-3)]">
                    To put this person on the register instead, invite them
                    again as a Manager or Cashier.
                  </p>
                )}
              </div>
            )}
            {(actionType === "delete" || actionType === "suspend") && (
              <p className="text-muted-foreground text-sm">
                User: {selected?.email}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeDialog}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant={
                actionType === "delete" ||
                (actionType === "suspend" && selected && !isInactive(selected))
                  ? "destructive"
                  : "default"
              }
              onClick={handleAction}
              disabled={isPending}
            >
              {isPending ? "Saving..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
