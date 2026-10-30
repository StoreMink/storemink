"use client";

// Buying and releasing metered extra locations (roadmap Step 5).
//
// The whole card is a statement of ONE number — how many shops this store may
// have — and the two ways to move it. It replaces the "coming soon" line that
// used to sit under the header, which was the only thing standing between a
// merchant and a third location they wanted to pay for.
//
// ★★ GST (design 7.5, GST Stage 16). Every figure comes from the invoice that
// would carry it: the summary, the button and the confirmation are the
// tax-copy sentences over `perPeriod`, `nextPurchase` and `nextRenewal`, read
// under the same terms as the charge. When the store's state is needed, or
// the business is outside India, the state picker or the outside-India
// sentence takes the Pay button's place. And `buy()` runs the amount guard
// (design 7.4): the payment window opens only when the start asks for exactly
// the amount the confirmation showed; otherwise the new amount is shown and
// the merchant presses Pay again.
//
// The GST fields are all present or all absent (`LocationBillingState`); a
// state without them (buying blocked before the tax reading, settings
// incomplete, or an older server) keeps the card's earlier words.

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, Loader2, MinusCircle, PlusCircle } from "lucide-react";
import {
  confirmBuyLocations,
  releaseExtraLocations,
  startBuyLocations,
} from "@/app/actions/subscribe-actions";
// ★ The TYPE comes from the pure module — a type re-export from a "use server"
// file fails the build (see lib/billing/invoice-types.ts).
import type { LocationBillingState } from "@/lib/billing/invoice-types";
import type { TaxTerms } from "@/lib/billing/tax-terms";
import {
  CHECKOUT,
  addLocationButton,
  addLocationConfirm,
  amountChanged,
  locationsExtraSummary,
} from "@/lib/billing/tax-copy";
import { openRazorpayModal } from "@/lib/payments/razorpay-client";
import { shouldOpenPayment } from "@/app/dashboard/plans/amount-guard";
import { StatePrompt } from "@/app/dashboard/plans/billing-details-card";

/** A state that carries the GST figures (design 7.5). */
type GstLocationBilling = Extract<LocationBillingState, { terms: TaxTerms }>;

/** The GST figures, or null when the reader left them out. */
function gstFigures(state: LocationBillingState): GstLocationBilling | null {
  return state.terms ? (state as GstLocationBilling) : null;
}

/** What the card says, and the amount its Pay button shows. */
export interface LocationCardCopy {
  /** "2 extra at ₹1,000/month each", after "N included with your plan · ". */
  extraSummary: string;
  /** The Add button's label. */
  addButton: string;
  /** The confirmation, and its button ("Pay ₹472", or "Add location"). */
  confirm: { text: string; confirmLabel: string };
  /**
   * The amount the confirmation shows as due now, in paise, or null when
   * nothing is due now: what the amount guard compares the start against.
   */
  shownPaise: number | null;
  /** What takes the Pay button's place, or null for the button itself. */
  gate: "outside_india" | "needs_state" | null;
}

/**
 * The card's words by GST state (design 7.5), all from tax-copy.ts.
 *
 * ★ Every "from your next renewal" figure is `nextRenewal.perLocation`'s own
 * total. ★★ With no renewal figure (the plan is cancelling, the next plan has
 * no POS, or the renewal could not be read) nothing stands in for it: the
 * confirmation names no renewal at all (R2-04). Today's price in its place
 * promised a charge that would not happen, or one short of its GST.
 */
export function locationCardCopy(
  state: LocationBillingState,
): LocationCardCopy {
  const gst = gstFigures(state);
  if (gst) {
    const listPaise = gst.perPeriod.listedPaise;
    const now = gst.nextPurchase;
    return {
      extraSummary: locationsExtraSummary(
        gst.terms,
        state.billed,
        listPaise,
        state.period,
      ),
      addButton: addLocationButton(gst.terms, listPaise, state.period),
      confirm: addLocationConfirm({
        terms: gst.terms,
        period: state.period,
        perLocation: gst.perPeriod,
        nextPurchase: now,
        nextRenewal: gst.nextRenewal?.perLocation ?? null,
      }),
      shownPaise: now && now.totalPaise > 0 ? now.totalPaise : null,
      gate: gst.outsideIndia
        ? "outside_india"
        : gst.needsState
          ? "needs_state"
          : null,
    };
  }

  // The card's earlier words, for a state with no GST figures.
  const each = state.period === "yearly" ? "year" : "month";
  const price = state.pricePerPeriodInr.toLocaleString("en-IN");
  const nowInr = state.nextPurchaseInr;
  return {
    extraSummary: `${state.billed} extra at ₹${price}/${each} each`,
    addButton: `Add a location · ₹${price}/${each}`,
    confirm:
      nowInr > 0
        ? {
            text: `Add a location for ₹${price}/${each}. You'll pay ₹${nowInr.toLocaleString("en-IN")} now for the rest of this cycle, then ₹${price}/${each} from your next renewal.`,
            confirmLabel: `Pay ₹${nowInr.toLocaleString("en-IN")}`,
          }
        : {
            text: `Add a location for ₹${price}/${each}, billed from your next renewal.`,
            confirmLabel: "Add location",
          },
    shownPaise: nowInr > 0 ? Math.round(nowInr * 100) : null,
    gate: null,
  };
}

/** For someone who manages locations but not billing (R2-10). */
export const LOCATIONS_BILLING_STAFF_ONLY =
  "Only someone who manages billing can add or release paid locations.";

export function LocationBillingCard({
  state,
  canManage,
  canPay,
}: {
  state: LocationBillingState;
  canManage: boolean;
  /**
   * Billing permission (`ai` manage, the Plans page's key): buying, releasing
   * and the state prompt are all refused by the server without it, so none is
   * offered (R2-10).
   */
  canPay: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirmingRaw] = useState<null | "buy" | "release">(
    null,
  );
  // The amount a start asked for after the guard stopped it: the next press
  // must match THIS, the figure the merchant was just told.
  const [askedPaise, setAskedPaise] = useState<number | null>(null);
  const copy = locationCardCopy(state);

  // Opening or closing a confirmation starts the guard afresh.
  const setConfirming = (next: null | "buy" | "release") => {
    setAskedPaise(null);
    setConfirmingRaw(next);
  };

  // ★ BUYING TAKES A PAYMENT; RELEASING DOES NOT. Two different flows, because
  // they are two different acts — the part period is charged on session, while a
  // release only books a change for the end of the cycle already paid for.
  const buy = (next: number) => {
    start(async () => {
      const startRes = await startBuyLocations(next);
      if (!startRes.ok) {
        setConfirming(null);
        // Not an error when the part period rounded to nothing: the location was
        // granted and it says so. Nor when an earlier payment went through and
        // the locations are added shortly (`waiting`, RC-F1b): a notice, with
        // nothing to pay again.
        toast.info(startRes.error);
        router.refresh();
        return;
      }
      if (startRes.completedEarlier) {
        // ★ An earlier, already paid purchase was finished instead of opening a
        // second payment (RC-F1b): the locations are added, a success.
        setConfirming(null);
        toast.success(startRes.message);
        router.refresh();
        return;
      }
      // ★★ THE AMOUNT GUARD (design 7.4). The window never asks for more (or
      // less) than the confirmation showed: on a difference the new amount is
      // shown, the card is read again, and the merchant presses Pay again.
      const shown = askedPaise ?? copy.shownPaise;
      if (!shouldOpenPayment(shown, startRes.amountPaise)) {
        setAskedPaise(startRes.amountPaise);
        toast.info(amountChanged(startRes.amountPaise, "pay"));
        router.refresh();
        return;
      }
      const opened = await openRazorpayModal({
        keyId: startRes.keyId,
        rzpOrderId: startRes.providerOrderId,
        amountPaise: startRes.amountPaise,
        name: "StoreMink",
        description: `Extra location · part period`,
        onSuccess: async (res) => {
          const done = await confirmBuyLocations(
            startRes.invoiceId,
            res.razorpay_payment_id,
            res.razorpay_signature,
          );
          setConfirming(null);
          if (!done.ok) {
            // ★ Money may have moved. Never "failed" — the server's wording says
            // not to pay again (§26's rule).
            toast.info(done.error);
          } else {
            toast.success("Location added.");
          }
          router.refresh();
        },
        onDismiss: () => {
          setConfirming(null);
          toast.error("Payment wasn't completed.");
        },
      });
      if (!opened) {
        setConfirming(null);
        toast.error("Couldn't open the payment window. Please try again.");
      }
    });
  };

  const release = (next: number) => {
    start(async () => {
      const res = await releaseExtraLocations(next);
      setConfirming(null);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // The message says WHEN it takes effect, which is what a merchant most
      // needs to read.
      toast.success(res.message);
      router.refresh();
    });
  };

  return (
    <div className="mt-4 max-w-3xl rounded-xl border border-[#e5e5e5] bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Building2
            className="mt-0.5 h-4 w-4 shrink-0 text-[#9aa1ab]"
            strokeWidth={2}
          />
          <div>
            <p className="text-sm font-medium text-[#111827]">
              {state.existing} of {state.allowance} location
              {state.allowance === 1 ? "" : "s"} used
            </p>
            <p className="mt-0.5 text-xs text-[#6b7280]">
              {state.included} included with your plan
              {state.billed > 0 && (
                <>
                  {" · "}
                  {copy.extraSummary}
                </>
              )}
            </p>
            {/* A booked release, so the merchant is not left wondering whether
                it registered. */}
            {state.scheduled !== null && (
              <p className="mt-1 text-xs text-[#b45309]">
                Dropping to {state.scheduled} extra at the end of this cycle.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Why the controls are absent, when they are. A disabled button with no
          explanation is the thing merchants open a support ticket about. */}
      {!state.canBuy && (
        <p className="mt-3 rounded-lg bg-[#f9fafb] px-3 py-2 text-xs text-[#6b7280]">
          {state.blockedReason}
        </p>
      )}

      {canManage && state.canBuy && !canPay && (
        <p className="mt-3 rounded-lg bg-[#f9fafb] px-3 py-2 text-xs text-[#6b7280]">
          {LOCATIONS_BILLING_STAFF_ONLY}
        </p>
      )}

      {canManage && canPay && state.canBuy && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {confirming === "buy" ? (
            <ConfirmRow
              text={copy.confirm.text}
              confirmLabel={copy.confirm.confirmLabel}
              note={
                askedPaise !== null && askedPaise !== copy.shownPaise
                  ? amountChanged(askedPaise, "pay")
                  : null
              }
              gate={
                copy.gate === "outside_india" ? (
                  <p className="rounded-lg bg-[#f9fafb] px-3 py-2 text-xs text-[#6b7280]">
                    {CHECKOUT.outsideIndia}
                  </p>
                ) : copy.gate === "needs_state" ? (
                  <StatePrompt
                    onSaved={() => router.refresh()}
                    disabled={pending}
                  />
                ) : null
              }
              pending={pending}
              onCancel={() => setConfirming(null)}
              onConfirm={() => buy(state.billed + 1)}
            />
          ) : confirming === "release" ? (
            <ConfirmRow
              text="Stop paying for one unused location? You keep it until the end of this billing cycle."
              confirmLabel="Release"
              pending={pending}
              onCancel={() => setConfirming(null)}
              onConfirm={() => release(state.billed - 1)}
            />
          ) : (
            <>
              <button
                type="button"
                onClick={() => setConfirming("buy")}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm font-medium text-[#111827] transition-colors hover:bg-[#111827]/[0.03] disabled:opacity-50"
              >
                <PlusCircle className="h-4 w-4" strokeWidth={2} />
                {copy.addButton}
              </button>

              {/* Only when something is actually unused. Offering "release" to
                  someone using every shop they pay for is offering an action
                  that can only be refused. */}
              {state.releasable > 0 && (
                <button
                  type="button"
                  onClick={() => setConfirming("release")}
                  disabled={pending}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-[#6b7280] transition-colors hover:bg-[#111827]/[0.03] disabled:opacity-50"
                >
                  <MinusCircle className="h-4 w-4" strokeWidth={2} />
                  Release {state.releasable} unused
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ConfirmRow({
  text,
  confirmLabel,
  note = null,
  gate = null,
  pending,
  onCancel,
  onConfirm,
}: {
  text: string;
  confirmLabel: string;
  /** The amount guard's line, when a start asked for another amount. */
  note?: string | null;
  /** Shown in place of the confirm button (the state picker, or why a
   *  payment cannot be taken). */
  gate?: ReactNode;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="w-full">
      {/* The price and the timing are stated HERE, at the point of no return,
          not only on the button that opened this. */}
      <p className="text-xs text-[#6b7280]">{text}</p>
      {note && (
        <p className="mt-1 text-xs font-medium text-amber-800">{note}</p>
      )}
      {gate && <div className="mt-2">{gate}</div>}
      <div className="mt-2 flex items-center gap-2">
        {!gate && (
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-lg bg-[#111827] px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-lg px-3 py-2 text-sm font-medium text-[#6b7280] transition-colors hover:bg-[#111827]/[0.03] disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
