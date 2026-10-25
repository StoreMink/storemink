/**
 * The testable half of scripts/revamp-live-check.ts: the loop that drives one
 * redesign to its end, one runner invocation after another. The script runs
 * itself (and reads .env) when it is imported, so its test imports this
 * instead, the split scripts/mink-whatsapp-eval-core.ts makes.
 *
 * ★ No server import: the runner, the job reads and the card's status read
 *   come in as `DriveDeps`, and so does `REVAMP_RUN_CEILING_MS` (jobs.ts), so
 *   the test needs neither a database nor a model.
 */
import type { RevampJobRow } from "../lib/mink/revamp/jobs";

/** A little past a parked lease, so the next claim is never refused by a hair. */
export const CLAIM_MARGIN_MS = 500;

/** What the loop reads of the job between invocations. */
export type DrivenJob = Pick<
  RevampJobRow,
  | "status"
  | "step"
  | "leaseUntil"
  | "cancelRequestedAt"
  | "attempts"
  | "maxAttempts"
  | "result"
>;

export interface DriveDeps {
  /** One runner invocation (`runRevampJob`, its kick switched off). */
  run(): Promise<{ outcome: string }>;
  /** The runner's read of the job (`readRevampJob`). */
  read(): Promise<DrivenJob | null>;
  /**
   * The card's status read (`readRevampStatus`), which settles a job nobody
   * may claim again: one stopped, out of attempts or past its ceiling.
   */
  readStatus(): Promise<{ status: string } | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
  /** jobs.ts `REVAMP_RUN_CEILING_MS`. */
  ceilingMs: number;
}

/**
 * ★★ Past its wall-clock ceiling (robustness audit B8): first claimed at
 *   least `ceilingMs` ago, the test jobs.ts runs in SQL (`pastCeilingSql`). A
 *   job never claimed has no clock and is never past it. The claim refuses
 *   such a job for good, so only the status read can end it.
 */
export function pastRunCeiling(
  job: Pick<DrivenJob, "result">,
  now: number,
  ceilingMs: number,
): boolean {
  const first = job.result?.firstClaimedAt;
  return (
    typeof first === "number" &&
    Number.isFinite(first) &&
    first <= now - ceilingMs
  );
}

/**
 * The line for a parked lease the loop waits out. ★★ `attempts` counts the
 *   step's real failures in a row since B8 (a claim, a wait on Google and a
 *   claim whose process died count none; four fail the job), so it is named
 *   as failures, never as the attempt the claim is about to make.
 */
export function leaseWaitLine(
  outcome: string,
  waitMs: number,
  job: Pick<DrivenJob, "attempts" | "maxAttempts" | "step">,
): string {
  return `${outcome}: waiting ${seconds(waitMs)} for the lease (${job.attempts} of ${job.maxAttempts} failures in a row at step ${job.step})`;
}

/**
 * Claim and run until the job settles, as the run route does, one invocation
 * after another. ★ A parked lease (a transient failure waits before the next
 * claim) is waited out, never polled, and the whole thing stops at the
 * deadline rather than waiting on a job forever.
 * ★★ A job nobody may claim again ends with the card's status read, which is
 *   what settles it: one stopped or out of attempts once its lease is free,
 *   and one past its ceiling at once, as the card would (the read settles a
 *   job under a parked lease too, and leaves one somebody holds live as it
 *   is). Reported as the status that read leaves, never as `unclaimable`: a
 *   job past its ceiling used to be refused three claims running and given
 *   up on, still `running`, while the read that fails it as
 *   `out_of_attempts` (detail `run_ceiling`) was never made.
 */
export async function driveRevamp(
  deps: DriveDeps,
  deadline: number,
): Promise<{ outcome: string; invocations: number }> {
  let invocations = 0;
  let unclaimable = 0;
  for (;;) {
    invocations += 1;
    const { outcome } = await deps.run();
    if (
      outcome === "ready" ||
      outcome === "failed" ||
      outcome === "cancelled"
    ) {
      return { outcome, invocations };
    }
    const job = await deps.read();
    if (!job) return { outcome: "missing", invocations };
    if (job.status !== "queued" && job.status !== "running") {
      return { outcome: job.status, invocations };
    }
    const now = deps.now();
    const leaseUntil = job.leaseUntil ? Date.parse(job.leaseUntil) : 0;
    const waitMs = Math.max(0, leaseUntil - now);
    const pastCeiling = pastRunCeiling(job, now, deps.ceilingMs);
    const ended =
      waitMs === 0 &&
      (job.cancelRequestedAt !== null || job.attempts >= job.maxAttempts);
    if (pastCeiling || ended) {
      // Nobody may claim it again (stopped, out of attempts, or past its
      // ceiling): the status read settles it for good, as the card's poll
      // would.
      if (pastCeiling) {
        deps.log(
          `past its ${hours(deps.ceilingMs)} ceiling from the first claim: reading its status as the card does`,
        );
      }
      const view = await deps.readStatus();
      const active = view?.status === "queued" || view?.status === "running";
      // ★ A job past its ceiling the read left active is held live by
      //   somebody: its lease is waited out like any other, and the read is
      //   asked again after it.
      if (!pastCeiling || !active) {
        return { outcome: view?.status ?? "unclaimable", invocations };
      }
    }
    if (now + waitMs > deadline) {
      deps.log(
        `stopped waiting: the job is still ${job.status} at step ${job.step}; run --run again to carry on`,
      );
      return { outcome: "timed_out", invocations };
    }
    if (waitMs > 0) {
      unclaimable = 0;
      deps.log(leaseWaitLine(outcome, waitMs, job));
      await deps.sleep(waitMs + CLAIM_MARGIN_MS);
    } else if (outcome === "not_claimed" || outcome === "busy") {
      // ★ Free to claim and still refused: something this loop cannot see,
      //   or (busy) this process already holds the runner's one revamp slot,
      //   which shops run one after another should never meet. A few short
      //   tries, never a tight loop against the database.
      unclaimable += 1;
      if (unclaimable >= 3) return { outcome: "unclaimable", invocations };
      await deps.sleep(2_000);
    } else {
      deps.log(`${outcome}: claiming again at step ${job.step}`);
    }
  }
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function hours(ms: number): string {
  const value = ms / 3_600_000;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}-hour`;
}
