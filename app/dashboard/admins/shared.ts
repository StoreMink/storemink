// Types + display helpers for the ONE Staff page (dashboard admins and
// register staff together). Client-safe: no server imports.

import type { PosStaffRow } from "@/app/actions/pos-staff-actions";

/**
 * Which table a person lives in. The two differ in how they sign in — an
 * `admins` row with email + password, or a `pos_staff` row with a PIN at the
 * register — and every row action is chosen by this.
 */
export type StaffKind = "admin" | "pos";

export interface StaffRow {
  kind: StaffKind;
  /** admins.id (the Firebase uid) or pos_staff.id. */
  id: string;
  email: string;
  first_name: string;
  last_name: string | null;
  /** A slug from lib/roles/catalog.ts; shown raw when it is not. */
  role: string;
  created_at: string;
  /**
   * Shops the person is limited to. Empty means every shop — for an admin
   * "unrestricted" (lib/locations/scope.ts: absence is not restriction), for
   * register staff "assigned to all of them".
   */
  locationIds: string[];
  /** Dashboard admin only. */
  force_password_reset: boolean;
  is_suspended: boolean;
  /** Register staff only. */
  pos_status: "invited" | "active" | "disabled" | null;
  pos_active: boolean;
}

export interface StaffStatus {
  label: "Active" | "Pending" | "Inactive";
  badgeClass: string;
}

/** One status vocabulary for both kinds, so the column reads the same. */
export function staffStatus(row: StaffRow): StaffStatus {
  if (row.kind === "pos") {
    if (!row.pos_active)
      return { label: "Inactive", badgeClass: "dash-badge-amber" };
    if (row.pos_status === "invited")
      return { label: "Pending", badgeClass: "dash-badge-amber" };
    return { label: "Active", badgeClass: "dash-badge-green" };
  }
  if (row.is_suspended)
    return { label: "Inactive", badgeClass: "dash-badge-amber" };
  if (row.force_password_reset)
    return { label: "Pending", badgeClass: "dash-badge-amber" };
  return { label: "Active", badgeClass: "dash-badge-green" };
}

/** "Priya Sharma" → first "Priya", last "Sharma"; a one-word name has no last. */
export function splitName(name: string): {
  first: string;
  last: string | null;
} {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: null };
  return { first: parts[0], last: parts.slice(1).join(" ") || null };
}

/** The full name the POS actions store (`updateStaff` takes one `name`). */
export function fullName(row: Pick<StaffRow, "first_name" | "last_name">) {
  return [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
}

export function posStaffToRow(s: PosStaffRow): StaffRow {
  const { first, last } = splitName(s.name);
  return {
    kind: "pos",
    id: s.id,
    email: s.email,
    first_name: first,
    last_name: last,
    role: s.role,
    created_at: s.createdAt,
    locationIds: s.locationIds,
    force_password_reset: false,
    is_suspended: false,
    pos_status: s.status,
    pos_active: s.active,
  };
}
