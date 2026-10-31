// scripts/prod-monitoring.py's alert definitions, read from its own dry run,
// which prints every body it would send and makes no network call. The five
// Theme Studio policies (Theme Studio plan P6) stay definitions until the
// owner applies them after the release (step A1), and so do the two refund
// policies (the refunds release, decision D10), the two GST policies (the
// GST release) and the four takedown policies (the content takedown release,
// decision D12, production step P4), so a wrong filter would sit silent in
// production; this pins what each one watches. The script is never run with
// --apply here.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "prod-monitoring.py");

interface Condition {
  displayName: string;
  conditionMatchedLog?: {
    filter: string;
    labelExtractors?: Record<string, string>;
  };
  conditionThreshold?: { filter: string };
  conditionAbsent?: {
    filter: string;
    aggregations: Record<string, unknown>[];
    duration: string;
    trigger: Record<string, unknown>;
  };
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
    condition.conditionAbsent?.filter ??
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
const REFUND_FAILED = "Billing: a refund to a merchant failed";
const REFUNDS_WAITING = "Billing: refunds waiting more than a day";
const GST_RENEWAL = "Billing: renewals cannot read the GST settings";
const GST_UNISSUED = "Billing: a captured payment's invoice is still a draft";
const COMPLAINT = "Takedown: a complaint needs action";
const FOLLOWUPS_FAILING = "Takedown: follow-ups failing";
const FOLLOWUPS_STOPPED = "Takedown: follow-ups stopped";
const SEND_EMAILS_SCHEDULE = "Cloud Scheduler attempt failed (send-emails)";
const FOLLOWUPS_METRIC = "moderation_followups_ran";
const WEB_PROD =
  'resource.type="cloud_run_revision" AND resource.labels.service_name="storemink-web-prod"';

// Each refund alert, the line it watches in lib/billing/refunds.ts, and its
// severity: a failed refund is money owed that did not go, a waiting one is a
// reminder.
const REFUND_LINES: Record<string, { line: string; severity: string }> = {
  [REFUND_FAILED]: { line: "billing.refund_failed", severity: "ERROR" },
  [REFUNDS_WAITING]: { line: "billing.refund_waiting", severity: "WARNING" },
};

// Each GST alert and the line it watches: lib/billing/renewal-worker.ts
// (always logError) and lib/billing/reconcile.ts (a WARNING for its first six
// hours, R1-14, so the alert matches the ERROR only).
const GST_LINES: Record<string, { line: string; errorOnly: boolean }> = {
  [GST_RENEWAL]: { line: "billing.renewal_tax_snapshot", errorOnly: false },
  [GST_UNISSUED]: { line: "billing.captured_draft_unissued", errorOnly: true },
};

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

type Logger = typeof import("@/lib/observability/logger");
type LoggedLine = Record<string, unknown> & {
  severity: string;
  message: string;
};

/**
 * The JSON line lib/observability/logger.ts writes in production for one
 * call: the module reads NODE_ENV when it loads, so it is loaded afresh with
 * NODE_ENV=production and its console stream captured.
 */
async function productionLine(
  stream: "error" | "warn" | "log",
  write: (logger: Logger) => void,
): Promise<LoggedLine> {
  vi.stubEnv("NODE_ENV", "production");
  vi.resetModules();
  const captured = vi.spyOn(console, stream).mockImplementation(() => {});
  try {
    const logger = await import("@/lib/observability/logger");
    write(logger);
    expect(captured).toHaveBeenCalledTimes(1);
    return JSON.parse(String(captured.mock.calls[0][0])) as LoggedLine;
  } finally {
    captured.mockRestore();
    vi.unstubAllEnvs();
    vi.resetModules();
  }
}

/**
 * Whether a filter's jsonPayload.message clause matches a message, by the
 * three operators the script uses: "=" the whole value, ":" contains it,
 * "=~" a regular expression that searches the value ("^" anchors it to the
 * start; RE2 and JavaScript agree on the plain patterns used here).
 */
function messageMatches(filter: string, message: string): boolean {
  const clause = /jsonPayload\.message(=~|:|=)"((?:[^"\\]|\\.)*)"/.exec(filter);
  if (!clause) throw new Error(`no message clause in ${filter}`);
  const [, operator, quoted] = clause;
  const value = quoted.replace(/\\(.)/g, "$1");
  if (operator === "=") return message === value;
  if (operator === ":") return message.includes(value);
  return new RegExp(value).test(message);
}

describe("prod-monitoring.py", () => {
  it("keeps the 15 applied alerts in order and adds exactly the five Theme Studio ones (P6), the two refund ones, the two GST ones and the four takedown ones (P4)", () => {
    const names = policies().map((policy) => policy.displayName);
    expect(names).toEqual([
      ...APPLIED_23_OCT,
      RUN,
      CAPTURE,
      QA,
      PLATFORM,
      SCHEDULE,
      REFUND_FAILED,
      REFUNDS_WAITING,
      GST_RENEWAL,
      GST_UNISSUED,
      COMPLAINT,
      FOLLOWUPS_FAILING,
      FOLLOWUPS_STOPPED,
      SEND_EMAILS_SCHEDULE,
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

  it("★ watches each refund line in the production web service, one email an hour, never on dev", () => {
    // The billing run (app/api/cron/billing) and the console's refund
    // actions both run in storemink-web-prod. The waiting line can be
    // written twice in its hour (a Scheduler retry or a run by hand), so the
    // hourly limit is what keeps it to one email.
    const byName = new Map(policies().map((p) => [p.displayName, p]));
    for (const [name, { line, severity }] of Object.entries(REFUND_LINES)) {
      const policy = byName.get(name) as Policy;
      expect(policy.severity).toBe(severity);
      expect(policy.conditions).toHaveLength(1);
      expect(policy.conditions[0].conditionMatchedLog).toBeDefined();
      expect(policy.userLabels).toEqual({ "managed-by": "storemink-alerts" });
      expect(policy.notificationChannels).toEqual(["<channel>"]);
      expect(policy.alertStrategy).toEqual({
        notificationRateLimit: { period: "3600s" },
        autoClose: "1800s",
      });
      const filter = filterOf(policy);
      expect(filter).toContain(
        'resource.labels.service_name="storemink-web-prod"',
      );
      // ":" (has), not "=": logError puts the stack after the message.
      expect(filter).toContain(`jsonPayload.message:"${line}"`);
      expect(filter).not.toMatch(/-dev\b/);
      expect(policy.documentation.content).toContain(line);
      expect(policy.documentation.content).toContain("refunds release");
      expect(policy.documentation.content).toContain("docs/monitoring.md");
    }
  });

  it("★ watches each GST line in the production web service at ERROR, one email an hour, never on dev", () => {
    const byName = new Map(policies().map((p) => [p.displayName, p]));
    for (const [name, { line, errorOnly }] of Object.entries(GST_LINES)) {
      const policy = byName.get(name) as Policy;
      expect(policy.severity).toBe("ERROR");
      expect(policy.conditions).toHaveLength(1);
      expect(policy.conditions[0].conditionMatchedLog).toBeDefined();
      expect(policy.userLabels).toEqual({ "managed-by": "storemink-alerts" });
      expect(policy.notificationChannels).toEqual(["<channel>"]);
      expect(policy.alertStrategy).toEqual({
        notificationRateLimit: { period: "3600s" },
        autoClose: "1800s",
      });
      const filter = filterOf(policy);
      expect(filter).toContain(
        'resource.labels.service_name="storemink-web-prod"',
      );
      expect(filter).toContain(`jsonPayload.message:"${line}"`);
      expect(filter).not.toMatch(/-dev\b/);
      // The captured-draft line is a WARNING for six hours (R1-14): only
      // the ERROR may page.
      if (errorOnly) expect(filter).toContain("severity>=ERROR");
      else expect(filter).not.toContain("severity");
      expect(policy.documentation.content).toContain(line);
      expect(policy.documentation.content).toContain("GST release");
      expect(policy.documentation.content).toContain("docs/monitoring.md");
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
      // Pinned with its own condition below.
      if (policy.conditions[0].conditionAbsent) continue;
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
    expect(out).toContain(
      "# 28 alert policies, 3 uptime checks, 2 log metrics, 1 channel",
    );
  });
});

describe("prod-monitoring.py: the takedown alerts (decision D12, production step P4)", () => {
  const byName = (name: string) =>
    policies().find((p) => p.displayName === name) as Policy;
  const T15_LINE = "moderation: block action failed\nError: refused";

  it("★ sends the four takedown alerts like the other log alerts: the owner's channel, the same label, production only", () => {
    for (const name of [
      COMPLAINT,
      FOLLOWUPS_FAILING,
      FOLLOWUPS_STOPPED,
      SEND_EMAILS_SCHEDULE,
    ]) {
      const policy = byName(name);
      expect(policy.conditions, name).toHaveLength(1);
      expect(policy.combiner).toBe("OR");
      expect(policy.userLabels).toEqual({ "managed-by": "storemink-alerts" });
      expect(policy.notificationChannels).toEqual(["<channel>"]);
      expect(policy.documentation.content).toContain("takedown release");
      expect(policy.documentation.content).toContain("production step P4");
      expect(policy.documentation.content).toContain("docs/monitoring.md");
      expect(filterOf(policy)).not.toMatch(/-dev\b/);
    }
    for (const name of [COMPLAINT, FOLLOWUPS_FAILING, FOLLOWUPS_STOPPED]) {
      expect(filterOf(byName(name))).toContain(
        'resource.labels.service_name="storemink-web-prod"',
      );
    }
  });

  it("★★ alerts on a failed follow-up by PREFIX, because production logError puts the stack after the message (must-do T22a)", async () => {
    const policy = byName(FOLLOWUPS_FAILING);
    expect(policy.severity).toBe("ERROR");
    expect(policy.conditions[0].conditionMatchedLog).toBeDefined();
    expect(policy.alertStrategy).toEqual({
      notificationRateLimit: { period: "3600s" },
      autoClose: "1800s",
    });
    const filter = filterOf(policy);
    expect(filter).toBe(
      `${WEB_PROD} AND jsonPayload.message=~"^moderation: follow-up failed" AND severity>=ERROR`,
    );
    expect(filter).not.toContain('jsonPayload.message="');

    // What lib/moderation/follow-ups.ts writes when a step throws.
    const line = await productionLine("error", (logger) =>
      logger.logError(
        "moderation: follow-up failed",
        new Error("connection terminated"),
        { step: "alerts" },
      ),
    );
    expect(line.severity).toBe("ERROR");
    expect(line.step).toBe("alerts");
    expect(
      line.message.startsWith(
        "moderation: follow-up failed\nError: connection terminated",
      ),
    ).toBe(true);
    expect(messageMatches(filter, line.message)).toBe(true);
    // An exact match on the message would never fire in production.
    expect(
      messageMatches(
        'jsonPayload.message="moderation: follow-up failed"',
        line.message,
      ),
    ).toBe(false);
    // The heartbeat and the console's own failures are not the follow-up's.
    expect(messageMatches(filter, "moderation: follow-ups ran")).toBe(false);
    expect(messageMatches(filter, T15_LINE)).toBe(false);
  });

  it("★ pages on every complaint deadline line, one notification per complaint and stage at most every 5 minutes", async () => {
    const policy = byName(COMPLAINT);
    expect(policy.severity).toBe("ERROR");
    expect(policy.alertStrategy).toEqual({
      notificationRateLimit: { period: "300s" },
      autoClose: "1800s",
    });
    const condition = policy.conditions[0].conditionMatchedLog;
    const filter = condition?.filter ?? "";
    expect(filter).toBe(
      `${WEB_PROD} AND jsonPayload.message=~"^moderation: complaint " AND severity>=WARNING`,
    );
    expect(condition?.labelExtractors).toEqual({
      ref: "EXTRACT(jsonPayload.ref)",
      kind: "EXTRACT(jsonPayload.kind)",
      stage: "EXTRACT(jsonPayload.stage)",
      phase: "EXTRACT(jsonPayload.phase)",
    });

    // What the deadline step writes (lib/moderation/follow-ups.ts).
    const line = await productionLine("warn", (logger) =>
      logger.logWarn("moderation: complaint due", {
        ref: "SM-000123",
        kind: "intimate_or_impersonation",
        stage: "act",
        phase: "soon",
        dueAt: "2026-11-02T04:30:00.000Z",
      }),
    );
    expect(line.severity).toBe("WARNING");
    expect(messageMatches(filter, line.message)).toBe(true);
    // Every label the notification names is a field of the line.
    for (const key of Object.keys(condition?.labelExtractors ?? {})) {
      expect(line[key], key).toBeTruthy();
    }

    // What the console writes the moment an urgent complaint is logged
    // (app/actions/takedown-actions.ts, logComplaintAction).
    const urgent = await productionLine("warn", (logger) =>
      logger.logWarn("moderation: complaint urgent", {
        ref: "SM-000124",
        kind: "court_order",
        stage: "act",
        phase: "logged",
        dueAt: "2026-11-02T06:00:00.000Z",
      }),
    );
    expect(urgent.severity).toBe("WARNING");
    expect(messageMatches(filter, urgent.message)).toBe(true);
    for (const key of Object.keys(condition?.labelExtractors ?? {})) {
      expect(urgent[key], key).toBeTruthy();
    }
    // Errors about complaints are not a deadline: the person who pressed the
    // button reads those on screen.
    for (const other of [
      "moderation.complaints: log failed\nError: refused",
      "moderation: log complaint action failed\nError: refused",
      "moderation: follow-up failed\nError: refused",
      T15_LINE,
    ]) {
      expect(messageMatches(filter, other), other).toBe(false);
    }
  });

  it("★ opens when 10 minutes pass without a follow-up heartbeat, summed across every revision, and stays open while it lasts", async () => {
    const policy = byName(FOLLOWUPS_STOPPED);
    expect(policy.severity).toBe("ERROR");
    expect(policy.conditions[0].conditionAbsent).toEqual({
      filter: `metric.type="logging.googleapis.com/user/${FOLLOWUPS_METRIC}" AND ${WEB_PROD}`,
      // One series for the whole service: grouped by revision, every deploy
      // would leave the old revision's series absent and open the alert.
      aggregations: [
        {
          alignmentPeriod: "60s",
          perSeriesAligner: "ALIGN_SUM",
          crossSeriesReducer: "REDUCE_SUM",
        },
      ],
      // Google's floor is 120 s in whole minutes.
      duration: "600s",
      trigger: { count: 1 },
    });
    expect(policy.alertStrategy).toEqual({ autoClose: "604800s" });

    const metric = dryRun().find(
      (block) =>
        block.kind === "log-based metric" &&
        block.body.name === FOLLOWUPS_METRIC,
    )?.body as { filter: string; metricDescriptor: Record<string, string> };
    expect(metric.filter).toBe(
      `${WEB_PROD} AND jsonPayload.message:"moderation: follow-ups ran"`,
    );
    expect(metric.metricDescriptor).toEqual({
      metricKind: "DELTA",
      valueType: "INT64",
      unit: "1",
    });
    // What every run writes in its finally (lib/moderation/follow-ups.ts).
    const line = await productionLine("log", (logger) =>
      logger.logInfo("moderation: follow-ups ran", { alertsSent: 0 }),
    );
    expect(line.severity).toBe("INFO");
    expect(messageMatches(metric.filter, line.message)).toBe(true);
  });

  it("★ reads Cloud Scheduler's own failed attempts for storemink-send-emails, the route the follow-ups ride on", () => {
    const policy = byName(SEND_EMAILS_SCHEDULE);
    expect(policy.severity).toBe("WARNING");
    expect(policy.conditions[0].conditionMatchedLog).toBeDefined();
    expect(policy.alertStrategy).toEqual({
      notificationRateLimit: { period: "3600s" },
      autoClose: "1800s",
    });
    expect(filterOf(policy)).toBe(
      'resource.type="cloud_scheduler_job" AND resource.labels.job_id="storemink-send-emails" AND log_id("cloudscheduler.googleapis.com/executions") AND severity>=ERROR',
    );
  });

  it("★ watches lines the code still writes, from the route the schedule calls", () => {
    const followUps = readFileSync(
      path.join(ROOT, "lib", "moderation", "follow-ups.ts"),
      "utf8",
    );
    expect(followUps).toContain('logError("moderation: follow-up failed"');
    expect(followUps).toContain('logInfo("moderation: follow-ups ran"');
    expect(followUps).toContain('logWarn("moderation: complaint due"');
    expect(
      readFileSync(
        path.join(ROOT, "app", "actions", "takedown-actions.ts"),
        "utf8",
      ),
    ).toContain('logWarn("moderation: complaint urgent"');
    const route = readFileSync(
      path.join(ROOT, "app", "api", "cron", "send-emails", "route.ts"),
      "utf8",
    );
    expect(route).toContain("runModerationFollowUps(");
  });
});
