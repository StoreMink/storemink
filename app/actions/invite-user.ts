"use server";

import { and, eq } from "drizzle-orm";
import { getServerUser } from "@/lib/auth/server-user";
import { emitEvent } from "@/lib/notifications/record";
import {
  createAuthUser,
  deleteAuthUser,
  authErrorCode,
} from "@/lib/auth/firebase-users";
import { setUserClaims } from "@/lib/auth/firebase-claims";
import { setAdminLocations } from "./location-actions";
import { withService } from "@/lib/db/client";
import { admins, posStaff } from "@/drizzle/schema";
import {
  getActingStoreId,
  isStoreSuperadmin,
} from "@/app/dashboard/lib/access";
import { buildStaffInviteEmail } from "@/lib/email/account-emails";
import { getStoreBrandById } from "@/lib/store/brand";
import { fromAddress } from "@/lib/email/sender";
import { sendEmail } from "@/lib/email/send";
import { PLATFORM_URL } from "@/lib/site";
import { getRequestOrigin } from "@/lib/request-url";
import { randomInt } from "crypto";
import {
  assertCanInviteStaff,
  PlanEntitlementError,
} from "@/lib/plans/entitlements";
import { roleNoun, type StaffRole } from "@/lib/roles/catalog";
import { getPlatformRole } from "@/lib/roles/platform-roles";
import { inviteStaff } from "./pos-staff-actions";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState, getStoreLocations } from "@/lib/pos/locations";

function generateTempPassword(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*";
  let password = "";
  for (let i = 0; i < 16; i++) {
    // randomInt is cryptographically secure (unlike Math.random).
    password += chars.charAt(randomInt(chars.length));
  }
  return password;
}

/** One shape for both halves, so a caller never has to narrow a union. */
type InviteResult = { success?: boolean; error?: string };

function normalizedEmailOf(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The register half of an invite. Delegates to `inviteStaff`, whose own gate
 * (the owner) the superadmin caller already passes, after two checks that
 * only make sense here: the store must actually have the register switched
 * on, and "no shops ticked" means every shop — the same reading the location
 * picker gives a dashboard admin, where absence is not restriction.
 */
async function invitePosStaff(input: {
  storeId: string;
  staffRole: StaffRole;
  firstName: string;
  lastName: string | null;
  email: string;
  locationIds: string[];
}): Promise<InviteResult> {
  // The caller's store must be the store this dashboard is for. `inviteStaff`
  // scopes to the host store, so a mismatch would file the invite elsewhere.
  const store = await getCurrentStore();
  if (store.id !== input.storeId) {
    return { error: "Invite POS staff from your own store's dashboard." };
  }
  if (!getPosState(store).posEnabled) {
    return {
      error:
        "Switch on POS before inviting a manager or cashier. Dashboard roles can be invited now.",
    };
  }

  let locationIds = input.locationIds;
  if (locationIds.length === 0) {
    locationIds = (await getStoreLocations(input.storeId)).map((l) => l.id);
  }

  const result = await inviteStaff({
    name: [input.firstName.trim(), input.lastName?.trim()]
      .filter(Boolean)
      .join(" "),
    email: input.email,
    role: input.staffRole.slug,
    locationIds,
  });
  if (result.error) return { error: result.error };
  return { success: true };
}

export async function inviteUser(formData: FormData): Promise<InviteResult> {
  const firstName = formData.get("firstName") as string;
  const lastName = (formData.get("lastName") as string) || null;
  const email = formData.get("email") as string;
  const role = formData.get("role") as string;
  // ★ MULTI-VALUE. `getAll` rather than `get`: a staff member can cover several
  // shops (a supervisor across Delhi and Jaipur), so the field is a set from
  // the start rather than a single id somebody later has to widen.
  const locationIds = formData
    .getAll("locationIds")
    .map(String)
    .filter(Boolean);

  if (!firstName || !firstName.trim()) {
    return { error: "First name is required." };
  }

  if (!email || !email.includes("@")) {
    return { error: "Please provide a valid email address." };
  }

  if (!role) {
    return { error: "Invalid role." };
  }

  const caller = await getServerUser();
  if (!caller) {
    return { error: "Not authenticated." };
  }

  // ★ A superadmin of THE STORE THIS DASHBOARD IS FOR, platform operators
  // included (user-management.ts's gate). It used to read the caller's own
  // admins row, which an operator does not have: since the register invite
  // moved here from Point of Sale → Staff, that left operators with an Invite
  // button that always failed. Fails closed on a lookup error.
  let storeId: string;
  try {
    if (!(await isStoreSuperadmin())) {
      return { error: "Unauthorized. Superadmin access required." };
    }
    storeId = await getActingStoreId();
  } catch {
    return { error: "Unauthorized. Superadmin access required." };
  }

  // A role from the platform's list (lib/roles/platform-roles.ts): the
  // dashboard roles StoreMink defines, or one of the two register roles.
  // Nothing else is a role, and a merchant cannot add one.
  let staffRole: StaffRole | null;
  try {
    staffRole = await getPlatformRole(role);
  } catch (err) {
    console.error("inviteUser role lookup error:", err);
    return { error: "Couldn't check that role. Please try again." };
  }
  if (!staffRole) {
    return { error: "Invalid role." };
  }

  // ★ A CASHIER OR MANAGER IS A REGISTER ACCOUNT, NOT A DASHBOARD ONE. They
  // get a `pos_staff` row and the self-registration link (password, phone
  // code, PIN) rather than a temporary dashboard password — the flow in
  // pos-staff-actions.ts, which also keeps the "a dashboard admin must not
  // become a cashier" guard. Only the entry point moved: since 2026-10-14 the
  // one Staff page invites every role.
  if (staffRole.kind === "pos") {
    // ★ A DASHBOARD LOGIN CANNOT ALSO WORK THE REGISTER: registration refuses
    // it (completeStaffRegistration), so inviting one leaves a Pending row
    // that can never finish. Say so now, while the owner can act on it.
    const adminRows = await withService((db) =>
      db
        .select({ id: admins.id })
        .from(admins)
        .where(eq(admins.email, normalizedEmailOf(email)))
        .limit(1),
    ).catch(() => []);
    if (adminRows[0]) {
      return {
        error:
          "This email already signs in to a StoreMink dashboard, and POS staff can't. If they work here, remove them from Staff first; otherwise use a different email address.",
      };
    }
    return invitePosStaff({
      storeId,
      staffRole,
      firstName,
      lastName,
      email: normalizedEmailOf(email),
      locationIds,
    });
  }

  const tempPassword = generateTempPassword();

  // Reject emails already attached to a dashboard profile. Identity Platform
  // blocks duplicate auth emails, but an auth account created without an email
  // (e.g. phone sign-up) can still collide at the profile layer. Exact match on
  // the already-lowercased email (not ILIKE, whose _/% wildcards would let a
  // crafted invite address collide with an unrelated admin).
  const normalizedEmail = email.trim().toLowerCase();
  const existingRows = await withService((db) =>
    db
      .select({ id: admins.id })
      .from(admins)
      .where(eq(admins.email, normalizedEmail))
      .limit(1),
  ).catch(() => []);

  if (existingRows[0]) {
    return { error: "A user with this email already exists." };
  }

  // ★ Register staff here keep their own login under this email, so creating a
  // dashboard user for it would fail with a bare "already exists". Name the
  // step that comes first instead.
  const posRows = await withService((db) =>
    db
      .select({ id: posStaff.id })
      .from(posStaff)
      .where(
        and(eq(posStaff.storeId, storeId), eq(posStaff.email, normalizedEmail)),
      )
      .limit(1),
  ).catch(() => []);
  if (posRows[0]) {
    return {
      error:
        "This email belongs to POS staff here. Remove them from Staff first, then invite them again with a dashboard role.",
    };
  }

  // Friendly preflight before creating an external auth identity. The same
  // check runs again in the profile INSERT transaction to close races between
  // simultaneous invites.
  try {
    await withService((db) => assertCanInviteStaff(db, storeId));
  } catch (err) {
    if (err instanceof PlanEntitlementError) return { error: err.message };
    console.error("inviteUser plan preflight error:", err);
    return { error: "Could not verify your plan's staff limit." };
  }

  // Create the Identity Platform user.
  let uid: string;
  try {
    uid = await createAuthUser({
      email,
      password: tempPassword,
      emailVerified: true,
    });
  } catch (err) {
    if (authErrorCode(err) === "auth/email-already-exists") {
      return { error: "A user with this email already exists." };
    }
    console.error("inviteUser createUser error:", err);
    return { error: "Failed to create user." };
  }

  // Insert the profile (upsert on the primary key so a leftover row is reused).
  const profileFields = {
    email: normalizedEmail,
    firstName: firstName.trim(),
    lastName: lastName?.trim() || null,
    role,
    forcePasswordReset: true,
    invitedBy: caller.id,
    storeId,
  };
  try {
    await withService(async (db) => {
      await assertCanInviteStaff(db, storeId);
      return db
        .insert(admins)
        .values({ id: uid, ...profileFields })
        .onConflictDoUpdate({ target: admins.id, set: profileFields });
    });
  } catch (err) {
    console.error("inviteUser profile insert error:", err);
    // Cleanup: delete the auth user so no orphan account is left behind.
    await deleteAuthUser(uid);
    return {
      error:
        err instanceof PlanEntitlementError
          ? err.message
          : "Failed to create user profile.",
    };
  }

  // ── Location scope ────────────────────────────────────────────────────────
  // ★ ASSIGNED AT INVITE, not in a second trip to another screen. The scope
  // machinery already existed (admin_locations + getViewerLocations), but the
  // only way to set it was an action with no caller — so in practice every
  // invited admin saw every shop. Deciding who covers where is part of deciding
  // who someone IS.
  //
  // ★ EMPTY MEANS UNRESTRICTED, and that is the existing contract
  // (lib/locations/scope.ts: null = all). So leaving the field alone invites
  // exactly the admin this form always did — no migration, no behaviour change
  // for anyone who ignores it.
  //
  // ⚠ Best-effort AFTER the account exists: a superadmin is unrestricted by
  // definition and the write is skipped for them, and a failure here must not
  // orphan an auth user we have just created. It leaves them unrestricted,
  // which is visible on the staff list and fixable in one click — the opposite
  // failure, an admin who can see nothing and cannot be told why, is not.
  if (role !== "superadmin" && locationIds.length > 0) {
    await setAdminLocations(uid, locationIds).catch((err) =>
      console.error("inviteUser setAdminLocations error:", err),
    );
  }

  // Mirror role + force_password_reset into the auth token as custom claims so
  // the proxy can gate the new admin's first login. Best-effort: the admins
  // row is authoritative for permission checks, so a claim hiccup only softens
  // the proxy's fast-path.
  await setUserClaims(uid, { role, forcePasswordReset: true }).catch((err) =>
    console.error("inviteUser setUserClaims error:", err),
  );

  // Send email via Resend
  const resendApiKey = process.env.RESEND_API_KEY;
  const isResendAvailable =
    resendApiKey && !resendApiKey.includes("placeholder");

  if (isResendAvailable) {
    const brand = await getStoreBrandById(storeId);
    // The invited admin belongs to the INVITER's store, and the inviter is on
    // that store's host — so the request origin sends them to their own store
    // dashboard ({slug}.storemink.com/dashboard) and is clickable in local dev.
    // PLATFORM_URL (the apex) would land them on the platform operator console
    // instead, and points at an unreachable host when developing locally.
    const appUrl = (await getRequestOrigin()) ?? PLATFORM_URL;

    // No try/catch: sendEmail never throws into its caller (rule 1 in
    // lib/email/send.ts), and it records the failure in the email log — which
    // is strictly more than the console.error this used to swallow it with.
    //
    // The `staff_invite` mailer is marked sensitive, so the email log records
    // that this went out — to whom, when, whether it sent — WITHOUT storing the
    // body, which carries a working temporary password in plaintext.
    //
    // The builder (lib/email/account-emails.ts) escapes every name, role and address it is given, and the
    // temporary password goes into the code inset escaped too.
    const { subject, html } = buildStaffInviteEmail({
      brand,
      firstName,
      lastName,
      email,
      // The role's name as it reads in a sentence ("a staff member"), not
      // the slug — `member` is stored, "Staff" is what the role is called.
      role: roleNoun(staffRole),
      tempPassword,
      signInUrl: `${appUrl}/dashboard`,
    });
    await sendEmail({
      storeId,
      // From/Subject are mail headers, NOT HTML: build the From with the
      // RFC-5322-safe helper and leave the brand name unescaped in both.
      from: fromAddress(brand, { suffix: "Dashboard" }),
      to: email,
      subject,
      mailer: "staff_invite",
      html,
    });
  }

  // Dev fallback only: if no email provider is configured there is no other
  // way to deliver the credential, so print it. Never log the password when an
  // email was actually sent (avoids plaintext credentials in production logs).
  if (!isResendAvailable) {
    console.log("\n" + "=".repeat(60));
    console.log("📨 USER INVITED (email not configured - dev fallback)");
    console.log(`Email: ${email}`);
    console.log(`Role: ${staffRole.name}`);
    console.log(`Temporary Password: ${tempPassword}`);
    console.log("=".repeat(60) + "\n");
  }

  // Team changes are always-on notifications (registry: configurable false) —
  // an owner must never be able to go blind on who gained dashboard access.
  emitEvent({
    type: "admin.invited",
    storeId,
    actor: { type: "admin", id: caller.id, label: caller.email },
    subject: { type: "admin", id: normalizedEmail, label: normalizedEmail },
    payload: { role },
  });

  return { success: true };
}
