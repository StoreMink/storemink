"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Popover } from "@base-ui/react/popover";
import {
  CalendarDays,
  ChevronDown,
  GitCompareArrows,
  Loader2,
  MapPin,
} from "lucide-react";

// Shopify-style quick filters: a date-range pill and a compare pill, each a
// popover that applies the moment you pick a preset (only a custom range needs
// an explicit Apply). State lives in the URL so the server renders the cards,
// a filtered view can be bookmarked, and a report link carries the filters.

export const RANGE_OPTIONS = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["90d", "Last 90 days"],
  ["mtd", "Month to date"],
  ["ytd", "Year to date"],
  ["12m", "Last 12 months"],
] as const;

const COMPARE_OPTIONS = [
  ["previous", "Previous period"],
  ["year", "Previous year"],
  ["none", "No comparison"],
] as const;

export interface DateControlsState {
  preset: string;
  comparison: string;
  label: string;
  comparisonLabel: string | null;
  customFrom: string;
  customTo: string;
  compareFrom: string;
  compareTo: string;
  timeZone: string;
}

interface Query {
  range: string;
  compare: string;
  from?: string;
  to?: string;
  compareFrom?: string;
  compareTo?: string;
  location?: string;
}

function toSearch(query: Query, preserve?: Record<string, string>): string {
  const params = new URLSearchParams(preserve);
  params.set("range", query.range);
  params.set("compare", query.compare);
  if (query.range === "custom" && query.from && query.to) {
    params.set("from", query.from);
    params.set("to", query.to);
  }
  if (query.compare === "custom" && query.compareFrom && query.compareTo) {
    params.set("compareFrom", query.compareFrom);
    params.set("compareTo", query.compareTo);
  }
  if (query.location && query.location !== "all") {
    params.set("location", query.location);
  }
  return params.toString();
}

function DateFields({
  from,
  to,
  onFrom,
  onTo,
  onApply,
  applyLabel,
}: {
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  onApply: () => void;
  applyLabel: string;
}) {
  const valid = Boolean(from && to && from <= to);
  return (
    <div className="dash-an-pop-dates">
      <label>
        Start
        <input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(event) => onFrom(event.target.value)}
        />
      </label>
      <label>
        End
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(event) => onTo(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="dash-an-pop-apply"
        disabled={!valid}
        onClick={onApply}
      >
        {applyLabel}
      </button>
    </div>
  );
}

export function AnalyticsDateControls({
  state,
  locations,
  selectedLocationId,
  disabled = false,
  preserve,
}: {
  state: DateControlsState;
  locations: Array<{ id: string; name: string }>;
  selectedLocationId: string | null;
  disabled?: boolean;
  preserve?: Record<string, string>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [rangeOpen, setRangeOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [from, setFrom] = useState(state.customFrom);
  const [to, setTo] = useState(state.customTo);
  const [compareFrom, setCompareFrom] = useState(state.compareFrom);
  const [compareTo, setCompareTo] = useState(state.compareTo);
  const [customCompare, setCustomCompare] = useState(
    state.comparison === "custom",
  );

  const base: Query = {
    range: state.preset,
    compare: state.comparison,
    from: state.customFrom,
    to: state.customTo,
    compareFrom: state.compareFrom,
    compareTo: state.compareTo,
    location: selectedLocationId ?? "all",
  };
  const go = (patch: Partial<Query>) => {
    setRangeOpen(false);
    setCompareOpen(false);
    setLocationOpen(false);
    startTransition(() => {
      router.push(`${pathname}?${toSearch({ ...base, ...patch }, preserve)}`, {
        scroll: false,
      });
    });
  };

  const presetName =
    RANGE_OPTIONS.find(([value]) => value === state.preset)?.[1] ?? null;
  const compareName =
    state.comparison === "none"
      ? "No comparison"
      : (state.comparisonLabel ?? "Previous period");
  const locationName =
    locations.find((location) => location.id === selectedLocationId)?.name ??
    "All locations";

  return (
    <div
      className={`dash-an-filters${pending ? " is-pending" : ""}`}
      aria-busy={pending}
    >
      <Popover.Root open={rangeOpen} onOpenChange={setRangeOpen}>
        <Popover.Trigger
          className="dash-an-pill"
          disabled={disabled}
          title={state.label}
        >
          <CalendarDays aria-hidden />
          <span>{presetName ?? state.label}</span>
          <ChevronDown className="dash-an-pill-caret" aria-hidden />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            className="isolate z-50"
            side="bottom"
            align="start"
            sideOffset={6}
          >
            <Popover.Popup className="dashboard-shell dash-an-pop is-range">
              <div className="dash-an-pop-grid">
                <ul className="dash-an-pop-list" aria-label="Date range">
                  {RANGE_OPTIONS.map(([value, label]) => (
                    <li key={value}>
                      <button
                        type="button"
                        aria-pressed={state.preset === value}
                        onClick={() => go({ range: value })}
                      >
                        {label}
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="dash-an-pop-custom">
                  <div className="dash-an-pop-heading">Custom range</div>
                  <DateFields
                    from={from}
                    to={to}
                    onFrom={setFrom}
                    onTo={setTo}
                    applyLabel="Apply dates"
                    onApply={() => go({ range: "custom", from, to })}
                  />
                  <p className="dash-an-pop-zone">
                    Days start and end in {state.timeZone}.
                  </p>
                </div>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>

      <Popover.Root open={compareOpen} onOpenChange={setCompareOpen}>
        <Popover.Trigger
          className="dash-an-pill"
          disabled={disabled}
          title={state.comparisonLabel ?? undefined}
        >
          <GitCompareArrows aria-hidden />
          <span>
            {state.comparison === "none"
              ? "No comparison"
              : `Compare to: ${compareName}`}
          </span>
          <ChevronDown className="dash-an-pill-caret" aria-hidden />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            className="isolate z-50"
            side="bottom"
            align="start"
            sideOffset={6}
          >
            <Popover.Popup className="dashboard-shell dash-an-pop">
              <ul className="dash-an-pop-list" aria-label="Compare to">
                {COMPARE_OPTIONS.map(([value, label]) => (
                  <li key={value}>
                    <button
                      type="button"
                      aria-pressed={
                        state.comparison === value && !customCompare
                      }
                      onClick={() => go({ compare: value })}
                    >
                      {label}
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    aria-pressed={customCompare}
                    onClick={() => setCustomCompare(true)}
                  >
                    Custom dates
                  </button>
                </li>
              </ul>
              {customCompare ? (
                <DateFields
                  from={compareFrom}
                  to={compareTo}
                  onFrom={setCompareFrom}
                  onTo={setCompareTo}
                  applyLabel="Compare"
                  onApply={() =>
                    go({ compare: "custom", compareFrom, compareTo })
                  }
                />
              ) : null}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>

      {locations.length > 0 ? (
        <Popover.Root open={locationOpen} onOpenChange={setLocationOpen}>
          <Popover.Trigger className="dash-an-pill" disabled={disabled}>
            <MapPin aria-hidden />
            <span>{locationName}</span>
            <ChevronDown className="dash-an-pill-caret" aria-hidden />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner
              className="isolate z-50"
              side="bottom"
              align="start"
              sideOffset={6}
            >
              <Popover.Popup className="dashboard-shell dash-an-pop">
                <ul className="dash-an-pop-list" aria-label="Location">
                  <li>
                    <button
                      type="button"
                      aria-pressed={selectedLocationId === null}
                      onClick={() => go({ location: "all" })}
                    >
                      All locations
                    </button>
                  </li>
                  {locations.map((location) => (
                    <li key={location.id}>
                      <button
                        type="button"
                        aria-pressed={selectedLocationId === location.id}
                        onClick={() => go({ location: location.id })}
                      >
                        {location.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : null}

      {pending ? (
        <Loader2 className="dash-an-filters-spin" aria-label="Updating" />
      ) : null}
    </div>
  );
}
