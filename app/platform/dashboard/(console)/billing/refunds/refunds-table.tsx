"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Loader2, Lock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  cancelRefund,
  recordRefundMadeOutside,
  retryRefund,
  sendRefund,
  type RefundQueueTab,
  type RefundWriteResult,
} from "@/app/actions/platform-billing";
// Types only: the module is server-only, and a type import is erased.
import type {
  ConsoleCreditNoteRow,
  RefundListRow,
  RefundReason,
  RefundStatus,
} from "@/lib/billing/refunds";

// ---------------------------------------------------------------------------
// The Refunds page's table and its three dialogs (renewal-cancel, design 7.2).
//
// ★★ THE ACTION'S SENTENCE IS THE ONE SHOWN. Every refusal comes back from
// `app/actions/platform-billing.ts`, which passes on the refund helpers'
// sentences unchanged ("That refund has already moved on. Refresh the page.",
// the cap, the ₹1 minimum, "Razorpay refused the refund: ..."). A dialog that
// wrote its own "Something went wrong" would hide which of those it was, and
// each one tells the operator something different to do.
//
// ★ A MEMBER SEES THE TABLE AND NO BUTTONS. Each write is a superadmin's and
// the action checks again; `canManage` only decides what is rendered, and the
// line above the table says why there is nothing to press.
// ---------------------------------------------------------------------------

export const REFUND_STATUS_LABEL: Record<RefundStatus, string> = {
  owed: "Owed",
  pending: "Sent, waiting for Razorpay",
  processed: "Refunded",
  failed: "Failed",
  cancelled: "Cancelled",
  recorded: "Recorded",
};

const STATUS_TONE: Record<RefundStatus, string> = {
  owed: "dash-badge-amber",
  pending: "dash-badge-blue",
  processed: "dash-badge-green",
  failed: "dash-badge-red",
  cancelled: "dash-badge-grey",
  recorded: "dash-badge-green",
};

export const REFUND_REASON_LABEL: Record<RefundReason, string> = {
  cycle_not_reached: "Plan ended before this cycle",
  feature_removed: "Main feature removed",
  suspended_by_mistake: "Suspended by mistake",
  declined_terms: "Declined new Terms",
  duplicate_payment: "Paid twice",
  goodwill: "Goodwill",
  other: "Other",
};

/** A refund's or a credit note's reason in words. A credit note can also
 *  cancel an unpaid invoice (`invoice_cancelled`), which no refund does. */
export function reasonLabel(reason: string): string {
  if (reason === "invoice_cancelled") return "Unpaid invoice cancelled";
  return REFUND_REASON_LABEL[reason as RefundReason] ?? "Other";
}

export const REFUND_TABS: { key: RefundQueueTab; label: string }[] = [
  { key: "needs_person", label: "Needs a person" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
  { key: "credit_notes", label: "Credit notes" },
];

export function refundsHref(tab: RefundQueueTab): string {
  return `/dashboard/billing/refunds?tab=${tab}`;
}

/** The console's own printable credit note (design 7.2, "Print"). */
export function consoleCreditNoteHref(id: string): string {
  return `/dashboard/billing/credit-notes/${id}`;
}

/** "₹2,400", or "₹2,400.50" when there are paise. */
export function inr(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Rupees as a form field holds them: "2400", "2400.5". */
export function rupeesField(paise: number): string {
  return String(Math.max(0, paise) / 100);
}

// Pinned to IST: these also render on the server, where Cloud Run is UTC.
export function fmtDate(iso: string | null): string {
  if (!iso) return "-";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "-";
  return at.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "-";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "-";
  return at.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

/** Shown only when the request itself failed, never for a refusal. */
export const REQUEST_FAILED_MESSAGE =
  "The request didn't reach StoreMink. Refresh the page and try again.";

/** What a finished write says, by where the refund now is. */
export const REFUND_DONE_TOAST: Record<RefundStatus, string> = {
  processed: "Refunded.",
  pending: "Sent. Waiting for Razorpay to confirm it.",
  owed: "Saved. It waits on the Refunds page until it can be sent.",
  recorded: "Refund recorded.",
  cancelled: "Refund cancelled.",
  failed: "Razorpay refused the refund.",
};

const BTN = "dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11";
const PRIMARY = "dash-btn dash-btn-primary pointer-coarse:min-h-11";
const GHOST = "dash-btn dash-btn-ghost pointer-coarse:min-h-11";
const LABEL = "mb-1 block text-sm font-medium text-[var(--dash-text)]";
const HINT = "text-xs text-[var(--dash-text-2)]";
const ERROR = "text-sm text-[var(--dash-red)]";

/** The store a refund or note belongs to, linked, or "Deleted store". */
function StoreCell({
  storeId,
  storeName,
  storeSlug,
}: {
  storeId: string | null;
  storeName: string | null;
  storeSlug: string | null;
}) {
  if (!storeId) {
    return <span className="text-[var(--dash-text-2)]">Deleted store</span>;
  }
  return (
    <Link
      href={`/dashboard/stores/${storeId}`}
      className="inline-block hover:underline pointer-coarse:min-h-11"
    >
      <span className="dash-cell-title block">{storeName ?? "Store"}</span>
      {storeSlug ? (
        <span className="dash-cell-sub mono block">{storeSlug}</span>
      ) : null}
    </Link>
  );
}

/** Ends a stored sentence with a full stop when it has none. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function refundSummary(row: RefundListRow): string {
  const store = row.storeId ? (row.storeName ?? "Store") : "Deleted store";
  return `${inr(row.amountPaise)} for invoice ${row.invoiceRef ?? "-"}, ${store}`;
}

/** The Detail column: the Razorpay refund id, the failure, who asked and why. */
function detailLines(row: RefundListRow): string[] {
  const lines: string[] = [];
  if (row.status === "recorded" && row.externalReference) {
    lines.push(
      `${row.method === "bank_transfer" ? "Bank transfer" : "Razorpay dashboard"}, reference ${row.externalReference}`,
    );
  }
  if (row.providerRefundId) {
    lines.push(`Razorpay refund ${row.providerRefundId}`);
  }
  if (row.failureReason) lines.push(`Why it failed: ${row.failureReason}`);
  if (row.status === "pending" && row.sentAt) {
    lines.push(`Sent ${fmtDateTime(row.sentAt)}`);
  }
  lines.push(
    `Asked by ${row.requestedBy === "system" ? "the billing run" : row.requestedBy}`,
  );
  if (row.note) lines.push(`Note: ${row.note}`);
  if (row.resolutionNote) {
    lines.push(
      row.status === "cancelled"
        ? `Why it was cancelled: ${row.resolutionNote}`
        : `Closing note: ${row.resolutionNote}`,
    );
  }
  return lines;
}

/** The tab bar. "Needs a person" carries the banner's count, 0 included. */
export function RefundTabs({
  tab,
  needsPerson,
}: {
  tab: RefundQueueTab;
  needsPerson: number | null;
}) {
  return (
    <nav
      aria-label="Refunds"
      className="dash-filter-tabs mb-5 w-fit max-w-full flex-wrap"
    >
      {REFUND_TABS.map(({ key, label }) => {
        const on = key === tab;
        const alert = key === "needs_person" && (needsPerson ?? 0) > 0;
        return (
          <Link
            key={key}
            href={refundsHref(key)}
            aria-current={on ? "page" : undefined}
            className={`dash-filter-tab pointer-coarse:min-h-11 ${on ? "active" : ""} ${alert ? "has-alert" : ""}`}
          >
            {label}
            {key === "needs_person" && needsPerson !== null ? (
              <span className="dash-tab-count">{needsPerson}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

const EMPTY: Record<RefundQueueTab, { title: string; text: string }> = {
  needs_person: {
    title: "Nothing needs a person",
    text: "A refund lands here when Razorpay refuses it, when it has waited more than a day, or while automatic sending is off and it waits for Send.",
  },
  in_progress: {
    title: "Nothing in progress",
    text: "Refunds that are owed or sent and waiting for Razorpay show here.",
  },
  done: {
    title: "No finished refunds yet",
    text: "Refunded, recorded and cancelled refunds show here.",
  },
  credit_notes: {
    title: "No credit notes yet",
    text: "A credit note is issued when a refund completes, and when an unpaid invoice that charged GST is cancelled.",
  },
};

function Empty({ tab }: { tab: RefundQueueTab }) {
  return (
    <div className="dash-card">
      <div className="dash-empty">
        <span className="dash-empty-icon">
          <Check aria-hidden className="h-5 w-5" strokeWidth={1.5} />
        </span>
        <p className="dash-empty-title">{EMPTY[tab].title}</p>
        <p className="dash-empty-text max-w-md">{EMPTY[tab].text}</p>
      </div>
    </div>
  );
}

type OpenDialog =
  | { kind: "cancel"; row: RefundListRow }
  | { kind: "retry"; row: RefundListRow }
  | { kind: "record"; row: RefundListRow };

/** One tab of the Refunds page (design 7.2). */
export function RefundsTable({
  tab,
  refunds,
  creditNotes,
  canManage,
}: {
  tab: RefundQueueTab;
  refunds: RefundListRow[];
  creditNotes: ConsoleCreditNoteRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<OpenDialog | null>(null);

  if (tab === "credit_notes") return <CreditNotesTable notes={creditNotes} />;

  return (
    <div className="space-y-3">
      {!canManage ? (
        <p className="inline-flex items-center gap-1.5 text-xs text-[var(--dash-text-2)]">
          <Lock aria-hidden className="h-3.5 w-3.5" />
          Only a platform superadmin can send, cancel or record refunds.
        </p>
      ) : null}

      {refunds.length === 0 ? (
        <Empty tab={tab} />
      ) : (
        <div className="dash-card">
          <table className="dash-table dash-table-wide">
            <thead>
              <tr>
                <th scope="col">Store</th>
                <th scope="col">Invoice</th>
                <th scope="col">Reason</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">Detail</th>
                {canManage ? (
                  <th scope="col" className="dash-col-actions">
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {refunds.map((row) => (
                <tr key={row.id} data-refund={row.id}>
                  <td>
                    <StoreCell
                      storeId={row.storeId}
                      storeName={row.storeName}
                      storeSlug={row.storeSlug}
                    />
                  </td>
                  <td className="font-mono text-xs">{row.invoiceRef ?? "-"}</td>
                  <td>{REFUND_REASON_LABEL[row.reason] ?? "Other"}</td>
                  <td className="whitespace-nowrap font-mono">
                    {inr(row.amountPaise)}
                  </td>
                  <td>
                    <span
                      className={`dash-badge whitespace-nowrap ${STATUS_TONE[row.status] ?? "dash-badge-grey"}`}
                    >
                      {REFUND_STATUS_LABEL[row.status] ?? row.status}
                    </span>
                  </td>
                  <td className="whitespace-nowrap text-[var(--dash-text-2)]">
                    {fmtDateTime(row.createdAt)}
                  </td>
                  <td className="min-w-56 whitespace-normal">
                    <ul className="space-y-0.5 text-xs text-[var(--dash-text-2)]">
                      {detailLines(row).map((line) => (
                        <li key={line} className="break-words">
                          {line}
                        </li>
                      ))}
                    </ul>
                  </td>
                  {canManage ? (
                    <td className="dash-col-actions whitespace-normal">
                      <RowActions
                        row={row}
                        onOpen={(kind) => setDialog({ kind, row })}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && dialog?.kind === "cancel" ? (
        <NoteDialog
          key={`cancel-${dialog.row.id}`}
          title="Cancel this refund?"
          description="It won't be sent. The merchant has been told a refund is coming, so write to them to explain. If it was already paid another way, use Record a refund made outside StoreMink instead. Say why, for the record."
          summary={refundSummary(dialog.row)}
          label="Reason"
          confirmLabel="Cancel refund"
          closeLabel="Keep it"
          onSubmit={(note) => cancelRefund(dialog.row.id, note)}
          onClose={() => setDialog(null)}
          onDone={() => router.refresh()}
        />
      ) : null}

      {canManage && dialog?.kind === "retry" ? (
        <NoteDialog
          key={`retry-${dialog.row.id}`}
          title="Send this refund again as a new refund?"
          description={`Razorpay refused the last one${dialog.row.failureReason ? `: ${asSentence(dialog.row.failureReason)}` : "."} Add a note for the record.`}
          summary={refundSummary(dialog.row)}
          label="Note"
          confirmLabel="Send again"
          closeLabel="Close"
          onSubmit={(note) => retryRefund(dialog.row.id, note)}
          onClose={() => setDialog(null)}
          onDone={() => router.refresh()}
        />
      ) : null}

      {canManage && dialog?.kind === "record" ? (
        <RecordRefundDialog
          key={`record-${dialog.row.id}`}
          target={{
            refundId: dialog.row.id,
            invoiceId: dialog.row.invoiceId,
            attemptId: dialog.row.attemptId,
            amountPaise: dialog.row.amountPaise,
            summary: refundSummary(dialog.row),
          }}
          onClose={() => setDialog(null)}
          onDone={() => router.refresh()}
        />
      ) : null}
    </div>
  );
}

/** Owed: Send, Cancel, Record. Failed: Try again, Record. Others: nothing. */
function RowActions({
  row,
  onOpen,
}: {
  row: RefundListRow;
  onOpen: (kind: OpenDialog["kind"]) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function send() {
    setError(null);
    start(async () => {
      try {
        const res = await sendRefund(row.id);
        if ("error" in res) {
          setError(res.error);
          return;
        }
        toast.success(REFUND_DONE_TOAST[res.status] ?? "Done.");
        router.refresh();
      } catch {
        setError(REQUEST_FAILED_MESSAGE);
      }
    });
  }

  if (row.status !== "owed" && row.status !== "failed") {
    return <span className="text-[var(--dash-text-3)]">-</span>;
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      {row.status === "owed" ? (
        <>
          <button
            type="button"
            onClick={send}
            disabled={pending}
            className="dash-btn dash-btn-primary dash-btn-sm pointer-coarse:min-h-11"
          >
            {pending ? (
              <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            Send
          </button>
          <button
            type="button"
            onClick={() => onOpen("cancel")}
            disabled={pending}
            className={BTN}
          >
            Cancel
          </button>
        </>
      ) : (
        <button type="button" onClick={() => onOpen("retry")} className={BTN}>
          Try again
        </button>
      )}
      <button
        type="button"
        onClick={() => onOpen("record")}
        disabled={pending}
        className={`${BTN} whitespace-normal text-left`}
      >
        Record a refund made outside StoreMink
      </button>
      {error ? (
        <p role="alert" className={`max-w-56 ${ERROR}`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A dialog with one required note and one write (Cancel, Try again). The
 * write's own sentence is shown when it refuses.
 */
function NoteDialog({
  title,
  description,
  summary,
  label,
  confirmLabel,
  closeLabel,
  onSubmit,
  onClose,
  onDone,
}: {
  title: string;
  description: string;
  summary: string;
  label: string;
  confirmLabel: string;
  closeLabel: string;
  onSubmit: (note: string) => Promise<RefundWriteResult>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      try {
        const res = await onSubmit(note);
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
        <p className="rounded-[var(--dash-radius-sm)] bg-[var(--dash-surface-2)] px-3 py-2 text-sm text-[var(--dash-text)]">
          {summary}
        </p>
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
            {closeLabel}
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

/** What "Record a refund made outside StoreMink" settles or records. */
export interface RecordTarget {
  /** The owed or failed refund this settles; absent for a queue item. */
  refundId?: string | null;
  /** The store being viewed; null for a deleted store; absent on the
   *  Refunds page, which lists every store. */
  storeId?: string | null;
  invoiceId: string;
  attemptId: string;
  /** Prefilled into the Amount field. */
  amountPaise: number;
  /** One line naming the money, shown at the top of the dialog. */
  summary: string;
}

/**
 * "Record a refund made outside StoreMink" (design 7.2): a bank transfer, or
 * a refund already made by hand in the Razorpay dashboard. The credit note
 * and the merchant's email follow when it saves. Also opened from a
 * reconciliation item (design 7.4).
 */
export function RecordRefundDialog({
  target,
  onClose,
  onDone,
}: {
  target: RecordTarget;
  onClose: () => void;
  onDone: () => void;
}) {
  const [method, setMethod] = useState<"bank_transfer" | "razorpay">(
    "bank_transfer",
  );
  const [amount, setAmount] = useState(rupeesField(target.amountPaise));
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      try {
        const res = await recordRefundMadeOutside({
          refundId: target.refundId ?? null,
          ...(target.storeId !== undefined ? { storeId: target.storeId } : {}),
          invoiceId: target.invoiceId,
          attemptId: target.attemptId,
          amountInr: amount,
          method,
          reference,
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

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record a refund made outside StoreMink</DialogTitle>
          <DialogDescription>
            Use this after paying the merchant another way, or for a refund
            already made in the Razorpay dashboard. The merchant is emailed and
            the credit note is issued when you save.
          </DialogDescription>
        </DialogHeader>
        <p className="rounded-[var(--dash-radius-sm)] bg-[var(--dash-surface-2)] px-3 py-2 text-sm text-[var(--dash-text)]">
          {target.summary}
        </p>
        <fieldset>
          <legend className={LABEL}>Method</legend>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["bank_transfer", "Bank transfer"],
                ["razorpay", "Razorpay dashboard"],
              ] as const
            ).map(([value, text]) => (
              <label
                key={value}
                className={`inline-flex cursor-pointer items-center gap-2 rounded-[var(--dash-radius-sm)] border px-3 py-1.5 text-sm pointer-coarse:min-h-11 ${
                  method === value
                    ? "border-[var(--dash-accent)] bg-[var(--dash-accent-soft)] text-[var(--dash-text)]"
                    : "border-[var(--dash-border-strong)] text-[var(--dash-text-2)]"
                }`}
              >
                <input
                  type="radio"
                  name="record-method"
                  checked={method === value}
                  onChange={() => setMethod(value)}
                  disabled={pending}
                />
                {text}
              </label>
            ))}
          </div>
        </fieldset>
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
        <label className="block">
          <span className={LABEL}>Reference</span>
          <input
            className="dash-input w-full font-mono"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={
              method === "bank_transfer" ? "UTR" : "Razorpay refund id"
            }
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
          />
        </label>
        <p className={`-mt-2 ${HINT}`}>
          The UTR of the bank transfer, or the Razorpay refund id.
        </p>
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
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className={PRIMARY}
          >
            {pending ? (
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            ) : null}
            Record refund
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The "Credit notes" tab: every store's notes, newest first. */
export function CreditNotesTable({ notes }: { notes: ConsoleCreditNoteRow[] }) {
  if (notes.length === 0) return <Empty tab="credit_notes" />;
  return (
    <div className="dash-card">
      <table className="dash-table dash-table-wide">
        <thead>
          <tr>
            <th scope="col">Number</th>
            <th scope="col">Issued</th>
            <th scope="col">Store</th>
            <th scope="col">For invoice</th>
            <th scope="col">Reason</th>
            <th scope="col">Amount</th>
            <th scope="col" className="dash-col-actions">
              <span className="sr-only">Print</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {notes.map((n) => (
            <tr key={n.id}>
              <td className="font-mono text-xs">{n.creditNoteRef}</td>
              <td className="whitespace-nowrap text-[var(--dash-text-2)]">
                {fmtDate(n.issuedAt)}
              </td>
              <td>
                <StoreCell
                  storeId={n.storeId}
                  storeName={n.storeName}
                  storeSlug={n.storeSlug}
                />
              </td>
              <td className="font-mono text-xs">{n.invoiceRef ?? "-"}</td>
              <td>{reasonLabel(n.reason)}</td>
              <td className="whitespace-nowrap font-mono">
                {inr(n.totalPaise)}
              </td>
              <td className="dash-col-actions">
                <Link
                  href={consoleCreditNoteHref(n.id)}
                  aria-label={`Print ${n.creditNoteRef}`}
                  className={BTN}
                >
                  Print
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
