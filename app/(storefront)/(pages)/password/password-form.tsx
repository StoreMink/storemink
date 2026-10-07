"use client";

import { useActionState } from "react";
import {
  unlockStorefront,
  type UnlockState,
} from "@/app/actions/storefront-access-actions";

export function PasswordForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<UnlockState, FormData>(
    unlockStorefront,
    {},
  );
  return (
    <form action={action} className="sm-password-form">
      <input type="hidden" name="next" value={next} />
      <label className="sm-password-label" htmlFor="storefront-password">
        Store password
      </label>
      <div className="sm-password-row">
        <input
          id="storefront-password"
          name="password"
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          className="sm-password-input"
          aria-invalid={state.error ? true : undefined}
          aria-describedby={
            state.error ? "storefront-password-error" : undefined
          }
        />
        <button
          type="submit"
          disabled={pending}
          className="sm-password-submit sm-btn-primary"
        >
          {pending ? "Checking…" : "Enter"}
        </button>
      </div>
      {state.error ? (
        <p
          id="storefront-password-error"
          role="alert"
          className="sm-password-error"
        >
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
