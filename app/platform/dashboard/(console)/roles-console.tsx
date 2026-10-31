/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  ScanLine,
  Trash2,
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
import { ResponsiveTable } from "@/app/dashboard/components/responsive-table";
import {
  SECTIONS,
  SECTION_GROUPS,
  ROLE_COLORS,
  roleBadgeClass,
  type PermissionAction,
  type RolePermissions,
} from "@/app/dashboard/lib/permissions";
import {
  ROLE_DESCRIPTION_MAX,
  ROLE_NAME_MAX,
  validateRoleInput,
  type RoleInput,
  type StaffRole,
} from "@/lib/roles/catalog";
import {
  createPlatformRole,
  deletePlatformRole,
  updatePlatformRole,
} from "@/app/actions/platform-role-actions";

// The operator's role editor. Every store's Staff page lists exactly these
// roles and every dashboard gate reads their maps, so the table says, per
// role, how many people across the platform would feel an edit.

type RoleRow = StaffRole & { holders: number };

const EMPTY: RoleInput = {
  name: "",
  description: "",
  color: "blue",
  permissions: {},
};

const fieldClass =
  "w-full rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-2 text-sm text-[var(--dash-text)] outline-none placeholder:text-[var(--dash-text-3)] focus:border-[var(--dash-accent)]";
const labelClass =
  "mb-1.5 block text-xs font-medium uppercase tracking-wide text-[var(--dash-text-2)]";

const COLOR_SWATCH: Record<string, string> = {
  grey: "#6b7280",
  blue: "#4f46e5",
  green: "#15a34a",
  amber: "#d97706",
  violet: "#7c3aed",
};

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

function RoleIcon({ role }: { role: StaffRole }) {
  if (role.slug === "superadmin") return <Zap className="h-3.5 w-3.5" />;
  if (role.kind === "pos") return <ScanLine className="h-3.5 w-3.5" />;
  return <KeyRound className="h-3.5 w-3.5" />;
}

export function RolesConsole({
  roles,
  canManage,
}: {
  roles: RoleRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [deleteTarget, setDeleteTarget] = useState<RoleRow | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<StaffRole | null>(null);

  const openEditor = (role?: StaffRole) => {
    setEditing(role ?? null);
    setEditorOpen(true);
  };
  const closeEditor = () => {
    setEditorOpen(false);
    setEditing(null);
  };
  const handleSaved = () => {
    closeEditor();
    router.refresh();
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    startTransition(async () => {
      const result = await deletePlatformRole(deleteTarget.slug);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Role deleted");
        setDeleteTarget(null);
        router.refresh();
      }
    });
  };

  return (
    <div className="w-full max-w-6xl space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
            Roles
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            The staff roles every store picks from. Changes reach everyone
            holding the role, on every store.
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            className="dash-btn dash-btn-primary shrink-0"
            onClick={() => openEditor()}
          >
            <Plus className="h-4 w-4" />
            New role
          </button>
        )}
      </header>

      <div className="dash-card">
        <div className="dash-card-header">
          <div>
            <div className="dash-card-title">Roles</div>
            <div className="dash-card-sub">
              {roles.length} {roles.length === 1 ? "role" : "roles"} · the
              standard five cannot be deleted
            </div>
          </div>
        </div>
        <ResponsiveTable className="dash-table dash-table-wide">
          <thead>
            <tr>
              <th>Role</th>
              <th>Where</th>
              <th>Description</th>
              <th>Access</th>
              <th>People</th>
              <th className="dash-col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => {
              const { viewable, manageable } = summarize(role);
              return (
                <tr key={role.slug}>
                  <td>
                    <div className="flex items-center gap-2">
                      <span
                        className={`dash-role-pill inline-flex items-center gap-1 ${roleBadgeClass(role.color)}`}
                      >
                        <RoleIcon role={role} />
                        {role.name}
                      </span>
                      {role.isSystem && (
                        <span className="dash-badge dash-badge-grey">
                          Standard
                        </span>
                      )}
                    </div>
                    <div className="dash-cell-sub mono">{role.slug}</div>
                  </td>
                  <td className="dash-cell-sub">
                    {role.kind === "pos" ? "POS" : "Dashboard"}
                  </td>
                  <td className="dash-cell-sub max-w-[360px]">
                    {role.description || "-"}
                  </td>
                  <td className="dash-cell-sub">
                    {role.slug === "superadmin"
                      ? "Full access"
                      : role.kind === "pos"
                        ? "POS capabilities (set in code)"
                        : `${viewable} view · ${manageable} manage`}
                  </td>
                  <td className="dash-cell-sub mono">{role.holders}</td>
                  <td className="dash-col-actions">
                    {canManage ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger className="dash-row-menu">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Actions</span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="min-w-[160px]"
                        >
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() => openEditor(role)}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          {!role.isSystem && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                className="cursor-pointer"
                                onClick={() => setDeleteTarget(role)}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <span className="dash-cell-sub">-</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </ResponsiveTable>
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Delete role</DialogTitle>
            <DialogDescription>
              Delete &ldquo;{deleteTarget?.name}&rdquo; for every store? This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {(deleteTarget?.holders ?? 0) > 0 && (
            <div className="py-2">
              <p className="text-sm text-[var(--dash-amber)]">
                {deleteTarget?.holders} staff member
                {deleteTarget?.holders === 1 ? "" : "s"} across the platform
                hold this role. Their stores must move them first.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isPending || (deleteTarget?.holders ?? 0) > 0}
            >
              {isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RoleEditorDialog
        open={editorOpen}
        role={editing}
        onClose={closeEditor}
        onSaved={handleSaved}
      />
    </div>
  );
}

function RoleEditorDialog({
  open,
  role,
  onClose,
  onSaved,
}: {
  open: boolean;
  role: StaffRole | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<RoleInput>(EMPTY);
  const [isPending, startTransition] = useTransition();
  const isEditing = !!role;
  const isOwner = role?.slug === "superadmin";
  const isRegister = role?.kind === "pos";
  const permissionsLocked = isOwner || isRegister;

  useEffect(() => {
    if (!open) return;
    if (role) {
      setForm({
        name: role.name,
        description: role.description ?? "",
        color: role.color || "blue",
        permissions: { ...role.permissions },
      });
    } else {
      setForm(EMPTY);
    }
  }, [open, role]);

  const isOn = (section: string, action: PermissionAction) =>
    (form.permissions[section] ?? []).includes(action);

  const toggle = (section: string, action: PermissionAction) => {
    setForm((f) => {
      const current = new Set(f.permissions[section] ?? []);
      if (current.has(action)) {
        current.delete(action);
        // Removing view also removes manage (manage implies view).
        if (action === "view") current.delete("manage");
      } else {
        current.add(action);
        // Granting manage implies view.
        if (action === "manage") current.add("view");
      }
      const next: RolePermissions = { ...f.permissions };
      const arr = Array.from(current) as PermissionAction[];
      if (arr.length === 0) delete next[section];
      else next[section] = arr;
      return { ...f, permissions: next };
    });
  };

  const set = <K extends keyof RoleInput>(key: K, value: RoleInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const handleSave = () => {
    // The same rule the action applies, so the form cannot accept what the
    // server then refuses.
    const invalid = validateRoleInput(form);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    startTransition(async () => {
      const result = isEditing
        ? await updatePlatformRole(role!.slug, form)
        : await createPlatformRole(form);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(isEditing ? "Role updated" : "Role created");
        onSaved();
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? `Edit role - ${role?.name}` : "New dashboard role"}
          </DialogTitle>
          <DialogDescription>
            {isRegister
              ? "A POS role: its name and description show on every store's Staff page. What it can do in POS is set in code."
              : "Choose which dashboard sections this role can view and manage, on every store."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
            <div>
              <label className={labelClass}>Name *</label>
              <input
                className={fieldClass}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                maxLength={ROLE_NAME_MAX}
              />
              {isEditing && (
                <p className="mt-1 text-[11.5px] text-[var(--dash-text-3)]">
                  Stored as <span className="mono">{role?.slug}</span>; the slug
                  never changes.
                </p>
              )}
            </div>
            <div>
              <label className={labelClass}>Colour</label>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {ROLE_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => set("color", c)}
                    aria-label={c}
                    className={`h-6 w-6 rounded-full transition ${
                      form.color === c
                        ? "ring-2 ring-[var(--dash-text)] ring-offset-2 ring-offset-[var(--dash-surface)]"
                        : "opacity-70 hover:opacity-100"
                    }`}
                    style={{ background: COLOR_SWATCH[c] }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className={labelClass}>Description</label>
            <textarea
              className={`${fieldClass} min-h-[60px] resize-y`}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              maxLength={ROLE_DESCRIPTION_MAX}
            />
          </div>

          <div>
            <label className={labelClass}>Permissions</label>

            {isOwner ? (
              <div className="flex items-start gap-2 rounded-md border border-[var(--dash-violet)]/30 bg-[var(--dash-violet-soft)] px-3 py-3 text-sm text-[var(--dash-violet)]">
                <Zap className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  The owner always has full, unrestricted access. Its
                  permissions can&rsquo;t be narrowed.
                </span>
              </div>
            ) : isRegister ? (
              <div className="flex items-start gap-2 rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface-2)] px-3 py-3 text-sm text-[var(--dash-text-2)]">
                <ScanLine className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  POS roles have no dashboard access. What they can do in POS is
                  fixed in code.
                </span>
              </div>
            ) : (
              <div className="space-y-4">
                {SECTION_GROUPS.map((group) => {
                  const sections = SECTIONS.filter((s) => s.group === group);
                  return (
                    <div key={group}>
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--dash-text-3)]">
                        {group}
                      </div>
                      <div className="overflow-hidden rounded-md border border-[var(--dash-border)]">
                        {sections.map((section, i) => (
                          <div
                            key={section.key}
                            className={`flex items-center justify-between px-3 py-2 ${
                              i > 0
                                ? "border-t border-[var(--dash-border)]"
                                : ""
                            }`}
                          >
                            <span className="text-sm text-[var(--dash-text)]">
                              {section.label}
                              {section.hiddenInNav && (
                                <span className="ml-1.5 text-[11px] text-[var(--dash-text-3)]">
                                  (folded into another page)
                                </span>
                              )}
                            </span>
                            <div className="flex items-center gap-4">
                              {(["view", "manage"] as PermissionAction[]).map(
                                (action) => {
                                  const supported =
                                    section.actions.includes(action);
                                  return (
                                    <label
                                      key={action}
                                      className={`flex items-center gap-1.5 text-xs ${
                                        supported
                                          ? "cursor-pointer text-[var(--dash-text-2)]"
                                          : "cursor-not-allowed text-[var(--dash-text-3)] opacity-60"
                                      }`}
                                    >
                                      <input
                                        type="checkbox"
                                        disabled={!supported}
                                        checked={
                                          supported && isOn(section.key, action)
                                        }
                                        onChange={() =>
                                          toggle(section.key, action)
                                        }
                                        className="h-3.5 w-3.5 accent-[var(--dash-accent)]"
                                      />
                                      {action === "view" ? "View" : "Manage"}
                                    </label>
                                  );
                                },
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isPending || (permissionsLocked && !isEditing)}
          >
            {isPending
              ? "Saving..."
              : isEditing
                ? "Save changes"
                : "Create role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
