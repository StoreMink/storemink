import { KeyRound, Zap } from "lucide-react";
import { ResponsiveTable } from "@/app/dashboard/components/responsive-table";
import {
  SECTIONS,
  SECTION_GROUPS,
  roleBadgeClass,
  can,
} from "../../lib/permissions";
import {
  dashboardRoles,
  isPosRole,
  posRoles,
  type StaffRole,
} from "@/lib/roles/catalog";
import { posCan, type PosCapability } from "@/lib/pos/permissions";

// ★ READ-ONLY. Every store uses the role list StoreMink's operators define
// (lib/roles/platform-roles.ts); a store cannot add to it, so this page
// answers one question — "which role do I give this person?" — rather than
// offering an editor. It is a server component: there is nothing to click.

type RoleRow = StaffRole & { member_count: number };

type Props = {
  roles: RoleRow[];
};

/** What the register lets each POS role do, in the words a merchant uses. */
const POS_CAPABILITIES: { cap: PosCapability; label: string }[] = [
  { cap: "sell", label: "Ring up sales and take payments" },
  { cap: "fulfil_pickup", label: "Prepare and hand over pickup orders" },
  { cap: "refund", label: "Take returns and issue refunds" },
  { cap: "adjust_inventory", label: "Receive, count and transfer stock" },
  { cap: "open_close_shift", label: "Open and close cash drawer shifts" },
  { cap: "cash_drop", label: "Record cash drops and payouts" },
  { cap: "edit_layout", label: "Arrange the POS layout" },
  {
    cap: "discount_over_cap",
    label: "Approve a cashier's discount above the store limit",
  },
  {
    cap: "override_verification",
    label: "Hand over or take a return when the customer cannot be sent a code",
  },
];

function summarize(role: StaffRole) {
  let viewable = 0;
  let manageable = 0;
  for (const section of SECTIONS) {
    const granted = role.permissions[section.key] ?? [];
    if (granted.includes("manage")) {
      manageable++;
      viewable++;
    } else if (granted.includes("view")) {
      viewable++;
    }
  }
  return { viewable, manageable };
}

function RolePill({ role }: { role: StaffRole }) {
  return (
    <span
      className={`dash-role-pill inline-flex items-center gap-1 ${roleBadgeClass(role.color)}`}
    >
      {role.slug === "superadmin" ? (
        <Zap className="h-3.5 w-3.5" />
      ) : (
        <KeyRound className="h-3.5 w-3.5" />
      )}
      {role.name}
    </span>
  );
}

function Mark({ value }: { value: "manage" | "view" | null }) {
  if (value === "manage") {
    return <span className="dash-badge dash-badge-green">Manage</span>;
  }
  if (value === "view") {
    return <span className="dash-badge dash-badge-grey">View</span>;
  }
  return <span className="dash-cell-sub">-</span>;
}

function grant(role: StaffRole, section: string): "manage" | "view" | null {
  const isOwner = role.slug === "superadmin";
  if (can(role.permissions, section, "manage", isOwner)) return "manage";
  if (can(role.permissions, section, "view", isOwner)) return "view";
  return null;
}

export function RolesManagementView({ roles }: Props) {
  const countBySlug = new Map<string, number>(
    roles.map((r) => [r.slug, r.member_count]),
  );
  const countFor = (slug: string) => countBySlug.get(slug) ?? 0;
  const dashboard = dashboardRoles(roles);
  const register = posRoles(roles);

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <h1>Roles &amp; Permissions</h1>
          <p>
            What each role can do. StoreMink defines the roles every store uses.
          </p>
        </div>
      </header>

      <div className="dash-card">
        <div className="dash-card-header">
          <div>
            <div className="dash-card-title">Roles</div>
            <div className="dash-card-sub">
              {dashboard.length} for the dashboard, {register.length} for POS
            </div>
          </div>
        </div>
        <ResponsiveTable className="dash-table dash-table-wide">
          <thead>
            <tr>
              <th>Role</th>
              <th>Who it is for</th>
              <th>Access</th>
              <th>People</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => {
              const { viewable, manageable } = summarize(role);
              return (
                <tr key={role.slug}>
                  <td>
                    <RolePill role={role} />
                  </td>
                  <td className="dash-cell-sub max-w-[420px]">
                    {role.description}
                  </td>
                  <td className="dash-cell-sub">
                    {role.slug === "superadmin"
                      ? "Full access"
                      : role.kind === "pos"
                        ? "POS only"
                        : `${viewable} view · ${manageable} manage`}
                  </td>
                  <td className="dash-cell-sub mono">{countFor(role.slug)}</td>
                </tr>
              );
            })}
          </tbody>
        </ResponsiveTable>
      </div>

      <div className="dash-card mt-3.5">
        <div className="dash-card-header">
          <div>
            <div className="dash-card-title">Dashboard pages</div>
            <div className="dash-card-sub">
              Manage includes View. Owners always have full access.
            </div>
          </div>
        </div>
        <ResponsiveTable className="dash-table dash-table-wide">
          <thead>
            <tr>
              <th>Page</th>
              {dashboard.map((role) => (
                <th key={role.slug}>{role.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SECTION_GROUPS.flatMap((group) =>
              SECTIONS.filter((s) => s.group === group && !s.hiddenInNav).map(
                (section) => (
                  <tr key={section.key}>
                    <td>
                      <div>{section.label}</div>
                      <div className="dash-cell-sub">{group}</div>
                    </td>
                    {dashboard.map((role) => (
                      <td key={role.slug}>
                        <Mark value={grant(role, section.key)} />
                      </td>
                    ))}
                  </tr>
                ),
              ),
            )}
          </tbody>
        </ResponsiveTable>
      </div>

      <div className="dash-card mt-3.5">
        <div className="dash-card-header">
          <div>
            <div className="dash-card-title">In POS</div>
            <div className="dash-card-sub">
              They sign in to POS only. Discounts, price overrides and new
              devices stay with the owner.
            </div>
          </div>
        </div>
        <ResponsiveTable className="dash-table dash-table-wide">
          <thead>
            <tr>
              <th>Can they</th>
              {register.map((role) => (
                <th key={role.slug}>{role.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {POS_CAPABILITIES.map(({ cap, label }) => (
              <tr key={cap}>
                <td>{label}</td>
                {register.map((role) => (
                  <td key={role.slug}>
                    {isPosRole(role.slug) && posCan(role.slug, cap) ? (
                      <span className="dash-badge dash-badge-green">Yes</span>
                    ) : (
                      <span className="dash-cell-sub">-</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </ResponsiveTable>
      </div>
    </div>
  );
}
