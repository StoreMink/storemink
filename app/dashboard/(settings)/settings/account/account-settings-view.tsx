"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertCircle,
  Check,
  KeyRound,
  Mail,
  Pencil,
  Shield,
  Smartphone,
  UserRound,
} from "lucide-react";
import { formatPhoneNumberIntl } from "react-phone-number-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  changePassword,
  updateProfileName,
} from "@/app/actions/account-settings";
import { VerifyPhoneForm } from "@/app/dashboard/components/verify-phone-form";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";

type Tab = "profile" | "security";

function passwordStrength(password: string) {
  if (!password) return null;
  if (password.length < 8)
    return { label: "Too short", tone: "var(--dash-red)", width: "33%" };
  if (password.length < 12)
    return { label: "Fair", tone: "var(--dash-amber)", width: "66%" };
  return { label: "Strong", tone: "var(--dash-green)", width: "100%" };
}

function initialsOf(first: string, last: string, email: string) {
  if (first) {
    return `${first[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase() || "?";
  }
  return (email.slice(0, 2) || "?").toUpperCase();
}

export function AccountSettingsView({
  email,
  role,
  firstName,
  lastName,
  phone,
  phoneVerified,
  initialTab,
  initialFocus,
}: {
  email: string;
  role: string;
  firstName: string;
  lastName: string;
  phone: string;
  /** The number was proven with a texted code (admins.phone_verified_at). */
  phoneVerified: boolean;
  initialTab: Tab;
  initialFocus: "phone" | "password" | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);

  const roleLabel = role === "superadmin" ? "Superadmin" : role || "Admin";

  return (
    <div className="dash-page-enter mx-auto w-full max-w-3xl">
      <header className="dash-page-header">
        <h1>Account settings</h1>
        <p>Manage your profile, password, and contact details</p>
      </header>

      <div className="dash-filter-tabs mb-5 mt-4 w-fit">
        <button
          className={`dash-filter-tab${tab === "profile" ? " active" : ""}`}
          onClick={() => setTab("profile")}
        >
          <UserRound className="h-4 w-4" />
          Profile
        </button>
        <button
          className={`dash-filter-tab${tab === "security" ? " active" : ""}`}
          onClick={() => setTab("security")}
        >
          <Shield className="h-4 w-4" />
          Security
        </button>
      </div>

      {tab === "profile" ? (
        <ProfileTab
          email={email}
          roleLabel={roleLabel}
          firstName={firstName}
          lastName={lastName}
          onSaved={() => router.refresh()}
        />
      ) : (
        <SecurityTab
          phone={phone}
          phoneVerified={phoneVerified}
          initialFocus={initialFocus}
          onPhoneSaved={() => router.refresh()}
        />
      )}
    </div>
  );
}

/* ───────────────────────── Profile ───────────────────────── */

function ProfileTab({
  email,
  roleLabel,
  firstName,
  lastName,
  onSaved,
}: {
  email: string;
  roleLabel: string;
  firstName: string;
  lastName: string;
  onSaved: () => void;
}) {
  const [first, setFirst] = useState(firstName);
  const [last, setLast] = useState(lastName);
  const [isPending, startTransition] = useTransition();

  const dirty = first.trim() !== firstName || last.trim() !== lastName;

  useUnsavedChangesWarning(dirty);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const fd = new FormData();
    fd.set("firstName", first);
    fd.set("lastName", last);
    startTransition(async () => {
      const res = await updateProfileName(fd);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Profile updated");
      onSaved();
    });
  };

  return (
    <form onSubmit={submit} className="dash-card">
      <div className="dash-card-header">
        <div>
          <div className="dash-card-title">Profile</div>
          <div className="dash-card-sub">Your name and account identity</div>
        </div>
      </div>

      <div className="flex flex-col gap-5 p-6">
        <div className="flex items-center gap-4">
          <div
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-lg font-bold text-white"
            style={{
              background:
                "linear-gradient(135deg, var(--dash-accent), var(--dash-accent-2))",
            }}
          >
            {initialsOf(first, last, email)}
          </div>
          <div>
            <div className="text-[15px] font-semibold text-[var(--dash-text)]">
              {[first, last].filter(Boolean).join(" ") || "Unnamed"}
            </div>
            <span className="dash-badge dash-badge-blue mt-1">{roleLabel}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="firstName">First name</Label>
            <Input
              id="firstName"
              value={first}
              onChange={(e) => setFirst(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lastName">
              Last name
              <span className="font-normal text-[var(--dash-text-3)]">
                {" "}
                (optional)
              </span>
            </Label>
            <Input
              id="lastName"
              value={last}
              onChange={(e) => setLast(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Email</Label>
          <div className="flex h-10 items-center gap-2 rounded-md border border-input bg-[var(--dash-surface-2)] px-3 text-sm text-[var(--dash-text-2)]">
            <Mail className="h-4 w-4 text-[var(--dash-text-3)]" />
            {email || "-"}
          </div>
          <p className="text-xs text-[var(--dash-text-3)]">
            Linked to your login. Ask your store owner to change it.
          </p>
        </div>

        <div className="flex justify-end border-t border-[var(--dash-border)] pt-4">
          <Button type="submit" disabled={!dirty || isPending}>
            {isPending ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/* ───────────────────────── Security ───────────────────────── */

function SecurityTab({
  phone,
  phoneVerified,
  initialFocus,
  onPhoneSaved,
}: {
  phone: string;
  phoneVerified: boolean;
  initialFocus: "phone" | "password" | null;
  onPhoneSaved: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <PasswordCard autoFocus={initialFocus === "password"} />
      <PhoneCard
        phone={phone}
        verified={phoneVerified}
        startEditing={initialFocus === "phone"}
        onSaved={onPhoneSaved}
      />
    </div>
  );
}

function PasswordCard({ autoFocus }: { autoFocus: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isPending, startTransition] = useTransition();

  const strength = passwordStrength(next);
  const mismatch = confirm.length > 0 && next !== confirm;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 8) return toast.error("New password is too short.");
    if (next !== confirm) return toast.error("New passwords don't match.");
    const fd = new FormData();
    fd.set("currentPassword", current);
    fd.set("newPassword", next);
    fd.set("confirmPassword", confirm);
    startTransition(async () => {
      const res = await changePassword(fd);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Password updated");
      setCurrent("");
      setNext("");
      setConfirm("");
    });
  };

  return (
    <form onSubmit={submit} className="dash-card">
      <div className="dash-card-header">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--dash-accent-soft)] text-[var(--dash-accent)]">
            <KeyRound className="h-4 w-4" />
          </span>
          <div>
            <div className="dash-card-title">Password</div>
            <div className="dash-card-sub">
              Use at least 8 characters, hard to guess
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-6">
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor="currentPassword">Current password</Label>
          <Input
            id="currentPassword"
            type="password"
            autoFocus={autoFocus}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor="newPassword">New password</Label>
          <Input
            id="newPassword"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
          />
          {strength && (
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--dash-surface-3)]">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: strength.width, background: strength.tone }}
                />
              </div>
              <span
                className="text-xs font-medium"
                style={{ color: strength.tone }}
              >
                {strength.label}
              </span>
            </div>
          )}
        </div>
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor="confirmPassword">Confirm new password</Label>
          <Input
            id="confirmPassword"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
          {mismatch && (
            <p className="text-xs text-[var(--dash-red)]">
              Passwords do not match
            </p>
          )}
        </div>

        <div className="flex justify-end border-t border-[var(--dash-border)] pt-4">
          <Button
            type="submit"
            disabled={isPending || !current || !next || !confirm || mismatch}
          >
            {isPending ? "Updating..." : "Update password"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function PhoneCard({
  phone,
  verified,
  startEditing,
  onSaved,
}: {
  phone: string;
  verified: boolean;
  startEditing: boolean;
  onSaved: () => void;
}) {
  const [savedPhone, setSavedPhone] = useState(phone);
  const [isVerified, setIsVerified] = useState(verified && !!phone);
  const [editing, setEditing] = useState(startEditing);
  const shown = savedPhone
    ? formatPhoneNumberIntl(savedPhone) || savedPhone
    : "";

  return (
    <div className="dash-card">
      <div className="dash-card-header">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--dash-accent-soft)] text-[var(--dash-accent)]">
            <Smartphone className="h-4 w-4" />
          </span>
          <div>
            <div className="dash-card-title">Mobile number</div>
            <div className="dash-card-sub">
              Confirmed with a code we text to it
            </div>
          </div>
        </div>
        {!editing && (
          <button
            type="button"
            className="dash-btn dash-btn-ghost dash-btn-sm"
            onClick={() => setEditing(true)}
          >
            <Pencil className="h-3.5 w-3.5" />
            {!savedPhone ? "Add number" : isVerified ? "Change" : "Verify"}
          </button>
        )}
      </div>

      <div className="p-6">
        {editing ? (
          <VerifyPhoneForm
            autoFocus
            onCancel={() => setEditing(false)}
            onVerified={(verifiedPhone) => {
              setSavedPhone(verifiedPhone);
              setIsVerified(true);
              setEditing(false);
              toast.success("Mobile number verified");
              onSaved();
            }}
          />
        ) : savedPhone ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono-dash text-[15px] text-[var(--dash-text)]">
              {shown}
            </span>
            {isVerified ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--dash-green-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--dash-green)]">
                <Check className="h-3 w-3" />
                Verified
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--dash-amber-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--dash-amber)]">
                <AlertCircle className="h-3 w-3" />
                Not verified
              </span>
            )}
          </div>
        ) : (
          <p className="text-sm text-[var(--dash-text-3)]">
            No mobile number added yet.
          </p>
        )}
      </div>
    </div>
  );
}
