import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { PLAN_META, type Plan } from "@/lib/plans";
import { nextPlan, upgradeUnlocks } from "@/lib/plans/upgrade-summary";

/**
 * One line, not a card: the plan the store is on and the way up. The hover
 * title names the next plan and what it unlocks, derived from PLAN_LIMITS so it
 * can never promise what enforcement withholds (lib/plans/upgrade-summary.ts).
 * No price: Plans & Billing shows it, worked out with GST (GST design 14).
 */
export function PlanTag({ plan }: { plan: Plan }) {
  const next = nextPlan(plan);
  const unlocks = next ? upgradeUnlocks(plan, next).slice(0, 4) : [];
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[var(--dash-accent)]/25 bg-[var(--dash-accent-soft)] py-1 pl-3 pr-1 text-[13px]">
      <Sparkles className="h-3.5 w-3.5 text-[var(--dash-accent)]" />
      <span className="font-semibold text-[var(--dash-accent)]">
        You&apos;re on the {PLAN_META[plan].name} plan
      </span>
      {next && (
        <Link
          href="/dashboard/plans"
          title={
            unlocks.length
              ? `${PLAN_META[next].name}: ${unlocks.join(", ")}`
              : undefined
          }
          className="dash-btn dash-btn-primary dash-btn-sm !rounded-full"
        >
          Upgrade
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </div>
  );
}
