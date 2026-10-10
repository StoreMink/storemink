"use server";

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getServerUser } from "@/lib/auth/server-user";
import { emitEvent } from "@/lib/notifications/record";
import { getActingStoreId } from "@/app/dashboard/lib/access";
import { verifyPassword, updateAuthUser } from "@/lib/auth/firebase-users";
import { getFirebaseAdminAuth } from "@/lib/auth/firebase-admin";
import { authIdsInUse } from "@/lib/auth/identity-usage";
import { withService, withUser } from "@/lib/db/client";
import { admins, storeBillingSettings } from "@/drizzle/schema";
import { rateLimit } from "@/lib/rate-limit";
import { logError } from "@/lib/observability/logger";

type Result = { error?: string; success?: boolean };

/** Update the signed-in admin's display name on their own profile row. */
export async function updateProfileName(formData: FormData): Promise<Result> {
  const firstName = ((formData.get("firstName") as string) || "").trim();
  const lastName = ((formData.get("lastName") as string) || "").trim();

  if (!firstName) {
    return { error: "First name is required." };
  }

  const user = await getServerUser();
  if (!user) return { error: "Not authenticated." };

  try {
    // Own-row update (admins RLS lets a user edit their own row).
    await withUser({ uid: user.id, email: user.email }, (db) =>
      db
        .update(admins)
        .set({ firstName, lastName: lastName || null })
        .where(eq(admins.id, user.id)),
    );
  } catch (err) {
    console.error("Failed to update profile name:", err);
    return { error: "Couldn't save your name. Please try again." };
  }

  return { success: true };
}

/**
 * Change the signed-in admin's password. The current password is re-verified
 * first (via the Identity Platform REST sign-in — firebase-admin can't check a
 * password), like Notion/Linear do, then updated with the Admin SDK.
 */
export async function changePassword(formData: FormData): Promise<Result> {
  const currentPassword = (formData.get("currentPassword") as string) || "";
  const newPassword = (formData.get("newPassword") as string) || "";
  const confirmPassword = (formData.get("confirmPassword") as string) || "";

  if (!currentPassword) {
    return { error: "Enter your current password." };
  }
  if (newPassword.length < 8) {
    return { error: "New password must be at least 8 characters." };
  }
  if (newPassword !== confirmPassword) {
    return { error: "New passwords do not match." };
  }
  if (newPassword === currentPassword) {
    return { error: "New password must be different from the current one." };
  }

  const user = await getServerUser();
  if (!user?.email) return { error: "Not authenticated." };

  // Re-verify the current password before allowing the change.
  const ok = await verifyPassword(user.email, currentPassword);
  if (!ok) {
    return { error: "Your current password is incorrect." };
  }

  try {
    await updateAuthUser(user.id, { password: newPassword });
  } catch (err) {
    console.error("changePassword error:", err);
    return { error: "Couldn't update your password." };
  }

  emitEvent({
    type: "security.password_changed",
    storeId: await getActingStoreId(),
    actor: { type: "admin", id: user.id, label: user.email },
    subject: { type: "admin", id: user.id, label: user.email },
  });

  return { success: true };
}

/** Firebase reports a verified phone in E.164: "+", then 7 to 15 digits. */
const E164 = /^\+[1-9]\d{6,14}$/;

/** How old the code-based sign-in may be when it is presented. */
const PROOF_MAX_AGE_SECONDS = 5 * 60;

/**
 * Record a mobile number the signed-in admin has just proven with a one-time
 * code, on their own admin row.
 *
 * ★★ THE CODE IS CHECKED BY AN ISOLATED SIGN-IN, NEVER BY LINKING THE NUMBER
 * TO THIS ADMIN'S LOGIN. Shoppers sign in to StoreMink storefronts by phone in
 * the same Firebase project, so linking (`updatePhoneNumber`) refused every
 * merchant whose mobile had ever been used to shop: "That mobile number is
 * already linked to another StoreMink account", with no way past it.
 * `VerifyPhoneForm` signs in on a separate in-memory Firebase app instead, so
 * the identity that proved the code may be a shopper's, or a brand-new
 * phone-only one, and that is fine: what it proves is that the person at this
 * keyboard received the text. Nothing about the merchant's own login changes.
 *
 * ★ THE NUMBER SAVED IS THE ONE IN THE VERIFIED TOKEN, never one the browser
 * sends, and the proof must be a phone sign-in made in the last five minutes.
 * `phone_verified_at` is what the go-live checklist reads; `phone` alone is
 * not proof, because the invited-staff password screen writes a typed value.
 */
export async function confirmVerifiedPhone(input: {
  idToken: string;
  cleanupCreatedAuthUser?: boolean;
}): Promise<{ phone?: string; error?: string }> {
  const user = await getServerUser();
  if (!user) return { error: "Not authenticated." };
  const idToken = typeof input?.idToken === "string" ? input.idToken : "";
  if (!idToken) {
    return { error: "The verification proof is missing. Request a new code." };
  }

  const limited = await rateLimit(`admin-phone-confirm:${user.id}`, {
    max: 10,
    windowSeconds: 900,
  });
  if (!limited.allowed) {
    return { error: "Too many attempts. Please wait 15 minutes." };
  }

  const auth = getFirebaseAdminAuth();
  if (!auth) {
    return { error: "Phone verification isn't configured on this server." };
  }
  const decoded = await auth.verifyIdToken(idToken, true).catch(() => null);
  if (!decoded) {
    return { error: "That code is invalid or expired. Request a new one." };
  }
  const phone =
    typeof decoded.phone_number === "string" && E164.test(decoded.phone_number)
      ? decoded.phone_number
      : null;
  const recent =
    typeof decoded.auth_time === "number" &&
    Math.floor(Date.now() / 1000) - decoded.auth_time <= PROOF_MAX_AGE_SECONDS;
  if (decoded.firebase?.sign_in_provider !== "phone" || !recent || !phone) {
    return { error: "That code didn't verify a mobile number. Try again." };
  }

  let saved: { storeId: string; role: string } | undefined;
  try {
    saved = await withService(async (db) => {
      const [row] = await db
        .update(admins)
        .set({ phone, phoneVerifiedAt: sql`now()` })
        .where(eq(admins.id, user.id))
        .returning({ storeId: admins.storeId, role: admins.role });
      // An owner who has not filled in the store's invoice contact yet gets
      // this number there too, which is what signup used to do with the
      // number it verified. Never over a value somebody typed, and never from
      // a staff member's personal phone.
      if (row?.role === "superadmin") {
        await db
          .update(storeBillingSettings)
          .set({ contactPhone: phone, updatedBy: user.id })
          .where(
            and(
              eq(storeBillingSettings.storeId, row.storeId),
              or(
                isNull(storeBillingSettings.contactPhone),
                sql`btrim(${storeBillingSettings.contactPhone}) = ''`,
              ),
            ),
          );
      }
      return row;
    });
  } catch (err) {
    logError("account.phone_verify_save", err, { uid: user.id });
    return { error: "Couldn't save your phone number. Please try again." };
  }
  if (!saved) {
    return { error: "There is no store profile on this account to save to." };
  }

  if (input.cleanupCreatedAuthUser === true && decoded.uid !== user.id) {
    await discardTemporaryPhoneIdentity(auth, decoded.uid, phone);
  }
  return { phone };
}

/**
 * The isolated sign-in creates a Firebase identity when the number has never
 * signed in before. It was only a way to deliver the code, and leaving it
 * behind clutters the user list. The browser's "this was new" flag is not
 * trusted by itself: delete only an identity that is minutes old, signs in by
 * phone alone, carries this exact number and holds no StoreMink role. A failed
 * cleanup never undoes the verification; it is logged.
 */
async function discardTemporaryPhoneIdentity(
  auth: NonNullable<ReturnType<typeof getFirebaseAdminAuth>>,
  uid: string,
  phone: string,
): Promise<void> {
  try {
    const record = await auth.getUser(uid);
    const createdAt = Date.parse(record.metadata.creationTime);
    const justCreated =
      Number.isFinite(createdAt) &&
      Date.now() - createdAt <= PROOF_MAX_AGE_SECONDS * 1000;
    const phoneOnly =
      !record.email &&
      record.providerData.length > 0 &&
      record.providerData.every((provider) => provider.providerId === "phone");
    if (!justCreated || !phoneOnly || record.phoneNumber !== phone) return;
    const inUse = await authIdsInUse(new Map([[uid, new Set<string>()]]));
    if (inUse.has(uid)) return;
    await auth.deleteUser(uid);
  } catch (err) {
    logError("account.phone_otp_identity_cleanup", err, { uid });
  }
}
