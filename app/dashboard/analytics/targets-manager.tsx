"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock, Pencil, Plus, Target, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  deleteAnalyticsTarget,
  saveAnalyticsTarget,
} from "@/app/actions/analytics-targets";
import { TARGET_METRIC_META, type TargetMetric } from "@/lib/analytics/targets";
import { formatAnalyticsValue } from "../components/analytics-format";
import { UpgradePopover, type ReportLock } from "../components/analytics-card";

export interface ManagedTarget {
  id: string;
  metric: TargetMetric;
  periodStart: string;
  periodEnd: string;
  targetValue: number;
}

interface Preset {
  id: string;
  label: string;
  start: string;
  end: string;
}

interface Draft {
  id: string | null;
  metric: TargetMetric;
  presetId: string;
  periodStart: string;
  periodEnd: string;
  targetValue: string;
}

function shortPeriod(start: string, end: string): string {
  const fmt = (date: string) =>
    new Intl.DateTimeFormat("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${date}T00:00:00.000Z`));
  return `${fmt(start)} – ${fmt(end)}`;
}

export function TargetsManager({
  targets,
  metrics,
  presets,
  canManage,
  lock,
}: {
  targets: ManagedTarget[];
  metrics: TargetMetric[];
  presets: Preset[];
  canManage: boolean;
  lock?: ReportLock;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (lock) {
    return (
      <UpgradePopover
        lock={lock}
        feature="Set targets"
        pitch="Set a goal for sales, orders or new customers and watch your progress on the dashboard, with days left and whether you are on track."
        triggerClassName="dash-an-btn is-locked"
        triggerLabel="Targets need a paid plan"
      >
        <Lock aria-hidden /> Create target
      </UpgradePopover>
    );
  }
  if (!canManage && targets.length === 0) return null;

  const firstPreset = presets[0];
  const blank = (): Draft => ({
    id: null,
    metric: metrics[0] ?? "total_sales",
    presetId: firstPreset?.id ?? "custom",
    periodStart: firstPreset?.start ?? "",
    periodEnd: firstPreset?.end ?? "",
    targetValue: "",
  });
  const openEditor = (target?: ManagedTarget) => {
    setError(null);
    setConfirmDelete(null);
    if (!target) {
      setDraft(blank());
      return;
    }
    const preset = presets.find(
      (p) => p.start === target.periodStart && p.end === target.periodEnd,
    );
    setDraft({
      id: target.id,
      metric: target.metric,
      presetId: preset?.id ?? "custom",
      periodStart: target.periodStart,
      periodEnd: target.periodEnd,
      targetValue: String(target.targetValue),
    });
  };

  const save = () => {
    if (!draft) return;
    setError(null);
    startTransition(async () => {
      const result = await saveAnalyticsTarget({
        id: draft.id,
        metric: draft.metric,
        periodStart: draft.periodStart,
        periodEnd: draft.periodEnd,
        targetValue: Number(draft.targetValue),
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setDraft(null);
      if (targets.length === 0) setOpen(false);
      router.refresh();
    });
  };

  const remove = (id: string) => {
    setError(null);
    startTransition(async () => {
      const result = await deleteAnalyticsTarget(id);
      if (result.error) {
        setError(result.error);
        return;
      }
      setConfirmDelete(null);
      router.refresh();
    });
  };

  const meta = draft ? TARGET_METRIC_META[draft.metric] : null;

  return (
    <>
      <button
        type="button"
        className="dash-an-btn"
        onClick={() => {
          setOpen(true);
          if (targets.length === 0) openEditor();
          else setDraft(null);
        }}
      >
        <Target aria-hidden />
        {targets.length === 0 ? "Create target" : "Manage targets"}
      </button>
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent className="dash-target-dialog sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {draft ? (draft.id ? "Edit target" : "Create target") : "Targets"}
            </DialogTitle>
            <DialogDescription>
              {draft
                ? "Targets follow their own dates, not the dashboard's date filter."
                : "Goals for this store, shown at the top of Analytics."}
            </DialogDescription>
          </DialogHeader>

          {draft && meta ? (
            <form
              className="dash-target-form"
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              <label>
                <span>Measure</span>
                <select
                  className="dash-input"
                  value={draft.metric}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      metric: event.target.value as TargetMetric,
                    })
                  }
                >
                  {metrics.map((metric) => (
                    <option key={metric} value={metric}>
                      {TARGET_METRIC_META[metric].label}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset>
                <legend>Period</legend>
                <div className="dash-target-presets">
                  {[
                    ...presets,
                    { id: "custom", label: "Custom dates", start: "", end: "" },
                  ].map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      aria-pressed={draft.presetId === preset.id}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          presetId: preset.id,
                          ...(preset.id === "custom"
                            ? {}
                            : {
                                periodStart: preset.start,
                                periodEnd: preset.end,
                              }),
                        })
                      }
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                {draft.presetId === "custom" ? (
                  <div className="dash-target-dates">
                    <label>
                      <span>Start</span>
                      <input
                        className="dash-input"
                        type="date"
                        value={draft.periodStart}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            periodStart: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>End</span>
                      <input
                        className="dash-input"
                        type="date"
                        value={draft.periodEnd}
                        min={draft.periodStart || undefined}
                        onChange={(event) =>
                          setDraft({ ...draft, periodEnd: event.target.value })
                        }
                      />
                    </label>
                  </div>
                ) : (
                  <p className="dash-target-hint">
                    {shortPeriod(draft.periodStart, draft.periodEnd)}
                  </p>
                )}
              </fieldset>
              <label>
                <span>Target</span>
                <div className="dash-target-value">
                  {meta.format === "currency" ? <em>₹</em> : null}
                  <input
                    className="dash-input"
                    inputMode="decimal"
                    type="number"
                    min="0"
                    step={meta.format === "percent" ? "0.1" : "1"}
                    max={meta.format === "percent" ? 100 : undefined}
                    placeholder={meta.format === "percent" ? "3.5" : "100000"}
                    value={draft.targetValue}
                    onChange={(event) =>
                      setDraft({ ...draft, targetValue: event.target.value })
                    }
                    required
                  />
                  {meta.format === "percent" ? <em>%</em> : null}
                </div>
              </label>
              {error ? (
                <p className="dash-target-error" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="dash-target-actions">
                {targets.length > 0 ? (
                  <button
                    type="button"
                    className="dash-btn dash-btn-ghost"
                    onClick={() => setDraft(null)}
                    disabled={pending}
                  >
                    Back
                  </button>
                ) : null}
                <button
                  type="submit"
                  className="dash-btn dash-btn-primary"
                  disabled={pending || !draft.targetValue}
                >
                  {pending ? "Saving…" : "Save target"}
                </button>
              </div>
            </form>
          ) : (
            <div className="dash-target-list">
              {targets.map((target) => (
                <div key={target.id} className="dash-target-row">
                  <div>
                    <strong>{TARGET_METRIC_META[target.metric].label}</strong>
                    <span>
                      {formatAnalyticsValue(
                        target.targetValue,
                        TARGET_METRIC_META[target.metric].format,
                      )}{" "}
                      · {shortPeriod(target.periodStart, target.periodEnd)}
                    </span>
                  </div>
                  {canManage ? (
                    confirmDelete === target.id ? (
                      <div className="dash-target-row-actions">
                        <button
                          type="button"
                          className="dash-btn dash-btn-ghost dash-btn-sm"
                          onClick={() => setConfirmDelete(null)}
                          disabled={pending}
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          className="dash-btn dash-btn-sm dash-target-delete"
                          onClick={() => remove(target.id)}
                          disabled={pending}
                        >
                          Delete
                        </button>
                      </div>
                    ) : (
                      <div className="dash-target-row-actions">
                        <button
                          type="button"
                          className="dash-an-icon-btn"
                          aria-label="Edit target"
                          onClick={() => openEditor(target)}
                        >
                          <Pencil aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="dash-an-icon-btn"
                          aria-label="Delete target"
                          onClick={() => setConfirmDelete(target.id)}
                        >
                          <Trash2 aria-hidden />
                        </button>
                      </div>
                    )
                  ) : null}
                </div>
              ))}
              {error ? (
                <p className="dash-target-error" role="alert">
                  {error}
                </p>
              ) : null}
              {canManage ? (
                <button
                  type="button"
                  className="dash-btn dash-btn-primary"
                  onClick={() => openEditor()}
                >
                  <Plus aria-hidden /> New target
                </button>
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
