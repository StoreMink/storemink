"use client";

/**
 * "You owe this" — the manual payment surface (§34).
 *
 * ★★ WITHOUT THIS THE NEW SYSTEM CANNOT COLLECT A RENEWAL AT ALL. Automatic
 * collection is gated behind `RECURRING_CHARGE_VERIFIED` (lib/billing/gateway.ts),
 * so every renewal invoice the worker writes is settled here or not at all — a
 * merchant with no way to pay is downgraded 48 hours later for a bill they never
 * saw. It stays a first-class path after the recurring charge lands, for amounts
 * over the ₹15,000 AFA-exempt limit and for merchants with no live mandate.
 *
 * ★ It renders NOTHING when nothing is owed. A permanent "no outstanding
 * invoices" panel is a bill-shaped thing on a page a merchant reads for
 * reassurance.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, CalendarClock, Loader2 } from "lucide-react";
import {
  confirmPayInvoice,
  startPayInvoice,
} from "@/app/actions/subscribe-actions";
// ★ The TYPE comes from the pure module, never from the "use server" file —
// every export of one of those is registered as a server action, and a type
// re-export fails the BUILD while typecheck passes. See invoice-types.ts.
import type { PayableInvoice } from "@/lib/billing/invoice-types";
import { openRazorpayModal } from "@/lib/payments/razorpay-client";
import {
  amountChanged,
  formatRupees,
  invoiceGstLine,
  istShortDate,
} from "@/lib/billing/tax-copy";
import { shouldOpenPayment } from "./amount-guard";

/**
 * An automatic renewal that is SCHEDULED: the bank's notice has gone out and
 * the debit follows a day or more later. Nothing is owed by hand meanwhile.
 */
function isScheduled(inv: PayableInvoice): boolean {
  return inv.status === "processing" && !!inv.autopayAt;
}

/** "1 Nov 2026 to 30 Nov 2026", in India time (GST design 7.3). */
function period(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  return `${istShortDate(from)} to ${istShortDate(to)}`;
}

export function OpenInvoices({
  invoices,
  canManage,
}: {
  invoices: PayableInvoice[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [paying, setPaying] = useState<string | null>(null);
  // ★ The amount guard's memory (design 7.4): when a start asked for a
  // different amount than the row showed, that amount is shown on the row and
  // is what the next press must match.
  const [askedPaise, setAskedPaise] = useState<Record<string, number>>({});

  if (invoices.length === 0) return null;

  async function pay(inv: PayableInvoice) {
    const invoiceId = inv.id;
    setPaying(invoiceId);
    const start = await startPayInvoice(invoiceId);
    if (!start.ok) {
      // ★ The server's sentence, word for word (renewal-cancel design 8.4).
      // It knows WHY: a cancelled plan's next invoice ("You've cancelled your
      // plan, so this invoice won't be charged..."), a closed one ("That
      // invoice is closed and can't be paid..."). A generic "couldn't pay"
      // would send the merchant to pay again for something they must not.
      toast.error(start.error);
      setPaying(null);
      // A refusal usually means this list is out of date (the plan was
      // cancelled or the invoice closed since the page loaded), and the
      // server's list leaves out what can no longer be paid.
      router.refresh();
      return;
    }
    // ★★ THE AMOUNT GUARD (design 7.4). The invoice is issued, so its total
    // cannot change, but account credit or a late change can still make the
    // start ask for something else: the window never asks for more (or less)
    // than this row showed. A mismatch shows the new amount and waits for
    // another press.
    const shown = askedPaise[invoiceId] ?? inv.totalPaise;
    if (!shouldOpenPayment(shown, start.amountPaise)) {
      setAskedPaise((prev) => ({ ...prev, [invoiceId]: start.amountPaise }));
      // The press named is this row's own button, "Pay now".
      toast.info(amountChanged(start.amountPaise, "pay_now"));
      setPaying(null);
      router.refresh();
      return;
    }
    const opened = await openRazorpayModal({
      keyId: start.keyId,
      rzpOrderId: start.providerOrderId,
      amountPaise: start.amountPaise,
      name: "StoreMink",
      description: start.invoiceRef
        ? `Invoice ${start.invoiceRef}`
        : "Subscription invoice",
      onSuccess: async (res) => {
        const done = await confirmPayInvoice(
          invoiceId,
          res.razorpay_payment_id,
          res.razorpay_signature,
        );
        setPaying(null);
        if (!done.ok) {
          // ★ Money may well have moved. Never report this as a failure — a
          // merchant told "payment failed" pays twice (§26's rule, same shape).
          // Shown as returned: for a payment that arrived after the plan
          // ended, the server says it is being refunded and when.
          toast.info(done.error);
        } else if (done.planRestored) {
          toast.success("Paid - your plan is active again.");
        } else {
          toast.success("Paid. Thank you!");
        }
        router.refresh();
      },
      onDismiss: () => {
        setPaying(null);
        toast.error("Payment wasn't completed.");
      },
    });
    if (!opened) {
      setPaying(null);
      toast.error("Couldn't open the payment window. Please try again.");
    }
  }

  // ★★ NOTHING TO PAY BY HAND WHEN EVERY INVOICE IS A SCHEDULED AUTOPAY
  // (21 Nov 2026). An automatic renewal now waits a day or more between its
  // bank notice and its debit, and the amber "You have an invoice to pay ...
  // your store moves to the Free plan" would alarm a merchant whose renewal is
  // going exactly to plan. The calm panel says what is true instead.
  const allScheduled = invoices.every(isScheduled);
  const owed = invoices.filter((inv) => !isScheduled(inv)).length;

  return (
    <section
      className={
        allScheduled
          ? "rounded-xl border border-[#e5e7eb] bg-white p-6"
          : "rounded-xl border border-amber-300 bg-amber-50 p-6"
      }
    >
      <div className="flex items-start gap-3">
        {allScheduled ? (
          <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" />
        ) : (
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        )}
        <div className="min-w-0 flex-1">
          <h2
            className={
              allScheduled
                ? "text-base font-semibold text-[#111827]"
                : "text-base font-semibold text-amber-900"
            }
          >
            {allScheduled
              ? "Your renewal is scheduled"
              : owed === 1
                ? "You have an invoice to pay"
                : `You have ${owed} invoices to pay`}
          </h2>
          <p
            className={
              allScheduled
                ? "mt-0.5 text-sm text-[#5b6472]"
                : "mt-0.5 text-sm text-amber-800"
            }
          >
            {allScheduled
              ? "Your saved payment method will be charged automatically. There is nothing you need to do."
              : "Unpaid by the due date, your store moves to the Free plan."}
          </p>

          <ul className="mt-4 space-y-2">
            {invoices.map((inv) => {
              const span = period(inv.periodStart, inv.periodEnd);
              // "Including ₹2,700 GST (18%)": the invoice's own figure, keyed
              // on the tax it carries, never on the rate alone.
              const gstLine = invoiceGstLine(inv.taxPaise, inv.taxRateBps);
              const asked = askedPaise[inv.id];
              const askedOther =
                asked !== undefined && asked !== inv.totalPaise;
              // `processing` means a payment is already with the gateway.
              // Offering "Pay" would open a second one against the same money.
              const inFlight = inv.status === "processing";
              const scheduled = isScheduled(inv);
              return (
                <li
                  key={inv.id}
                  className={
                    allScheduled
                      ? "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#e5e7eb] bg-white px-4 py-3"
                      : "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-white px-4 py-3"
                  }
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#111827]">
                      {formatRupees(inv.totalPaise)}
                      {inv.invoiceRef ? (
                        <span className="ml-2 font-mono text-xs font-normal text-[#5b6472]">
                          {inv.invoiceRef}
                        </span>
                      ) : null}
                    </div>
                    {gstLine && (
                      <div className="mt-0.5 text-xs text-[#5b6472]">
                        {gstLine}
                      </div>
                    )}
                    <div className="mt-0.5 text-xs text-[#5b6472]">
                      {span ? `Service period ${span}` : "Subscription"}
                      {inv.dueAt ? ` · due ${istShortDate(inv.dueAt)}` : null}
                    </div>
                    {askedOther && (
                      <div className="mt-1 text-xs font-medium text-amber-800">
                        {amountChanged(asked, "pay_now")}
                      </div>
                    )}
                  </div>
                  {scheduled && inv.autopayAt ? (
                    <span className="text-xs font-medium text-[#374151]">
                      Autopay on or after {istShortDate(inv.autopayAt)}
                    </span>
                  ) : inFlight ? (
                    <span className="text-xs font-medium text-amber-700">
                      Payment in progress…
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => pay(inv)}
                      disabled={!canManage || paying !== null}
                      className="inline-flex items-center gap-2 rounded-lg bg-[#111827] px-4 py-2 text-sm font-semibold text-white transition hover:bg-black disabled:opacity-50"
                      title={
                        canManage
                          ? undefined
                          : "Only an admin who can manage billing may pay this"
                      }
                    >
                      {paying === inv.id ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Opening…
                        </>
                      ) : (
                        "Pay now"
                      )}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
