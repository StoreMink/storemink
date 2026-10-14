"use server";

import { and, count, eq } from "drizzle-orm";
import { getServerUser } from "@/lib/auth/server-user";
import { emitEvent } from "@/lib/notifications/record";
import { sendEmail } from "@/lib/email/send";
import {
  getActingStoreId,
  isStoreSuperadmin,
} from "@/app/dashboard/lib/access";
import { authIdsInUse } from "@/lib/auth/identity-usage";
import {
  deleteAuthUser,
  updateAuthUser,
  generatePasswordResetLink,
} from "@/lib/auth/firebase-users";
import { setUserClaims } from "@/lib/auth/firebase-claims";
import { withService } from "@/lib/db/client";
import { admins, roles } from "@/drizzle/schema";
import { buildPasswordResetEmail } from "@/lib/email/account-emails";
import { fromAddress } from "@/lib/email/sender";
import { getStoreBrand } from "@/lib/store/brand";

type Result = { error?: string; success?: boolean };

// Superadmin-only staff management, SCOPED TO THE STORE THIS REQUEST IS FOR.
//
// These guards used to ask "is the caller a superadmin of SOME store?" and then
// read and write the admins table by id alone. A free self-signup is the
// superadmin of its own store, so any merchant could delete, demote or suspend
// another store's staff, and `deleteUser` would delete ANY Identity Platform
// login by uid, a shopper's included. Now:
//   • the caller must be a superadmin of the HOST store (platform operators
//     count, as everywhere else — `isStoreSuperadmin`);
//   • every target read and write carries `store_id = <host store>`, so a uid
//     belonging to another store (or to no admin at all) is "not found";
//   • the last-superadmin count is per store;
//   • a login is deleted only when nothing else on the platform still uses it.

type Gate = { id: string; storeId: string } | { error: string };

async function requireSuperadminCaller(): Promise<Gate> {
  const user = await getServerUser();
  if (!user) return { error: "Not authenticated" };
  try {
    const storeId = await getActingStoreId();
    // Fails closed: an access lookup that errors answers "not a superadmin".
    if (!(await isStoreSuperadmin())) return { error: "Unauthorized" };
    return { id: user.id, storeId };
  } catch {
    return { error: "Unauthorized" };
  }
}

type Target = { role: string; email: string };

// The target admin row IN THIS STORE, or null when there is none. Throws on a
// failed read so callers refuse rather than treat "unknown" as "absent".
async function loadTarget(
  userId: string,
  storeId: string,
): Promise<Target | null> {
  const rows = await withService((db) =>
    db
      .select({ role: admins.role, email: admins.email })
      .from(admins)
      .where(and(eq(admins.id, userId), eq(admins.storeId, storeId)))
      .limit(1),
  );
  return rows[0] ?? null;
}

const NOT_FOUND = "That user isn't a member of this store.";
const READ_FAILED = "Couldn't load that user. Please try again.";

// Superadmins in THIS store. Another store's owners say nothing about whether
// this one would be left with nobody able to manage its staff.
async function superadminCount(storeId: string): Promise<number> {
  const rows = await withService((db) =>
    db
      .select({ n: count() })
      .from(admins)
      .where(and(eq(admins.role, "superadmin"), eq(admins.storeId, storeId))),
  );
  return rows[0]?.n ?? 0;
}

export async function deleteUser(userId: string): Promise<Result> {
  const gate = await requireSuperadminCaller();
  if ("error" in gate) return gate;

  if (userId === gate.id) {
    return { error: "You cannot delete your own account." };
  }

  let target: Target | null;
  try {
    target = await loadTarget(userId, gate.storeId);
  } catch {
    return { error: READ_FAILED };
  }
  if (!target) return { error: NOT_FOUND };

  // Don't allow deleting the last remaining superadmin (would lock everyone out).
  if (target.role === "superadmin") {
    if ((await superadminCount(gate.storeId)) <= 1) {
      return { error: "Cannot delete the last superadmin." };
    }
  }

  // Delete the Cloud SQL profile row, then the Identity Platform account. The
  // old `auth.users` ON DELETE CASCADE is gone (auth + profile now live in
  // separate systems), so both must be removed explicitly. The row goes first:
  // it IS this store's access, so removing it is the revocation.
  try {
    await withService((db) =>
      db
        .delete(admins)
        .where(and(eq(admins.id, userId), eq(admins.storeId, gate.storeId))),
    );
  } catch (err) {
    console.error("deleteUser profile delete error:", err);
    return { error: "Failed to delete user." };
  }

  // The login may still be somebody's shopper account, till PIN or operator
  // access. Delete it only when nothing else uses it; an unanswerable check
  // counts as "in use" — a stray login is recoverable, a deleted one is not.
  let inUse = true;
  try {
    const emails = new Set([target.email.trim().toLowerCase()]);
    inUse = (await authIdsInUse(new Map([[userId, emails]]))).has(userId);
  } catch (err) {
    console.error("deleteUser identity usage check error:", err);
  }
  if (inUse) {
    // Keep the login, but drop the dashboard role claim it carried here.
    await setUserClaims(userId, { role: null }).catch((err) =>
      console.error("deleteUser setUserClaims error:", err),
    );
  } else {
    try {
      await deleteAuthUser(userId);
    } catch (err) {
      console.error("deleteUser auth delete error:", err);
      return { error: "Failed to delete the user's login. Please try again." };
    }
  }

  emitEvent({
    type: "admin.removed",
    storeId: gate.storeId,
    actor: { type: "admin", id: gate.id },
    subject: { type: "admin", id: userId },
  });
  return { success: true };
}

export async function changeUserRole(
  userId: string,
  role: string,
): Promise<Result> {
  const gate = await requireSuperadminCaller();
  if ("error" in gate) return gate;

  // The target role must be a real role OF THIS STORE. Fall back to the two
  // built-in roles when the store's roles table hasn't been seeded yet.
  const roleRows = await withService((db) =>
    db
      .select({ slug: roles.slug })
      .from(roles)
      .where(and(eq(roles.slug, role), eq(roles.storeId, gate.storeId)))
      .limit(1),
  ).catch(() => []);
  if (!roleRows[0] && !["superadmin", "member"].includes(role)) {
    return { error: "Invalid role" };
  }

  let target: Target | null;
  try {
    target = await loadTarget(userId, gate.storeId);
  } catch {
    return { error: READ_FAILED };
  }
  if (!target) return { error: NOT_FOUND };

  // Prevent demoting the last superadmin (e.g. yourself), which would leave
  // the dashboard with no one able to manage users.
  if (role !== "superadmin" && target.role === "superadmin") {
    if ((await superadminCount(gate.storeId)) <= 1) {
      return { error: "Cannot demote the last superadmin." };
    }
  }

  try {
    await withService((db) =>
      db
        .update(admins)
        .set({ role })
        .where(and(eq(admins.id, userId), eq(admins.storeId, gate.storeId))),
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to update." };
  }

  // Keep the auth token's role claim in sync (drives the proxy's fast-path
  // gating; reaches the user on their next token refresh). Best-effort — the
  // admins row is authoritative for actual permission checks.
  await setUserClaims(userId, { role }).catch((err) =>
    console.error("changeUserRole setUserClaims error:", err),
  );

  emitEvent({
    type: "admin.role_changed",
    storeId: gate.storeId,
    actor: { type: "admin", id: gate.id },
    subject: { type: "admin", id: userId },
    payload: { role },
  });
  return { success: true };
}

export async function toggleUserSuspension(
  userId: string,
  isSuspended: boolean,
): Promise<Result> {
  const gate = await requireSuperadminCaller();
  if ("error" in gate) return gate;

  if (userId === gate.id && isSuspended) {
    return { error: "You cannot suspend your own account." };
  }

  let updated: { id: string }[];
  try {
    updated = await withService((db) =>
      db
        .update(admins)
        .set({ isSuspended })
        .where(and(eq(admins.id, userId), eq(admins.storeId, gate.storeId)))
        .returning({ id: admins.id }),
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to update." };
  }
  if (updated.length === 0) return { error: NOT_FOUND };

  return { success: true };
}

export async function changeOwnPassword(newPassword: string): Promise<Result> {
  if (!newPassword || newPassword.length < 8)
    return { error: "Password must be at least 8 characters" };

  const user = await getServerUser();
  if (!user) return { error: "Not authenticated." };

  try {
    await updateAuthUser(user.id, { password: newPassword });
  } catch (err) {
    console.error("changeOwnPassword error:", err);
    return { error: "Couldn't update your password. Please try again." };
  }
  return { success: true };
}

export async function triggerPasswordReset(email: string): Promise<Result> {
  // Generate an Identity Platform reset link and deliver it via our own email
  // transport (Resend), mirroring the old resetPasswordForEmail. Always report
  // success so the endpoint can't be used to enumerate which emails exist.
  const link = await generatePasswordResetLink(email.trim()).catch(() => null);
  if (!link) return { success: true };

  const resendApiKey = process.env.RESEND_API_KEY;
  if (resendApiKey && !resendApiKey.includes("placeholder")) {
    const brand = await getStoreBrand();
    // `password_reset` is a sensitive mailer: the log records the attempt but
    // not the body, because the reset link in it IS the credential.
    // ignoreSuppression — someone is waiting on this to get back into their
    // account, and a historic bounce shouldn't lock them out.
    const { subject, html } = buildPasswordResetEmail({ brand, link });
    await sendEmail({
      storeId: await getActingStoreId().catch(() => null),
      from: fromAddress(brand, { suffix: "Accounts" }),
      to: email,
      subject,
      mailer: "password_reset",
      ignoreSuppression: true,
      html,
    });
  } else {
    // Dev fallback: no email provider configured.
    console.log(`\n🔑 Password reset link for ${email}:\n${link}\n`);
  }

  return { success: true };
}
