"use client";

import { useRef } from "react";
import PhoneInput from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CountrySelect } from "@/components/ui/phone-country-select";
import { customPhoneLabels } from "@/lib/phone-labels";
import { LOCAL_DEV_ROOT } from "@/lib/store/host";
import { usePhoneVerification } from "@/lib/auth/use-phone-verification";

/**
 * Prove a mobile number with a texted code and save it, verified, to the
 * signed-in admin's profile — the dashboard's look over
 * `usePhoneVerification`, which holds every rule (the isolated sign-in, the
 * proof kept for a retried save, the fresh reCAPTCHA per send).
 *
 * Used by Account settings and inline by the go-live checklist.
 */
export function VerifyPhoneForm({
  onVerified,
  onCancel,
  autoFocus = false,
  submitLabel = "Send code",
}: {
  /** Called with the E.164 number once the server has recorded it. */
  onVerified: (phone: string) => void;
  /** Renders a Cancel button when given. */
  onCancel?: () => void;
  autoFocus?: boolean;
  submitLabel?: string;
}) {
  const recaptcha = useRef<HTMLDivElement | null>(null);
  const codeInput = useRef<HTMLInputElement | null>(null);
  const v = usePhoneVerification(onVerified, { recaptcha, codeInput });

  return (
    <div className="flex max-w-md flex-col gap-3">
      {/* Invisible reCAPTCHA anchor for the code sign-in. */}
      <div ref={recaptcha} />

      {v.step === "number" ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void v.sendCode();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="verify-phone-number">Mobile number</Label>
            <PhoneInput
              defaultCountry="IN"
              countrySelectComponent={CountrySelect}
              labels={customPhoneLabels}
              value={v.phone}
              onChange={v.setPhone}
              disabled={v.sending}
              numberInputProps={{
                id: "verify-phone-number",
                autoComplete: "tel",
                autoFocus,
              }}
              inputComponent={Input}
              className="flex gap-2 [&>div:first-child]:h-9 [&>div:first-child]:rounded-md [&>div:first-child]:border [&>div:first-child]:border-input [&>div:first-child]:bg-background"
            />
            <p className="text-xs text-[var(--dash-text-3)]">
              We&apos;ll text a six-digit code to this number.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={v.sending || !v.phone}>
              {v.sending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Sending…
                </>
              ) : (
                submitLabel
              )}
            </Button>
            {onCancel && (
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="verify-phone-code">
              Enter the code sent to{" "}
              <span className="font-semibold">{v.shownNumber}</span>
            </Label>
            <Input
              id="verify-phone-code"
              ref={codeInput}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={v.code}
              disabled={v.verifying || v.verifyBlocked}
              onChange={(event) => v.onCodeChange(event.target.value)}
              className="max-w-[12rem] text-center font-mono tracking-[0.3em]"
            />
            <p className="text-xs text-[var(--dash-text-3)]">
              {v.verifying ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Verifying…
                </span>
              ) : (
                "The code is checked as soon as you type the sixth digit."
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {v.canRetrySave && (
              <Button
                type="button"
                disabled={v.verifying}
                onClick={v.retrySave}
              >
                Try again
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={
                v.sending || v.verifying || v.resendIn > 0 || v.resendBlocked
              }
              onClick={() => void v.sendCode(true)}
            >
              {v.sending
                ? "Sending…"
                : v.resendIn > 0
                  ? `Resend in ${v.resendIn}s`
                  : "Resend code"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={v.verifying}
              onClick={v.changeNumber}
            >
              Change number
            </Button>
            {onCancel && (
              <Button
                type="button"
                variant="ghost"
                disabled={v.verifying}
                onClick={onCancel}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}

      {v.error && (
        <p role="alert" className="text-sm text-[var(--dash-red)]">
          {v.error}
        </p>
      )}
      {v.verifyBlocked && (
        <p className="text-sm text-[var(--dash-red)]">
          Too many incorrect codes. Request a new code later.
        </p>
      )}
      {v.localhostHint && v.step === "number" && (
        <p className="text-xs text-[var(--dash-text-3)]">
          Codes aren&apos;t sent to real numbers on localhost. Use a Firebase
          test number, or open{" "}
          <a href={v.localhostHint} className="underline">
            this page on {LOCAL_DEV_ROOT}
          </a>
          .
        </p>
      )}
    </div>
  );
}
