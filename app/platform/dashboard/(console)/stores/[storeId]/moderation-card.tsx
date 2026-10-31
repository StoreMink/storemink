"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, ShieldAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  releaseStoreHoldAction,
  setStoreHoldAction,
} from "@/app/actions/takedown-actions";
// A type only: the module is server-only, and a type import is erased.
import type { StoreModerationSummary } from "@/lib/moderation/console-read";
import { suspendOnComplaintHref } from "./suspend-store-dialog";

// ---------------------------------------------------------------------------
// The store page's "Complaints and holds" card and its hold banner (takedown
// design 3.7, 6.7).
//
// ★ EVERY OPERATOR READS, A SUPERADMIN ACTS (design 3.10). The lines and
// links are for everyone who can open the page; "Put on hold", "Release
// hold" and "Suspend on a complaint" render only for a superadmin, and the
// actions check again on the server.
// ★ THE MERCHANT IS NEVER TOLD ABOUT A HOLD (decision D14): nothing here
// sends anything to the store, and the dialog says so.
// ★ A SUCCESS RE-RENDERS THE PAGE ITSELF (the actions call `refresh()`), so a
// dialog only closes and shows the action's own toast. Outside production an
// action also runs the minute's follow-up before it answers (up to 40 s), so
// the button keeps its pending state until then.
// ---------------------------------------------------------------------------

/** Every sentence of the card, the banner and the two dialogs. */
export const MODERATION_CARD_TEXT = {
  title: "Complaints and holds",
  blockedItems: (n: number) => `Blocked items: ${n}`,
  openComplaints: (n: number) => `Open complaints: ${n}`,
  suspendedByBlock: (date: string) => `Suspended by a block since ${date}`,
  /** Added: the hold state's two lines (design 6.7 says "the hold state"). */
  onHold: (date: string) => `On hold since ${date}`,
  notOnHold: "Not on hold",
  suspendOnComplaint: "Suspend on a complaint",
  putOnHold: "Put on hold",
  /** Added: the card when its read failed (it decides the Delete button). */
  readFailed:
    "This store's complaints and holds couldn't be read just now. Refresh the page to try again.",
  banner: (date: string, setBy: string, reason: string) =>
    `On hold for an investigation since ${date}, set by ${setBy}: ${reason}. It can't be deleted.`,
  holdTitle: (name: string) => `Put ${name} on hold?`,
  holdBody:
    "Nobody can delete this store while it is on hold. The store is not told.",
  reasonLabel: "Reason",
  whoAskedLabel: "Who asked",
  /** Added: the hint under "Who asked" (design 6.7: "authority and reference"). */
  whoAskedHint: "The authority and its reference.",
  complaintLabel: "Complaint",
  /** Added: the hint under "Complaint". */
  complaintHint: "Optional. The complaint's reference.",
  reviewOnLabel: "Review on",
  /** Added: the hint under "Review on". */
  reviewOnHint: "Optional. The Overview lists the hold from that day.",
  releaseTitle: (name: string) => `Release the hold on ${name}?`,
  /** Added: the release dialog's note label (design 6.7: "a required note"). */
  noteLabel: "Note",
  release: "Release hold",
  /** Added: a request that failed before the server answered. */
  failed: "Could not save it. Please try again.",
} as const;

const PRIMARY = "dash-btn dash-btn-primary pointer-coarse:min-h-11";
const GHOST = "dash-btn dash-btn-ghost pointer-coarse:min-h-11";
const LABEL = "mb-1 block text-sm font-medium text-[var(--dash-text)]";
const HINT = "mt-1 block text-xs text-[var(--dash-text-2)]";
const ERROR = "text-sm text-[var(--dash-red)]";
const LINK =
  "font-medium text-[var(--dash-accent)] hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center";

/** "26 Oct 2026", in India time like the rest of the store page. */
export function holdDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

/** The reason as the banner's sentence ends it, without a doubled stop. */
function reasonWords(reason: string): string {
  return reason.trim().replace(/[.!?]+$/, "");
}

/** The complaints list narrowed to this store, on one tab. */
export function storeComplaintsHref(
  storeId: string,
  view?: "blocks" | "holds",
): string {
  const params = new URLSearchParams();
  if (view) params.set("view", view);
  params.set("store", storeId);
  return `/dashboard/complaints?${params.toString()}`;
}

export function ModerationCard({
  storeId,
  storeName,
  summary,
  canManage,
}: {
  storeId: string;
  storeName: string;
  /** Null when the read failed: the card says so, and Delete is off. */
  summary: StoreModerationSummary | null;
  canManage: boolean;
}) {
  const [holding, setHolding] = useState(false);

  if (!summary) {
    return (
      <p role="status" className="text-sm text-[var(--dash-text-2)]">
        {MODERATION_CARD_TEXT.readFailed}
      </p>
    );
  }

  const lines: { key: string; text: string; href: string | null }[] = [
    {
      key: "blocks",
      text: MODERATION_CARD_TEXT.blockedItems(summary.activeBlocks),
      href: storeComplaintsHref(storeId, "blocks"),
    },
    {
      key: "complaints",
      text: MODERATION_CARD_TEXT.openComplaints(summary.openComplaints),
      href: storeComplaintsHref(storeId),
    },
  ];
  if (summary.storeBlock) {
    lines.push({
      key: "store-block",
      text: MODERATION_CARD_TEXT.suspendedByBlock(
        holdDate(summary.storeBlock.blockedAt),
      ),
      href: `/dashboard/complaints/blocks/${summary.storeBlock.id}`,
    });
  }
  lines.push(
    summary.hold
      ? {
          key: "hold",
          text: MODERATION_CARD_TEXT.onHold(holdDate(summary.hold.setAt)),
          href: storeComplaintsHref(storeId, "holds"),
        }
      : { key: "hold", text: MODERATION_CARD_TEXT.notOnHold, href: null },
  );

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-[var(--dash-border)] text-sm">
        {lines.map((line) => (
          <li key={line.key} className="py-2">
            {line.href ? (
              <Link href={line.href} className={LINK}>
                {line.text}
              </Link>
            ) : (
              <span className="text-[var(--dash-text-2)]">{line.text}</span>
            )}
          </li>
        ))}
      </ul>

      {canManage ? (
        <div className="flex flex-wrap gap-2">
          {summary.storeBlock ? null : (
            <Link href={suspendOnComplaintHref(storeId)} className={GHOST}>
              {MODERATION_CARD_TEXT.suspendOnComplaint}
            </Link>
          )}
          {summary.hold ? null : (
            <button
              type="button"
              onClick={() => setHolding(true)}
              className={GHOST}
            >
              {MODERATION_CARD_TEXT.putOnHold}
            </button>
          )}
        </div>
      ) : null}

      {holding ? (
        <PutOnHoldDialog
          storeId={storeId}
          storeName={storeName}
          onClose={() => setHolding(false)}
        />
      ) : null}
    </div>
  );
}

/** The banner at the top of the page while the store is held (design 6.7). */
export function HoldBanner({
  storeName,
  hold,
  canManage,
}: {
  storeName: string;
  hold: NonNullable<StoreModerationSummary["hold"]>;
  canManage: boolean;
}) {
  const [releasing, setReleasing] = useState(false);
  return (
    <div
      role="status"
      className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-[var(--dash-border-strong)] bg-[var(--dash-amber-soft)] px-4 py-3 text-sm text-[var(--dash-text)]"
    >
      <p className="flex min-w-0 items-start gap-2">
        <ShieldAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {MODERATION_CARD_TEXT.banner(
            holdDate(hold.setAt),
            hold.setBy,
            reasonWords(hold.reason),
          )}
        </span>
      </p>
      {canManage ? (
        <button
          type="button"
          onClick={() => setReleasing(true)}
          className={GHOST}
        >
          {MODERATION_CARD_TEXT.release}
        </button>
      ) : null}
      {releasing ? (
        <ReleaseHoldDialog
          holdId={hold.id}
          storeName={storeName}
          onClose={() => setReleasing(false)}
        />
      ) : null}
    </div>
  );
}

function PutOnHoldDialog({
  storeId,
  storeName,
  onClose,
}: {
  storeId: string;
  storeName: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [authorityRef, setAuthorityRef] = useState("");
  const [complaint, setComplaint] = useState("");
  const [reviewOn, setReviewOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      try {
        const res = await setStoreHoldAction({
          storeId,
          reason,
          authorityRef: authorityRef.trim() || null,
          complaint: complaint.trim() || null,
          reviewOn: reviewOn || null,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        toast.success(res.message);
        onClose();
      } catch {
        setError(MODERATION_CARD_TEXT.failed);
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{MODERATION_CARD_TEXT.holdTitle(storeName)}</DialogTitle>
          <DialogDescription>{MODERATION_CARD_TEXT.holdBody}</DialogDescription>
        </DialogHeader>
        <label className="block">
          <span className={LABEL}>{MODERATION_CARD_TEXT.reasonLabel}</span>
          <textarea
            className="dash-input w-full"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={pending}
            required
          />
        </label>
        <label className="block">
          <span className={LABEL}>{MODERATION_CARD_TEXT.whoAskedLabel}</span>
          <input
            className="dash-input w-full"
            value={authorityRef}
            onChange={(e) => setAuthorityRef(e.target.value)}
            disabled={pending}
          />
          <span className={HINT}>{MODERATION_CARD_TEXT.whoAskedHint}</span>
        </label>
        <label className="block">
          <span className={LABEL}>{MODERATION_CARD_TEXT.complaintLabel}</span>
          <input
            className="dash-input w-full"
            value={complaint}
            onChange={(e) => setComplaint(e.target.value)}
            disabled={pending}
          />
          <span className={HINT}>{MODERATION_CARD_TEXT.complaintHint}</span>
        </label>
        <label className="block">
          <span className={LABEL}>{MODERATION_CARD_TEXT.reviewOnLabel}</span>
          <input
            type="date"
            className="dash-input w-48"
            value={reviewOn}
            onChange={(e) => setReviewOn(e.target.value)}
            disabled={pending}
          />
          <span className={HINT}>{MODERATION_CARD_TEXT.reviewOnHint}</span>
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
            {MODERATION_CARD_TEXT.putOnHold}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReleaseHoldDialog({
  holdId,
  storeName,
  onClose,
}: {
  holdId: string;
  storeName: string;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      try {
        const res = await releaseStoreHoldAction(holdId, note);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        toast.success(res.message);
        onClose();
      } catch {
        setError(MODERATION_CARD_TEXT.failed);
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
          <DialogTitle>
            {MODERATION_CARD_TEXT.releaseTitle(storeName)}
          </DialogTitle>
        </DialogHeader>
        <label className="block">
          <span className={LABEL}>{MODERATION_CARD_TEXT.noteLabel}</span>
          <textarea
            className="dash-input w-full"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pending}
            required
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
            {MODERATION_CARD_TEXT.release}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
