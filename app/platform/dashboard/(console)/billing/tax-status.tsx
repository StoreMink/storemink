"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cancelGstChange } from "@/app/actions/platform";
import type { PlatformTaxSettings } from "@/lib/billing/invoice-types";
import {
  TAX_CONSOLE,
  TAX_STATUS,
  cancelChangeConfirm,
  taxStatusSentence,
} from "@/lib/billing/tax-copy";
import {
  termsAt,
  type TaxTerms,
  type TaxTermsSource,
} from "@/lib/billing/tax-terms";

// ---------------------------------------------------------------------------
// Card 1, GST status (GST design 6.2): one sentence saying what is charged now
// and what is scheduled, the way to withdraw a scheduled change, and the amber
// line while the LLP's particulars are missing from every invoice.
//
// ★ THE SENTENCE IS `termsAt(settings, now)`, the rule invoices are built by,
// so a change whose start has passed reads as started even before the hourly
// run copies it into the in-force columns. `now` comes from the server render,
// so the server and the browser draw the same sentence.
//
// ★★ SETTINGS THAT COULD NOT BE READ (`unreadable`, review R3-05) ARE NOT
// SUMMARISED: the card says so (TAX_CONSOLE.readFailed) where the sentence
// would be, and offers no cancel, no LLP line and no "last changed", because
// every one of them would describe the defaults rather than what is stored.
// ---------------------------------------------------------------------------

/** The settings row's columns `termsAt` reads (tax-terms.ts). */
export function termsSourceOf(settings: PlatformTaxSettings): TaxTermsSource {
  const next = settings.nextTax;
  return {
    taxEnabled: settings.taxEnabled,
    taxInclusive: settings.taxInclusive,
    taxRateBps: settings.taxRateBps,
    nextTaxEnabled: next ? next.enabled : null,
    nextTaxInclusive: next ? next.inclusive : null,
    nextTaxRateBps: next ? next.rateBps : null,
    nextTaxStartsAt: next ? next.startsAt : null,
  };
}

/** The terms in force at `nowIso` for these settings. */
export function termsFor(
  settings: PlatformTaxSettings,
  nowIso: string,
): TaxTerms {
  return termsAt(termsSourceOf(settings), new Date(nowIso));
}

/** Blank while the LLPIN or the registered office is (design 6.2). */
export function llpParticularsMissing(settings: PlatformTaxSettings): boolean {
  return !settings.llpin?.trim() || !settings.registeredOffice?.trim();
}

export function TaxStatus({
  settings,
  canEdit,
  now,
  unreadable = false,
}: {
  settings: PlatformTaxSettings;
  canEdit: boolean;
  /** ISO, from the server render. */
  now: string;
  /** The settings could not be read: `settings` are only the defaults. */
  unreadable?: boolean;
}) {
  const router = useRouter();
  const terms = termsFor(settings, now);
  const upcoming = terms.upcoming;
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();

  function cancelChange() {
    start(async () => {
      try {
        const res = await cancelGstChange();
        if (res.error) {
          toast.error(res.error);
        } else {
          toast.success(TAX_STATUS.cancelled);
        }
      } catch {
        toast.error(REQUEST_FAILED);
      }
      setConfirming(false);
      // Refused or not, the card reloads: a change that started while the
      // page was open must show as started (design 6.2).
      router.refresh();
    });
  }

  return (
    <section
      aria-labelledby="tax-status-title"
      className="dash-card max-w-3xl p-6"
    >
      <h2
        id="tax-status-title"
        className="text-base font-semibold text-[var(--dash-text)]"
      >
        {TAX_CONSOLE.statusTitle}
      </h2>
      {unreadable ? (
        <p
          role="alert"
          data-testid="tax-status-unreadable"
          className="mt-2 rounded-[var(--dash-radius-sm)] bg-[var(--dash-amber-soft)] px-3 py-2 text-sm text-[var(--dash-text)]"
        >
          {TAX_CONSOLE.readFailed}
        </p>
      ) : (
        <p
          data-testid="tax-status-sentence"
          className="mt-2 text-sm text-[var(--dash-text)]"
        >
          {taxStatusSentence(terms)}
        </p>
      )}

      {!unreadable && llpParticularsMissing(settings) ? (
        <p className="mt-3 flex items-start gap-2 rounded-[var(--dash-radius-sm)] bg-[var(--dash-amber-soft)] px-3 py-2 text-xs text-[var(--dash-text)]">
          <AlertTriangle
            aria-hidden
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--dash-amber)]"
          />
          <span>{TAX_STATUS.llpMissing}</span>
        </p>
      ) : null}

      {upcoming && canEdit && !unreadable && !confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="dash-btn dash-btn-ghost dash-btn-sm mt-4 pointer-coarse:min-h-11"
        >
          {TAX_STATUS.cancel}
        </button>
      ) : null}

      {upcoming && canEdit && !unreadable && confirming ? (
        <div
          role="group"
          aria-label={TAX_STATUS.cancel}
          className="mt-4 rounded-[var(--dash-radius-sm)] border border-[var(--dash-border-strong)] p-3"
        >
          <p className="text-sm text-[var(--dash-text)]">
            {cancelChangeConfirm(upcoming.startsAt)}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={cancelChange}
              disabled={pending}
              className="dash-btn dash-btn-primary dash-btn-sm inline-flex items-center gap-2 pointer-coarse:min-h-11"
            >
              {pending ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : null}
              {TAX_STATUS.confirmCancel}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
            >
              {TAX_STATUS.keep}
            </button>
          </div>
        </div>
      ) : null}

      {!unreadable && settings.updatedAt ? (
        <p className="mt-4 text-xs text-[var(--dash-text-2)]">
          Last changed{" "}
          {new Date(settings.updatedAt).toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            timeZone: "Asia/Kolkata",
          })}
          {settings.updatedBy ? ` by ${settings.updatedBy}` : ""}
        </p>
      ) : null}
    </section>
  );
}

/** Shown only when the request itself failed, never for a refusal. */
export const REQUEST_FAILED =
  "The request didn't reach StoreMink. Refresh the page and try again.";
