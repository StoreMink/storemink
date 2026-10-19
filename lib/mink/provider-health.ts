import "server-only";

import type { MinkProviderTarget } from "./retry";

/**
 * Which Mink models this server instance has just seen fail, so a NEW run can
 * start on the fallback instead of paying the same stall again.
 *
 * ★ A CAPACITY WINDOW LASTS MINUTES, NOT ONE REQUEST. Production failed 6 of
 * 11 runs between 18:03 and 18:08 UTC on 2026-10-19, and a run that waits out
 * a 20 s first-chunk deadline before failing over makes every merchant in that
 * window wait 20 s. One failure on a model marks it for `COOLDOWN_MS`; runs
 * created meanwhile start on the fallback, and one answer from the model
 * clears the mark at once.
 * ★ PER PROCESS, DELIBERATELY. Cloud Run instances share nothing, so each
 * learns for itself; a shared store would add a database round trip to every
 * run to save at most one stall per instance per window. It holds nothing but
 * model ids and deadlines, so serving several stores from it leaks nothing.
 */
const COOLDOWN_MS = 60_000;

const unavailableUntil = new Map<string, number>();

function key(target: MinkProviderTarget): string {
  return `${target.location}/${target.model}`;
}

export function markMinkModelUnavailable(
  target: MinkProviderTarget,
  now = Date.now(),
): void {
  unavailableUntil.set(key(target), now + COOLDOWN_MS);
}

export function markMinkModelAnswered(target: MinkProviderTarget): void {
  unavailableUntil.delete(key(target));
}

export function minkModelLooksAvailable(
  target: MinkProviderTarget,
  now = Date.now(),
): boolean {
  const until = unavailableUntil.get(key(target));
  if (until === undefined) return true;
  if (until <= now) {
    unavailableUntil.delete(key(target));
    return true;
  }
  return false;
}

/** Tests only: forget everything this process has seen. */
export function resetMinkModelHealth(): void {
  unavailableUntil.clear();
}
