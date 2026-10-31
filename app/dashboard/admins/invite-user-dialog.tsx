"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { inviteUser } from "@/app/actions/invite-user";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { InfoTip } from "@/components/ui/info-tip";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Loader2, UserPlus } from "lucide-react";
import {
  dashboardRoles,
  findRole,
  posRoles,
  type StaffRole,
} from "@/lib/roles/catalog";

export function InviteUserDialog({
  className,
  label = "Add User",
  locations = [],
  roles,
  posEnabled = false,
}: {
  className?: string;
  label?: string;
  size?: "default" | "sm" | "lg";
  /** The platform's role list (StoreMink defines it; a store picks from it). */
  roles: StaffRole[];
  /** The store's shops. Empty for a single-location store, which hides the
   *  field entirely — a scope picker with one option is a decision nobody has
   *  to make. */
  locations?: { id: string; name: string }[];
  /** The register roles can only be invited once Point of Sale is on. They
   *  are still LISTED, greyed, so the roles read the same in every store. */
  posEnabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const chosen = findRole(roles, role);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!firstName.trim()) {
      setError("First name is required.");
      return;
    }

    const formData = new FormData();
    formData.set("firstName", firstName.trim());
    formData.set("lastName", lastName.trim());
    formData.set("email", email);
    formData.set("role", role);
    // ★ append, not set — the field is multi-value, and the action reads it
    // with getAll. Skipped for an owner, who is unrestricted by definition.
    if (role !== "superadmin") {
      for (const id of locationIds) formData.append("locationIds", id);
    }

    startTransition(async () => {
      const result = await inviteUser(formData);
      if (result.error) {
        setError(result.error);
      } else {
        toast.success("Invitation sent", {
          description: `An invite has been sent to ${email}`,
        });
        setOpen(false);
        setFirstName("");
        setLastName("");
        setEmail("");
        setRole("member");
        setLocationIds([]);
        router.refresh();
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className={className}>
        <UserPlus className="h-4 w-4" />
        {label}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[520px]">
        <form onSubmit={handleSubmit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Invite user</DialogTitle>
            <DialogDescription>
              We email them a link to set up their account.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="invite-first-name">
                First name <span className="text-[var(--dash-red)]">*</span>
              </Label>
              <Input
                id="invite-first-name"
                type="text"
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={isPending}
                className="h-10 px-3"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="invite-last-name">
                Last name{" "}
                <span className="font-normal text-[var(--dash-text-3)]">
                  (optional)
                </span>
              </Label>
              <Input
                id="invite-last-name"
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={isPending}
                className="h-10 px-3"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-email">
              Email address <span className="text-[var(--dash-red)]">*</span>
            </Label>
            <Input
              id="invite-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isPending}
              className="h-10 px-3"
            />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="invite-role">
                Role <span className="text-[var(--dash-red)]">*</span>
              </Label>
              <InfoTip label="About roles">
                Dashboard roles sign in to the dashboard. Manager and Cashier
                sign in to POS only, with an 8-digit PIN they choose.
              </InfoTip>
            </div>
            <Select
              value={role}
              onValueChange={(val) => setRole(val ?? "member")}
              disabled={isPending}
            >
              <SelectTrigger id="invite-role" className="h-10 px-3">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Dashboard</SelectLabel>
                  {dashboardRoles(roles).map((r) => (
                    <SelectItem key={r.slug} value={r.slug}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel>POS</SelectLabel>
                  {posRoles(roles).map((r) => (
                    <SelectItem
                      key={r.slug}
                      value={r.slug}
                      disabled={!posEnabled}
                    >
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {chosen && (
              <p className="text-[12.5px] text-[var(--dash-text-3)]">
                {chosen.description}
              </p>
            )}
            {!posEnabled && (
              <p className="text-[12.5px] text-[var(--dash-text-3)]">
                Manager and Cashier use POS. Switch on POS to invite them.
              </p>
            )}
          </div>

          {/* ★ Hidden for an owner: they see every shop by definition, so a
              picker there would imply a restriction that does not apply.
              Hidden for a single-location store for the same reason. */}
          {locations.length > 1 && role !== "superadmin" && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Locations</legend>
              <p className="text-[12.5px] text-[var(--dash-text-3)]">
                Leave all unticked for every location.
              </p>
              <div className="flex flex-col gap-1.5 rounded-md border border-[var(--dash-border)] p-3">
                {locations.map((l) => {
                  const checked = locationIds.includes(l.id);
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
                          setLocationIds((ids) =>
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
              </div>
            </fieldset>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-md border border-[var(--dash-red)]/30 bg-[var(--dash-red)]/10 px-4 py-3"
            >
              <p className="text-[14px] font-medium text-[var(--dash-red)]">
                {error}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                "Send invite"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
