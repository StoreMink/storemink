"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { closeReconciliationItem } from "@/app/actions/platform";
import type { ReconciliationItem } from "@/lib/billing/invoice-types";
import {
  CAPTURED_DRAFT_REPAIR,
  KEPT_DRAFT_REPAIR,
} from "@/lib/billing/tax-copy";
import { InfoTip } from "@/components/ui/info-tip";
import { RecordRefundDialog } from "../refunds/refunds-table";
import { IssueRefundDialog } from "../../stores/[storeId]/billing-actions";

// ---------------------------------------------------------------------------
// Money discrepancies the sweep found and could not decide (§34).
//
// ★★ CLOSING AN ITEM MOVES NO MONEY, and the screen says so rather than leaving
// it to be assumed. An amount mismatch is actually resolved by refunding the
// difference, issuing a credit, or deciding it does not matter — all elsewhere,
// deliberately, by someone who chose them. A button here that "fixed" a
// discrepancy would be a money movement nobody reviewed.
//
// ★ THREE OUTCOMES, because "resolved" alone is a lie in two common cases:
// something genuinely settled, something a human must chase (manual review), and
// something that turned out not to matter (ignored). Collapsing them loses the
// difference between "dealt with" and "decided not to".
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<string, string> = {
  amount_mismatch: "Amount mismatch",
  unknown_payment: "Unknown payment",
  orphan_payment: "Payment with no store",
  missing_webhook: "Missing webhook",
  state_conflict: "State conflict",
  wrong_association: "Wrong association",
  credit_grant_failed: "Credit grant failed",
};

const inr = (paise: number | null) =>
  paise === null
    ? "-"
    : `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Whose money it is. ★ A DELETED STORE IS NOT ONE TO ATTRIBUTE: deleteStore
 * detaches the store's open items, and the sweep files a payment captured
 * after the deletion, both marked `storeDeleted` in `detail`. Pointing the
 * operator at attribution there sends them looking for a store that is gone.
 */
function storeLabel(item: ReconciliationItem): string {
  if (item.storeName) return item.storeName;
  const detail = asRecord(item.detail);
  if (detail.storeDeleted === true) {
    const name =
      typeof detail.storeName === "string" ? detail.storeName.trim() : "";
    return name ? `${name} (store deleted)` : "store deleted";
  }
  return "no store - needs attributing";
}

/** The sweep's own one-line reason, when it left one. */
function itemNote(item: ReconciliationItem): string | null {
  const note = asRecord(item.detail).note;
  return typeof note === "string" && note.trim() ? note.trim() : null;
}

// ---------------------------------------------------------------------------
// ★ The refund pass's items (renewal-cancel, design 7.4). They are filed as
// `state_conflict` with a `detail.repair_key` that says which question is
// open, and each names what to do about it and opens the tool that does it.
// The button only OPENS a dialog; the refund or the record is its own action,
// re-checked on the server, and closing the item stays a separate step.
//
// ★ The closed-tab purchases the hourly check could not finish (RC-F1b) are
// filed the same way, `purchase_refused:<attempt>` (a check failed before
// anything was written) and `purchase_unapplied:<attempt>` (the invoice was
// issued but the purchase did not apply). Their `detail.note` says exactly
// what a person must decide, so it is shown under the hint. Only an issued
// invoice can be refunded through StoreMink, so Issue a refund is offered for
// the unapplied kind alone; both link to the store's page, where the plan and
// billing tools are.
//
// ★ The GST repair pass (GST plan A4.6) files a payment captured behind an
// invoice that was still a draft as `captured_draft:<invoice>`: it issued the
// invoice and settled it paid, never applied the purchase. The item says what
// was bought and opens the store's page, where a person checks it was applied.
// deleteStore files and detaches the same items for a store being deleted
// (`detail.storeDeleted`); there is no store to apply anything to, so the
// item says so and offers the refund instead.
//
// ★ An invoice issued with the GST it was priced with, because a payment had
// already fixed its total while the GST in force had changed (R1-03), is filed
// as `kept_draft:<invoice>`. Its note names both rates and the payment; a
// person decides whether a difference goes back, through Issue a refund with a
// reason they pick, and the store's page is a link away.
// ---------------------------------------------------------------------------

export type RepairKind =
  | "paid_unreached"
  | "kept_before_refunds"
  | "refund_refused"
  | "purchase_refused"
  | "purchase_unapplied"
  | "captured_draft"
  | "kept_draft";

export const REPAIR_COPY: Record<RepairKind, { title: string; hint: string }> =
  {
    paid_unreached: {
      title: "Renewal paid for a cycle the plan did not reach",
      hint: "Issue a refund (reason: Plan ended before this cycle), then close this with what you did.",
    },
    kept_before_refunds: {
      title: "Payment kept after the plan ended, before automatic refunds",
      hint: "Check Razorpay for a refund made by hand. Record it if there was one, or issue the refund, then close this.",
    },
    refund_refused: {
      title: "An automatic refund was refused",
      hint: "The reason is in the detail. Fix the cause or refund another way and record it, then close this.",
    },
    purchase_refused: {
      title: "A paid purchase was not applied",
      hint: "Nothing was applied or refunded. Apply it by hand or refund it in the Razorpay dashboard, then close this.",
    },
    purchase_unapplied: {
      title: "A paid purchase was invoiced but not applied",
      hint: "The merchant was told not to pay again. Apply it by hand or issue a refund, then close this.",
    },
    captured_draft: {
      title: CAPTURED_DRAFT_REPAIR.title,
      hint: CAPTURED_DRAFT_REPAIR.hint,
    },
    kept_draft: {
      title: KEPT_DRAFT_REPAIR.title,
      hint: KEPT_DRAFT_REPAIR.hint,
    },
  };

/** A `captured_draft` item whose store was deleted (deleteStore's repair). */
export const CAPTURED_DRAFT_STORE_DELETED =
  "The store has been deleted, so what it paid for can't be applied. Refund the payment, then close this with what you did.";

/** What the purchase behind a `purchase_*` item was (`detail.purchase`). */
export const PURCHASE_LABEL: Record<string, string> = {
  enrolment: "A first plan payment",
  plan_change: "A plan change",
  locations: "Extra locations",
  unknown: "An add-on that names neither a plan change nor locations",
};

const REPAIR_KINDS: readonly RepairKind[] = [
  "paid_unreached",
  "kept_before_refunds",
  "refund_refused",
  "purchase_refused",
  "purchase_unapplied",
  "captured_draft",
  "kept_draft",
];

/** Which question an item holds, from its `repair_key` prefix. */
export function repairKind(item: ReconciliationItem): RepairKind | null {
  const key = asRecord(item.detail).repair_key;
  if (typeof key !== "string") return null;
  const prefix = key.split(":")[0];
  return (REPAIR_KINDS as readonly string[]).includes(prefix)
    ? (prefix as RepairKind)
    : null;
}

/** A closed-tab purchase the hourly check could not finish (RC-F1b). */
function isPurchaseKind(
  kind: RepairKind,
): kind is "purchase_refused" | "purchase_unapplied" {
  return kind === "purchase_refused" || kind === "purchase_unapplied";
}

/** An item about a purchase (`detail.purchase` says what was bought), where a
 *  refund's reason is the operator's to pick: never "Plan ended before this
 *  cycle", which is the two refund items' alone. */
function boughtSomething(kind: RepairKind): boolean {
  return isPurchaseKind(kind) || kind === "captured_draft";
}

/** An item whose refund reason is the operator's to pick: every item but the
 *  two about a cycle the plan never reached, and the refusal beside them. */
function reasonIsOperators(kind: RepairKind): boolean {
  return boughtSomething(kind) || kind === "kept_draft";
}

/** Whether a `captured_draft` item's store has since been deleted. */
function storeDeleted(item: ReconciliationItem): boolean {
  return asRecord(item.detail).storeDeleted === true || !item.storeId;
}

function detailText(item: ReconciliationItem, key: string): string | null {
  const value = asRecord(item.detail)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type RepairDialog = { kind: "issue" | "record"; item: ReconciliationItem };

const fmt = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : "-";

export function ReconciliationQueue({
  items,
  status,
  canManage = false,
}: {
  items: ReconciliationItem[];
  status: string;
  /** A superadmin: the refund openers render. Closing is anyone's. */
  canManage?: boolean;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [repair, setRepair] = useState<RepairDialog | null>(null);
  const repairOpen = repair ? repairKind(repair.item) : null;
  const purchaseRepair = repairOpen !== null && reasonIsOperators(repairOpen);

  if (items.length === 0) {
    return (
      <div className="dash-card p-8 text-center">
        <Check
          className="mx-auto mb-3 h-6 w-6 text-[#9aa1ab]"
          strokeWidth={1.5}
        />
        <p className="text-sm font-medium text-[#111827]">
          {status === "open" ? "Nothing to review" : "Nothing here"}
        </p>
        <p className="mx-auto mt-1 max-w-md text-sm text-[#6b7280]">
          {status === "open"
            ? "The hourly sweep files payment questions it cannot decide here."
            : "No items with this outcome yet."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const kind = repairKind(item);
        return (
          <div key={item.id} className="dash-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
                  <span className="text-sm font-semibold text-[#111827]">
                    {kind
                      ? REPAIR_COPY[kind].title
                      : (KIND_LABEL[item.kind] ?? item.kind)}
                  </span>
                  {/* ★ A null store is legitimate and is itself the problem: an
                    orphan payment nobody can attribute, or one whose store was
                    deleted. Say which rather than rendering a blank. */}
                  <span className="text-sm text-[#5b6472]">
                    {storeLabel(item)}
                  </span>
                </div>

                {kind ? (
                  <RepairDetail item={item} kind={kind} />
                ) : (
                  itemNote(item) && (
                    <p className="mt-1 text-sm text-[#5b6472]">
                      {itemNote(item)}
                    </p>
                  )
                )}

                {item.expectedPaise !== null && item.observedPaise !== null && (
                  <p className="mt-1.5 text-sm text-[#111827]">
                    Asked for{" "}
                    <strong className="font-mono">
                      {inr(item.expectedPaise)}
                    </strong>
                    , received{" "}
                    <strong className="font-mono">
                      {inr(item.observedPaise)}
                    </strong>
                    <span className="ml-2 text-[#6b7280]">
                      (
                      {item.observedPaise > item.expectedPaise
                        ? `${inr(item.observedPaise - item.expectedPaise)} over`
                        : `${inr(item.expectedPaise - item.observedPaise)} short`}
                      )
                    </span>
                  </p>
                )}

                <p className="mt-1 font-mono text-xs text-[#6b7280]">
                  {item.providerPaymentId ?? item.providerOrderId ?? item.id}
                </p>
                <p className="mt-0.5 text-xs text-[#9aa1ab]">
                  Found {fmt(item.createdAt)}
                </p>

                {item.status !== "open" && (
                  <p className="mt-2 rounded bg-[#f9fafb] px-2 py-1 text-xs text-[#5b6472]">
                    <strong>{item.status}</strong>
                    {item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
                    {item.resolvedAt ? ` · ${fmt(item.resolvedAt)}` : ""}
                    {item.resolutionNote ? ` - ${item.resolutionNote}` : ""}
                  </p>
                )}
              </div>

              {item.status === "open" && (
                <button
                  type="button"
                  onClick={() => setOpenId(openId === item.id ? null : item.id)}
                  className="shrink-0 rounded-lg border border-[#e5e5e5] px-3 py-1.5 text-sm font-medium text-[#111827] hover:bg-[#111827]/[0.03]"
                >
                  {openId === item.id ? "Cancel" : "Close this"}
                </button>
              )}
            </div>

            {kind && item.status === "open" ? (
              <RepairOpeners
                item={item}
                kind={kind}
                canManage={canManage}
                onOpen={(dialogKind) => setRepair({ kind: dialogKind, item })}
              />
            ) : null}

            {openId === item.id && (
              <CloseForm
                id={item.id}
                onDone={() => {
                  setOpenId(null);
                  router.refresh();
                }}
              />
            )}
          </div>
        );
      })}

      {canManage && repair?.kind === "issue" && repair.item.invoiceId ? (
        <IssueRefundDialog
          key={`issue-${repair.item.id}`}
          storeId={repair.item.storeId}
          targets={[
            {
              invoiceId: repair.item.invoiceId,
              invoiceRef: detailText(repair.item, "invoiceRef"),
              label: `${detailText(repair.item, "invoiceRef") ?? "Invoice"} · ${inr(repair.item.expectedPaise)}`,
              leftPaise: repair.item.expectedPaise,
              perDayPaise: null,
              // The two refund items name an invoice the plan never reached: a
              // paid renewal above it, or one marked uncollectible. A purchase
              // that did not apply, or a GST difference on a kept draft, is
              // not that case; the operator picks.
              cycleNotReachedFits: !purchaseRepair,
              payments: repair.item.attemptId
                ? [
                    {
                      attemptId: repair.item.attemptId,
                      label: repair.item.providerPaymentId ?? "Payment",
                      leftPaise: repair.item.expectedPaise ?? 0,
                    },
                  ]
                : [],
            },
          ]}
          initialInvoiceId={repair.item.invoiceId}
          initialReason={purchaseRepair ? null : "cycle_not_reached"}
          onClose={() => setRepair(null)}
          onDone={() => router.refresh()}
        />
      ) : null}

      {canManage &&
      repair?.kind === "record" &&
      repair.item.invoiceId &&
      repair.item.attemptId ? (
        <RecordRefundDialog
          key={`record-${repair.item.id}`}
          target={{
            storeId: repair.item.storeId,
            invoiceId: repair.item.invoiceId,
            attemptId: repair.item.attemptId,
            amountPaise: repair.item.expectedPaise ?? 0,
            summary: `${inr(repair.item.expectedPaise)} for invoice ${detailText(repair.item, "invoiceRef") ?? "-"}, ${storeLabel(repair.item)}`,
          }}
          onClose={() => setRepair(null)}
          onDone={() => router.refresh()}
        />
      ) : null}
    </div>
  );
}

/** What a refund item is about: the hint, the invoice, the refusal. */
function RepairDetail({
  item,
  kind,
}: {
  item: ReconciliationItem;
  kind: RepairKind;
}) {
  const invoiceRef = detailText(item, "invoiceRef");
  const refusal = kind === "refund_refused" ? detailText(item, "reason") : null;
  const purchase = boughtSomething(kind) ? detailText(item, "purchase") : null;
  // A captured draft's note repeats its hint word for word; it is shown only
  // if the pass ever writes something else. A kept draft's note is the point:
  // it names the GST the invoice was issued with and the GST in force.
  const rawNote =
    boughtSomething(kind) || kind === "kept_draft" ? itemNote(item) : null;
  const note =
    kind === "captured_draft" && rawNote === CAPTURED_DRAFT_REPAIR.detail
      ? null
      : rawNote;
  const deleted = kind === "captured_draft" && storeDeleted(item);
  return (
    <div className="mt-1 space-y-1 text-sm text-[var(--dash-text-2)]">
      <p>{deleted ? CAPTURED_DRAFT_STORE_DELETED : REPAIR_COPY[kind].hint}</p>
      {purchase ? (
        <p className="text-[var(--dash-text)]">
          What was bought: {PURCHASE_LABEL[purchase] ?? purchase}
        </p>
      ) : null}
      {note ? <p className="text-[var(--dash-text)]">{note}</p> : null}
      {invoiceRef || item.expectedPaise !== null ? (
        <p className="text-[var(--dash-text)]">
          {invoiceRef ? (
            <>
              Invoice <span className="font-mono">{invoiceRef}</span>
            </>
          ) : null}
          {invoiceRef && item.expectedPaise !== null ? " · " : null}
          {item.expectedPaise !== null && item.observedPaise === null
            ? inr(item.expectedPaise)
            : null}
        </p>
      ) : null}
      {refusal ? (
        <p className="text-[var(--dash-text)]">Why it was refused: {refusal}</p>
      ) : null}
    </div>
  );
}

/**
 * The tools an item names (design 7.4). A renewal paid for a cycle never
 * reached opens the store page's Issue a refund on that invoice; a deleted
 * store has no page, so the same dialog opens here.
 */
function RepairOpeners({
  item,
  kind,
  canManage,
  onOpen,
}: {
  item: ReconciliationItem;
  kind: RepairKind;
  canManage: boolean;
  onOpen: (kind: "issue" | "record") => void;
}) {
  if (kind === "captured_draft") {
    return (
      <CapturedDraftOpeners item={item} canManage={canManage} onOpen={onOpen} />
    );
  }
  if (kind === "kept_draft") {
    return (
      <KeptDraftOpeners item={item} canManage={canManage} onOpen={onOpen} />
    );
  }
  if (isPurchaseKind(kind)) {
    return (
      <PurchaseOpeners
        item={item}
        kind={kind}
        canManage={canManage}
        onOpen={onOpen}
      />
    );
  }
  if (!canManage) {
    return (
      <p className="mt-3 text-xs text-[var(--dash-text-2)]">
        Only a platform superadmin can issue or record a refund.
      </p>
    );
  }
  const BTN = "dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11";
  const canIssue = !!item.invoiceId;
  const canRecord = !!item.invoiceId && !!item.attemptId;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {kind === "paid_unreached" && canIssue && item.storeId ? (
        <Link
          href={`/dashboard/stores/${item.storeId}?refund=${item.invoiceId}`}
          className={BTN}
        >
          Issue a refund
        </Link>
      ) : null}
      {(kind === "paid_unreached" && canIssue && !item.storeId) ||
      (kind === "kept_before_refunds" && canIssue) ? (
        <button type="button" className={BTN} onClick={() => onOpen("issue")}>
          Issue a refund
        </button>
      ) : null}
      {(kind === "kept_before_refunds" || kind === "refund_refused") &&
      canRecord ? (
        <button type="button" className={BTN} onClick={() => onOpen("record")}>
          Record a refund made outside StoreMink
        </button>
      ) : null}
    </div>
  );
}

/**
 * The tools a closed-tab purchase names (RC-F1b). Applying it by hand starts on
 * the store's page, which any operator may open. Issue a refund is offered only
 * for the unapplied kind, whose invoice was issued: StoreMink refunds only an
 * issued invoice, so for a refused one it would be refused, and the hint sends
 * the operator to the Razorpay dashboard instead.
 */
function PurchaseOpeners({
  item,
  kind,
  canManage,
  onOpen,
}: {
  item: ReconciliationItem;
  kind: "purchase_refused" | "purchase_unapplied";
  canManage: boolean;
  onOpen: (kind: "issue" | "record") => void;
}) {
  const BTN = "dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11";
  const refundable =
    kind === "purchase_unapplied" && !!item.invoiceId && !!item.attemptId;
  if (!item.storeId && !refundable) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {item.storeId ? (
        <Link href={`/dashboard/stores/${item.storeId}`} className={BTN}>
          Open the store
        </Link>
      ) : null}
      {refundable && canManage ? (
        <button type="button" className={BTN} onClick={() => onOpen("issue")}>
          Issue a refund
        </button>
      ) : null}
      {refundable && !canManage ? (
        <p className="text-xs text-[var(--dash-text-2)]">
          Only a platform superadmin can issue or record a refund.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The tools a captured draft names (GST plan A4.6). Its invoice is issued and
 * paid, so the question is whether the purchase was applied: the store's page
 * is where a person checks and applies it, and any operator may open it. For a
 * deleted store nothing can be applied, so Issue a refund opens in place, for
 * a superadmin, the way the queue's other deleted-store items do.
 */
function CapturedDraftOpeners({
  item,
  canManage,
  onOpen,
}: {
  item: ReconciliationItem;
  canManage: boolean;
  onOpen: (kind: "issue" | "record") => void;
}) {
  const BTN = "dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11";
  if (!storeDeleted(item)) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link href={`/dashboard/stores/${item.storeId}`} className={BTN}>
          Open the store
        </Link>
      </div>
    );
  }
  if (!item.invoiceId || !item.attemptId) return null;
  if (!canManage) {
    return (
      <p className="mt-3 text-xs text-[var(--dash-text-2)]">
        Only a platform superadmin can issue or record a refund.
      </p>
    );
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button type="button" className={BTN} onClick={() => onOpen("issue")}>
        Issue a refund
      </button>
    </div>
  );
}

/**
 * The tools a kept draft names (R1-03). Its invoice is issued and paid, so a
 * difference the merchant overpaid goes back through Issue a refund, which
 * issues its credit note; the reason is the operator's. The store's page is a
 * link away for anyone. With no payment on the item (a credit pack's receipt)
 * there is nothing to pick, so only the link shows.
 */
function KeptDraftOpeners({
  item,
  canManage,
  onOpen,
}: {
  item: ReconciliationItem;
  canManage: boolean;
  onOpen: (kind: "issue" | "record") => void;
}) {
  const BTN = "dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11";
  const refundable = !!item.invoiceId && !!item.attemptId;
  if (!item.storeId && !refundable) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {item.storeId ? (
        <Link href={`/dashboard/stores/${item.storeId}`} className={BTN}>
          Open the store
        </Link>
      ) : null}
      {refundable && canManage ? (
        <button type="button" className={BTN} onClick={() => onOpen("issue")}>
          Issue a refund
        </button>
      ) : null}
      {refundable && !canManage ? (
        <p className="text-xs text-[var(--dash-text-2)]">
          Only a platform superadmin can issue or record a refund.
        </p>
      ) : null}
    </div>
  );
}

function CloseForm({ id, onDone }: { id: string; onDone: () => void }) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<
    "resolved" | "manual_review" | "ignored"
  >("resolved");

  function submit() {
    start(async () => {
      const res = await closeReconciliationItem(id, outcome, note);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Closed.");
      onDone();
    });
  }

  return (
    <div className="mt-4 border-t border-[#e5e5e5] pt-4">
      {/* ★ Stated at the point of action, not in a header nobody re-reads. */}
      <p className="mb-3 rounded-lg bg-[#f9fafb] px-3 py-2 text-xs text-[#5b6472]">
        This records what you found. It does <strong>not</strong> move money.
      </p>

      <div className="mb-3 flex flex-wrap gap-2">
        {(
          [
            ["resolved", "Resolved"],
            ["manual_review", "Needs chasing"],
            ["ignored", "Doesn't matter"],
          ] as const
        ).map(([value, label]) => (
          <label
            key={value}
            className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm ${
              outcome === value
                ? "border-[#111827] bg-[#111827]/[0.03] font-medium"
                : "border-[#e5e5e5]"
            }`}
          >
            <input
              type="radio"
              className="mr-2"
              checked={outcome === value}
              onChange={() => setOutcome(value)}
            />
            {label}
          </label>
        ))}
      </div>

      <div className="mb-1 flex items-center gap-1.5">
        <label
          htmlFor={`close-note-${id}`}
          className="text-sm font-medium text-[#111827]"
        >
          What did you find?
        </label>
        <InfoTip label="About the note">
          Required. The note is the audit trail for this item.
        </InfoTip>
      </div>
      <textarea
        id={`close-note-${id}`}
        className="dash-input w-full"
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      <button
        type="button"
        onClick={submit}
        disabled={pending || !note.trim()}
        className="mt-2 inline-flex items-center gap-2 rounded-lg bg-[#111827] px-4 py-2 text-sm font-semibold text-white transition hover:bg-black disabled:opacity-50"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" />}
        Close item
      </button>
    </div>
  );
}
