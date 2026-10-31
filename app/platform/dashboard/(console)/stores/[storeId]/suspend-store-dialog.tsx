"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
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
import { setStoreStatus } from "@/app/actions/platform";

// ---------------------------------------------------------------------------
// The plain Suspend, asked why (takedown design 6.7, plan A13). One dialog for
// the store page (`store-manage.tsx`) and the stores list
// (`stores-console.tsx`), so the two cannot ask differently.
//
// ★ A COMPLAINT IS NOT SUSPENDED HERE. Suspending over a complaint, an order
// or content that breaks our policies is a whole-store block, which keeps a
// copy of the store and tells its owners; this dialog sends the operator to
// "Suspend on a complaint" for that and never calls the action. Any other
// reason needs a note, which `setStoreStatus` records with the suspension.
// ★ THE SERVER IS THE BOUNDARY. `setStoreStatus` refuses a complaint reason
// and an empty note for itself; the dialog only says it first.
// ---------------------------------------------------------------------------

/** Every sentence the dialog shows (design 6.7, and the lines it left open). */
export const SUSPEND_DIALOG_TEXT = {
  title: (name: string) => `Suspend ${name}?`,
  question: "Why are you suspending this store?",
  complaint:
    "Because of a complaint, an order, or content that breaks our policies",
  other: "For another reason, for example the owner asked",
  /** The same sentence `setStoreStatus` answers a complaint reason with. */
  useBlock:
    "Use Suspend on a complaint instead, so that StoreMink keeps a copy of the store and tells its owners.",
  goToBlock: "Suspend on a complaint",
  /** Added: the note's label and hint (design 6.7 says only "needs a note"). */
  noteLabel: "Note",
  notePlaceholder:
    "For example: the owner asked us to close the store for now.",
  /** The same sentence `setStoreStatus` answers an empty note with. */
  noteMissing: "Write why you are suspending this store.",
  confirm: "Suspend store",
  done: "Store suspended.",
  /** Added: a request that failed before the server answered. */
  failed: "Couldn't suspend the store. Please try again.",
} as const;

/** "Suspend on a complaint": the block form with this store, whole store. */
export function suspendOnComplaintHref(storeId: string): string {
  return `/dashboard/complaints/block?store=${encodeURIComponent(storeId)}&kind=store`;
}

const PRIMARY = "dash-btn dash-btn-primary pointer-coarse:min-h-11";
const GHOST = "dash-btn dash-btn-ghost pointer-coarse:min-h-11";
const LABEL = "mb-1 block text-sm font-medium text-[var(--dash-text)]";
const ERROR = "text-sm text-[var(--dash-red)]";
const NOTICE =
  "rounded-[var(--dash-radius-sm)] bg-[var(--dash-surface-2)] px-3 py-2 text-sm text-[var(--dash-text)]";

type Why = "complaint" | "other";

/**
 * Mounted while open: Close (or Escape) calls `onClose`; a suspension that
 * went through shows its toast and calls `onSuspended`.
 */
export function SuspendStoreDialog({
  storeId,
  storeName,
  onClose,
  onSuspended,
}: {
  storeId: string;
  storeName: string;
  onClose: () => void;
  onSuspended: () => void;
}) {
  const [why, setWhy] = useState<Why | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function choose(next: Why) {
    setWhy(next);
    setError(null);
  }

  function suspend() {
    setError(null);
    if (!note.trim()) {
      setError(SUSPEND_DIALOG_TEXT.noteMissing);
      return;
    }
    start(async () => {
      try {
        const res = await setStoreStatus(storeId, "suspended", {
          kind: "other",
          note,
        });
        if (res.error) {
          setError(res.error);
          return;
        }
        toast.success(SUSPEND_DIALOG_TEXT.done);
        onSuspended();
      } catch {
        setError(SUSPEND_DIALOG_TEXT.failed);
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
          <DialogTitle>{SUSPEND_DIALOG_TEXT.title(storeName)}</DialogTitle>
          <DialogDescription>{SUSPEND_DIALOG_TEXT.question}</DialogDescription>
        </DialogHeader>

        <div
          role="radiogroup"
          aria-label={SUSPEND_DIALOG_TEXT.question}
          className="space-y-2"
        >
          {(
            [
              ["complaint", SUSPEND_DIALOG_TEXT.complaint],
              ["other", SUSPEND_DIALOG_TEXT.other],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="flex cursor-pointer items-start gap-2 rounded-[var(--dash-radius-sm)] border border-[var(--dash-border)] px-3 py-2 text-sm text-[var(--dash-text)] pointer-coarse:min-h-11"
            >
              <input
                type="radio"
                name="suspend-why"
                value={value}
                checked={why === value}
                onChange={() => choose(value)}
                disabled={pending}
                className="mt-0.5"
              />
              <span>{label}</span>
            </label>
          ))}
        </div>

        {why === "complaint" ? (
          <p role="status" className={NOTICE}>
            {SUSPEND_DIALOG_TEXT.useBlock}
          </p>
        ) : null}

        {why === "other" ? (
          <label className="block">
            <span className={LABEL}>{SUSPEND_DIALOG_TEXT.noteLabel}</span>
            <textarea
              className="dash-input w-full"
              rows={3}
              value={note}
              placeholder={SUSPEND_DIALOG_TEXT.notePlaceholder}
              onChange={(e) => setNote(e.target.value)}
              disabled={pending}
            />
          </label>
        ) : null}

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
          {why === "complaint" ? (
            <Link href={suspendOnComplaintHref(storeId)} className={PRIMARY}>
              {SUSPEND_DIALOG_TEXT.goToBlock}
            </Link>
          ) : null}
          {why === "other" ? (
            <button
              type="button"
              onClick={suspend}
              disabled={pending}
              className={PRIMARY}
            >
              {pending ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : null}
              {SUSPEND_DIALOG_TEXT.confirm}
            </button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
