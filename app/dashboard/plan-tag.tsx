import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { PLAN_META, type Plan } from "@/lib/plans";
import {
  nextPlan,
  planPriceLine,
  upgradeUnlocks,
} from "@/lib/plans/upgrade-summary";

/**
 * One line, not a card: the plan the store is on and the way up. The hover
 * title names what the next plan unlocks, derived from PLAN_LIMITS so it can
 * never promise what enforcement withholds (lib/plans/upgrade-summary.ts).
 */
export function PlanTag({ plan }: { plan: Plan }) {
  const next = nextPlan(plan);
  const unlocks = next ? upgradeUnlocks(plan, next).slice(0, 4) : [];
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
      <span className="dash-badge dash-badge-grey">
        {PLAN_META[plan].name} plan
      </span>
      {next && (
        <Link
          href="/dashboard/plans"
          title={
            unlocks.length
              ? `${PLAN_META[next].name} · ${planPriceLine(next)}: ${unlocks.join(", ")}`
              : undefined
          }
          className="inline-flex items-center gap-0.5 font-semibold text-[var(--dash-accent)] hover:underline"
        >
          Upgrade
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </div>
  );
}
