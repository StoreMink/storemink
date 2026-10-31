"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  cancelPlanAtCycleEnd,
  endPlanNow,
  issueRefund,
  listStoreBilling,
  undoPlanCancellation,
  type EndNowPreview,
  type EndPlanNowResult,
  type EndPlanReason,
  type StoreBilling,
  type StoreBillingInvoice,
  type StoreBillingSubscription,
} from "@/app/actions/platform-billing";
// Types only: the module is server-only, and a type import is erased.
import type { RefundReason } from "@/lib/billing/refunds";
import {
  REFUND_DONE_TOAST,
  REFUND_REASON_LABEL,
  REFUND_STATUS_LABEL,
  REQUEST_FAILED_MESSAGE,
  consoleCreditNoteHref,
  fmtDate,
  fmtDateTime,
  inr,
  reasonLabel,
  rupeesField,
} from "../../billing/refunds/refunds-table";

// ---------------------------------------------------------------------------
// The store page's billing tools (renewal-cancel, design 7.3).
//
// ★ A MEMBER READS, A SUPERADMIN ACTS. The cancelling line and the refunds
// list are for everyone who can open the page; the four buttons render only
// for a superadmin, and every action checks again on the server.
//
// ★★ THE ACTION'S SENTENCE IS THE ONE SHOWN, with one exception:
// cancelling and undoing reuse the merchant's own cancellation code, whose
// refusals speak to the merchant ("You don't have an active subscription."),
// so `frameMerchantError` turns those few into the operator's voice. Any
// other refusal is shown word for word.
// ---------------------------------------------------------------------------

const PRIMARY = "dash-btn dash-btn-primary pointer-coarse:min-h-11";
const GHOST = "dash-btn dash-btn-ghost pointer-coarse:min-h-11";
const LABEL = "mb-1 block text-sm font-medium text-[var(--dash-text)]";
const HINT = "text-xs text-[var(--dash-text-2)]";
const ERROR = "text-sm text-[var(--dash-red)]";
const NOTICE =
  "rounded-[var(--dash-radius-sm)] bg-[var(--dash-surface-2)] px-3 py-2 text-sm text-[var(--dash-text)]";

/** The merchant-voice refusals of the cancellation code, said to an operator. */
const MERCHANT_TO_OPERATOR: Record<string, string> = {
  "Couldn't read your subscription. Try again.":
    "Couldn't read this store's subscription. Try again.",
  "You don't have an active subscription.":
    "This store has no active subscription.",
  "Your subscription is already cancelling.":
    "This store's plan is already cancelling.",
  "Couldn't cancel your subscription. Try again.":
    "Couldn't cancel this store's plan. Try again.",
  "Couldn't resume your subscription. Try again.":
    "Couldn't undo the cancellation. Try again.",
  "That subscription can't be resumed. Subscribe again to start a new cycle.":
    "This plan can't be resumed. The merchant has to subscribe again to start a new cycle.",
};

export function frameMerchantError(message: string): string {
  return MERCHANT_TO_OPERATOR[message] ?? message;
}

/** Today in India, as a date field holds it ("2026-10-29"). */
function todayInIndia(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** "Cancelling at the end of the cycle, asked by the merchant on 28 Oct 2026." */
export function cancellingLine(sub: StoreBillingSubscription): string {
  const who =
    sub.cancelRequestedBy?.kind === "operator"
      ? (sub.cancelRequestedBy.email ?? "an operator")
      : "the merchant";
  const when = sub.cancelRequestedAt
    ? ` on ${fmtDate(sub.cancelRequestedAt)}`
    : "";
  return `Cancelling at the end of the cycle, asked by ${who}${when}.`;
}

// ── Issue a refund ──────────────────────────────────────────────────────────

/** One invoice the Issue a refund dialog can refund. */
export interface IssueRefundTarget {
  invoiceId: string;
  invoiceRef: string | null;
  /** "{ref} · {period} · {amount} · {refunded so far}". */
  label: string;
  /** What is left to refund on it; null when the caller does not know. */
  leftPaise: number | null;
  /** What one day of the period costs; null without a period. */
  perDayPaise: number | null;
  /** Whether "Plan ended before this cycle" may be offered. */
  cycleNotReachedFits: boolean;
  /** Its payments with something left, the one with the most first. */
  payments: { attemptId: string; label: string; leftPaise: number }[];
}

function periodWords(start: string | null, end: string | null): string {
  if (!start || !end) return "no period";
  return `${fmtDate(start)} to ${fmtDate(end)}`;
}

/** The dialog's view of one of the store's invoices. */
export function issueTargetFromInvoice(
  inv: StoreBillingInvoice,
): IssueRefundTarget {
  const refunded =
    inv.inProgressPaise > 0
      ? `${inr(inv.refundedPaise)} refunded so far, ${inr(inv.inProgressPaise)} in progress`
      : `${inr(inv.refundedPaise)} refunded so far`;
  let perDayPaise: number | null = null;
  if (inv.periodStart && inv.periodEnd) {
    const days = Math.round(
      (Date.parse(inv.periodEnd) - Date.parse(inv.periodStart)) / 86_400_000,
    );
    if (days > 0) perDayPaise = Math.round(inv.totalPaise / days);
  }
  return {
    invoiceId: inv.id,
    invoiceRef: inv.invoiceRef,
    label: `${inv.invoiceRef ?? "Invoice"} · ${periodWords(inv.periodStart, inv.periodEnd)} · ${inr(inv.totalPaise)} · ${refunded}`,
    leftPaise: inv.leftPaise,
    perDayPaise,
    cycleNotReachedFits: inv.cycleNotReachedFits,
    payments: inv.payments
      .filter((p) => p.leftPaise > 0)
      .map((p) => ({
        attemptId: p.attemptId,
        label: `${p.providerPaymentId ?? "Payment"} · ${inr(p.leftPaise)} left`,
        leftPaise: p.leftPaise,
      })),
  };
}

const ISSUE_REASONS: RefundReason[] = [
  "cycle_not_reached",
  "feature_removed",
  "suspended_by_mistake",
  "declined_terms",
  "duplicate_payment",
  "goodwill",
  "other",
];

/**
 * "Issue a refund" (design 7.3): one refund of one payment, written owed and
 * sent at once. Also opened from a reconciliation item (design 7.4), where a
 * deleted store passes `storeId: null`.
 */
export function IssueRefundDialog({
  storeId,
  targets,
  initialInvoiceId,
  initialReason,
  onClose,
  onDone,
}: {
  storeId: string | null;
  targets: IssueRefundTarget[];
  initialInvoiceId?: string | null;
  initialReason?: RefundReason | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const first =
    targets.find((t) => t.invoiceId === initialInvoiceId) ?? targets[0];
  const [invoiceId, setInvoiceId] = useState(first?.invoiceId ?? "");
  const target = targets.find((t) => t.invoiceId === invoiceId) ?? first;
  const [attemptId, setAttemptId] = useState(
    first?.payments[0]?.attemptId ?? "",
  );
  const startLeft = first?.payments[0]?.leftPaise ?? first?.leftPaise ?? 0;
  const [amount, setAmount] = useState(rupeesField(startLeft));
  const [reason, setReason] = useState<RefundReason | "">(
    initialReason &&
      (initialReason !== "cycle_not_reached" || first?.cycleNotReachedFits)
      ? initialReason
      : "",
  );
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const reasons = ISSUE_REASONS.filter(
    (r) => r !== "cycle_not_reached" || target?.cycleNotReachedFits,
  );

  function pickInvoice(id: string) {
    setInvoiceId(id);
    const next = targets.find((t) => t.invoiceId === id);
    const pay = next?.payments[0];
    setAttemptId(pay?.attemptId ?? "");
    setAmount(rupeesField(pay?.leftPaise ?? next?.leftPaise ?? 0));
    if (reason === "cycle_not_reached" && !next?.cycleNotReachedFits) {
      setReason("");
    }
  }

  function pickPayment(id: string) {
    setAttemptId(id);
    const pay = target?.payments.find((p) => p.attemptId === id);
    if (pay) setAmount(rupeesField(pay.leftPaise));
  }

  function submit() {
    if (!target || !reason) return;
    setError(null);
    start(async () => {
      try {
        const res = await issueRefund({
          storeId,
          invoiceId: target.invoiceId,
          attemptId: attemptId || null,
          amountInr: amount,
          reason,
          note,
        });
        if ("error" in res) {
          setError(res.error);
          return;
        }
        toast.success(REFUND_DONE_TOAST[res.status] ?? "Done.");
        onClose();
        onDone();
      } catch {
        setError(REQUEST_FAILED_MESSAGE);
      }
    });
  }

  const blocked = !target
    ? "There is no paid invoice to refund."
    : !reason
      ? "Choose a reason first."
      : null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Issue a refund</DialogTitle>
          <DialogDescription>
            The money goes back to the payment this invoice was paid with. The
            merchant gets a credit note and an email once Razorpay confirms it.
          </DialogDescription>
        </DialogHeader>

        <label className="block">
          <span className={LABEL}>Invoice</span>
          <select
            className="dash-input w-full"
            value={invoiceId}
            onChange={(e) => pickInvoice(e.target.value)}
            disabled={pending || targets.length < 2}
          >
            {targets.map((t) => (
              <option key={t.invoiceId} value={t.invoiceId}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        {target && target.payments.length > 1 ? (
          <label className="block">
            <span className={LABEL}>Payment</span>
            <select
              className="dash-input w-full"
              value={attemptId}
              onChange={(e) => pickPayment(e.target.value)}
              disabled={pending}
            >
              {target.payments.map((p) => (
                <option key={p.attemptId} value={p.attemptId}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="block">
          <span className={LABEL}>Amount (₹)</span>
          <input
            className="dash-input w-40"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={pending}
          />
        </label>
        {target?.perDayPaise ? (
          <p className={`-mt-2 ${HINT}`}>
            This cycle costs {inr(target.perDayPaise)} a day.
          </p>
        ) : null}

        <label className="block">
          <span className={LABEL}>Reason</span>
          <select
            className="dash-input w-full"
            value={reason}
            onChange={(e) => setReason(e.target.value as RefundReason | "")}
            disabled={pending}
          >
            <option value="">Choose a reason</option>
            {reasons.map((r) => (
              <option key={r} value={r}>
                {REFUND_REASON_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        {reason === "duplicate_payment" ? (
          <p className={NOTICE}>
            No credit note is issued: this returns an extra payment, not part of
            the invoice. The invoice stays Paid.
          </p>
        ) : null}

        <label className="block">
          <span className={LABEL}>Note</span>
          <textarea
            className="dash-input w-full"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pending}
          />
        </label>

        {error ? (
          <p role="alert" className={ERROR}>
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className={GHOST}
          >
            Close
          </button>
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              onClick={submit}
              disabled={pending || !!blocked}
              className={PRIMARY}
            >
              {pending ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : null}
              Send refund
            </button>
            {blocked ? <span className={HINT}>{blocked}</span> : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Cancel and undo ─────────────────────────────────────────────────────────

function PlanNoteDialog({
  title,
  description,
  label,
  confirmLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  description: string;
  label: string;
  confirmLabel: string;
  onSubmit: (note: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      try {
        const refusal = await onSubmit(note);
        if (refusal) {
          setError(refusal);
          return;
        }
        onClose();
      } catch {
        setError(REQUEST_FAILED_MESSAGE);
      }
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <label className="block">
          <span className={LABEL}>{label}</span>
          <textarea
            className="dash-input w-full"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pending}
          />
        </label>
        {error ? (
          <p role="alert" className={ERROR}>
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className={GHOST}
          >
            Close
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className={PRIMARY}
          >
            {pending ? (
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            ) : null}
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── End the plan now ────────────────────────────────────────────────────────

const END_REASONS: { key: EndPlanReason; label: string }[] = [
  { key: "declined_terms", label: "Declined new Terms" },
  { key: "feature_removed", label: "Main feature removed" },
  { key: "other", label: "Other" },
];

type EndOutcome = Extract<EndPlanNowResult, { success: true }>;

function EndPlanDialog({
  storeId,
  storeName,
  planName,
  initialPreview,
  onClose,
  onDone,
}: {
  storeId: string;
  storeName: string;
  planName: string;
  initialPreview: EndNowPreview | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState<EndPlanReason | "">("");
  const [initialFrom] = useState(todayInIndia);
  const [from, setFrom] = useState(initialFrom);
  const [refundUnused, setRefundUnused] = useState(true);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<EndNowPreview | null>(initialPreview);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<EndOutcome | null>(null);
  const [pending, start] = useTransition();
  const asked = useRef(0);

  // The preview is the server's own count for this date and reason, so the
  // figure on the checkbox is the figure `endPlanNow` will refund.
  useEffect(() => {
    // The page's own preview already counts from today: ask again only once
    // the date or the reason has moved.
    if (from === initialFrom && reason === "" && asked.current === 0) return;
    const ticket = ++asked.current;
    let live = true;
    const timer = setTimeout(() => {
      setChecking(true);
      listStoreBilling(storeId, { refundFrom: from || null, reason })
        .then((billing) => {
          if (!live || ticket !== asked.current) return;
          setPreview(billing?.endNow ?? null);
        })
        .catch(() => {
          if (!live || ticket !== asked.current) return;
          setPreview({
            from: null,
            lines: [],
            totalPaise: 0,
            error: REQUEST_FAILED_MESSAGE,
          });
        })
        .finally(() => {
          if (live && ticket === asked.current) setChecking(false);
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [storeId, from, reason, initialFrom]);

  const lines = preview?.lines ?? [];
  const firstRefunded = lines.find((l) => l.amountPaise > 0);
  const canRefund = (preview?.totalPaise ?? 0) > 0;

  function submit() {
    if (!reason) return;
    setError(null);
    start(async () => {
      try {
        const res = await endPlanNow({
          storeId,
          reason,
          refundUnused: refundUnused && canRefund,
          refundFrom: from || null,
          note,
        });
        if ("error" in res) {
          setError(res.error);
          return;
        }
        setOutcome(res);
        onDone();
      } catch {
        setError(REQUEST_FAILED_MESSAGE);
      }
    });
  }

  const blocked = !reason
    ? "Choose a reason first."
    : preview?.error
      ? preview.error
      : null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            End {storeName}&apos;s {planName} plan now?
          </DialogTitle>
          <DialogDescription>
            The store moves to the Free plan at once and any open POS shift is
            closed. Use this only when the merchant asks us to end their plan.
          </DialogDescription>
        </DialogHeader>

        {outcome ? (
          <div className="space-y-2 text-sm text-[var(--dash-text)]">
            <p className="font-medium">The plan has ended.</p>
            {outcome.refunds.length === 0 && outcome.skipped.length === 0 ? (
              <p className={HINT}>Nothing was refunded.</p>
            ) : (
              <ul className="space-y-1">
                {outcome.refunds.map((r, i) => (
                  <li key={`r-${i}`}>
                    {r.invoiceRef ?? "Invoice"}: {inr(r.amountPaise)},{" "}
                    {r.error ? (
                      <span className="text-[var(--dash-red)]">{r.error}</span>
                    ) : r.status ? (
                      REFUND_STATUS_LABEL[r.status]
                    ) : (
                      "Not sent"
                    )}
                  </li>
                ))}
                {outcome.skipped.map((s, i) => (
                  <li key={`s-${i}`} className={HINT}>
                    {s.why}
                  </li>
                ))}
              </ul>
            )}
            <DialogFooter>
              <button type="button" onClick={onClose} className={PRIMARY}>
                Done
              </button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <label className="block">
              <span className={LABEL}>Reason</span>
              <select
                className="dash-input w-full"
                value={reason}
                onChange={(e) =>
                  setReason(e.target.value as EndPlanReason | "")
                }
                disabled={pending}
              >
                <option value="">Choose a reason</option>
                {END_REASONS.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className={LABEL}>Refund the unused part from</span>
              <input
                type="date"
                className="dash-input w-48"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                disabled={pending}
              />
            </label>
            {reason === "feature_removed" ? (
              <p className={`-mt-2 ${HINT}`}>
                The date the feature was removed or reduced; the refund covers
                the cycle after it.
              </p>
            ) : null}

            <div className={NOTICE}>
              {canRefund && firstRefunded ? (
                <label className="flex items-start gap-2 pointer-coarse:min-h-11">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={refundUnused}
                    onChange={(e) => setRefundUnused(e.target.checked)}
                    disabled={pending}
                  />
                  <span>
                    Refund the unused part of this cycle:{" "}
                    {inr(preview?.totalPaise ?? 0)} ({firstRefunded.daysLeft} of{" "}
                    {firstRefunded.daysTotal} days)
                  </span>
                </label>
              ) : (
                <p>
                  {checking
                    ? "Counting what is left of this cycle..."
                    : "Nothing paid for this cycle can be refunded."}
                </p>
              )}
              {lines.length > 0 ? (
                <ul className="mt-2 space-y-0.5 text-xs text-[var(--dash-text-2)]">
                  {lines.map((l) => (
                    <li key={l.invoiceId}>
                      {l.skippedWhy ??
                        `${l.invoiceRef ?? "Invoice"}: ${inr(l.amountPaise)} (${l.daysLeft} of ${l.daysTotal} days)`}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <label className="block">
              <span className={LABEL}>Note</span>
              <textarea
                className="dash-input w-full"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={pending}
              />
            </label>

            {error ? (
              <p role="alert" className={ERROR}>
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <button
                type="button"
                onClick={onClose}
                disabled={pending}
                className={GHOST}
              >
                Close
              </button>
              <div className="flex flex-col items-end gap-1">
                <button
                  type="button"
                  onClick={submit}
                  disabled={pending || !!blocked}
                  className={PRIMARY}
                >
                  {pending ? (
                    <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                  ) : null}
                  End plan now
                </button>
                {blocked ? (
                  <span className={`${HINT} max-w-xs text-right`}>
                    {blocked}
                  </span>
                ) : null}
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── The tools ───────────────────────────────────────────────────────────────

type OpenTool = "cancel" | "undo" | "end" | "refund" | null;

/**
 * The billing block's tools (design 7.3). `openRefundFor` is the invoice a
 * reconciliation item sent the operator here for (`?refund=`).
 */
export function StoreBillingTools({
  billing,
  planName,
  canManage,
  openRefundFor,
}: {
  billing: StoreBilling;
  planName: string;
  canManage: boolean;
  openRefundFor?: string | null;
}) {
  const router = useRouter();
  const sub = billing.subscription;
  const targets = billing.invoices
    .map(issueTargetFromInvoice)
    .filter((t) => (t.leftPaise ?? 0) > 0);
  const linked = openRefundFor
    ? targets.find((t) => t.invoiceId === openRefundFor)
    : undefined;
  const [open, setOpen] = useState<OpenTool>(
    canManage && linked ? "refund" : null,
  );
  const cancelling = !!sub?.live && sub.cancelAtPeriodEnd;
  const close = () => setOpen(null);
  const refresh = () => router.refresh();

  return (
    <div className="space-y-3">
      {cancelling && sub ? (
        <p className="rounded-[var(--dash-radius-sm)] border border-[var(--dash-border-strong)] bg-[var(--dash-amber-soft)] px-3 py-2 text-sm text-[var(--dash-text)]">
          {cancellingLine(sub)}
        </p>
      ) : null}

      {canManage && openRefundFor && !linked ? (
        <p className={HINT}>
          The invoice the reconciliation item names has nothing left to refund
          here.
        </p>
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap items-start gap-2">
          {sub?.live && !sub.cancelAtPeriodEnd ? (
            <button
              type="button"
              className={GHOST}
              onClick={() => setOpen("cancel")}
            >
              Cancel at the end of the cycle
            </button>
          ) : null}
          {cancelling ? (
            <button
              type="button"
              className={GHOST}
              onClick={() => setOpen("undo")}
            >
              Undo cancellation
            </button>
          ) : null}
          {sub?.live ? (
            <button
              type="button"
              className={GHOST}
              onClick={() => setOpen("end")}
            >
              End the plan now
            </button>
          ) : null}
          <div className="flex flex-col gap-1">
            <button
              type="button"
              className={GHOST}
              onClick={() => setOpen("refund")}
              disabled={targets.length === 0}
            >
              Issue a refund
            </button>
            {targets.length === 0 ? (
              <span className={HINT}>
                No paid invoice has money left to refund.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {canManage && open === "cancel" && sub ? (
        <PlanNoteDialog
          title="Cancel at the end of the cycle"
          description={`End ${billing.storeName}'s ${planName} plan on ${fmtDate(sub.currentPeriodEnd)}? Only on the merchant's written request. Autopay stops now; a renewal paid for the next cycle is refunded.`}
          label="Where did they ask?"
          confirmLabel="Cancel plan"
          onClose={close}
          onSubmit={async (note) => {
            const res = await cancelPlanAtCycleEnd(billing.storeId, note);
            if ("error" in res) return frameMerchantError(res.error);
            toast.success(
              res.accessUntil
                ? `The plan will end on ${fmtDate(res.accessUntil)}.`
                : "The plan will end at the end of its cycle.",
            );
            refresh();
            return null;
          }}
        />
      ) : null}

      {canManage && open === "undo" ? (
        <PlanNoteDialog
          title="Undo the cancellation?"
          description="Do this only on the merchant's request. Autopay stays off; they pay each renewal themselves."
          label="Note"
          confirmLabel="Undo"
          onClose={close}
          onSubmit={async (note) => {
            const res = await undoPlanCancellation(billing.storeId, note);
            if ("error" in res) return frameMerchantError(res.error);
            toast.success(
              res.advanced
                ? "Cancellation undone. The renewal already paid started the next cycle."
                : "Cancellation undone.",
            );
            refresh();
            return null;
          }}
        />
      ) : null}

      {canManage && open === "end" && sub ? (
        <EndPlanDialog
          storeId={billing.storeId}
          storeName={billing.storeName}
          planName={planName}
          initialPreview={billing.endNow}
          onClose={close}
          onDone={refresh}
        />
      ) : null}

      {canManage && open === "refund" && targets.length > 0 ? (
        <IssueRefundDialog
          storeId={billing.storeId}
          targets={targets}
          initialInvoiceId={linked?.invoiceId ?? null}
          initialReason={linked ? "cycle_not_reached" : null}
          onClose={close}
          onDone={refresh}
        />
      ) : null}
    </div>
  );
}

/** The store's refunds and credit notes, compact (design 7.3). */
export function StoreRefundsList({ billing }: { billing: StoreBilling }) {
  const { refunds, creditNotes } = billing;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--dash-text)]">
          Refunds and credit notes
        </h3>
        <Link
          href="/dashboard/billing/refunds"
          className="text-xs text-[var(--dash-text-2)] hover:text-[var(--dash-text)] hover:underline pointer-coarse:min-h-11 pointer-coarse:inline-flex pointer-coarse:items-center"
        >
          All refunds →
        </Link>
      </div>
      {refunds.length === 0 && creditNotes.length === 0 ? (
        <p className={HINT}>No refunds or credit notes for this store yet.</p>
      ) : null}
      {refunds.length > 0 ? (
        <ul className="divide-y divide-[var(--dash-border)] text-sm">
          {refunds.slice(0, 10).map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2"
            >
              <span className="min-w-0 text-[var(--dash-text)]">
                <span className="font-mono text-xs">{r.invoiceRef ?? "-"}</span>{" "}
                · {REFUND_REASON_LABEL[r.reason] ?? "Other"}
              </span>
              <span className="whitespace-nowrap text-[var(--dash-text)]">
                {inr(r.amountPaise)} ·{" "}
                <span className="text-[var(--dash-text-2)]">
                  {REFUND_STATUS_LABEL[r.status] ?? r.status},{" "}
                  {fmtDateTime(r.createdAt)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {creditNotes.length > 0 ? (
        <ul className="divide-y divide-[var(--dash-border)] text-sm">
          {creditNotes.slice(0, 10).map((n) => (
            <li
              key={n.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
            >
              <span className="min-w-0 text-[var(--dash-text)]">
                <span className="font-mono text-xs">{n.creditNoteRef}</span> ·{" "}
                {reasonLabel(n.reason)} · {inr(n.totalPaise)}
              </span>
              <Link
                href={consoleCreditNoteHref(n.id)}
                aria-label={`Print ${n.creditNoteRef}`}
                className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
              >
                Print
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
