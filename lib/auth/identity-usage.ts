// Which Identity Platform logins still mean something to StoreMink. A Firebase
// uid is attached to the platform only through Cloud SQL rows — admins.id,
// users.id and pos_staff.user_id ARE uids, and platform operators are matched
// by email (platform_admins has no uid column). A login with none of those
// belongs to nobody: deleting it loses nothing, and leaving it behind blocks
// its email address from ever signing up again (Firebase answers
// `auth/email-already-in-use` to a password nobody remembers).
//
// Shared by `deleteStore`, which must keep a login another store or the
// operator console still uses, and the signup wizard's reclaim of an email
// left holding such an orphan. One definition, so "in use" can't drift between
// the code that removes logins and the code that frees them.

import "server-only";
import { inArray } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { admins, platformAdmins, posStaff, users } from "@/drizzle/schema";

/**
 * The uids in `candidates` (uid → its lower-cased email addresses, possibly
 * none) that still hold a StoreMink role: a store admin, a storefront customer,
 * a POS operator, or a platform operator. Throws when the lookup fails —
 * callers must treat that as "in use", never as "free".
 */
export async function authIdsInUse(
  candidates: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<Set<string>> {
  const inUse = new Set<string>();
  const ids = [...candidates.keys()];
  if (ids.length === 0) return inUse;
  const emails = [
    ...new Set([...candidates.values()].flatMap((set) => [...set])),
  ];

  await withService(async (db) => {
    const remainingAdmins = await db
      .select({ id: admins.id })
      .from(admins)
      .where(inArray(admins.id, ids));
    const remainingCustomers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, ids));
    const remainingPosStaff = await db
      .select({ id: posStaff.userId })
      .from(posStaff)
      .where(inArray(posStaff.userId, ids));
    for (const row of [...remainingAdmins, ...remainingCustomers]) {
      inUse.add(row.id);
    }
    for (const row of remainingPosStaff) {
      if (row.id) inUse.add(row.id);
    }

    if (emails.length > 0) {
      const operators = await db
        .select({ email: platformAdmins.email })
        .from(platformAdmins)
        .where(inArray(platformAdmins.email, emails));
      const operatorEmails = new Set(
        operators.map((row) => row.email.trim().toLowerCase()),
      );
      for (const [id, set] of candidates) {
        if ([...set].some((email) => operatorEmails.has(email))) {
          inUse.add(id);
        }
      }
    }
  });
  return inUse;
}
