"use client";

/**
 * The Billing details card on Plans & Billing (GST design 7.3), and the state
 * prompt the checkout dialog and the Mink credit packs panel show when GST
 * needs the merchant's state before they pay.
 *
 * ★ Every label, hint, error and line comes from `BILLING_DETAILS` and
 * `CHECKOUT` in lib/billing/tax-copy.ts, rendered as plain text.
 * ★ The browser checks what it can for a quick answer, and the server
 * (`saveMyBillingDetails`) checks everything again: its refusal, with the
 * field it names, is what the card shows.
 */

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { saveMyBillingDetails } from "@/app/actions/subscribe-actions";
import {
  BILLING_DETAILS,
  CHECKOUT,
  billingDetailsPrefilled,
  billingDetailsUses,
} from "@/lib/billing/tax-copy";
import {
  gstStateOptions,
  gstinStateCode,
  isValidGstinFormat,
} from "@/lib/billing/gst";
import { COUNTRIES, DEFAULT_COUNTRY, countryName } from "@/lib/countries";
import type {
  BillingDetailsField,
  BillingDetailsInput,
  BillingDetailsView,
} from "@/lib/billing/quote-types";
import { BILLING_DETAILS_ID, BILLING_DETAILS_STATE_ID } from "./gst-notice";

const PIN_PATTERN = /^\d{6}$/;
const OTHER = "OTHER";

type FieldErrors = Partial<Record<BillingDetailsField, string>>;

/** The country name the "Your invoices use" line names outside India. */
function usesCountryName(details: BillingDetailsView): string | null {
  if (details.country === DEFAULT_COUNTRY) return null;
  if (details.country === OTHER) return details.countryName || null;
  return details.countryName || countryName(details.country);
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <section
      id={BILLING_DETAILS_ID}
      aria-labelledby={`${BILLING_DETAILS_ID}-title`}
      className="scroll-mt-6 rounded-xl border border-[rgba(17,24,39,0.08)] bg-white p-6 shadow-sm"
    >
      <h2
        id={`${BILLING_DETAILS_ID}-title`}
        className="text-lg font-semibold text-[#111827]"
      >
        {BILLING_DETAILS.title}
      </h2>
      <p className="mt-1 text-sm text-[#5b6472]">
        {BILLING_DETAILS.description}
      </p>
      {children}
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-[#344054]">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-[#5b6472]">
          {hint}
        </p>
      )}
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-1 text-xs text-red-600"
        >
          {error}
        </p>
      )}
    </div>
  );
}

function describedBy(id: string, hint: boolean, error: boolean) {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  return ids || undefined;
}

export function BillingDetailsCard({
  details,
  canManage,
}: {
  /** null for someone who cannot manage billing, and on a read failure. */
  details: BillingDetailsView | null;
  canManage: boolean;
}) {
  if (!canManage) {
    // ★ The details are read behind the manage gate (`getMyBillingDetails`),
    // so someone who only views billing sees why there is nothing to change.
    return (
      <CardShell>
        <p className="mt-4 text-sm text-[#5b6472]">
          {BILLING_DETAILS.staffOnly}
        </p>
      </CardShell>
    );
  }
  // ⚠ A read failure: no form, because an empty form saved over the real
  // details would remove them. The card says so instead.
  if (!details) {
    return (
      <CardShell>
        <p
          role="alert"
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {BILLING_DETAILS.loadFailed}
        </p>
      </CardShell>
    );
  }
  return <BillingDetailsForm details={details} />;
}

function BillingDetailsForm({ details }: { details: BillingDetailsView }) {
  const router = useRouter();
  const base = useId();
  const id = (name: string) => `${base}-${name}`;
  const [country, setCountry] = useState(details.country || DEFAULT_COUNTRY);
  const [otherName, setOtherName] = useState(details.countryName);
  const [legalName, setLegalName] = useState(details.legalName);
  const [gstin, setGstin] = useState(details.gstin);
  const [stateCode, setStateCode] = useState(details.stateCode);
  const [line1, setLine1] = useState(details.addressLine1);
  const [line2, setLine2] = useState(details.addressLine2);
  const [city, setCity] = useState(details.city);
  const [postal, setPostal] = useState(details.postalCode);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const india = country === DEFAULT_COUNTRY;
  // A GSTIN names its state: the State select follows it and is locked.
  const gstinState = india ? gstinStateCode(gstin) : null;
  const shownState = gstinState ?? stateCode;
  const prefilled = details.saved
    ? null
    : billingDetailsPrefilled(details.prefilledFrom);
  const uses = billingDetailsUses(
    details.placeOfSupply,
    usesCountryName(details),
  );

  function check(): FieldErrors {
    const found: FieldErrors = {};
    if (country === OTHER && !otherName.trim()) {
      found.countryName = BILLING_DETAILS.errors.countryName;
    }
    if (india) {
      const g = gstin.trim();
      if (g && !isValidGstinFormat(g)) {
        found.gstin = BILLING_DETAILS.errors.gstin;
      } else if (!shownState) {
        found.stateCode = BILLING_DETAILS.errors.state;
      }
      if (postal.trim() && !PIN_PATTERN.test(postal.trim())) {
        found.postalCode = BILLING_DETAILS.errors.pin;
      }
    }
    return found;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    const found = check();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const input: BillingDetailsInput = {
      country,
      legalName,
      addressLine1: line1,
      addressLine2: line2,
      city,
      postalCode: postal,
    };
    if (country === OTHER) input.countryName = otherName;
    if (india) {
      input.gstin = gstin.trim().toUpperCase();
      input.stateCode = shownState;
    }

    setSaving(true);
    try {
      const result = await saveMyBillingDetails(input);
      if (!result.ok) {
        if (result.field) setErrors({ [result.field]: result.error });
        else setFormError(result.error);
        return;
      }
      toast.success(BILLING_DETAILS.saved);
      router.refresh();
    } catch {
      setFormError(BILLING_DETAILS.errors.failed);
    } finally {
      setSaving(false);
    }
  }

  const f = BILLING_DETAILS.fields;
  return (
    <CardShell>
      <form onSubmit={save} noValidate className="mt-5 space-y-4">
        {prefilled && (
          <p className="rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
            {prefilled}
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id={id("country")}
            label={f.country.label}
            error={errors.country}
          >
            <select
              id={id("country")}
              className="dash-input w-full"
              value={country}
              onChange={(e) => {
                setCountry(e.target.value);
                setErrors({});
              }}
              aria-describedby={describedBy(
                id("country"),
                false,
                !!errors.country,
              )}
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          {country === OTHER && (
            <Field
              id={id("countryName")}
              label={f.countryName.label}
              error={errors.countryName}
            >
              <input
                id={id("countryName")}
                className="dash-input w-full"
                value={otherName}
                onChange={(e) => setOtherName(e.target.value)}
                aria-describedby={describedBy(
                  id("countryName"),
                  false,
                  !!errors.countryName,
                )}
              />
            </Field>
          )}
          <Field
            id={id("legalName")}
            label={f.businessName.label}
            hint={f.businessName.hint}
          >
            <input
              id={id("legalName")}
              className="dash-input w-full"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              aria-describedby={describedBy(id("legalName"), true, false)}
            />
          </Field>
          {india && (
            <Field
              id={id("gstin")}
              label={f.gstin.label}
              hint={f.gstin.hint}
              error={errors.gstin}
            >
              <input
                id={id("gstin")}
                className="dash-input w-full uppercase"
                value={gstin}
                maxLength={15}
                autoCapitalize="characters"
                spellCheck={false}
                onChange={(e) => setGstin(e.target.value)}
                aria-invalid={errors.gstin ? true : undefined}
                aria-describedby={describedBy(
                  id("gstin"),
                  true,
                  !!errors.gstin,
                )}
              />
            </Field>
          )}
          {india && (
            <Field
              id={BILLING_DETAILS_STATE_ID}
              label={f.state.label}
              hint={f.state.hint}
              error={errors.stateCode}
            >
              <select
                id={BILLING_DETAILS_STATE_ID}
                className="dash-input w-full"
                value={shownState}
                disabled={gstinState !== null}
                onChange={(e) => setStateCode(e.target.value)}
                aria-invalid={errors.stateCode ? true : undefined}
                aria-describedby={describedBy(
                  BILLING_DETAILS_STATE_ID,
                  true,
                  !!errors.stateCode,
                )}
              >
                <option value="">{f.state.placeholder}</option>
                {gstStateOptions(shownState).map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field id={id("line1")} label={f.address.label}>
            <input
              id={id("line1")}
              className="dash-input w-full"
              value={line1}
              onChange={(e) => setLine1(e.target.value)}
            />
          </Field>
          <Field id={id("line2")} label={f.address2.label}>
            <input
              id={id("line2")}
              className="dash-input w-full"
              value={line2}
              onChange={(e) => setLine2(e.target.value)}
            />
          </Field>
          <Field id={id("city")} label={f.city.label}>
            <input
              id={id("city")}
              className="dash-input w-full"
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
          </Field>
          <Field
            id={id("postal")}
            label={india ? f.pin.label : f.postalCode.label}
            error={errors.postalCode}
          >
            <input
              id={id("postal")}
              className="dash-input w-full"
              value={postal}
              inputMode={india ? "numeric" : undefined}
              maxLength={india ? 6 : undefined}
              onChange={(e) => setPostal(e.target.value)}
              aria-invalid={errors.postalCode ? true : undefined}
              aria-describedby={describedBy(
                id("postal"),
                false,
                !!errors.postalCode,
              )}
            />
          </Field>
        </div>

        <p className="text-sm text-[#344054]">{uses}</p>
        {formError && (
          <p role="alert" className="text-sm text-red-600">
            {formError}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="dash-btn dash-btn-primary"
          >
            {saving ? BILLING_DETAILS.saving : BILLING_DETAILS.save}
          </button>
        </div>
        <p className="text-xs text-[#5b6472]">{BILLING_DETAILS.footnote}</p>
      </form>
    </CardShell>
  );
}

/**
 * "Add your state before you pay": the state select and Save the checkout
 * dialog and the Mink credit packs panel show in place of a payment when GST
 * is charged and no state of the merchant's exists (design 7.3). It saves
 * ONLY the state, then tells the caller so it can quote again.
 */
export function StatePrompt({
  onSaved,
  disabled = false,
}: {
  onSaved: () => void;
  disabled?: boolean;
}) {
  const selectId = useId();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setError(null);
    if (!code) {
      setError(BILLING_DETAILS.errors.state);
      return;
    }
    setSaving(true);
    try {
      const result = await saveMyBillingDetails({ stateCode: code });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved();
    } catch {
      setError(BILLING_DETAILS.errors.failed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm text-amber-900">{CHECKOUT.needsState}</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label
            htmlFor={selectId}
            className="text-xs font-medium text-amber-900"
          >
            {BILLING_DETAILS.fields.state.label}
          </label>
          <select
            id={selectId}
            className="dash-input mt-1 w-full"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={disabled || saving}
          >
            <option value="">{BILLING_DETAILS.fields.state.placeholder}</option>
            {gstStateOptions(code).map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={disabled || saving}
          className="dash-btn dash-btn-primary"
        >
          {saving ? BILLING_DETAILS.saving : CHECKOUT.save}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
