import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { getMinkCreditCycle } from "@/lib/ai/quota";
import { aiAllowanceFor } from "@/lib/plans";
import { getPlanAllowancesLive } from "@/lib/plans/allowances";
import type { MinkActorContext } from "./types";

// ---------------------------------------------------------------------------
// How many Mink credits a store can still spend on a photo tool, asked BEFORE
// any work is done, so a store with nothing left is refused up front instead
// of being handed a result it then cannot keep.
//
// ★ ONE COPY, shared by Refine with Mink AI and background removal. Both then
//   charge through their own atomic function (consume_mink_refine_credits,
//   consume_mink_cutout_credits), which takes the plan cycle's allowance
//   first and top-ups second; this read uses the same pool in the same way,
//   so "you have enough" here and the charge cannot disagree except when the
//   credits are spent elsewhere in between, which the charge then reports.
// ---------------------------------------------------------------------------

export interface ImageCreditHeadroom {
  /** The plan cycle the charge is recorded against. */
  period: string;
  /** The plan's included allowance, or null for an unmetered plan. */
  planCap: number | null;
  /** Credits left (allowance plus top-ups), or null for an unmetered plan. */
  remaining: number | null;
}

export async function imageCreditHeadroom(
  actor: Pick<MinkActorContext, "storeId" | "effectivePlan">,
  chargeCredits: boolean,
): Promise<ImageCreditHeadroom> {
  const [cycle, allowances] = await Promise.all([
    getMinkCreditCycle(actor.storeId),
    getPlanAllowancesLive(),
  ]);
  const planCap = aiAllowanceFor(
    actor.effectivePlan,
    chargeCredits,
    allowances,
  );
  if (planCap === null) {
    return { period: cycle.period, planCap: null, remaining: null };
  }
  const remaining = await withService(async (db) => {
    const res = await db.execute(sql`
      select
        greatest(${planCap}::int - coalesce((
          select used from public.ai_usage
          where store_id = ${actor.storeId}::uuid and period = ${cycle.period}
        ), 0), 0)
        + coalesce((
          select balance from public.ai_credit_balances
          where store_id = ${actor.storeId}::uuid
        ), 0) as remaining
    `);
    return Number(
      (res.rows[0] as { remaining?: number | string } | undefined)?.remaining ??
        0,
    );
  });
  return { period: cycle.period, planCap, remaining };
}

/** Whether `headroom` covers a charge of `credits`. */
export function canAfford(
  headroom: Pick<ImageCreditHeadroom, "remaining">,
  credits: number,
): boolean {
  return headroom.remaining === null || headroom.remaining >= credits;
}
