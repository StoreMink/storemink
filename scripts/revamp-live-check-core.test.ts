import { describe, expect, it, vi } from "vitest";
import {
  CLAIM_MARGIN_MS,
  driveRevamp,
  leaseWaitLine,
  pastRunCeiling,
  type DriveDeps,
  type DrivenJob,
} from "./revamp-live-check-core";

// jobs.ts REVAMP_RUN_CEILING_MS; the script passes the real one in.
const CEILING = 4 * 60 * 60_000;
const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const HOUR = 60 * 60_000;

function job(overrides: Partial<DrivenJob> = {}): DrivenJob {
  return {
    status: "running",
    step: "photos",
    leaseUntil: null,
    cancelRequestedAt: null,
    attempts: 0,
    maxAttempts: 4,
    result: { firstClaimedAt: NOW - HOUR },
    ...overrides,
  };
}

const at = (ms: number) => new Date(ms).toISOString();

/**
 * The loop's world, scripted: each invocation's outcome, each read of the job
 * and each status read, in turn, on a clock that only the waits move.
 */
function harness(script: {
  runs: string[];
  jobs: DrivenJob[];
  views?: Array<{ status: string }>;
}) {
  let clock = NOW;
  const lines: string[] = [];
  const deps = {
    run: vi.fn(async () => ({ outcome: script.runs.shift() ?? "not_claimed" })),
    read: vi.fn(async () => script.jobs.shift() ?? null),
    readStatus: vi.fn(async () => script.views?.shift() ?? null),
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    now: () => clock,
    log: (line: string) => {
      lines.push(line);
    },
    ceilingMs: CEILING,
  } satisfies DriveDeps;
  return { deps, lines };
}

describe("leaseWaitLine", () => {
  it("★★ names the job's attempts as the step's failures in a row (B8), never as an attempt", () => {
    const line = leaseWaitLine("handover", 60_000, job({ attempts: 1 }));
    expect(line).toBe(
      "handover: waiting 60.0 s for the lease (1 of 4 failures in a row at step photos)",
    );
    expect(line).not.toMatch(/attempt/i);
  });
});

describe("pastRunCeiling", () => {
  it("is false for a job never claimed, and for one inside its ceiling", () => {
    expect(pastRunCeiling(job({ result: null }), NOW, CEILING)).toBe(false);
    expect(pastRunCeiling(job({ result: {} }), NOW, CEILING)).toBe(false);
    expect(
      pastRunCeiling(
        job({ result: { firstClaimedAt: NOW - CEILING + 1 } }),
        NOW,
        CEILING,
      ),
    ).toBe(false);
  });

  it("★ is true from the moment the ceiling is reached, as jobs.ts's own test counts it", () => {
    expect(
      pastRunCeiling(
        job({ result: { firstClaimedAt: NOW - CEILING } }),
        NOW,
        CEILING,
      ),
    ).toBe(true);
    expect(
      pastRunCeiling(
        job({ result: { firstClaimedAt: NOW - CEILING - HOUR } }),
        NOW,
        CEILING,
      ),
    ).toBe(true);
  });
});

describe("driveRevamp", () => {
  it("★★ reads the status of a job past its ceiling, which fails it, instead of calling it unclaimable", async () => {
    const { deps, lines } = harness({
      runs: ["not_claimed"],
      jobs: [job({ result: { firstClaimedAt: NOW - CEILING - 60_000 } })],
      views: [{ status: "failed" }],
    });

    await expect(driveRevamp(deps, NOW + HOUR)).resolves.toEqual({
      outcome: "failed",
      invocations: 1,
    });
    // ★ The card's read, once; no claims refused in a loop, no waits.
    expect(deps.readStatus).toHaveBeenCalledTimes(1);
    expect(deps.run).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(lines).toEqual([
      "past its 4-hour ceiling from the first claim: reading its status as the card does",
    ]);
  });

  it("★ reads it at once under a parked lease too, as the card's read settles such a job", async () => {
    const { deps } = harness({
      runs: ["handover"],
      jobs: [
        job({
          leaseUntil: at(NOW + 20 * 60_000),
          result: { firstClaimedAt: NOW - CEILING },
        }),
      ],
      views: [{ status: "failed" }],
    });

    await expect(driveRevamp(deps, NOW + HOUR)).resolves.toEqual({
      outcome: "failed",
      invocations: 1,
    });
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("★ waits out somebody's live lease on a job past its ceiling, then reads again", async () => {
    const past = { firstClaimedAt: NOW - CEILING - 1 };
    const { deps } = harness({
      runs: ["not_claimed", "not_claimed"],
      jobs: [
        job({ leaseUntil: at(NOW + 30_000), result: past }),
        job({ result: past }),
      ],
      // The first read leaves it to its holder; the second settles it.
      views: [{ status: "running" }, { status: "failed" }],
    });

    await expect(driveRevamp(deps, NOW + HOUR)).resolves.toEqual({
      outcome: "failed",
      invocations: 2,
    });
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(deps.sleep).toHaveBeenCalledWith(30_000 + CLAIM_MARGIN_MS);
    expect(deps.readStatus).toHaveBeenCalledTimes(2);
  });

  it("logs a parked lease's wait as failures in a row, and claims again after it", async () => {
    const { deps, lines } = harness({
      runs: ["handover", "ready"],
      jobs: [job({ attempts: 1, leaseUntil: at(NOW + 60_000) })],
    });

    await expect(driveRevamp(deps, NOW + HOUR)).resolves.toEqual({
      outcome: "ready",
      invocations: 2,
    });
    expect(lines).toEqual([
      "handover: waiting 60.0 s for the lease (1 of 4 failures in a row at step photos)",
    ]);
    expect(deps.sleep).toHaveBeenCalledWith(60_000 + CLAIM_MARGIN_MS);
    expect(deps.readStatus).not.toHaveBeenCalled();
  });

  it("still settles a job out of failures with the status read once its lease is free", async () => {
    const { deps } = harness({
      runs: ["handover"],
      jobs: [job({ attempts: 4 })],
      views: [{ status: "failed" }],
    });
    await expect(driveRevamp(deps, NOW + HOUR)).resolves.toEqual({
      outcome: "failed",
      invocations: 1,
    });
  });

  it("still gives up on a job inside its ceiling that three free claims refuse", async () => {
    const { deps } = harness({
      runs: ["not_claimed", "not_claimed", "not_claimed"],
      jobs: [job(), job(), job()],
    });
    await expect(driveRevamp(deps, NOW + HOUR)).resolves.toEqual({
      outcome: "unclaimable",
      invocations: 3,
    });
    expect(deps.readStatus).not.toHaveBeenCalled();
    expect(deps.sleep.mock.calls).toEqual([[2_000], [2_000]]);
  });

  it("stops at the deadline rather than wait past it", async () => {
    const { deps, lines } = harness({
      runs: ["handover"],
      jobs: [job({ leaseUntil: at(NOW + 20 * 60_000) })],
    });
    await expect(driveRevamp(deps, NOW + 10 * 60_000)).resolves.toEqual({
      outcome: "timed_out",
      invocations: 1,
    });
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(lines).toEqual([
      "stopped waiting: the job is still running at step photos; run --run again to carry on",
    ]);
  });
});
