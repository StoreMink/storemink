import "server-only";

/**
 * Did an EARLIER automatic debit of this invoice take the money after all?
 *
 * ★★ WHY (PR #303 review, 22 Nov 2026). Two things in the renewal code rested
 * on "a failed debit is final": the hourly reconcile fails an automatic
 * attempt at once when every payment on its order reads `failed`, freeing the
 * invoice for the next try, and the scan for payments on closed attempts read
 * manual checkouts only. Razorpay does not treat a failed payment as final. A
 * payment marked failed (a timeout, a slow bank answer) can be authorised
 * late by the bank, and with automatic capture on the order it is then
 * captured. So:
 *
 *   1. the debit of try 1 is sent, Razorpay reports it failed, the attempt is
 *      failed and the invoice goes back to `open`;
 *   2. hours later the bank authorises after all and the payment is captured;
 *   3. about a day later try 2 sends a new notice and debits again.
 *
 * The merchant has paid one renewal twice. Before the three automatic tries
 * existed an attempt was failed only after 72 hours and nothing followed it,
 * so a second debit could not happen.
 *
 * The rule this module holds: BEFORE ANOTHER PAYMENT IS TAKEN FOR AN INVOICE,
 * EVERY EARLIER DEBIT THAT WAS SENT FOR IT IS ASKED ABOUT AGAIN. It is called
 * where a new automatic try starts (renewal-worker.ts), just before a
 * notified debit is sent (debit-pass.ts, a day or more after its try
 * started), and where the merchant pays by hand (manual-pay.ts).
 *
 * ★ Only attempts whose debit WAS sent are read: nothing but our own server
 *   call can pay a recurring order, so an attempt that ended before its debit
 *   cannot hold money. An invoice with no such attempt costs no gateway call,
 *   which is every first try.
 * ★ A captured payment is filed for a person (`fileClosedAttemptPayment`),
 *   once, and is never applied or refunded here: the attempt it landed on is
 *   closed, and a closed attempt is never reopened.
 * ★ FAILS CLOSED. A gateway that cannot be read is `unknown`, and a payment
 *   that is neither failed nor captured (authorised, still being created) is
 *   `unsettled`: neither is "nothing was paid", and the caller does not debit.
 */

import { and, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { billingPaymentAttempts } from "@/drizzle/schema";
import { logError, logWarn } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  capturedPayment,
  rzpFetchOrderPayments,
} from "@/lib/payments/razorpay";
import {
  CLOSED_CHECKOUT_PAID_KEY_PREFIX,
  fileClosedAttemptPayment,
} from "./collect";

export type EarlierDebits =
  /** No earlier debit was sent, or every payment on each reads failed. */
  | "clear"
  /** An earlier debit was captured: the money is held, and a person has it. */
  | "paid"
  /** A payment on an earlier debit is neither failed nor captured yet. */
  | "unsettled"
  /** It could not be read. Never "clear". */
  | "unknown";

/** The most earlier debits one invoice can have and still be read here. The
 *  backstop allows six starts (`AUTO_COLLECT_MAX_STARTS`). */
const EARLIER_DEBITS_READ = 12;

export interface EarlierDebitsDeps {
  /** Injected so tests need no gateway. */
  fetchOrderPayments?: typeof rzpFetchOrderPayments;
  creds?: ReturnType<typeof getPlatformRazorpayCreds>;
}

/**
 * The state of the invoice's earlier, closed automatic debits at the gateway.
 * `exceptAttemptId` leaves out the attempt the caller is about to debit.
 */
export async function earlierDebitsOf(
  input: {
    invoiceId: string;
    storeId: string | null;
    exceptAttemptId?: string | null;
    /** Which path asked, for the reconciliation item it may file. */
    source: "collect" | "debit" | "manual";
    now: Date;
  },
  deps: EarlierDebitsDeps = {},
): Promise<EarlierDebits> {
  let rows: {
    id: string;
    providerOrderId: string | null;
    amountPaise: number;
    state: string;
    failureCode: string | null;
  }[];
  try {
    rows = await withService((db) =>
      db
        .select({
          id: billingPaymentAttempts.id,
          providerOrderId: billingPaymentAttempts.providerOrderId,
          amountPaise: billingPaymentAttempts.amountPaise,
          state: billingPaymentAttempts.state,
          failureCode: billingPaymentAttempts.failureCode,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, input.invoiceId),
            eq(billingPaymentAttempts.mode, "automatic"),
            inArray(billingPaymentAttempts.state, ["failed", "cancelled"]),
            isNotNull(billingPaymentAttempts.providerOrderId),
            // A debit was sent on it: the only way a recurring order is paid.
            or(
              isNotNull(billingPaymentAttempts.debitSentAt),
              isNotNull(billingPaymentAttempts.providerPaymentId),
            ),
            input.exceptAttemptId
              ? ne(billingPaymentAttempts.id, input.exceptAttemptId)
              : undefined,
          ),
        )
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(EARLIER_DEBITS_READ),
    );
  } catch (err) {
    logError("billing.earlier_debits.read", err, {
      invoiceId: input.invoiceId,
    });
    return "unknown";
  }
  if (rows.length === 0) return "clear";

  const creds =
    deps.creds === undefined ? getPlatformRazorpayCreds() : deps.creds;
  const fetchPayments = deps.fetchOrderPayments ?? rzpFetchOrderPayments;
  if (!creds) return "unknown";

  let worst: EarlierDebits = "clear";
  const worse = (state: EarlierDebits) => {
    const rank = { clear: 0, unknown: 1, unsettled: 2, paid: 3 } as const;
    if (rank[state] > rank[worst]) worst = state;
  };
  for (const row of rows) {
    try {
      const res = await fetchPayments(creds, row.providerOrderId!);
      if (!res.ok) {
        worse("unknown");
        continue;
      }
      const paid = capturedPayment(res.data);
      if (paid) {
        worse("paid");
        await fileClosedAttemptPayment({
          storeId: input.storeId,
          invoiceId: input.invoiceId,
          attemptId: row.id,
          providerPaymentId: paid.id,
          providerOrderId: row.providerOrderId,
          expectedPaise: row.amountPaise,
          observedPaise: typeof paid.amount === "number" ? paid.amount : null,
          closedAs: row.state,
          closedCode: row.failureCode,
          automatic: true,
          source: input.source,
          now: input.now,
        });
        continue;
      }
      if (res.data.some((payment) => payment.status !== "failed")) {
        worse("unsettled");
      }
    } catch (err) {
      logError("billing.earlier_debits.one", err, { attemptId: row.id });
      worse("unknown");
    }
  }
  if (worst !== "clear") {
    logWarn("billing.earlier_debits.held", {
      storeId: input.storeId,
      invoiceId: input.invoiceId,
      state: worst,
      source: input.source,
    });
  }
  return worst;
}

/**
 * Is this store's unpaid renewal one StoreMink is already HOLDING the money
 * for? True when the invoice of the cycle the store is entering is still
 * open and a payment for exactly what it owes sits, unresolved, in the
 * reconciliation queue as captured on a closed attempt.
 *
 * ★★ WHY (PR #303 fifth review, 22 Nov 2026). A renewal debit recorded as
 * failed and captured later is filed for a person, and every further debit
 * and Pay now is held (above). But the invoice stayed open, grace ran out
 * after 48 hours, and the store was downgraded to Free, its POS and paid
 * features gone, while its payment for that very invoice sat in the queue:
 * for example over a weekend nobody worked it. `downgradeExpired` asks this
 * first and leaves such a store exactly as it is.
 *
 * ★ EXACT AMOUNT ONLY. A payment for another amount (the amount due changed
 *   after its checkout was opened) does not settle the invoice, so it holds
 *   nothing: the item is still for a person, and grace runs as it would.
 *   The payment's amount is the gateway's own when it was read
 *   (`observed_paise`), else the closed attempt's, which is what its order
 *   was created for.
 * ★ ONLY WHILE THE ITEM IS UNRESOLVED (`open` or `manual_review`). A person
 *   who closes it has decided: they settled the invoice (it is paid, and the
 *   cycle advances) or refunded the payment (it is unpaid, and the next run
 *   downgrades as for any unpaid renewal).
 * ★ NULL WHEN IT COULD NOT BE READ, which the caller treats as "do not
 *   downgrade this run": taking a plan away is not done on a failed read.
 */
export async function renewalPaymentHeld(
  storeId: string,
  currentCycleSeq: number,
): Promise<boolean | null> {
  try {
    return await withService(async (db) => {
      const result = await db.execute(sql`
        select 1
          from public.billing_invoices i
          join public.billing_reconciliation_items r on r.invoice_id = i.id
         where i.store_id = ${storeId}::uuid
           and i.kind = 'subscription'
           and i.cycle_seq = ${currentCycleSeq + 1}
           and i.status = 'open'
           and r.status in ('open', 'manual_review')
           and r.detail ->> 'repair_key' like ${`${CLOSED_CHECKOUT_PAID_KEY_PREFIX}%`}
           and coalesce(r.observed_paise, r.expected_paise) = greatest(
                 0,
                 i.total_paise - least(
                   i.total_paise,
                   abs(coalesce((
                     select sum(c.delta_paise)
                       from public.billing_credits c
                      where c.invoice_id = i.id and c.kind = 'applied'
                   ), 0))
                 )
               )
         limit 1`);
      return result.rows.length > 0;
    });
  } catch (err) {
    logError("billing.renewal_payment_held.read", err, { storeId });
    return null;
  }
}
