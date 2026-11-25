"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { deleteAuthUser } from "@/lib/auth/firebase-users";
import { authIdsInUse } from "@/lib/auth/identity-usage";
import { withService } from "@/lib/db/client";
import { isUniqueViolation, loggableError } from "@/lib/db/errors";
import { logError } from "@/lib/observability/logger";
import { isPosCustomerId } from "@/lib/pos/customer-claim";
import { customerCreditBalances, orders, users } from "@/drizzle/schema";
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
import {
  CUSTOMER_DELETE_CHECK_FAILED_MESSAGE,
  CUSTOMER_LINKED_TO_ORDERS_MESSAGE,
  customerHasCreditMessage,
  customerHasOrdersMessage,
} from "@/app/dashboard/users/shared";

export interface ActionResult {
  success?: boolean;
  error?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CustomerUpdateInput {
  firstName: string;
  lastName?: string;
  email?: string;
}

/**
 * Dashboard: edit a storefront customer's profile (name / email). Phone is the
 * customer's verified login identifier and is intentionally NOT editable here.
 * Guarded by the "users" section manage permission.
 */
export async function updateCustomer(
  id: string,
  input: CustomerUpdateInput,
): Promise<ActionResult> {
  const managerId = await getManagerUserId("users");
  if (!managerId) {
    return { error: "You don't have permission to manage users." };
  }

  const firstName = input.firstName?.trim();
  const lastName = input.lastName?.trim() || null;
  const email = input.email?.trim() || null;

  if (!firstName) return { error: "First name is required." };
  if (email && !EMAIL_RE.test(email)) {
    return { error: "Please enter a valid email address." };
  }

  // Scope by store_id: the service scope bypasses RLS, so without this a store
  // admin could edit ANY store's customer by passing its id.
  const storeId = await getActingStoreId();
  try {
    await withService((db) =>
      db
        .update(users)
        .set({ firstName, lastName, email })
        .where(and(eq(users.id, id), eq(users.storeId, storeId))),
    );
  } catch (err) {
    console.error("Failed to update customer:", err);
    // 23505 = unique_violation (email is UNIQUE on the users table).
    if (isUniqueViolation(err)) {
      return { error: "That email is already used by another customer." };
    }
    return { error: "Failed to save changes. Please try again." };
  }

  revalidatePath("/dashboard/users");
  revalidatePath(`/dashboard/users/${id}`);
  return { success: true };
}

type DeleteDecision =
  | { kind: "missing" }
  | { kind: "deleted"; email: string | null }
  | { kind: "refused"; error: string };

/**
 * Dashboard: delete a customer, unless doing so would destroy records the
 * store must keep. Guarded by "users" manage.
 *
 * ★★ A CUSTOMER WITH ORDERS IS NEVER DELETED. `orders.customer_id` cascades
 * on delete, so removing the users row used to remove every order, payment,
 * refund and invoice behind it: GST records, gone on one click. A customer
 * holding store credit is refused too, because the credit ledger has no
 * foreign key and the balance the store owes would be orphaned.
 *
 * ★ LOCK, THEN COUNT, THEN DELETE, as three statements in one transaction.
 * `FOR UPDATE` on the users row conflicts with the `FOR KEY SHARE` an order
 * insert's foreign-key check takes, so an order being placed right now either
 * commits before the lock (and the count, a fresh statement, sees it) or waits
 * and then fails once the row is gone. A single `DELETE ... WHERE NOT EXISTS`
 * would not do: its subquery keeps the statement's snapshot, so a racing order
 * would be cascaded away.
 *
 * ★ The refusal is decided on every order with this customer id, not only
 * this store's, because the cascade is not store-scoped either. The message
 * counts only this store's orders, so no other store's volume is revealed.
 *
 * ★ The login is removed only when nothing else uses it (`authIdsInUse`): an
 * owner who shopped at their own store has `admins.id = users.id`, and
 * deleting "that customer" used to delete the owner's dashboard login. A till
 * customer (`pos_` id) has no login at all.
 */
export async function deleteCustomer(id: string): Promise<ActionResult> {
  const managerId = await getManagerUserId("users");
  if (!managerId) {
    return { error: "You don't have permission to manage users." };
  }

  const storeId = await getActingStoreId();

  let decision: DeleteDecision;
  try {
    decision = await withService(async (db): Promise<DeleteDecision> => {
      // The store-scoped row is the ownership record: the login is global, so
      // without this a store admin could delete another store's customer.
      const target = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(and(eq(users.id, id), eq(users.storeId, storeId)))
        .limit(1)
        .for("update");
      if (!target[0]) return { kind: "missing" };

      const counts = await db
        .select({
          here: sql<number>`(count(*) filter (where ${orders.storeId} = ${storeId}))::int`,
          total: sql<number>`count(*)::int`,
        })
        .from(orders)
        .where(eq(orders.customerId, id));
      const here = Number(counts[0]?.here ?? 0);
      const total = Number(counts[0]?.total ?? 0);
      if (total > 0) {
        return {
          kind: "refused",
          error:
            here > 0
              ? customerHasOrdersMessage(here)
              : CUSTOMER_LINKED_TO_ORDERS_MESSAGE,
        };
      }

      // Read directly: getCreditBalance fails open to 0, which here would
      // allow the very delete this check exists to refuse.
      const credit = await db
        .select({ balance: customerCreditBalances.balance })
        .from(customerCreditBalances)
        .where(
          and(
            eq(customerCreditBalances.storeId, storeId),
            eq(customerCreditBalances.customerId, id),
          ),
        )
        .limit(1);
      const balance = Number(credit[0]?.balance ?? 0);
      if (balance > 0) {
        return { kind: "refused", error: customerHasCreditMessage(balance) };
      }

      await db
        .delete(users)
        .where(and(eq(users.id, id), eq(users.storeId, storeId)));
      return { kind: "deleted", email: target[0].email ?? null };
    });
  } catch (err) {
    // Fail closed: "we couldn't check" must never read as "not found".
    logError("customers.delete_check_failed", loggableError(err), {
      storeId,
      customerId: id,
    });
    return { error: CUSTOMER_DELETE_CHECK_FAILED_MESSAGE };
  }

  if (decision.kind === "missing") return { error: "Customer not found." };
  if (decision.kind === "refused") return { error: decision.error };

  // The customer is gone. The login is cleaned up after the commit, and a
  // failure here is logged, not reported: answering "failed" for a customer
  // who was deleted would only make the retry say "not found".
  if (!isPosCustomerId(id)) {
    const email = decision.email?.trim().toLowerCase();
    let inUse = true;
    try {
      // After the delete, or it would find this customer's own row.
      inUse = (
        await authIdsInUse(new Map([[id, new Set(email ? [email] : [])]]))
      ).has(id);
    } catch (err) {
      logError("customers.login_use_check_failed", loggableError(err), {
        storeId,
        customerId: id,
      });
    }
    if (!inUse) {
      try {
        await deleteAuthUser(id);
      } catch (err) {
        logError("customers.login_delete_failed", err, {
          storeId,
          customerId: id,
        });
      }
    }
  }

  revalidatePath("/dashboard/users");
  revalidatePath(`/dashboard/users/${id}`);
  return { success: true };
}
