import Link from "next/link";
import { ArrowUpRight, Check } from "lucide-react";
import { PLAN_META, type Plan } from "@/lib/plans";
import {
  nextPlan,
  planHighlights,
  planPriceLine,
  upgradeUnlocks,
} from "@/lib/plans/upgrade-summary";

/**
 * "You're on Free" — and what the next plan would unlock. Every line is derived
 * from PLAN_LIMITS (lib/plans/upgrade-summary.ts), so the card cannot promise
 * a feature enforcement does not deliver, and a change to the catalogue moves
 * the card with it.
 */
export function PlanCard({ plan }: { plan: Plan }) {
  const next = nextPlan(plan);
  const highlights = planHighlights(plan).slice(0, 5);
  const unlocks = next ? upgradeUnlocks(plan, next).slice(0, 5) : [];

  return (
    <section className="dash-card flex flex-col gap-4 p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-[16px] font-bold tracking-tight text-[var(--dash-text)]">
            You&apos;re on the {PLAN_META[plan].name} plan
          </h2>
          <p className="text-[12.5px] text-[var(--dash-text-3)]">
            {planPriceLine(plan)} · {PLAN_META[plan].tagline}
          </p>
        </div>
        <Link
          href="/dashboard/plans"
          className="dash-btn dash-btn-ghost dash-btn-sm"
        >
          Plans &amp; billing
        </Link>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <h3 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--dash-text-3)]">
            Included
          </h3>
          <ul className="flex flex-col gap-1 text-[13px] text-[var(--dash-text-2)]">
            {highlights.map((line) => (
              <li key={line} className="flex items-start gap-2">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--dash-green)]" />
                {line}
              </li>
            ))}
          </ul>
        </div>
        {next && unlocks.length > 0 && (
          <div>
            <h3 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--dash-text-3)]">
              Upgrade to {PLAN_META[next].name} to unlock
            </h3>
            <ul className="flex flex-col gap-1 text-[13px] text-[var(--dash-text-2)]">
              {unlocks.map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--dash-accent)]" />
                  {line}
                </li>
              ))}
            </ul>
            <Link
              href="/dashboard/plans"
              className="dash-btn dash-btn-primary dash-btn-sm mt-3"
            >
              Upgrade to {PLAN_META[next].name} · {planPriceLine(next)}
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}
