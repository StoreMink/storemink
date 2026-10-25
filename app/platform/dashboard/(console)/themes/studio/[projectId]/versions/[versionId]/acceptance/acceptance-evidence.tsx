import type { ThemeStudioAcceptanceRunView } from "@/lib/theme-studio/acceptance";
import {
  acceptanceWarnings,
  gateBlocks,
  type GateFinding,
  type GateResult,
} from "@/lib/theme-studio/acceptance-gates";
import {
  isPlatformFinding,
  isSeriousFinding,
} from "@/lib/theme-studio/finding-severity";
import type { StudioTone } from "../../../../studio-status";
import { StudioBadge, plainText, studioDate } from "../../../../studio-ui";
import { CHECK_HEADINGS } from "../../../../studio-words";

// ---------------------------------------------------------------------------
// One check run as evidence, for the Checks tab's Technical details (wave
// TS-2, builder 2C): the run's facts (its build, its digests, who ran it and
// when), then every check with its code and every finding as it was measured.
// The main view of the Checks tab says the same things in plain words; codes,
// builds and digests appear here and nowhere else on screen.
//
// Server-safe and hook-free: the Checks tab renders it on the server, so it
// reads the severity rules directly. A run passes when no serious finding is
// left, and its warnings never stop Publish (severity-v1, "Fix it, then
// allow Publish"). Dashboard tokens only (studio.css).
// ---------------------------------------------------------------------------

type RunStatus = ThemeStudioAcceptanceRunView["status"];

const RUN_TONE: Record<RunStatus, StudioTone> = {
  running: "info",
  awaiting_browser: "info",
  passed: "success",
  failed: "danger",
  blocked: "danger",
  error: "neutral",
  expired: "neutral",
};

const RUN_LABEL: Record<RunStatus, string> = {
  running: "Running",
  awaiting_browser: "Waiting for the browser",
  passed: "Passed",
  failed: "Found problems",
  blocked: "Security problem",
  error: "Did not finish",
  expired: "Did not finish",
};

/** A check run's state in words, in the Studio's badge. */
export function AcceptanceRunBadge({ status }: { status: RunStatus }) {
  return (
    <StudioBadge
      status={{
        words: RUN_LABEL[status] ?? "Did not finish",
        tone: RUN_TONE[status] ?? "neutral",
      }}
    />
  );
}

/** What one check came to: it passed, it stops Publish, or it only warns. */
export function gateMark(result: GateResult): {
  label: string;
  tone: StudioTone;
} {
  if (result.status === "pass") return { label: "Pass", tone: "success" };
  if (result.status === "skipped") return { label: "Not run", tone: "neutral" };
  if (gateBlocks(result)) return { label: "Must fix", tone: "danger" };
  return { label: "Warnings", tone: "warning" };
}

/** A finding stops Publish when it is serious in a check that is required;
 * every other finding is a warning (a finding with no severity counts as
 * serious). */
export function findingStops(result: GateResult, finding: GateFinding) {
  return result.required && isSeriousFinding(finding);
}

/** The first 12 characters of a digest: enough to tell two apart. */
function short(digest: string | null): string {
  return digest ? `${digest.slice(0, 12)}...` : "none";
}

function metricText(metrics: GateResult["metrics"]): string | null {
  if (!metrics) return null;
  const parts = Object.entries(metrics)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}: ${value}`);
  return parts.length ? parts.join(", ") : null;
}

/** The run in one sentence, beside its badge. */
export function runSummary(
  run: ThemeStudioAcceptanceRunView,
  autoChecks = true,
): string {
  const blocking = run.gates.filter(gateBlocks).length;
  const warnings = acceptanceWarnings(run.gates).reduce(
    (n, g) => n + g.findings.length,
    0,
  );
  const parts: string[] = [];
  if (run.status === "failed" && blocking)
    parts.push(
      `${blocking} check${blocking === 1 ? "" : "s"} found problems that stop Publish.`,
    );
  if (run.status === "blocked")
    parts.push("The security scan failed, so this design can't be published.");
  if (run.status === "passed")
    parts.push(
      warnings > 0
        ? `Passed, with ${warnings} warning${warnings === 1 ? "" : "s"}. Warnings never stop Publish; they go live with the theme.`
        : "Passed.",
    );
  if (run.status === "running" || run.status === "awaiting_browser")
    parts.push("Still running.");
  if (run.status === "error" || run.status === "expired")
    parts.push("It did not finish, so it does not count as passed.");
  if (!run.currentBuild)
    parts.push(
      run.status === "passed" && autoChecks
        ? "It ran on an earlier StoreMink build, so Publish checks this design again on today's build first, about 3 to 5 minutes."
        : "It ran on an earlier StoreMink build.",
    );
  return parts.join(" ");
}

/**
 * One check run in full, for Technical details: the run's facts, then each
 * check with its code, its status and every finding as measured (its code,
 * where it was found and its own words, without a long dash).
 */
export function AcceptanceEvidence({
  run,
  autoChecks = true,
}: {
  run: ThemeStudioAcceptanceRunView;
  /** The automatic checks are on here, so Publish re-checks old evidence. */
  autoChecks?: boolean;
}) {
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Check run</h3>
        <AcceptanceRunBadge status={run.status} />
        {!run.currentBuild ? (
          <StudioBadge status={{ words: "Earlier build", tone: "warning" }} />
        ) : null}
      </div>
      <p className="studio-muted text-sm">{runSummary(run, autoChecks)}</p>
      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex flex-wrap gap-x-2">
          <dt className="studio-muted">Run</dt>
          <dd className="studio-code">{run.id}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="studio-muted">Build</dt>
          <dd>
            <span className="studio-code">{run.buildId}</span>{" "}
            {run.currentBuild ? "(today's build)" : "(an earlier build)"}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="studio-muted">Started</dt>
          <dd>
            {studioDate(run.createdAt)} by {run.createdByEmail}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="studio-muted">Finished</dt>
          <dd>{run.completedAt ? studioDate(run.completedAt) : "not yet"}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="studio-muted">Theme file</dt>
          <dd className="studio-code">{short(run.packageDigest)}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="studio-muted">Pictures</dt>
          <dd className="studio-code">{short(run.assetsDigest)}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="studio-muted">Evidence</dt>
          <dd className="studio-code">{short(run.evidenceDigest)}</dd>
        </div>
        {run.userAgent ? (
          <div className="flex flex-wrap gap-x-2 sm:col-span-2">
            <dt className="studio-muted">Browser</dt>
            <dd className="min-w-0 break-words">{run.userAgent}</dd>
          </div>
        ) : null}
      </dl>

      <ul className="grid gap-2">
        {run.gates.map((result) => {
          const metrics = metricText(result.metrics);
          const mark = gateMark(result);
          const name = Object.hasOwn(CHECK_HEADINGS, result.id)
            ? CHECK_HEADINGS[result.id]
            : result.label;
          return (
            <li
              key={result.id}
              className="rounded-[var(--dash-radius-sm)] border border-[var(--dash-border)] px-3 py-2"
            >
              <details open={gateBlocks(result)}>
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {name} <span className="studio-code">{result.id}</span>
                    {!result.required ? (
                      <span className="studio-muted text-xs">
                        {" "}
                        (not required)
                      </span>
                    ) : null}
                  </span>
                  <StudioBadge
                    status={{
                      words:
                        result.findings.length && result.status !== "skipped"
                          ? `${mark.label}, ${result.findings.length}`
                          : mark.label,
                      tone: mark.tone,
                    }}
                  />
                </summary>
                {metrics ? <p className="studio-code mt-1">{metrics}</p> : null}
                {result.findings.length ? (
                  <ul className="mt-2 grid gap-1">
                    {result.findings.map((finding, index) => {
                      const stops = findingStops(result, finding);
                      return (
                        <li
                          key={`${finding.code}-${index}`}
                          className="text-xs leading-relaxed"
                        >
                          <span
                            className={
                              stops
                                ? "studio-error mr-1.5 font-semibold"
                                : "mr-1.5 font-semibold"
                            }
                          >
                            {stops ? "Must fix" : "Warning"}
                            {isPlatformFinding(result.id, finding)
                              ? ", StoreMink's code"
                              : ""}
                          </span>
                          <span className="studio-code mr-1.5">
                            {finding.code}
                          </span>
                          {finding.where ? (
                            <span className="studio-code mr-1.5">
                              {plainText(finding.where)}
                            </span>
                          ) : null}
                          {plainText(finding.message)}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
