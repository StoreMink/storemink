import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logWarn } from "@/lib/observability/logger";

// ---------------------------------------------------------------------------
// Spend ceilings for paid provider calls, claimed before the call.
//
// ★★ ALL OR NOTHING. Every limit in one claim counts this call, or none does:
//    the checks run in ONE transaction that rolls back on the first refusal.
//    `check_rate_limit` and `check_rate_limit_cost` add to their counter even
//    when they refuse, so checking limits one by one, each in its own
//    transaction, let a refusal by the platform's hourly ceiling still spend
//    the store's daily allowance on a picture nobody drew, and a refused claim
//    spend the very allowance it was refused for.
// ★ FAILS CLOSED. A database error throws, and nothing paid is attempted.
// ---------------------------------------------------------------------------

export interface SpendLimit {
  key: string;
  max: number;
  windowSeconds: number;
  /** How much this call spends; 1 when absent. */
  cost?: number;
}

/**
 * The platform's hourly ceiling on generated pictures, shared by every caller
 * that draws one, so they all count against the same allowance in the same way.
 */
export const MINK_IMAGE_GLOBAL_LIMIT = {
  key: "mink-image-global",
  max: 200,
  windowSeconds: 3_600,
} as const;

/** Whether a claim went through, and which limit refused it when it did not. */
export type SpendClaim = { ok: true } | { ok: false; refusedKey: string };

class LimitRefused extends Error {
  constructor(public readonly key: string) {
    super(`Spend limit refused: ${key}`);
  }
}

/** Claims every limit, or none. */
export async function claimSpendLimits(
  limits: readonly SpendLimit[],
): Promise<SpendClaim> {
  if (!limits.length) return { ok: true };
  try {
    await withService(async (db) => {
      for (const limit of limits) {
        const cost = limit.cost ?? 1;
        const result =
          cost === 1
            ? await db.execute(
                sql`select check_rate_limit(p_key => ${limit.key}, p_max => ${limit.max}, p_window_seconds => ${limit.windowSeconds}) as allowed`,
              )
            : await db.execute(
                sql`select check_rate_limit_cost(p_key => ${limit.key}, p_max => ${limit.max}, p_window_seconds => ${limit.windowSeconds}, p_cost => ${cost}) as allowed`,
              );
        const allowed =
          (result.rows[0] as { allowed?: boolean } | undefined)?.allowed ===
          true;
        // ★ Thrown, so the transaction rolls back every count it has taken.
        if (!allowed) throw new LimitRefused(limit.key);
      }
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof LimitRefused) {
      return { ok: false, refusedKey: error.key };
    }
    throw error;
  }
}

/**
 * Gives back what a claim took, for work that ended without spending it (an
 * attempt that failed before anything was charged). ★ BEST EFFORT and never
 * throws: a refund that does not land costs the merchant one attempt of an
 * allowance, which is the behaviour it replaces.
 */
export async function releaseSpendLimits(
  limits: ReadonlyArray<Pick<SpendLimit, "key" | "cost">>,
): Promise<void> {
  if (!limits.length) return;
  try {
    await withService(async (db) => {
      for (const limit of limits) {
        await db.execute(sql`
          update public.rate_limits
          set count = greatest(count - ${limit.cost ?? 1}, 0)
          where key = ${limit.key}
        `);
      }
    });
  } catch (error) {
    logWarn("mink.spend: release failed", {
      keys: limits.map((limit) => limit.key).join(","),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
