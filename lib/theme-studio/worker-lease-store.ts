import { sql } from "drizzle-orm";
import { themeStudioRuns, themeStudioVisualQaRuns } from "@/drizzle/schema";
import type { Db } from "@/lib/db/client";
import { WORKER_LEASE_SECONDS } from "./worker-lease";

/** A clock-time fence also rejects a lease that expired while waiting on a
 * row lock. A renewal never changes status, attempts, checkpoints or owner. */
export async function renewStudioLease(
  db: Pick<Db, "execute">,
  queue: "generation" | "qa",
  id: string,
  owner: string,
): Promise<boolean> {
  const table =
    queue === "generation" ? themeStudioRuns : themeStudioVisualQaRuns;
  const rows = await db.execute(sql`UPDATE ${table}
    SET lease_expires_at=clock_timestamp()+(${WORKER_LEASE_SECONDS}::int * interval '1 second')
    WHERE id=${id}::uuid AND status='running' AND lease_owner=${owner}::uuid
      AND lease_expires_at>clock_timestamp()
    RETURNING id`);
  return rows.rows.length === 1;
}
