"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  getGstChangeNotices,
  getGstChangePreview,
  scheduleGstChange,
} from "@/app/actions/platform";
import type { GstImpactRow } from "@/lib/billing/gst-impact";
import type { PlatformTaxSettings } from "@/lib/billing/invoice-types";
import {
  TAX_CHANGE,
  TAX_CONSOLE,
  changeButtonLabel,
  changeScheduledToast,
  formatRupees,
  impactLines,
  impactPaidHow,
  impactStateOnInvoices,
  impactTruncatedNote,
  impactWarning,
  istShortDate,
  noticeOptionLabel,
  priceModeOptions,
  switchOnNowConfirm,
  tooSoonAfterNotice,
} from "@/lib/billing/tax-copy";
import {
  LAW_SET_RATE_RISE_WITHOUT_NOTICE,
  raisesPayable,
  type TaxValues,
} from "@/lib/billing/tax-terms";
import { PLAN_META } from "@/lib/plans";
import { Field, ReadOnlyNote } from "./tax-identity-form";
import { REQUEST_FAILED, termsFor } from "./tax-status";

// ---------------------------------------------------------------------------
// Card 3, Charging GST (GST design 6.4): what is charged, now or from a start,
// under the notice rule, with what it changes for merchants with a plan.
//
// ★ THE SAVE DECIDES, NOT THIS FORM. `scheduleTaxChange` re-reads the row under
// a lock and refuses what it must (a rise starting now, a rise without a
// qualifying notice, a start too soon after it). This form mirrors the same
// rules (`raisesPayable`, `noticeQualifies` through the notices read) only so
// the notice select and the impact panel appear when they will be needed.
//
// ★★ `unreadable` (review R3-05): the settings could not be read, so what is
// "charged now" here is only the defaults, and every control is disabled.
// ---------------------------------------------------------------------------

type Notices = Awaited<ReturnType<typeof getGstChangeNotices>>;
type Preview = Awaited<ReturnType<typeof getGstChangePreview>>;

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/**
 * A `datetime-local` value ("2026-12-01T00:00") read as India time, as ISO
 * text; null when it does not parse.
 */
export function istLocalToIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return null;
  const ms =
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
    ) - IST_OFFSET_MS;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** An instant as a `datetime-local` value in India time ("2026-12-01T00:00"). */
export function isoToIstLocal(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 16);
}

/** A rate typed as a percent, as basis points; null when it is not 0 to 100. */
export function rateBpsOf(text: string): number | null {
  if (!text.trim()) return null;
  const pct = Number(text);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return Math.round(pct * 100);
}

/** "Pro, monthly" for the impact table. */
function planLabel(row: GstImpactRow): string {
  const name = PLAN_META[row.plan].name;
  return `${name}, ${row.period}`;
}

export function TaxChangeForm({
  settings,
  canEdit,
  now,
  basicMonthlyPaise,
  notices,
  unreadable = false,
}: {
  settings: PlatformTaxSettings;
  canEdit: boolean;
  /** The settings could not be read: `settings` are only the defaults. */
  unreadable?: boolean;
  /** ISO, from the server render. */
  now: string;
  /** The live Basic monthly price, for the price-mode examples. */
  basicMonthlyPaise: number;
  /** Null when the announcements could not be read. */
  notices: Notices;
}) {
  const router = useRouter();
  const terms = termsFor(settings, now);
  // What is charged now, as the save compares it (`effectiveRise`).
  const before: TaxValues = {
    enabled: terms.active,
    inclusive: terms.inclusive,
    rateBps: terms.active ? terms.rateBps : settings.taxRateBps,
  };

  const [enabled, setEnabled] = useState(before.enabled);
  const [inclusive, setInclusive] = useState(before.inclusive);
  const [rateText, setRateText] = useState(String(before.rateBps / 100));
  const [when, setWhen] = useState<"now" | "scheduled">("now");
  const [startsLocal, setStartsLocal] = useState("");
  const [noticeId, setNoticeId] = useState("");
  const [lawChanged, setLawChanged] = useState(false);
  const [step, setStep] = useState<"edit" | "warn" | "confirm">("edit");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const rateBps = rateBpsOf(rateText);
  const after: TaxValues = {
    enabled,
    inclusive,
    rateBps: rateBps ?? before.rateBps,
  };
  const rise = rateBps === null ? null : raisesPayable(before, after);
  const showLaw = LAW_SET_RATE_RISE_WITHOUT_NOTICE && rise === "rate";
  const needsNotice = rise !== null && !(showLaw && lawChanged);
  const switchesOn = !before.enabled && enabled;
  // The impact panel: for every change that switches GST on or raises what
  // merchants pay (design 6.4).
  const showImpact =
    enabled && rateBps !== null && (switchesOn || rise !== null);

  // ── The impact preview, asked again whenever the proposal changes ────────
  // ★ Each answer is kept with the proposal it was asked for, so an answer for
  // an earlier proposal is never shown (or warned from) under a newer one.
  const [answer, setAnswer] = useState<{ key: string; result: Preview } | null>(
    null,
  );
  const asked = useRef(0);
  const proposalKey = showImpact ? `${enabled}:${inclusive}:${rateBps}` : "";
  useEffect(() => {
    if (!proposalKey) return;
    const id = ++asked.current;
    const timer = setTimeout(() => {
      getGstChangePreview({
        enabled,
        inclusive,
        ratePercent: (rateBps ?? 0) / 100,
      })
        .then((result) => {
          if (asked.current === id) setAnswer({ key: proposalKey, result });
        })
        .catch(() => {
          if (asked.current === id) {
            setAnswer({
              key: proposalKey,
              result: { ok: false, reason: "read_failed" },
            });
          }
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [proposalKey, enabled, inclusive, rateBps]);
  const preview =
    showImpact && answer && answer.key === proposalKey ? answer.result : null;
  const impact = preview && preview.ok ? preview.impact : null;
  const warning = impact
    ? impactWarning(impact.counts.noState, impact.counts.outsideIndia)
    : null;

  const modes = priceModeOptions(basicMonthlyPaise, after.rateBps);
  const chosenNotice = notices?.find((n) => n.id === noticeId) ?? null;
  const startsIso = when === "scheduled" ? istLocalToIso(startsLocal) : null;
  const tooSoon =
    needsNotice &&
    when === "scheduled" &&
    chosenNotice?.earliestStart &&
    chosenNotice.sentAt &&
    startsIso &&
    Date.parse(startsIso) < Date.parse(chosenNotice.earliestStart)
      ? tooSoonAfterNotice(chosenNotice.earliestStart, chosenNotice.sentAt)
      : null;

  function save() {
    setError(null);
    start(async () => {
      try {
        const res = await scheduleGstChange({
          enabled,
          inclusive,
          ratePercent: rateText,
          when,
          startsAt: startsIso ?? undefined,
          noticeId: needsNotice && noticeId ? noticeId : null,
          rateSetByLaw: showLaw && lawChanged,
        });
        setStep("edit");
        if (!res.ok) {
          setError(res.error);
          toast.error(res.error);
          return;
        }
        toast.success(
          res.applied === "scheduled" && res.startsAt
            ? changeScheduledToast(res.startsAt)
            : TAX_CHANGE.saved,
        );
        router.refresh();
      } catch {
        setStep("edit");
        setError(REQUEST_FAILED);
      }
    });
  }

  /** The button: the warning first, then the confirmation for "now". */
  function next() {
    setError(null);
    if (step === "edit" && showImpact && warning) {
      setStep("warn");
      return;
    }
    if (step !== "confirm" && when === "now" && switchesOn) {
      setStep("confirm");
      return;
    }
    save();
  }

  const disabled = !canEdit || unreadable || pending;

  return (
    <section
      aria-labelledby="tax-change-title"
      className="dash-card mt-6 max-w-3xl p-6"
    >
      <h2
        id="tax-change-title"
        className="mb-4 text-base font-semibold text-[var(--dash-text)]"
      >
        {TAX_CONSOLE.changeTitle}
      </h2>

      <fieldset className="mb-5 space-y-2" disabled={disabled}>
        <legend className="sr-only">{TAX_CONSOLE.changeTitle}</legend>
        <Choice
          disabled={disabled}
          name="gst-charge"
          checked={!enabled}
          onChange={() => setEnabled(false)}
          title={TAX_CHANGE.dontCharge}
        />
        <Choice
          disabled={disabled}
          name="gst-charge"
          checked={enabled}
          onChange={() => setEnabled(true)}
          title={TAX_CHANGE.charge}
        />
      </fieldset>

      {enabled ? (
        <>
          <Field
            id="gst-rate"
            label={TAX_CHANGE.rateLabel}
            hint={TAX_CHANGE.rateHint}
          >
            <div className="flex items-center gap-2">
              <input
                id="gst-rate"
                className="dash-input w-24"
                value={rateText}
                onChange={(e) => setRateText(e.target.value)}
                disabled={disabled}
                inputMode="decimal"
              />
              <span className="text-sm text-[var(--dash-text-2)]">%</span>
            </div>
          </Field>

          <fieldset className="mb-5 space-y-2" disabled={disabled}>
            <legend className="sr-only">Prices</legend>
            <Choice
              disabled={disabled}
              name="gst-prices"
              checked={inclusive}
              onChange={() => setInclusive(true)}
              title={modes.inclusive.title}
              body={modes.inclusive.body}
            />
            <Choice
              disabled={disabled}
              name="gst-prices"
              checked={!inclusive}
              onChange={() => setInclusive(false)}
              title={modes.exclusive.title}
              body={modes.exclusive.body}
            />
          </fieldset>
        </>
      ) : null}

      <fieldset className="mb-2 space-y-2" disabled={disabled}>
        <legend className="sr-only">When</legend>
        <Choice
          disabled={disabled}
          name="gst-when"
          checked={when === "now"}
          onChange={() => setWhen("now")}
          title={TAX_CHANGE.now}
        />
        <Choice
          disabled={disabled}
          name="gst-when"
          checked={when === "scheduled"}
          onChange={() => setWhen("scheduled")}
          title={TAX_CHANGE.scheduled}
        />
      </fieldset>
      {when === "scheduled" ? (
        <div className="mb-2">
          <label className="sr-only" htmlFor="gst-starts">
            {TAX_CHANGE.scheduled}
          </label>
          <div className="flex items-center gap-2">
            <input
              id="gst-starts"
              type="datetime-local"
              className="dash-input w-64"
              value={startsLocal}
              onChange={(e) => setStartsLocal(e.target.value)}
              disabled={disabled}
              min={
                chosenNotice?.earliestStart
                  ? isoToIstLocal(chosenNotice.earliestStart)
                  : undefined
              }
            />
            <span className="text-sm text-[var(--dash-text-2)]">IST</span>
          </div>
        </div>
      ) : null}
      <p className="mb-5 text-xs text-[var(--dash-text-2)]">
        {TAX_CHANGE.whenHint}
      </p>

      {needsNotice ? (
        <Field
          id="gst-notice"
          label={TAX_CHANGE.noticeLabel}
          hint={TAX_CHANGE.noticeHint}
        >
          {notices === null ? (
            <p role="status" className="text-sm text-[var(--dash-text-2)]">
              The announcements couldn&apos;t be read just now. Refresh the page
              to try again.
            </p>
          ) : (
            <select
              id="gst-notice"
              className="dash-input w-full"
              value={noticeId}
              onChange={(e) => setNoticeId(e.target.value)}
              disabled={disabled}
            >
              <option value="">Choose the notice</option>
              {notices.map((n) => (
                <option key={n.id} value={n.id} disabled={!n.check.ok}>
                  {noticeOptionLabel(n)}
                </option>
              ))}
            </select>
          )}
          <Link
            href="/dashboard/announcements"
            className="mt-2 inline-flex text-sm text-[var(--dash-accent)] hover:underline pointer-coarse:min-h-11"
          >
            {TAX_CHANGE.noticeLink}
          </Link>
          {tooSoon ? (
            <p className="mt-2 text-xs text-[var(--dash-text)]">{tooSoon}</p>
          ) : null}
        </Field>
      ) : null}

      {showLaw ? (
        <label className="mb-5 flex items-center gap-2 text-sm text-[var(--dash-text)]">
          <input
            type="checkbox"
            checked={lawChanged}
            onChange={(e) => setLawChanged(e.target.checked)}
            disabled={disabled}
          />
          {TAX_CHANGE.lawChanged}
        </label>
      ) : null}

      {showImpact ? <ImpactPanel preview={preview} /> : null}

      <p className="mb-6 flex items-start gap-2 rounded-[var(--dash-radius-sm)] bg-[var(--dash-amber-soft)] px-3 py-2 text-xs text-[var(--dash-text)]">
        <AlertTriangle
          aria-hidden
          className="mt-0.5 h-4 w-4 shrink-0 text-[var(--dash-amber)]"
        />
        <span>{TAX_CHANGE.amberNote}</span>
      </p>

      {step === "warn" && warning ? (
        <div
          role="group"
          aria-label={TAX_CHANGE.impactTitle}
          className="mb-4 rounded-[var(--dash-radius-sm)] border border-[var(--dash-border-strong)] p-3"
        >
          <p className="text-sm text-[var(--dash-text)]">{warning}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                when === "now" && switchesOn ? setStep("confirm") : save()
              }
              disabled={disabled}
              className="dash-btn dash-btn-primary dash-btn-sm pointer-coarse:min-h-11"
            >
              {TAX_CHANGE.scheduleAnyway}
            </button>
            <button
              type="button"
              onClick={() => setStep("edit")}
              disabled={pending}
              className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
            >
              {TAX_CHANGE.goBack}
            </button>
          </div>
        </div>
      ) : null}

      {step === "confirm" ? (
        <div
          role="group"
          aria-label={TAX_CHANGE.switchOn}
          className="mb-4 rounded-[var(--dash-radius-sm)] border border-[var(--dash-border-strong)] p-3"
        >
          <p className="text-sm text-[var(--dash-text)]">
            {switchOnNowConfirm(after.rateBps, inclusive)}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={save}
              disabled={disabled}
              className="dash-btn dash-btn-primary dash-btn-sm inline-flex items-center gap-2 pointer-coarse:min-h-11"
            >
              {pending ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : null}
              {TAX_CHANGE.switchOn}
            </button>
            <button
              type="button"
              onClick={() => setStep("edit")}
              disabled={pending}
              className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
            >
              {TAX_CHANGE.notYet}
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-[var(--dash-border)] pt-4">
        <button
          type="button"
          onClick={next}
          // While the impact is still being worked out the warning it may
          // carry is unknown, so the change waits for it (design 6.4).
          disabled={disabled || step !== "edit" || (showImpact && !preview)}
          className="dash-btn dash-btn-primary inline-flex items-center gap-2 pointer-coarse:min-h-11"
        >
          {pending && step === "edit" ? (
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          ) : null}
          {changeButtonLabel({ when, switchesOn })}
        </button>
        {!canEdit ? <ReadOnlyNote /> : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-[var(--dash-red)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** What the proposal changes for merchants with a plan (design 6.4). */
function ImpactPanel({ preview }: { preview: Preview | null }) {
  return (
    <div
      aria-live="polite"
      className="mb-5 rounded-[var(--dash-radius-sm)] border border-[var(--dash-border)] p-4"
    >
      <h3 className="text-sm font-semibold text-[var(--dash-text)]">
        {TAX_CHANGE.impactTitle}
      </h3>
      {preview === null ? (
        <p className="mt-2 inline-flex items-center gap-2 text-sm text-[var(--dash-text-2)]">
          <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          Working out what this changes…
        </p>
      ) : !preview.ok ? (
        <p role="alert" className="mt-2 text-sm text-[var(--dash-red)]">
          {TAX_CHANGE.impactFailed}
        </p>
      ) : (
        <ImpactBody impact={preview.impact} />
      )}
    </div>
  );
}

function ImpactBody({
  impact,
}: {
  impact: Extract<Preview, { ok: true }>["impact"];
}) {
  const lines = impactLines(impact.counts);
  if (impact.rows.length === 0) {
    return (
      <p className="mt-2 text-sm text-[var(--dash-text-2)]">
        No merchant has a plan that renews.
      </p>
    );
  }
  return (
    <>
      {lines.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--dash-text)]">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 overflow-x-auto">
        <table className="dash-table w-full text-sm">
          <thead>
            <tr>
              {TAX_CHANGE.impactColumns.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {impact.rows.map((row) => (
              <tr key={row.storeId}>
                <td>
                  <Link
                    href={`/dashboard/stores/${row.storeId}`}
                    className="hover:underline"
                  >
                    {row.storeName}
                  </Link>
                </td>
                <td>{planLabel(row)}</td>
                <td>{istShortDate(row.renewsOn)}</td>
                <td className="font-mono">{formatRupees(row.todayPaise)}</td>
                <td className="font-mono">{formatRupees(row.afterPaise)}</td>
                <td>{impactPaidHow(row.routeAfter)}</td>
                <td>
                  {impactStateOnInvoices(row.placeOfSupply, row.countryName)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {impact.truncated ? (
        <p className="mt-2 text-xs text-[var(--dash-text-2)]">
          {impactTruncatedNote(impact.rows.length)}
        </p>
      ) : null}
    </>
  );
}

function Choice({
  name,
  checked,
  onChange,
  title,
  body,
  disabled,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  body?: string;
  /** Repeated on the input itself: a disabled fieldset is not every reader's
   *  answer to "is this control disabled". */
  disabled: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-[var(--dash-radius-sm)] border p-3 pointer-coarse:min-h-11 ${
        checked
          ? "border-[var(--dash-text)] bg-[var(--dash-surface-2)]"
          : "border-[var(--dash-border)]"
      }`}
    >
      <input
        type="radio"
        name={name}
        className="mt-1"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      <span>
        <span className="block text-sm font-medium text-[var(--dash-text)]">
          {title}
        </span>
        {body ? (
          <span className="mt-0.5 block text-xs text-[var(--dash-text-2)]">
            {body}
          </span>
        ) : null}
      </span>
    </label>
  );
}
