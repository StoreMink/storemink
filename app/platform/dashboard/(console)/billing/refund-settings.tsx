"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Lock } from "lucide-react";
import { setAutoRefunds } from "@/app/actions/platform-billing";

// ---------------------------------------------------------------------------
// The refunds card on Billing & tax (renewal-cancel design 7.1; GST design 6:
// its own card, below the tax cards and the monthly invoice list).
//
// ★ It has its own action and its own column: none of the three tax saves
// reads or writes `auto_refunds`, and this card writes no tax column. While
// StoreMink's tax identity is incomplete the row's CHECKs refuse every write,
// this switch included; the action then answers with
// AUTO_REFUNDS_IDENTITY_INCOMPLETE (GST plan A2), which shows under the
// switch like any other refusal.
//
// ★ `unreadable` (review R3-05): the settings could not be read, so the switch
// shows the default (off), not what is stored, and is disabled.
// ---------------------------------------------------------------------------

/** Shown only when the request itself failed, never for a refusal. */
const AUTO_REFUNDS_REQUEST_FAILED =
  "The request didn't reach StoreMink. Refresh the page and try again.";

/**
 * "Send refunds automatically" (renewal-cancel, design 7.1).
 *
 * ★ It saves the moment it is switched, on its own card, apart from the tax
 * forms' Save buttons: it decides whether money leaves without anyone pressing
 * Send, so it must never ride along unnoticed with a GSTIN edit. A refusal
 * switches it back and shows the action's own sentence under it.
 */
export function AutoRefundsSwitch({
  initial,
  canEdit,
  unreadable = false,
}: {
  initial: boolean;
  canEdit: boolean;
  /** The settings could not be read: `initial` is only the default. */
  unreadable?: boolean;
}) {
  const [on, setOn] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function toggle(next: boolean) {
    setError(null);
    setOn(next);
    start(async () => {
      try {
        const res = await setAutoRefunds(next);
        if ("error" in res) {
          setOn(!next);
          setError(res.error);
          return;
        }
        toast.success(
          next
            ? "Refunds will be sent automatically."
            : "Refunds will wait for an operator to press Send.",
        );
      } catch {
        setOn(!next);
        setError(AUTO_REFUNDS_REQUEST_FAILED);
      }
    });
  }

  return (
    <section
      aria-labelledby="auto-refunds-title"
      className="dash-card mt-6 max-w-3xl p-6"
    >
      <h2
        id="auto-refunds-title"
        className="text-base font-semibold text-[var(--dash-text)]"
      >
        Refunds
      </h2>
      <label className="mt-3 flex items-center gap-3 text-sm text-[var(--dash-text)] pointer-coarse:min-h-11">
        <input
          type="checkbox"
          role="switch"
          aria-checked={on}
          checked={on}
          onChange={(e) => toggle(e.target.checked)}
          disabled={!canEdit || unreadable || pending}
          className="h-5 w-5 shrink-0 accent-[var(--dash-accent)]"
        />
        <span className="font-medium">Send refunds automatically</span>
        {pending ? (
          <Loader2
            aria-hidden
            className="h-4 w-4 animate-spin text-[var(--dash-text-2)]"
          />
        ) : null}
      </label>
      <p className="mt-2 max-w-2xl text-xs text-[var(--dash-text-2)]">
        When on, the hourly billing run sends each refund StoreMink owes as soon
        as it&apos;s owed, back to the payment it came from. When off, each one
        waits on the Refunds page for an operator to press Send, and merchants
        who were told their refund is on its way wait too. Refunds an operator
        issues are always sent at once.
      </p>
      {!canEdit ? (
        <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-[var(--dash-text-2)]">
          <Lock aria-hidden className="h-3.5 w-3.5" />
          Only a platform superadmin can change this.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-[var(--dash-red)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}
