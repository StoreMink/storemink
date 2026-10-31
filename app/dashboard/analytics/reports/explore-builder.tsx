"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Download, Save, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  deleteAnalyticsReport,
  saveAnalyticsReport,
} from "@/app/actions/analytics-reports";
import {
  EXPLORE_DIMENSION_LABELS,
  EXPLORE_METRICS,
  MAX_EXPLORE_METRICS,
  dimensionsFor,
  exploreSearch,
  metricsFor,
  normalizeExploreConfig,
  type ExploreChart,
  type ExploreConfig,
  type ExploreDataset,
  type ExploreDimension,
  type ExploreMetric,
} from "@/lib/analytics/explore";
import { serializeCsv } from "@/lib/csv/serialize";

// The custom report builder's controls. All state lives in the URL (the
// server re-runs the report on every change), so a report can be bookmarked
// or shared as a link; Save stores the same config under a name.

export function ExploreBuilder({
  config,
  trafficAllowed,
  baseParams,
  report,
  canSave,
  csv,
}: {
  config: ExploreConfig;
  trafficAllowed: boolean;
  /** Date range / comparison / location params to keep on every change. */
  baseParams: Record<string, string>;
  report: { id: string; name: string } | null;
  canSave: boolean;
  csv: {
    filename: string;
    header: string[];
    rows: Array<Array<string | number>>;
  };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState(report?.name ?? "");
  const [asNew, setAsNew] = useState(!report);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const go = (next: Partial<ExploreConfig>) => {
    const merged = normalizeExploreConfig(
      { ...config, ...next },
      { trafficAllowed },
    );
    const params = new URLSearchParams({
      ...baseParams,
      ...exploreSearch(merged),
      ...(report ? { report: report.id } : {}),
    });
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    });
  };

  const allowedMetrics = metricsFor(config.dataset, config.dimension);
  const toggleMetric = (metric: ExploreMetric) => {
    const has = config.metrics.includes(metric);
    if (has && config.metrics.length === 1) return;
    go({
      metrics: has
        ? config.metrics.filter((m) => m !== metric)
        : [...config.metrics, metric].slice(0, MAX_EXPLORE_METRICS),
    });
  };

  const exportCsv = () => {
    const blob = new Blob([serializeCsv(csv.header, csv.rows)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = csv.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await saveAnalyticsReport({
        id: asNew ? null : (report?.id ?? null),
        name,
        config,
      });
      if (result.error || !result.id) {
        setError(result.error ?? "Couldn't save the report.");
        return;
      }
      setSaveOpen(false);
      const params = new URLSearchParams({
        ...baseParams,
        ...exploreSearch(config),
        report: result.id,
      });
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
      router.refresh();
    });
  };

  const remove = () => {
    if (!report) return;
    startTransition(async () => {
      const result = await deleteAnalyticsReport(report.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.push("/dashboard/analytics/reports");
    });
  };

  return (
    <div className={`dash-explore-bar${pending ? " is-pending" : ""}`}>
      <div className="dash-explore-controls">
        <label>
          <span>Data</span>
          <select
            className="dash-input"
            value={config.dataset}
            onChange={(event) =>
              go({
                dataset: event.target.value as ExploreDataset,
                dimension: "day",
                metrics: [],
              })
            }
          >
            <option value="sales">Sales and orders</option>
            {trafficAllowed ? (
              <option value="traffic">Storefront traffic</option>
            ) : null}
          </select>
        </label>
        <label>
          <span>Group by</span>
          <select
            className="dash-input"
            value={config.dimension}
            onChange={(event) =>
              go({ dimension: event.target.value as ExploreDimension })
            }
          >
            {dimensionsFor(config.dataset).map((dimension) => (
              <option key={dimension} value={dimension}>
                {EXPLORE_DIMENSION_LABELS[dimension]}
              </option>
            ))}
          </select>
        </label>
        <div className="dash-explore-view" role="group" aria-label="Show as">
          {(["line", "bar", "table"] as ExploreChart[]).map((chart) => (
            <button
              key={chart}
              type="button"
              aria-pressed={config.chart === chart}
              onClick={() => go({ chart })}
            >
              {chart === "line" ? "Line" : chart === "bar" ? "Bar" : "Table"}
            </button>
          ))}
        </div>
        <div className="dash-explore-actions">
          <button type="button" className="dash-an-btn" onClick={exportCsv}>
            <Download aria-hidden /> Export CSV
          </button>
          {canSave ? (
            <button
              type="button"
              className="dash-an-btn"
              onClick={() => {
                setError(null);
                setAsNew(!report);
                setSaveOpen(true);
              }}
            >
              <Save aria-hidden /> {report ? "Save" : "Save report"}
            </button>
          ) : null}
          {canSave && report ? (
            confirmDelete ? (
              <>
                <button
                  type="button"
                  className="dash-an-btn"
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep
                </button>
                <button
                  type="button"
                  className="dash-an-btn dash-explore-delete"
                  onClick={remove}
                  disabled={pending}
                >
                  Delete report
                </button>
              </>
            ) : (
              <button
                type="button"
                className="dash-an-btn is-icon"
                aria-label="Delete this saved report"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 aria-hidden />
              </button>
            )
          ) : null}
        </div>
      </div>
      <div className="dash-explore-metrics" role="group" aria-label="Measures">
        <span>Measures</span>
        {allowedMetrics.map((metric) => {
          const on = config.metrics.includes(metric);
          return (
            <button
              key={metric}
              type="button"
              aria-pressed={on}
              disabled={!on && config.metrics.length >= MAX_EXPLORE_METRICS}
              onClick={() => toggleMetric(metric)}
            >
              {EXPLORE_METRICS[metric].label}
            </button>
          );
        })}
      </div>
      {error && !saveOpen ? (
        <p className="dash-target-error" role="alert">
          {error}
        </p>
      ) : null}

      <Dialog
        open={saveOpen}
        onOpenChange={(next) => !pending && setSaveOpen(next)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {report && !asNew ? "Save report" : "Save as a new report"}
            </DialogTitle>
            <DialogDescription>
              Saves the measures and grouping. Dates follow the range you pick
              when you open it.
            </DialogDescription>
          </DialogHeader>
          <form
            className="dash-target-form"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <label>
              <span>Name</span>
              <input
                className="dash-input"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            {report ? (
              <label className="dash-explore-asnew">
                <input
                  type="checkbox"
                  checked={asNew}
                  onChange={(event) => setAsNew(event.target.checked)}
                />{" "}
                Save as a new report
              </label>
            ) : null}
            {error ? (
              <p className="dash-target-error" role="alert">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <button
                type="button"
                className="dash-btn dash-btn-ghost"
                onClick={() => setSaveOpen(false)}
                disabled={pending}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="dash-btn dash-btn-primary"
                disabled={pending || !name.trim()}
              >
                {pending ? "Saving…" : "Save"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
