import { Lock } from "lucide-react";
import {
  TARGET_METRIC_META,
  TARGET_STATUS_LABEL,
  type TargetMetric,
  type TargetProgress,
} from "@/lib/analytics/targets";
import { formatAnalyticsValue } from "./analytics-format";

// A target's progress card (Shopify's target gauge): an arc filled to the
// share achieved, the status, current vs target, the period and days left.
// Target cards follow their own period, never the dashboard's date filter.

function periodLabel(start: string, end: string): string {
  const fmt = (date: string, withYear: boolean) =>
    new Intl.DateTimeFormat("en-IN", {
      day: "numeric",
      month: "short",
      year: withYear ? "numeric" : undefined,
      timeZone: "UTC",
    }).format(new Date(`${date}T00:00:00.000Z`));
  return start.slice(0, 4) === end.slice(0, 4)
    ? `${fmt(start, false)} – ${fmt(end, true)}`
    : `${fmt(start, true)} – ${fmt(end, true)}`;
}

function Gauge({ percent }: { percent: number }) {
  // A 180-degree arc; the fill caps at the full arc but the label does not.
  const radius = 52;
  const length = Math.PI * radius;
  const filled = Math.max(0, Math.min(percent, 100)) / 100;
  return (
    <svg viewBox="0 0 120 68" className="dash-target-gauge" aria-hidden>
      <path
        d="M 8 60 A 52 52 0 0 1 112 60"
        className="dash-target-gauge-track"
      />
      <path
        d="M 8 60 A 52 52 0 0 1 112 60"
        className="dash-target-gauge-fill"
        strokeDasharray={`${length * filled} ${length}`}
      />
    </svg>
  );
}

export function TargetCard({
  metric,
  periodStart,
  periodEnd,
  targetValue,
  current,
  progress,
}: {
  metric: TargetMetric;
  periodStart: string;
  periodEnd: string;
  targetValue: number;
  current: number | null;
  progress: TargetProgress | null;
}) {
  const meta = TARGET_METRIC_META[metric];
  const title = `${meta.label} target`;
  if (current === null || progress === null) {
    return (
      <section className="dash-an-card dash-target">
        <header className="dash-an-card-head">
          <span className="dash-an-title">{title}</span>
        </header>
        <p className="dash-target-locked">
          <Lock aria-hidden /> This target tracks storefront traffic, which is
          part of the Pro plan.
        </p>
      </section>
    );
  }
  const percent = progress.percent;
  return (
    <section className={`dash-an-card dash-target is-${progress.status}`}>
      <header className="dash-an-card-head">
        <span className="dash-an-title">{title}</span>
        <span className={`dash-target-status is-${progress.status}`}>
          {TARGET_STATUS_LABEL[progress.status]}
        </span>
      </header>
      <div className="dash-target-body">
        <div className="dash-target-gauge-wrap">
          <Gauge percent={percent} />
          <strong className="dash-target-percent">
            {percent >= 1000 ? "999%+" : `${Math.round(percent)}%`}
          </strong>
        </div>
        <dl className="dash-target-facts">
          <div>
            <dt>Current</dt>
            <dd>{formatAnalyticsValue(current, meta.format)}</dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd>{formatAnalyticsValue(targetValue, meta.format)}</dd>
          </div>
          <div>
            <dt>Period</dt>
            <dd>{periodLabel(periodStart, periodEnd)}</dd>
          </div>
          <div>
            <dt>Days left</dt>
            <dd>{progress.daysLeft.toLocaleString("en-IN")}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
