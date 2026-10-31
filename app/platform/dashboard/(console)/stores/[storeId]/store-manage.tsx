"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUpCircle, Coins, Power, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoTip } from "@/components/ui/info-tip";
import {
  deleteStore,
  grantAiCredits,
  setStorePlan,
  setStoreStatus,
} from "@/app/actions/platform";
import { PLAN_IDS, PLAN_META, normalizePlan, type Plan } from "@/lib/plans";
import { SuspendStoreDialog } from "./suspend-store-dialog";

// ---------------------------------------------------------------------------
// The four things an operator can DO to a store, on the store's own page.
//
// ★ THEY LIVE HERE RATHER THAN ONLY IN THE LIST because acting on a store from
// a row of 500 means acting on whichever row you last hovered. On this page the
// name of the store you are suspending is the heading above the button.
//
// ★ EVERY ACTION RE-GATES SERVER-SIDE. `canManage` decides what to RENDER;
// `setStoreStatus` / `setStorePlan` / `grantAiCredits` / `deleteStore` each
// check `role === "superadmin"` for themselves. A hidden button is not a
// permission.
//
// ★ StoreMink's holds and blocks (takedown design 6.7). Suspend asks why
// (`SuspendStoreDialog`); Activate and Delete are disabled, with the reason
// written under them, while a block keeps the store suspended or the store
// cannot be deleted. The server refuses either way, and a refusal it gives
// is shown as an error toast in its own words.
// ---------------------------------------------------------------------------

/**
 * Why Delete is off (design 6.7), or why we could not tell: the store page's
 * moderation read failed, so the button fails closed.
 */
export type DeleteBlocker = "hold" | "archive" | "unchecked";

export const STORE_MANAGE_TEXT = {
  deleteBlocked: {
    hold: "This store is on hold for an investigation. Release the hold first.",
    archive:
      "StoreMink is still keeping a copy of something blocked on this store. Try again in a few minutes.",
    /** Added: the page's read of holds and blocks failed. */
    unchecked:
      "StoreMink couldn't check whether this store can be deleted. Refresh the page to try again.",
  } satisfies Record<DeleteBlocker, string>,
  suspendedByBlock:
    "This store is suspended by a block on a complaint. Lift the block in Complaints.",
} as const;

const DURATIONS = [
  { id: "indefinite", label: "Indefinite" },
  { id: "1", label: "1 month" },
  { id: "3", label: "3 months" },
  { id: "6", label: "6 months" },
  { id: "12", label: "12 months" },
  { id: "custom", label: "Custom date" },
] as const;
type Duration = (typeof DURATIONS)[number]["id"];

const PRIMARY = "dash-btn dash-btn-primary pointer-coarse:min-h-11";
const GHOST = "dash-btn dash-btn-ghost pointer-coarse:min-h-11";
const DANGER =
  "inline-flex items-center justify-center gap-1.5 rounded-md bg-red-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11";
const LABEL = "mb-1 block text-sm font-medium text-[var(--dash-text)]";

/** One of the bar's dialogs, in the console's standard dialog look. */
function ManageDialog({
  title,
  description,
  onClose,
  footer,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  onClose: () => void;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="space-y-4">{children}</div>
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StoreManageBar({
  storeId,
  slug,
  name,
  status,
  plan,
  canManage,
  suspendedByBlock = false,
  deleteBlocker = null,
}: {
  storeId: string;
  slug: string;
  name: string;
  status: string;
  plan: Plan;
  canManage: boolean;
  /** A live whole-store block keeps the store suspended (Activate is off). */
  suspendedByBlock?: boolean;
  deleteBlocker?: DeleteBlocker | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  const [planOpen, setPlanOpen] = useState(false);
  const [targetPlan, setTargetPlan] = useState<Plan>(normalizePlan(plan));
  const [duration, setDuration] = useState<Duration>("indefinite");
  const [customDate, setCustomDate] = useState("");

  const [creditsOpen, setCreditsOpen] = useState(false);
  const [creditAmount, setCreditAmount] = useState("25");
  const [creditNote, setCreditNote] = useState("");

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const [suspendOpen, setSuspendOpen] = useState(false);

  const fieldId = useId();

  if (!canManage) return null;

  function done(message: string) {
    toast.success(message);
    startTransition(() => router.refresh());
  }

  /** Activate: the plain reactivation; a suspension asks why first. */
  async function activate() {
    setBusy(true);
    try {
      const res = await setStoreStatus(storeId, "active");
      if (res.error) return void toast.error(res.error);
      done("Store reactivated.");
    } catch {
      toast.error("Could not update the store. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const activateOff = status !== "active" && suspendedByBlock;

  /** The expiry the current selection resolves to, or an error to show. */
  function selectedExpiry(): { expiresAt: string | null } | { error: string } {
    if (targetPlan === "free" || duration === "indefinite") {
      return { expiresAt: null };
    }
    if (duration === "custom") {
      if (!customDate) return { error: "Pick an expiry date." };
      const end = new Date(`${customDate}T23:59:59.999`);
      if (Number.isNaN(end.getTime()) || end.getTime() <= Date.now()) {
        return { error: "The expiry date must be in the future." };
      }
      return { expiresAt: end.toISOString() };
    }
    const end = new Date();
    end.setMonth(end.getMonth() + Number(duration));
    return { expiresAt: end.toISOString() };
  }

  async function savePlan() {
    const resolved = selectedExpiry();
    if ("error" in resolved) return void toast.error(resolved.error);

    setBusy(true);
    const res = await setStorePlan(storeId, targetPlan, {
      expiresAt: resolved.expiresAt,
    });
    setBusy(false);
    if (res.error) return void toast.error(res.error);
    setPlanOpen(false);
    done(`${name} is now on ${PLAN_META[targetPlan]?.name ?? targetPlan}.`);
  }

  async function saveCredits() {
    const amount = Number(creditAmount);
    if (!Number.isInteger(amount) || amount < 1) {
      return void toast.error("Enter a whole number of credits.");
    }
    setBusy(true);
    const res = await grantAiCredits(storeId, amount, creditNote || undefined);
    setBusy(false);
    if (res.error) return void toast.error(res.error);
    setCreditsOpen(false);
    setCreditNote("");
    done(`Granted ${amount} credits.`);
  }

  async function confirmDelete() {
    setBusy(true);
    let res: Awaited<ReturnType<typeof deleteStore>>;
    try {
      res = await deleteStore(storeId);
    } catch {
      setBusy(false);
      return void toast.error("Could not delete the store. Please try again.");
    }
    setBusy(false);
    // A hold set, or a copy started, since this page was drawn: the server's
    // own sentence (design 6.7).
    if (res.error) return void toast.error(res.error);
    if (res.warning) toast.warning(res.warning);
    else toast.success(`${name} deleted.`);
    // Back to the list — the page we are on no longer describes anything.
    router.push("/dashboard/stores");
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setPlanOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-50 px-3.5 py-2 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-100"
        >
          <ArrowUpCircle className="h-4 w-4" /> Plan
        </button>
        <button
          onClick={() => setCreditsOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-50 px-3.5 py-2 text-sm font-semibold text-amber-700 transition hover:bg-amber-100"
        >
          <Coins className="h-4 w-4" /> Credits
        </button>
        <button
          onClick={() =>
            status === "active" ? setSuspendOpen(true) : void activate()
          }
          disabled={busy || activateOff}
          aria-describedby={activateOff ? "store-activate-off" : undefined}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Power className="h-4 w-4" />
          {status === "active" ? "Suspend" : "Activate"}
        </button>
        <button
          onClick={() => {
            setConfirmText("");
            setDeleteOpen(true);
          }}
          disabled={!!deleteBlocker}
          aria-describedby={deleteBlocker ? "store-delete-off" : undefined}
          className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
        >
          <Trash2 className="h-4 w-4" /> Delete
        </button>
      </div>
      {activateOff || deleteBlocker ? (
        <div className="mt-2 max-w-md space-y-1 text-xs text-slate-600">
          {activateOff ? (
            <p id="store-activate-off">{STORE_MANAGE_TEXT.suspendedByBlock}</p>
          ) : null}
          {deleteBlocker ? (
            <p id="store-delete-off">
              {STORE_MANAGE_TEXT.deleteBlocked[deleteBlocker]}
            </p>
          ) : null}
        </div>
      ) : null}

      {suspendOpen ? (
        <SuspendStoreDialog
          storeId={storeId}
          storeName={name}
          onClose={() => setSuspendOpen(false)}
          onSuspended={() => {
            setSuspendOpen(false);
            startTransition(() => router.refresh());
          }}
        />
      ) : null}

      {planOpen && (
        <ManageDialog
          title={`Change plan - ${name}`}
          onClose={() => !busy && setPlanOpen(false)}
          footer={
            <>
              <button
                type="button"
                className={GHOST}
                onClick={() => setPlanOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className={PRIMARY}
                disabled={busy}
                onClick={savePlan}
              >
                {busy ? "Saving…" : "Save plan"}
              </button>
            </>
          }
        >
          <div>
            <label htmlFor={`${fieldId}-plan`} className={LABEL}>
              Plan
            </label>
            <select
              id={`${fieldId}-plan`}
              className="dash-input w-full"
              value={targetPlan}
              onChange={(e) => setTargetPlan(e.target.value as Plan)}
            >
              {PLAN_IDS.map((id) => (
                <option key={id} value={id}>
                  {PLAN_META[id]?.name ?? id}
                </option>
              ))}
            </select>
          </div>

          {targetPlan !== "free" && (
            <div>
              <div className="mb-1 flex items-center gap-1.5">
                <label
                  htmlFor={`${fieldId}-duration`}
                  className="text-sm font-medium text-[var(--dash-text)]"
                >
                  Duration
                </label>
                <InfoTip label="About the duration">
                  A timed grant lapses to Free when it ends. Paid billing may
                  raise an operator grant, never lower it.
                </InfoTip>
              </div>
              <select
                id={`${fieldId}-duration`}
                className="dash-input w-full"
                value={duration}
                onChange={(e) => setDuration(e.target.value as Duration)}
              >
                {DURATIONS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
              {duration === "custom" && (
                <input
                  type="date"
                  aria-label="Expiry date"
                  className="dash-input mt-2 w-full"
                  value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                />
              )}
            </div>
          )}
        </ManageDialog>
      )}

      {creditsOpen && (
        <ManageDialog
          title={`Grant Mink credits - ${name}`}
          description="Credits never expire and are used after the monthly allowance. The grant and your note are recorded under your email."
          onClose={() => !busy && setCreditsOpen(false)}
          footer={
            <>
              <button
                type="button"
                className={GHOST}
                onClick={() => setCreditsOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className={PRIMARY}
                disabled={busy}
                onClick={saveCredits}
              >
                {busy ? "Granting…" : "Grant"}
              </button>
            </>
          }
        >
          <div>
            <label htmlFor={`${fieldId}-credits`} className={LABEL}>
              Credits
            </label>
            <input
              id={`${fieldId}-credits`}
              type="number"
              min={1}
              className="dash-input w-full"
              value={creditAmount}
              onChange={(e) => setCreditAmount(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={`${fieldId}-note`} className={LABEL}>
              Note{" "}
              <span className="font-normal text-[var(--dash-text-2)]">
                (optional)
              </span>
            </label>
            <input
              id={`${fieldId}-note`}
              className="dash-input w-full"
              value={creditNote}
              onChange={(e) => setCreditNote(e.target.value)}
            />
          </div>
        </ManageDialog>
      )}

      {deleteOpen && (
        <ManageDialog
          title={`Delete ${name}?`}
          description="This permanently removes the store, all its data and every login attached to it. It cannot be undone."
          onClose={() => !busy && setDeleteOpen(false)}
          footer={
            <>
              <button
                type="button"
                className={GHOST}
                onClick={() => setDeleteOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className={DANGER}
                disabled={busy || confirmText !== slug}
                onClick={confirmDelete}
              >
                {busy ? "Deleting…" : "Delete permanently"}
              </button>
            </>
          }
        >
          <div>
            <label htmlFor={`${fieldId}-confirm`} className={LABEL}>
              Type{" "}
              <code className="rounded bg-[var(--dash-surface-2)] px-1">
                {slug}
              </code>{" "}
              to confirm
            </label>
            <input
              id={`${fieldId}-confirm`}
              className="dash-input w-full"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
            />
          </div>
        </ManageDialog>
      )}
    </>
  );
}
