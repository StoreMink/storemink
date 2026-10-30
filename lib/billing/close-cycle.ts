import "server-only";

/**
 * Closing the subscription invoices of cycles a plan will never enter
 * (renewal-cancel, design 6.1 and rule R3).
 *
 * ★★ WHEN A PLAN ENDS, EVERY INVOICE FOR A CYCLE IT DOES NOT REACH BECOMES
 * `void`, whatever its status: a draft (finalize failed mid-pass), an open one
 * (nobody will chase it), one still processing (a payment may yet land, and is
 * then refunded) and a paid one (the money is refunded by the refund pass). "A
 * cycle it does not reach" is `cycle_seq > lastReachedSeq`, the subscription's
 * current cycle. Leaving any of them open is how a merchant who cancelled is
 * charged, chased or kept out of a refund for a cycle they never got.
 *
 * ★ ONE STATEMENT, so the caller learns what each invoice WAS before it closed:
 * the locking CTE reads the rows as they stand, and the UPDATE returns that
 * reading. Only `status` and `updated_at` change, which is what lets the
 * immutability guard (`billing_invoices_guard_immutable`) allow it inside the
 * caller's transaction: money, number, kind, cycle, issue date and parties stay
 * exactly as issued, and the parties snapshot fires only on an issue.
 *
 * ★ LOCK ORDER: every caller already holds the store's subscription row (the
 * cycle-turn batch, the downgrade pass's per-store transaction, deleteStore's
 * lock), and this then takes the invoice rows. Subscription first, invoices
 * second, everywhere, so two writers never wait on each other in a cycle.
 *
 * `issuedOnly` is deleteStore's: there a draft keeps its own handling (it is
 * deleted with the store unless a payment may have reached the gateway), so
 * only ISSUED invoices (`finalized_at is not null`) are closed.
 *
 * Not a "use server" file: it takes a store id and a cycle as arguments, the
 * shape that must never be a public endpoint.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";

/** One invoice this call closed, as it stood just before. */
export interface ClosedInvoice {
  id: string;
  /** `draft`, `open`, `processing` or `paid`: what the invoice was. */
  previousStatus: string;
  totalPaise: number;
  /** Null for a draft, which was never given a number. */
  invoiceRef: string | null;
}

/**
 * Close every subscription invoice for a cycle this store will not enter.
 *
 * Closes `draft`, `open`, `processing` and `paid`; `void` and `uncollectible`
 * are already final and are left as they are.
 *
 * Runs inside the caller's transaction; throws on a database error so the
 * caller's transaction (and the plan end it is part of) rolls back with it.
 */
export async function closeUnreachedInvoices(
  db: Db,
  input: {
    storeId: string;
    /** The last cycle the plan reached: the subscription's current cycle. */
    lastReachedSeq: number;
    now: Date;
    /** Close issued invoices only (deleteStore). */
    issuedOnly?: boolean;
  },
): Promise<ClosedInvoice[]> {
  const issued = input.issuedOnly ? sql`and i.finalized_at is not null` : sql``;
  const res = await db.execute(sql`
    with closing as (
      select i.id, i.status, i.total_paise, i.invoice_ref
        from public.billing_invoices i
       where i.store_id = ${input.storeId}
         and i.kind = 'subscription'
         and i.cycle_seq > ${input.lastReachedSeq}
         and i.status in ('draft', 'open', 'processing', 'paid')
         ${issued}
         for update
    )
    update public.billing_invoices i
       set status = 'void', updated_at = ${input.now.toISOString()}
      from closing c
     where i.id = c.id
    returning c.id, c.status as previous_status, c.total_paise, c.invoice_ref`);

  // ★ A bigint comes back from a raw query as TEXT, so the amount is converted
  // here rather than left for a caller to add as a string.
  return (res.rows ?? []).map((row) => {
    const r = row as {
      id: string;
      previous_status: string;
      total_paise: number | string;
      invoice_ref: string | null;
    };
    return {
      id: r.id,
      previousStatus: r.previous_status,
      totalPaise: Number(r.total_paise),
      invoiceRef: r.invoice_ref ?? null,
    };
  });
}
