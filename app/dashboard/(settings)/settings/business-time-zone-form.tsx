"use client";

import { useActionState } from "react";
import {
  saveAnalyticsTimeZone,
  type AnalyticsSettingsState,
} from "@/app/actions/analytics-settings";
import { COMMON_ANALYTICS_TIME_ZONES } from "@/lib/analytics/range";

const INITIAL_STATE: AnalyticsSettingsState = {};

export function BusinessTimeZoneForm({ timeZone }: { timeZone: string }) {
  const [state, action, pending] = useActionState(
    saveAnalyticsTimeZone,
    INITIAL_STATE,
  );

  return (
    <form action={action} className="dash-card">
      <header className="dash-card-header">
        <div>
          <h2 className="dash-card-title">Business time zone</h2>
          <p className="dash-card-sub">
            Sets where each day starts and ends in Analytics.
          </p>
        </div>
      </header>
      <div className="dash-card-body">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            name="timeZone"
            defaultValue={timeZone}
            className="dash-input h-9 w-full min-w-0 sm:w-auto sm:min-w-[260px]"
            aria-label="Business time zone"
          >
            {!COMMON_ANALYTICS_TIME_ZONES.some(
              ([value]) => value === timeZone,
            ) ? (
              <option value={timeZone}>{timeZone}</option>
            ) : null}
            {COMMON_ANALYTICS_TIME_ZONES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={pending}
            className="dash-btn dash-btn-primary h-9"
          >
            {pending ? "Saving…" : "Save time zone"}
          </button>
        </div>
        {state.error ? (
          <p className="mt-2 text-[13px] text-red-700" role="alert">
            {state.error}
          </p>
        ) : null}
        {state.success ? (
          <p className="mt-2 text-[13px] text-emerald-700" role="status">
            {state.success}
          </p>
        ) : null}
      </div>
    </form>
  );
}
