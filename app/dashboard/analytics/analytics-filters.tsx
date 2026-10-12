import type { AnalyticsRange } from "@/lib/analytics/range";
import type { AnalyticsLocationOption } from "@/lib/analytics/location";
import { AnalyticsDateControls } from "./analytics-date-controls";

// Server wrapper: hands the client controls plain strings only (the range's
// window instants stay on the server), shared by the dashboard and reports.
export function AnalyticsFilters({
  range,
  locations,
  selectedLocationId,
  disabled,
  preserve,
}: {
  range: AnalyticsRange;
  locations: AnalyticsLocationOption[];
  selectedLocationId: string | null;
  disabled?: boolean;
  /** Other URL params to keep when the dates change (a report's settings). */
  preserve?: Record<string, string>;
}) {
  return (
    <AnalyticsDateControls
      state={{
        preset: range.preset,
        comparison: range.comparison,
        label: range.label,
        comparisonLabel: range.comparisonLabel,
        customFrom: range.customFrom,
        customTo: range.customTo,
        compareFrom: range.compareFrom,
        compareTo: range.compareTo,
        timeZone: range.timeZone,
      }}
      locations={locations.map(({ id, name }) => ({ id, name }))}
      selectedLocationId={selectedLocationId}
      disabled={disabled}
      preserve={preserve}
    />
  );
}
