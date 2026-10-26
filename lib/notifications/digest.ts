// ---------------------------------------------------------------------------
// Digest windows — when a queued notification email becomes eligible to send.
//
// Pure (no Date.now() unless you omit `from`) so the boundaries are testable
// without freezing the clock.
//
// The windows are deliberately aligned to CLOCK boundaries rather than "now +
// 1 hour": everything that happens between 14:00 and 15:00 shares one send
// time, so it leaves as ONE grouped email. A rolling window would give each
// event its own deadline and quietly degrade back into one email per event —
// the exact thing digests exist to prevent.
//
// DUE ≠ SENT. A row is sent by the next worker run after it comes due. Cloud
// Scheduler runs /api/cron/send-emails every minute (docs/cron-jobs.md), and
// an instant email being enqueued also kicks the worker, so hourly and daily
// digests leave within about a minute of coming due.
// ---------------------------------------------------------------------------

import type { Digest } from "./events";

/**
 * The hour (UTC) a daily digest becomes DUE: 23:00 UTC, 04:30 IST, the
 * merchant's morning summary for an India-first product. Cloud Scheduler
 * drains the queue every minute, so the digest leaves within about a minute.
 * (23 was chosen when the worker ran once a day at 00:00 UTC; moving it now is
 * a product decision, not a scheduling one.)
 */
export const DAILY_DIGEST_HOUR_UTC = 23;

/**
 * When an event queued at `from` should be sent, given its digest setting.
 *   instant → immediately
 *   hourly  → the top of the next hour
 *   daily   → the next DAILY_DIGEST_HOUR_UTC (today's if still ahead)
 */
export function digestSendAfter(digest: Digest, from: Date = new Date()): Date {
  if (digest === "hourly") {
    const next = new Date(from);
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(next.getUTCHours() + 1);
    return next;
  }
  if (digest === "daily") {
    const next = new Date(from);
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(DAILY_DIGEST_HOUR_UTC);
    // Already past today's slot → tomorrow's.
    if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  return new Date(from);
}
