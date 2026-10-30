"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Lock } from "lucide-react";
import { saveTaxIdentitySettings } from "@/app/actions/platform";
// The state list comes from the pure GST module: platform-settings.ts is
// `server-only`, so importing a runtime value from it here fails the build.
import { GST_STATES } from "@/lib/billing/gst";
import type { PlatformTaxSettings } from "@/lib/billing/invoice-types";
import { TAX_CONSOLE, TAX_IDENTITY } from "@/lib/billing/tax-copy";
import { REQUEST_FAILED } from "./tax-status";

// ---------------------------------------------------------------------------
// Card 2, StoreMink's tax identity (GST design 6.3): who StoreMink is on every
// invoice, never what it charges. Saved through `saveTaxIdentity`, which
// refuses what the database would (GST design 5.8); this form only answers
// before a round trip, never instead of one.
//
// ★★ `unreadable` (review R3-05): the settings could not be read, so the
// fields hold the defaults (blanks) and Save is disabled. Saving them would
// write blanks over StoreMink's stored identity while GST is off.
// ---------------------------------------------------------------------------

/** "Use the address above": the address lines, city and PIN as one line. */
export function addressAsOneLine(parts: {
  line1: string;
  line2: string;
  city: string;
  postalCode: string;
}): string {
  return [parts.line1, parts.line2, parts.city, parts.postalCode]
    .map((p) => p.trim())
    .filter(Boolean)
    .join(", ");
}

export function TaxIdentityForm({
  initial,
  canEdit,
  unreadable = false,
}: {
  initial: PlatformTaxSettings;
  canEdit: boolean;
  /** The settings could not be read: `initial` is only the defaults. */
  unreadable?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [legalName, setLegalName] = useState(initial.legalName ?? "");
  const [gstin, setGstin] = useState(initial.gstin ?? "");
  const [stateCode, setStateCode] = useState(initial.stateCode ?? "");
  const [line1, setLine1] = useState(initial.address.line1 ?? "");
  const [line2, setLine2] = useState(initial.address.line2 ?? "");
  const [city, setCity] = useState(initial.address.city ?? "");
  const [postalCode, setPostalCode] = useState(
    initial.address.postalCode ?? "",
  );
  const [sacCode, setSacCode] = useState(initial.sacCode ?? "");
  const [llpin, setLlpin] = useState(initial.llpin ?? "");
  const [registeredOffice, setRegisteredOffice] = useState(
    initial.registeredOffice ?? "",
  );
  const [invoicePrefix, setInvoicePrefix] = useState(initial.invoicePrefix);

  function save() {
    setError(null);
    start(async () => {
      try {
        const res = await saveTaxIdentitySettings({
          legalName,
          gstin,
          stateCode,
          addressLine1: line1,
          addressLine2: line2,
          city,
          postalCode,
          sacCode,
          llpin,
          registeredOffice,
          invoicePrefix,
        });
        if (res.error) {
          setError(res.error);
          toast.error(res.error);
          return;
        }
        toast.success(TAX_IDENTITY.saved);
        router.refresh();
      } catch {
        setError(REQUEST_FAILED);
      }
    });
  }

  const disabled = !canEdit || unreadable || pending;

  return (
    <section
      aria-labelledby="tax-identity-title"
      className="dash-card mt-6 max-w-3xl p-6"
    >
      <h2
        id="tax-identity-title"
        className="mb-4 text-base font-semibold text-[var(--dash-text)]"
      >
        {TAX_CONSOLE.identityTitle}
      </h2>

      <Field id="tax-legal-name" {...TAX_IDENTITY.legalName}>
        <input
          id="tax-legal-name"
          className="dash-input w-full"
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
          disabled={disabled}
          placeholder={TAX_IDENTITY.legalName.placeholder}
        />
      </Field>

      <Field id="tax-gstin" {...TAX_IDENTITY.gstin}>
        <input
          id="tax-gstin"
          className="dash-input w-full font-mono uppercase"
          value={gstin}
          onChange={(e) => setGstin(e.target.value.toUpperCase())}
          disabled={disabled}
          placeholder={TAX_IDENTITY.gstin.placeholder}
          maxLength={15}
        />
      </Field>

      <Field id="tax-state" {...TAX_IDENTITY.state}>
        <select
          id="tax-state"
          className="dash-input w-full"
          value={stateCode}
          onChange={(e) => setStateCode(e.target.value)}
          disabled={disabled}
        >
          <option value="">Not set</option>
          {GST_STATES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name} ({s.code})
            </option>
          ))}
        </select>
      </Field>

      <Field
        id="tax-address-1"
        label={TAX_IDENTITY.address.label}
        hint={TAX_IDENTITY.address.hint}
      >
        <div className="space-y-2">
          <input
            id="tax-address-1"
            aria-label={TAX_IDENTITY.address.line1}
            className="dash-input w-full"
            value={line1}
            onChange={(e) => setLine1(e.target.value)}
            disabled={disabled}
            placeholder={TAX_IDENTITY.address.line1}
          />
          <input
            aria-label={TAX_IDENTITY.address.line2}
            className="dash-input w-full"
            value={line2}
            onChange={(e) => setLine2(e.target.value)}
            disabled={disabled}
            placeholder={TAX_IDENTITY.address.line2}
          />
          <div className="flex gap-2">
            <input
              aria-label={TAX_IDENTITY.address.city}
              className="dash-input w-full"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              disabled={disabled}
              placeholder={TAX_IDENTITY.address.city}
            />
            <input
              aria-label={TAX_IDENTITY.address.pin}
              className="dash-input w-40"
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              disabled={disabled}
              placeholder={TAX_IDENTITY.address.pin}
              inputMode="numeric"
              maxLength={6}
            />
          </div>
        </div>
      </Field>

      <Field id="tax-sac" {...TAX_IDENTITY.sacCode}>
        <input
          id="tax-sac"
          className="dash-input w-40 font-mono"
          value={sacCode}
          onChange={(e) => setSacCode(e.target.value)}
          disabled={disabled}
          placeholder={TAX_IDENTITY.sacCode.placeholder}
          inputMode="numeric"
          maxLength={6}
        />
      </Field>

      <Field id="tax-llpin" {...TAX_IDENTITY.llpin}>
        <input
          id="tax-llpin"
          className="dash-input w-40 font-mono uppercase"
          value={llpin}
          onChange={(e) => setLlpin(e.target.value.toUpperCase())}
          disabled={disabled}
          placeholder={TAX_IDENTITY.llpin.placeholder}
          maxLength={8}
        />
      </Field>

      <Field
        id="tax-registered-office"
        label={TAX_IDENTITY.registeredOffice.label}
        hint={TAX_IDENTITY.registeredOffice.hint}
      >
        <div className="flex flex-wrap items-start gap-2">
          <input
            id="tax-registered-office"
            className="dash-input min-w-0 flex-1"
            value={registeredOffice}
            onChange={(e) => setRegisteredOffice(e.target.value)}
            disabled={disabled}
          />
          <button
            type="button"
            onClick={() =>
              setRegisteredOffice(
                addressAsOneLine({ line1, line2, city, postalCode }),
              )
            }
            disabled={disabled}
            className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
          >
            {TAX_IDENTITY.registeredOffice.useAddress}
          </button>
        </div>
      </Field>

      <Field id="tax-prefix" {...TAX_IDENTITY.prefix}>
        <input
          id="tax-prefix"
          className="dash-input w-24 font-mono uppercase"
          value={invoicePrefix}
          onChange={(e) => setInvoicePrefix(e.target.value.toUpperCase())}
          disabled={disabled}
          maxLength={TAX_IDENTITY.prefix.maxLength}
        />
      </Field>

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-[var(--dash-border)] pt-4">
        <button
          type="button"
          onClick={save}
          disabled={disabled}
          className="dash-btn dash-btn-primary inline-flex items-center gap-2 pointer-coarse:min-h-11"
        >
          {pending ? (
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          ) : null}
          {TAX_IDENTITY.save}
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

/** A member sees every value and why they cannot change it. */
export function ReadOnlyNote() {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-[var(--dash-text-2)]">
      <Lock aria-hidden className="h-3.5 w-3.5" />
      Only a platform superadmin can change these.
    </span>
  );
}

export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  placeholder?: string;
  maxLength?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <label
        htmlFor={id}
        className="mb-1 block text-sm font-medium text-[var(--dash-text)]"
      >
        {label}
      </label>
      {hint ? (
        <p className="mb-2 text-xs text-[var(--dash-text-2)]">{hint}</p>
      ) : null}
      {children}
    </div>
  );
}
