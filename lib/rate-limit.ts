import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";

export interface RateLimitOptions {
  /** Max requests allowed inside the window (or max total cost, with `cost`). */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * What this call spends of `max` (a whole number, at least 1): a budget
   * counted in something other than requests, such as characters read aloud.
   * Omitted, each call counts 1. ★ Never mix the two on one key: a weighted
   * key's count is in its own units.
   */
  cost?: number;
}

export interface RateLimitResult {
  allowed: boolean;
}

/** A cost as the database takes it: a whole number, never below 1. */
function weightOf(cost: number): number {
  return Number.isFinite(cost) ? Math.max(1, Math.ceil(cost)) : 1;
}

/**
 * Shared, cross-instance rate limiter backed by Postgres (the rate_limits
 * table and the check_rate_limit / check_rate_limit_cost functions). Use this
 * for abuse-prone endpoints (public forms, uploads, image processing) where an
 * in-memory limiter would be useless because each Cloud Run instance has its
 * own memory.
 *
 * Fails OPEN: if the DB call errors we allow the request rather than locking
 * everyone out on a transient hiccup. The limiter is a guard rail, not the
 * primary correctness boundary (auth + validation still apply).
 */
export async function rateLimit(
  key: string,
  { max, windowSeconds, cost }: RateLimitOptions,
): Promise<RateLimitResult> {
  try {
    const result = await withService((db) =>
      db.execute(
        cost === undefined
          ? sql`select check_rate_limit(p_key => ${key}, p_max => ${max}, p_window_seconds => ${windowSeconds}) as allowed`
          : sql`select check_rate_limit_cost(p_key => ${key}, p_max => ${max}, p_window_seconds => ${windowSeconds}, p_cost => ${weightOf(cost)}) as allowed`,
      ),
    );
    const allowed = (result.rows[0] as { allowed: boolean | null } | undefined)
      ?.allowed;
    return { allowed: allowed === true };
  } catch (e) {
    // Fail OPEN — a transient DB hiccup must not lock everyone out.
    console.error("rateLimit threw (failing open):", e);
    return { allowed: true };
  }
}

// The per-IP key: the address that connected to our load balancer, read from
// the right of X-Forwarded-For so a caller cannot choose it (lib/client-ip.ts).
export { clientIp } from "@/lib/client-ip";
