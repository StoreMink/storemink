"use client";

import { useRef } from "react";
import PhoneInput from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { Loader2 } from "lucide-react";
import { CountrySelect } from "@/components/ui/phone-country-select";
import { customPhoneLabels } from "@/lib/phone-labels";
import { LOCAL_DEV_ROOT } from "@/lib/store/host";
import { usePhoneVerification } from "@/lib/auth/use-phone-verification";

/**
 * The owner's mobile, verified, on the signup wizard's paid-plan path.
 *
 * Razorpay autopay needs a mobile number on the billing account, and signup no
 * longer asks for one, so a merchant who chooses a paid plan proves it here,
 * just before paying. It is the same verification the dashboard's go-live
 * checklist runs (`usePhoneVerification`), so doing it here also ticks that
 * task off. Loaded with next/dynamic: the phone library has no business in
 * the bundle of a signup that never chooses a paid plan.
 */
export default function SignupPhoneVerify({
  onVerified,
}: {
  onVerified: (phone: string) => void;
}) {
  const recaptcha = useRef<HTMLDivElement | null>(null);
  const codeInput = useRef<HTMLInputElement | null>(null);
  const v = usePhoneVerification(onVerified, { recaptcha, codeInput });

  return (
    <div className="sgn-stack">
      <div ref={recaptcha} />

      {v.step === "number" ? (
        <form
          className="sgn-field"
          onSubmit={(event) => {
            event.preventDefault();
            void v.sendCode();
          }}
        >
          <label className="sgn-label" htmlFor="signup-phone">
            Mobile number
          </label>
          <div className="sgn-inline">
            <PhoneInput
              defaultCountry="IN"
              countrySelectComponent={CountrySelect}
              labels={customPhoneLabels}
              value={v.phone}
              onChange={v.setPhone}
              disabled={v.sending}
              numberInputProps={{
                id: "signup-phone",
                autoComplete: "tel",
                autoFocus: true,
              }}
              className="sgn-phone"
            />
            <button
              type="submit"
              disabled={v.sending || !v.phone}
              className="sgn-btn sgn-btn-primary is-auto"
            >
              {v.sending ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                "Send code"
              )}
            </button>
          </div>
        </form>
      ) : (
        <form
          className="sgn-field"
          onSubmit={(event) => {
            event.preventDefault();
            if (v.canRetrySave) v.retrySave();
          }}
        >
          <label className="sgn-label" htmlFor="signup-phone-code">
            Enter the code sent to <strong>{v.shownNumber}</strong>
          </label>
          <input
            id="signup-phone-code"
            ref={codeInput}
            type="text"
            className="sgn-input is-code"
            placeholder="000000"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={v.code}
            disabled={v.verifying || v.verifyBlocked}
            onChange={(event) => v.onCodeChange(event.target.value)}
          />
          <p className="sgn-help">
            {v.verifying
              ? "Checking the code…"
              : "The code is checked as soon as you type the sixth digit."}
          </p>
          {v.canRetrySave && (
            <button
              type="submit"
              disabled={v.verifying}
              className="sgn-btn sgn-btn-primary"
            >
              Try again
            </button>
          )}
          <div className="sgn-links">
            <button
              type="button"
              className="sgn-link"
              disabled={
                v.sending || v.verifying || v.resendIn > 0 || v.resendBlocked
              }
              onClick={() => void v.sendCode(true)}
            >
              {v.resendIn > 0 ? `Resend in ${v.resendIn}s` : "Resend code"}
            </button>
            <button
              type="button"
              className="sgn-link"
              disabled={v.verifying}
              onClick={v.changeNumber}
            >
              Change number
            </button>
          </div>
        </form>
      )}

      {v.error && (
        <div role="alert" className="sgn-note is-error">
          <p>{v.error}</p>
        </div>
      )}
      {v.verifyBlocked && (
        <div className="sgn-note is-error">
          <p>Too many incorrect codes. Request a new code later.</p>
        </div>
      )}
      {v.localhostHint && v.step === "number" && (
        <div className="sgn-note is-warn">
          You&apos;re on <code>localhost</code>, where Firebase refuses real
          numbers. Open{" "}
          <a href={v.localhostHint}>this page on {LOCAL_DEV_ROOT}</a> instead
          (same server), or use a fictional test number from the Identity
          Platform console.
        </div>
      )}
    </div>
  );
}
