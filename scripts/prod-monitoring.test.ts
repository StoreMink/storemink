// scripts/prod-monitoring.py's alert definitions, read from its own dry run,
// which prints every body it would send and makes no network call. The five
// Theme Studio policies (Theme Studio plan P6) stay definitions until the
// owner applies them after the release (step A1), so a wrong filter would sit
// silent in production; this pins what each one watches. The script is never
// run with --apply here.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "prod-monitoring.py");

interface Condition {
  displayName: string;
  conditionMatchedLog?: { filter: string };
  conditionThreshold?: { filter: string };
  conditionPrometheusQueryLanguage?: {
    query: string;
    duration: string;
    evaluationInterval: string;
  };
}
interface Policy {
  displayName: string;
  severity: string;
  combiner: string;
  conditions: Condition[];
  documentation: { content: string };
  userLabels: Record<string, string>;
  alertStrategy: Record<string, unknown>;
  notificationChannels: string[];
}

function python(args: string[]): string {
  return execFileSync("python3", ["-I", ...args], {
    cwd: ROOT,
    // Only PATH (and the NODE_ENV Node's types require; the script reads
    // no environment variable).
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
}

/** Every "## <kind>" block of the dry run, its JSON parsed. */
function dryRun(): { kind: string; body: Record<string, unknown> }[] {
  const out = python([SCRIPT]);
  return out
    .split("\n## ")
    .slice(1)
    .map((block) => {
      const newline = block.indexOf("\n");
      const json = block.slice(newline + 1).split("\n\n# ")[0];
      return { kind: block.slice(0, newline), body: JSON.parse(json) };
    });
}

function policies(): Policy[] {
  return dryRun()
    .filter((block) => block.kind === "alert policy")
    .map((block) => block.body as unknown as Policy);
}

function filterOf(policy: Policy): string {
  const condition = policy.conditions[0];
  return (
    condition.conditionMatchedLog?.filter ??
    condition.conditionThreshold?.filter ??
    condition.conditionPrometheusQueryLanguage?.query ??
    ""
  );
}

/** The script run with arguments that must stop before any network call. */
function refusedOffline(args: string[]): string {
  try {
    python([
      "-c",
      [
        "import runpy, subprocess, sys, urllib.request",
        "def refuse(*a, **k):",
        "    raise SystemExit('reached the network: ' + repr(a[:1]))",
        "urllib.request.urlopen = refuse",
        "subprocess.run = refuse",
        `sys.argv = ${JSON.stringify([SCRIPT, ...args])}`,
        `runpy.run_path(${JSON.stringify(SCRIPT)}, run_name="__main__")`,
      ].join("\n"),
    ]);
  } catch (error) {
    const failed = error as { stderr?: string; stdout?: string };
    return `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
  }
  throw new Error("expected the script to stop");
}

const GOOGLE_AI = "Google AI: a model refusing more than 30% of calls";

// The 15 applied on 23 Oct 2026, in the order the script creates them.
const APPLIED_23_OCT = [
  "Web: server errors (5xx)",
  "Database: serious Postgres errors",
  "Database: connection storm from the web service",
  "Database: down",
  "Database: CPU above 60%",
  "Web: memory above 95%",
  "Web: a server ran out of memory",
  "Web: at its maximum number of servers",
  "Cloud Run: quota exceeded",
  "Google AI: a model refusing more than 30% of calls",
  "Mink chat: the fallback model refused",
  "Mink chat: more than 3 failed runs in 10 minutes",
  "Mink redesign: a redesign failed",
  "Theme Studio: a photo came back below the size asked for",
  "Uptime: a StoreMink page is down",
];
const RUN = "Theme Studio: a theme run failed or lost its lease";
const CAPTURE = "Theme Studio: the capture job failed to start";
const QA = "Theme Studio: design reviews are not draining";
const PLATFORM = "Theme Studio: a problem in StoreMink's own storefront code";
const SCHEDULE = "Theme Studio: a schedule attempt failed";

// Each app-line alert and the line it watches: lib/theme-studio/worker.ts,
// capture-start.ts, the design-review queue's count (TS-3A) and
// acceptance-gates.ts.
const APP_LINES: Record<string, string> = {
  [RUN]: "theme studio: run settled",
  [CAPTURE]: "theme_studio.capture_job_start_failed",
  [QA]: "theme_studio.qa_waiting",
  [PLATFORM]: "theme_studio.platform_finding",
};
// Where theme work runs in storemink-prod: the web service, the two private
// workers (scripts/theme-studio-workers.py) and the capture job.
const PROD_THEME_RESOURCES = [
  'resource.labels.service_name="storemink-web-prod"',
  'resource.labels.service_name="storemink-theme-studio-model-prod"',
  'resource.labels.service_name="storemink-theme-studio-qa-prod"',
  'resource.labels.job_name="storemink-theme-studio-capture"',
];

/** How many ORs sit outside every bracket, ignoring quoted text. */
function orsAtTopLevel(filter: string): number {
  let depth = 0;
  let quoted = false;
  let found = 0;
  for (let i = 0; i < filter.length; i += 1) {
    const char = filter[i];
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && filter.startsWith(" OR ", i)) found += 1;
  }
  expect(depth, filter).toBe(0);
  expect(quoted, filter).toBe(false);
  return found;
}

describe("prod-monitoring.py", () => {
  it("keeps the 15 applied alerts in order and adds exactly the five Theme Studio ones (P6)", () => {
    const names = policies().map((policy) => policy.displayName);
    expect(names).toEqual([
      ...APPLIED_23_OCT,
      RUN,
      CAPTURE,
      QA,
      PLATFORM,
      SCHEDULE,
    ]);
    // --apply is idempotent by display name, so every name is unique.
    expect(new Set(names).size).toBe(names.length);
  });

  it("★ sends every Theme Studio alert like the other log alerts: the owner's channel, the same label, one email an hour", () => {
    const byName = new Map(policies().map((p) => [p.displayName, p]));
    for (const name of [RUN, CAPTURE, QA, PLATFORM, SCHEDULE]) {
      const policy = byName.get(name) as Policy;
      expect(policy.conditions).toHaveLength(1);
      expect(policy.conditions[0].conditionMatchedLog).toBeDefined();
      expect(policy.userLabels).toEqual({ "managed-by": "storemink-alerts" });
      expect(policy.notificationChannels).toEqual(["<channel>"]);
      expect(policy.alertStrategy).toEqual({
        notificationRateLimit: { period: "3600s" },
        autoClose: "1800s",
      });
      expect(policy.documentation.content).toContain("plan P6");
      expect(policy.documentation.content).toContain("docs/monitoring.md");
    }
  });

  it("★ watches each app line wherever theme work runs in storemink-prod, never on dev", () => {
    const byName = new Map(policies().map((p) => [p.displayName, p]));
    for (const [name, line] of Object.entries(APP_LINES)) {
      const policy = byName.get(name) as Policy;
      const filter = filterOf(policy);
      for (const resource of PROD_THEME_RESOURCES) {
        expect(filter).toContain(resource);
      }
      expect(filter).toContain(`jsonPayload.message:"${line}"`);
      expect(filter).not.toMatch(/-dev\b/);
      // The email quotes the line it fired on.
      expect(policy.documentation.content).toContain(line);
    }
  });

  it("★ fires on a run that failed or lost its lease, never on one that is only requeued", () => {
    const run = policies().find((p) => p.displayName === RUN) as Policy;
    const filter = filterOf(run);
    expect(filter).toContain(
      '(jsonPayload.outcome="failed" OR jsonPayload.outcome="lost")',
    );
    expect(filter).not.toMatch(/requeued|succeeded|cancelled/);
  });

  it("★ never fires on a failed photo run whose fill round draws its photos again (the theme keeps building)", () => {
    // lib/theme-studio/worker.ts logs `continues: true` on the run settled
    // line of a photo run whose style photo was refused or rejected, or
    // that drew nothing, when it queued a fill round for the same slots.
    const run = policies().find((p) => p.displayName === RUN) as Policy;
    expect(filterOf(run)).toMatch(/ AND NOT jsonPayload\.continues=true$/);
    expect(run.documentation.content).toContain("continues: true");
  });

  it("★ reads Cloud Scheduler's own failed attempts for the two production schedules", () => {
    const schedule = policies().find(
      (p) => p.displayName === SCHEDULE,
    ) as Policy;
    expect(filterOf(schedule)).toBe(
      'resource.type="cloud_scheduler_job" AND (resource.labels.job_id="storemink-theme-studio-runs" OR resource.labels.job_id="storemink-theme-studio-qa") AND log_id("cloudscheduler.googleapis.com/executions") AND severity>=ERROR',
    );
  });

  it("★ the Google AI alert is one PromQL condition: a 30-minute share above 30% with at least 20 calls, held 15 minutes, emailing only when it opens (owner, 25 Oct 2026)", () => {
    const google = policies().find(
      (p) => p.displayName === GOOGLE_AI,
    ) as Policy;
    // One condition, so one incident and one email per opening (the two
    // threshold conditions it replaced opened two of each).
    expect(google.conditions).toHaveLength(1);
    expect(google.combiner).toBe("OR");
    const rule = google.conditions[0].conditionPrometheusQueryLanguage;
    expect(rule).toBeDefined();
    expect(rule?.duration).toBe("900s");
    expect(rule?.evaluationInterval).toBe("60s");
    const query = rule?.query ?? "";
    expect(query).toContain(
      "aiplatform_googleapis_com:publisher_online_serving_model_invocation_count",
    );
    expect(query).toContain(
      'monitored_resource="aiplatform.googleapis.com/PublisherModel"',
    );
    expect(query).toContain('response_code=~"429|499"');
    // The ratio and the volume gate, both per model and location, both over
    // the same 30 minutes.
    expect(query).toMatch(/\) > 0\.3 and on \(model_user_id, location\) \(/);
    expect(query).toMatch(/>= 20\)$/);
    expect(query.match(/\[30m\]/g)).toHaveLength(3);
    expect(query.match(/sum by \(model_user_id, location\)/g)).toHaveLength(3);
    expect(google.alertStrategy).toEqual({
      autoClose: "3600s",
      notificationPrompts: ["OPENED"],
    });
    expect(google.severity).toBe("WARNING");
    // The email says 499s are ours, not a chat stall watchdog's.
    expect(google.documentation.content).toContain("cut off by our side (499)");
    expect(google.documentation.content).toContain("once when it starts");
  });

  it("keeps every other metric alert's strategy as it was applied on 23 Oct", () => {
    for (const policy of policies()) {
      if (policy.displayName === GOOGLE_AI) continue;
      if (policy.conditions[0].conditionMatchedLog) continue;
      expect(policy.alertStrategy, policy.displayName).toEqual({
        autoClose: "1800s",
      });
    }
  });

  it("★ --update refuses a name the script does not define before it reads anything", () => {
    const out = refusedOffline(["--update", "Google AI: no such policy"]);
    expect(out).toContain("--update names no policy this script defines");
    expect(out).not.toContain("reached the network");
  });

  it("brackets every OR (the Logging query language binds OR tighter than AND)", () => {
    for (const policy of policies()) {
      expect(orsAtTopLevel(filterOf(policy)), policy.displayName).toBe(0);
    }
  });

  it("★ makes no network call and runs no gcloud in its dry run", () => {
    const out = python([
      "-c",
      [
        "import runpy, subprocess, sys, urllib.request",
        "def refuse(*args, **kwargs):",
        "    raise SystemExit('the dry run tried to reach ' + repr(args[:1]))",
        "urllib.request.urlopen = refuse",
        "subprocess.run = refuse",
        `sys.argv = [${JSON.stringify(SCRIPT)}]`,
        `runpy.run_path(${JSON.stringify(SCRIPT)}, run_name="__main__")`,
      ].join("\n"),
    ]);
    expect(out).toContain("# DRY RUN: nothing is sent.");
    expect(out).toContain("# 20 alert policies");
  });
});
