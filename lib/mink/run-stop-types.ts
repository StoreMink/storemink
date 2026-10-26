/**
 * What `POST /api/mink/runs/[runId]/stop` answered. Client-safe (no server
 * imports), so the dashboard's chat hook and the voice loop can read it
 * without pulling in the database client: the lib/logs/failure-types.ts
 * split.
 *
 * ★ A stop is a REQUEST, not an abort. Behind the production load balancer an
 * aborted fetch never reaches Cloud Run, so the run kept going after the
 * browser let go of it (25 Oct 2026: a voice barge-in dropped a reply that had
 * already started a storefront redesign, and its card never showed). The
 * server now decides, on the run's own row, whether the stop or the run's
 * first side effect came first, and the browser lets go only on `stopped`.
 */
export type MinkStopResult =
  /** Nothing was done and nothing will be: the run ends with no answer. */
  | { outcome: "stopped" }
  /** The run already started something; it will finish and answer. */
  | { outcome: "acted" }
  /** The run had already ended (or is not this viewer's). */
  | { outcome: "finished"; status?: MinkStoppedRunStatus }
  /** The browser could not find out. Treat it like `acted`: keep reading. */
  | { outcome: "unknown" };

export type MinkStoppedRunStatus = "succeeded" | "failed" | "cancelled";

const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * Reads a stop answer strictly. Anything it does not recognise is `unknown`,
 * never `stopped`: letting go of a reply the server is still producing is the
 * failure this exists to prevent, so only an explicit `stopped` may cause it.
 */
export function readMinkStopResult(value: unknown): MinkStopResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { outcome: "unknown" };
  }
  const record = value as Record<string, unknown>;
  switch (record.outcome) {
    case "stopped":
      return { outcome: "stopped" };
    case "acted":
      return { outcome: "acted" };
    case "finished": {
      const status = record.status;
      return typeof status === "string" && FINISHED_STATUSES.has(status)
        ? { outcome: "finished", status: status as MinkStoppedRunStatus }
        : { outcome: "finished" };
    }
    default:
      return { outcome: "unknown" };
  }
}
