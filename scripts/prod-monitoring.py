#!/usr/bin/env python3
# Production alerting for storemink-prod, emailed to one address. Created by
# the owner's decision of 23 Oct 2026 ("alerts and uptime checks, emailed to
# me"); what each alert means and what to do: docs/monitoring.md.
#
# The last five policies watch Theme Studio work (Theme Studio plan P6,
# defined 25 Oct 2026). They are definitions until the owner approves applying
# them after the Theme Studio release (step A1): an --apply run before then
# would create them as well.
#
#   python3 -I scripts/prod-monitoring.py                      dry run: prints
#                                                              every body, no network
#   python3 -I scripts/prod-monitoring.py --apply --email <a>  creates what is
#                                                              missing (idempotent by
#                                                              display name), then
#                                                              lists what exists
#
# Writes ONLY to storemink-prod: one email channel, three uptime checks, one
# log-based counter, and the alert policies below. Reads only configuration we
# need to stay idempotent (our channels, checks, policies, log metrics) and
# metric DESCRIPTORS (metadata), never time series, log entries, env vars or
# secrets. Uses the caller's gcloud login (gcloud auth print-access-token).
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PROJECT = "storemink-prod"


def arg_value(name):
    if name in sys.argv:
        index = sys.argv.index(name)
        if index + 1 < len(sys.argv):
            return sys.argv[index + 1].strip()
    return ""


# The alert address is an argument, never committed: the channel is matched by
# it, so re-running with the same address finds the channel already made.
EMAIL = arg_value("--email")
WEB = "storemink-web-prod"
DB_ID = "storemink-prod:storemink-prod-db"
MON = f"https://monitoring.googleapis.com/v3/projects/{PROJECT}"
LOGGING = f"https://logging.googleapis.com/v2/projects/{PROJECT}"
LABELS = {"managed-by": "storemink-alerts"}
CHANNEL_NAME = "StoreMink owner email"
CHAT_FAILURE_METRIC = "mink_chat_run_failures"

WEB_LOGS = f'resource.type="cloud_run_revision" AND resource.labels.service_name="{WEB}"'

# Where Theme Studio work runs in storemink-prod: the web service today, the two
# private workers once the schedules are routed to them (the names
# scripts/theme-studio-workers.py deploys) and the capture job. Exact names, so
# dev (storemink-web-dev, storemink-theme-studio-capture-dev) never matches.
# Every clause is bracketed: in the Logging query language OR binds tighter
# than AND.
THEME_SERVICES = [WEB, "storemink-theme-studio-model-prod", "storemink-theme-studio-qa-prod"]
CAPTURE_JOB = "storemink-theme-studio-capture"
THEME_LOGS = (
    '((resource.type="cloud_run_revision" AND ('
    + " OR ".join(f'resource.labels.service_name="{name}"' for name in THEME_SERVICES)
    + f')) OR (resource.type="cloud_run_job" AND resource.labels.job_name="{CAPTURE_JOB}"))'
)
# Production's two every-minute Theme Studio schedules (docs/cron-jobs.md).
# Dev has none (owner, 2026-10-10).
THEME_SCHEDULES = ["storemink-theme-studio-runs", "storemink-theme-studio-qa"]
SET_UP_23_OCT = "Set up 23 Oct 2026 (owner-approved)."
THEME_STUDIO_ORIGIN = "Theme Studio alert (plan P6), defined 25 Oct 2026 and applied after the Theme Studio release with the owner's OK."

UPTIME_CHECKS = [
    {"displayName": "Uptime: storemink.com", "host": "storemink.com", "path": "/"},
    {"displayName": "Uptime: a merchant store (echoss.storemink.com)", "host": "echoss.storemink.com", "path": "/"},
    {"displayName": "Uptime: dashboard login (echoss.storemink.com/auth/login)", "host": "echoss.storemink.com", "path": "/auth/login"},
]


def die(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def token() -> str:
    result = subprocess.run(["gcloud", "auth", "print-access-token"], capture_output=True, text=True)
    value = result.stdout.strip()
    if result.returncode != 0 or not value:
        die("the gcloud user login has expired: run `gcloud auth login` and try again")
    return value


ACCESS = None


def api(method: str, url: str, body=None):
    request = urllib.request.Request(url, method=method)
    request.add_header("Authorization", f"Bearer {ACCESS}")
    request.add_header("x-goog-user-project", PROJECT)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, data=data, timeout=60) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:1500]
        raise RuntimeError(f"{method} {url.split('?')[0]} -> {error.code}: {detail}") from None


def list_all(url: str, key: str):
    items, page = [], None
    while True:
        sep = "&" if "?" in url else "?"
        page_url = url + (f"{sep}pageToken={urllib.parse.quote(page)}" if page else "")
        data = api("GET", page_url)
        items.extend(data.get(key, []))
        page = data.get("nextPageToken")
        if not page:
            return items


def descriptor_exists(metric_type: str) -> bool:
    try:
        api("GET", f"{MON}/metricDescriptors/{metric_type}")
        return True
    except RuntimeError as error:
        if "-> 404" in str(error):
            return False
        raise


def doc(subject: str, what: str, check: str, origin: str = SET_UP_23_OCT) -> dict:
    return {
        "subject": subject,
        "mimeType": "text/markdown",
        "content": f"**What it means:** {what}\n\n**First thing to check:** {check}\n\n{origin} What to do: docs/monitoring.md in the StoreMink repo.",
    }


def threshold(display, filt, aligner, period, reducer, comparison, value, duration, group_by=None, denominator=None):
    aggregation = {
        "alignmentPeriod": f"{period}s",
        "perSeriesAligner": aligner,
        "crossSeriesReducer": reducer,
    }
    if group_by:
        aggregation["groupByFields"] = group_by
    condition = {
        "filter": filt,
        "aggregations": [aggregation],
        "comparison": comparison,
        "thresholdValue": value,
        "duration": f"{duration}s",
        "trigger": {"count": 1},
    }
    if denominator:
        condition["denominatorFilter"] = denominator
        condition["denominatorAggregations"] = [dict(aggregation)]
    return {"displayName": display, "conditionThreshold": condition}


def log_match(display, filt):
    return {"displayName": display, "conditionMatchedLog": {"filter": filt}}


def policy(name, severity, conditions, documentation, combiner="OR", log_based=False):
    body = {
        "displayName": name,
        "severity": severity,
        "combiner": combiner,
        "conditions": conditions,
        "documentation": documentation,
        "userLabels": LABELS,
        "enabled": True,
    }
    if log_based:
        # A log condition notifies per matching entry: at most one email an hour.
        body["alertStrategy"] = {"notificationRateLimit": {"period": "3600s"}, "autoClose": "1800s"}
    else:
        body["alertStrategy"] = {"autoClose": "1800s"}
    return body


def metric_types(policy_body):
    types = set()
    for condition in policy_body["conditions"]:
        threshold_condition = condition.get("conditionThreshold")
        if not threshold_condition:
            continue
        for part in threshold_condition["filter"].split(" AND "):
            if part.startswith("metric.type="):
                types.add(part.split("=", 1)[1].strip('"'))
    return types


MODEL_CALLS = 'metric.type="aiplatform.googleapis.com/publisher/online_serving/model_invocation_count" AND resource.type="aiplatform.googleapis.com/PublisherModel"'
MODEL_GROUP = ["resource.label.model_user_id", "resource.label.location"]


def policies(uptime_check_ids):
    found = []
    found.append(policy(
        "Web: server errors (5xx)", "ERROR",
        [
            threshold("More than 5 server errors in a minute",
                      f'metric.type="run.googleapis.com/request_count" AND {WEB_LOGS} AND metric.label.response_code_class="5xx"',
                      "ALIGN_SUM", 60, "REDUCE_SUM", "COMPARISON_GT", 5, 0),
            threshold("More than 20 server errors in an hour",
                      f'metric.type="run.googleapis.com/request_count" AND {WEB_LOGS} AND metric.label.response_code_class="5xx"',
                      "ALIGN_SUM", 3600, "REDUCE_SUM", "COMPARISON_GT", 20, 0),
        ],
        doc("StoreMink: the web service is returning server errors",
            "storemink-web-prod answered with 5xx errors more often than usual. Shoppers, merchants or Mink chat may be seeing failures.",
            "Cloud Run, storemink-web-prod, the Logs tab filtered to severity Error. A burst at minutes 51 to 54 of the hour is usually the Help indexing job retrying."),
    ))
    found.append(policy(
        "Database: serious Postgres errors", "CRITICAL",
        [threshold("10 or more FATAL-class Postgres errors in a minute",
                   f'metric.type="logging.googleapis.com/log_entry_count" AND resource.type="cloudsql_database" AND resource.label.database_id="{DB_ID}" AND metric.label.log="cloudsql.googleapis.com/postgres" AND metric.label.severity=one_of("ALERT","CRITICAL","EMERGENCY")',
                   "ALIGN_SUM", 60, "REDUCE_SUM", "COMPARISON_GT", 9, 0)],
        doc("StoreMink: the database is logging serious errors",
            "Postgres on storemink-prod-db logged 10 or more FATAL-class errors in a minute. On 1 Oct this was the database running out of connections, and 57 requests failed.",
            "Cloud SQL, storemink-prod-db: connections and the Postgres log. Also check the web service's server count: a jump to several servers opens many connections at once."),
    ))
    found.append(policy(
        "Database: connection storm from the web service", "ERROR",
        [threshold("More than 30 new database connections in a minute",
                   f'metric.type="run.googleapis.com/infrastructure/cloudsql/connection_request_count" AND {WEB_LOGS}',
                   "ALIGN_SUM", 60, "REDUCE_SUM", "COMPARISON_GT", 30, 0)],
        doc("StoreMink: the web service is opening many database connections",
            "storemink-web-prod opened more than 30 database connections in one minute (normal is 1 to 8). This came just before the 1 Oct failures.",
            "Cloud Run, storemink-web-prod: how many servers are running and whether a traffic burst started. The database allows about 25 connections."),
    ))
    found.append(policy(
        "Database: down", "CRITICAL",
        [threshold("Database reports down for 2 minutes",
                   f'metric.type="cloudsql.googleapis.com/database/up" AND resource.type="cloudsql_database" AND resource.label.database_id="{DB_ID}"',
                   "ALIGN_MIN", 60, "REDUCE_MIN", "COMPARISON_LT", 1, 120)],
        doc("StoreMink: the database is down",
            "storemink-prod-db reports it is not up. Every store, dashboard and till is affected.",
            "Cloud SQL, storemink-prod-db: Operations and Logs. A maintenance restart takes a few minutes and closes itself."),
    ))
    found.append(policy(
        "Database: CPU above 60%", "WARNING",
        [threshold("CPU above 60% for 10 minutes",
                   f'metric.type="cloudsql.googleapis.com/database/cpu/utilization" AND resource.type="cloudsql_database" AND resource.label.database_id="{DB_ID}"',
                   "ALIGN_MEAN", 60, "REDUCE_MEAN", "COMPARISON_GT", 0.6, 600)],
        doc("StoreMink: the database CPU is high",
            "storemink-prod-db averaged above 60% CPU for 10 minutes. It runs on a shared core, so it slows down sharply above this.",
            "Cloud SQL, storemink-prod-db: which queries are busy, and whether a background job or a traffic burst is running."),
    ))
    found.append(policy(
        "Web: memory above 95%", "WARNING",
        [threshold("A web server above 95% memory for 10 minutes",
                   f'metric.type="run.googleapis.com/container/memory/utilizations" AND {WEB_LOGS}',
                   "ALIGN_PERCENTILE_99", 60, "REDUCE_MAX", "COMPARISON_GT", 0.95, 600)],
        doc("StoreMink: a web server is nearly out of memory",
            "A storemink-web-prod server stayed above 95% of its memory for 10 minutes. At 100% it is killed and drops every request it is serving.",
            "Cloud Run, storemink-web-prod, Metrics: memory and which requests were running (image resizing and uploads are the usual cause)."),
    ))
    found.append(policy(
        "Web: a server ran out of memory", "ERROR",
        [log_match("Cloud Run memory limit exceeded", f'{WEB_LOGS} AND log_id("run.googleapis.com/varlog/system") AND "Memory limit of"')],
        doc("StoreMink: a web server ran out of memory and was restarted",
            "Cloud Run killed a storemink-web-prod server for exceeding its memory limit. Requests it was serving failed.",
            "Cloud Run, storemink-web-prod, Logs: the minutes before the kill. Repeated kills mean the memory limit is still too low."),
        log_based=True,
    ))
    found.append(policy(
        "Web: at its maximum number of servers", "WARNING",
        [threshold("4 active web servers for 5 minutes",
                   f'metric.type="run.googleapis.com/container/instance_count" AND {WEB_LOGS} AND metric.label.state="active"',
                   "ALIGN_MAX", 60, "REDUCE_SUM", "COMPARISON_GT", 3, 300)],
        doc("StoreMink: the web service has no room left to grow",
            "storemink-web-prod has run at its maximum of 4 servers for 5 minutes. Extra traffic now queues or fails. (If the maximum is raised, update this alert.)",
            "Cloud Run, storemink-web-prod: request count and where it comes from. A bot burst is the usual cause; database connections are the next thing to fail."),
    ))
    found.append(policy(
        "Cloud Run: quota exceeded", "ERROR",
        [threshold("Any Cloud Run quota refusal",
                   'metric.type="serviceruntime.googleapis.com/quota/exceeded" AND resource.type="consumer_quota" AND resource.label.service="run.googleapis.com"',
                   "ALIGN_COUNT_TRUE", 60, "REDUCE_SUM", "COMPARISON_GT", 0, 0)],
        doc("StoreMink: Cloud Run refused something for quota",
            "A Cloud Run quota in storemink-prod was exceeded. On 17 Oct this refused a deploy for memory.",
            "IAM & Admin, Quotas, filtered to Cloud Run Admin API, region asia-south1 (CPU and memory per region)."),
    ))
    found.append(policy(
        "Google AI: a model refusing more than 30% of calls", "WARNING",
        [
            threshold("Refused or held (429, 499) above 30% over 15 minutes",
                      f'{MODEL_CALLS} AND metric.label.response_code=one_of("429","499")',
                      "ALIGN_SUM", 900, "REDUCE_SUM", "COMPARISON_GT", 0.3, 0, MODEL_GROUP,
                      denominator=MODEL_CALLS),
            threshold("At least 10 calls in those 15 minutes",
                      MODEL_CALLS, "ALIGN_SUM", 900, "REDUCE_SUM", "COMPARISON_GT", 9, 0, MODEL_GROUP),
        ],
        doc("StoreMink: Google is refusing one of our AI models",
            "Over 15 minutes, more than 30% of calls to one Gemini model (at one location) came back refused (429) or abandoned after a stall (499), with at least 10 calls. Mink chat falls back to gemini-3.5-flash in Mumbai; redesign photos and Theme Studio wait and retry.",
            "Vertex AI, Model Garden metrics for the model named in this alert. This is Google's shared pool being busy, not our quota; it usually passes within the hour."),
        combiner="AND_WITH_MATCHING_RESOURCE",
    ))
    found.append(policy(
        "Mink chat: the fallback model refused", "ERROR",
        [log_match("mink.model: fallback refused", f'{WEB_LOGS} AND jsonPayload.message:"mink.model: fallback refused"')],
        doc("StoreMink: Mink chat's fallback model refused a request",
            "The fallback model (gemini-3.5-flash, asia-south1) refused outright (404 or 403). Chat then depends on the main model alone.",
            "Cloud Run, storemink-web-prod, Logs: search \"fallback refused\" for the status. A 404 means the model id or location is wrong for this project."),
        log_based=True,
    ))
    found.append(policy(
        "Mink chat: more than 3 failed runs in 10 minutes", "ERROR",
        [threshold("More than 3 failed or timed-out chat runs in 10 minutes",
                   f'metric.type="logging.googleapis.com/user/{CHAT_FAILURE_METRIC}" AND resource.type="cloud_run_revision"',
                   "ALIGN_SUM", 600, "REDUCE_SUM", "COMPARISON_GT", 3, 0)],
        doc("StoreMink: Mink chat is failing for merchants",
            "More than 3 Mink chat runs failed or timed out within 10 minutes.",
            "Cloud Run, storemink-web-prod, Logs: search \"mink.run: failed\" and \"mink.model: attempt failed\". Check the Google AI refusal alert too."),
    ))
    found.append(policy(
        "Mink redesign: a redesign failed", "WARNING",
        [log_match("mink.revamp: failed", f'{WEB_LOGS} AND jsonPayload.message:"mink.revamp: failed"')],
        doc("StoreMink: a storefront redesign failed",
            "A Mink storefront redesign ended as failed. The merchant was not charged.",
            "Cloud Run, storemink-web-prod, Logs: search \"mink.revamp:\" around the time of this alert for the step and its error code."),
        log_based=True,
    ))
    found.append(policy(
        "Theme Studio: a photo came back below the size asked for", "WARNING",
        [log_match("theme_studio.image_below_requested_size", f'{WEB_LOGS} AND jsonPayload.message:"theme_studio.image_below_requested_size"')],
        doc("StoreMink: an AI photo came back smaller than asked",
            "An image model answer was under 85% of the size we asked for. On 22 Oct this was the parser keeping Google's 1K draft instead of the 2K photo.",
            "Cloud Run, storemink-web-prod, Logs: the theme_studio.image_answer line just before it (image parts, thought drafts, width and height)."),
        log_based=True,
    ))
    if uptime_check_ids:
        ids = ",".join(f'"{check_id}"' for check_id in uptime_check_ids)
        found.append(policy(
            "Uptime: a StoreMink page is down", "CRITICAL",
            [threshold("Failing from at least 2 regions",
                       f'metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url" AND metric.label.check_id=one_of({ids})',
                       "ALIGN_NEXT_OLDER", 1200, "REDUCE_COUNT_FALSE", "COMPARISON_GT", 1, 60, ["metric.label.check_id"])],
            doc("StoreMink: a page is not answering",
                "A StoreMink uptime check (storemink.com, a merchant store, or the dashboard login) failed from at least 2 of 3 regions.",
                "Open the page yourself. Then Cloud Run storemink-web-prod and the load balancer: a deploy, a certificate, or the database."),
        ))
    # Theme Studio (plan P6). Each watches one content-free line wherever theme
    # work runs in storemink-prod (THEME_LOGS), or Cloud Scheduler's own log.
    found.append(policy(
        "Theme Studio: a theme run failed or lost its lease", "WARNING",
        [log_match("theme studio: run settled (outcome failed or lost, not continuing)",
                   f'{THEME_LOGS} AND jsonPayload.message:"theme studio: run settled" AND (jsonPayload.outcome="failed" OR jsonPayload.outcome="lost") AND NOT jsonPayload.continues=true')],
        doc("StoreMink: a Theme Studio run failed or lost its lease",
            "A \"theme studio: run settled\" log line with outcome \"failed\" (a design, change or photo run ended as failed, and the theme shows why) or \"lost\" (the run's lease ran out before it could finish, so the run was taken back from that server; for example database connections ran short, since each renewal waits at most 5 seconds for one, or the server stalled). A run that is simply tried again settles as \"requeued\" and does not fire this, nor does a photo run whose style photo was refused or rejected, or that drew nothing, while fill rounds remain: a fill round draws its photos again and the theme keeps building (its line carries continues: true).",
            "Logs Explorer in storemink-prod: search \"theme studio: run settled\" for the runId and its error code, then \"theme studio: run execution threw\" and the memory and database alerts around the same minute.",
            THEME_STUDIO_ORIGIN),
        log_based=True,
    ))
    found.append(policy(
        "Theme Studio: the capture job failed to start", "ERROR",
        [log_match("theme_studio.capture_job_start_failed",
                   f'{THEME_LOGS} AND jsonPayload.message:"theme_studio.capture_job_start_failed"')],
        doc("StoreMink: Theme Studio could not start its capture job",
            f"The theme_studio.capture_job_start_failed log line: a Theme Studio route found a capture waiting, asked Cloud Run to start the capture job ({CAPTURE_JOB}), and was refused or the call failed. Theme checks wait meanwhile, and a capture nobody takes within 15 minutes is failed as capture_not_started (a theme_studio.capture_stale line).",
            "Logs Explorer in storemink-prod: the line's status field is Google's HTTP answer. 403 means the runtime account storemink-run lacks roles/run.invoker on the job (docs/theme-studio-capture-job.md, \"Start it on demand instead\"); 404 means the job is missing. An error field instead of a status means the call itself failed (a timeout or the network); one such line followed by theme_studio.capture_job_started is a blip.",
            THEME_STUDIO_ORIGIN),
        log_based=True,
    ))
    found.append(policy(
        "Theme Studio: design reviews are not draining", "WARNING",
        [log_match("theme_studio.qa_waiting",
                   f'{THEME_LOGS} AND jsonPayload.message:"theme_studio.qa_waiting"')],
        doc("StoreMink: Theme Studio design reviews are waiting",
            "The theme_studio.qa_waiting log line: at least one Theme Studio design review has waited more than 10 minutes to start (the line counts them). Those themes stay at their final check until their review runs.",
            "Whether the storemink-theme-studio-qa schedule is answering (the alert \"Theme Studio: a schedule attempt failed\"), then Logs Explorer for \"theme studio: QA worker failed\". At most 2 design reviews run at once across the platform, so two slow ones also hold the rest back.",
            THEME_STUDIO_ORIGIN),
        log_based=True,
    ))
    found.append(policy(
        "Theme Studio: a problem in StoreMink's own storefront code", "WARNING",
        [log_match("theme_studio.platform_finding",
                   f'{THEME_LOGS} AND jsonPayload.message:"theme_studio.platform_finding"')],
        doc("StoreMink: Theme Studio found a fault in StoreMink's shared storefront code",
            "The theme_studio.platform_finding log line: a theme check found a problem in StoreMink's shared storefront code, not in the theme (isPlatformFinding in lib/theme-studio/finding-severity.ts). It names the check (gate), the finding code, its findingSeverity and how many, never a selector or a store's content. A serious one blocks that theme's Publish until our code is fixed; a minor one is a warning. Live stores whose theme has similar colours may show the same fault.",
            "Logs Explorer in storemink-prod: search \"theme_studio.platform_finding\" for the gate and code, find the shared selector in that theme's check report, and fix StoreMink's storefront code. For contrast, scripts/theme-studio-contrast-check.mjs replays the known cases offline.",
            THEME_STUDIO_ORIGIN),
        log_based=True,
    ))
    schedules = " OR ".join(f'resource.labels.job_id="{job}"' for job in THEME_SCHEDULES)
    found.append(policy(
        "Theme Studio: a schedule attempt failed", "WARNING",
        [log_match("Cloud Scheduler attempt failed (Theme Studio runs or qa)",
                   f'resource.type="cloud_scheduler_job" AND ({schedules}) AND log_id("cloudscheduler.googleapis.com/executions") AND severity>=ERROR')],
        doc("StoreMink: a Theme Studio schedule attempt failed",
            "Cloud Scheduler's own attempt log (there is no app line): an every-minute call of storemink-theme-studio-runs or storemink-theme-studio-qa failed. The route answered an error (503 when its work threw, 401 when the shared secret does not match) or did not answer within the attempt deadline. Queued theme work waits for the next call that succeeds; nothing is lost.",
            "Cloud Scheduler, the job named in this alert: its last attempts and their status. Then Logs Explorer at that minute: \"theme studio worker route failed\" (runs) or \"theme studio: QA worker failed\" (qa).",
            THEME_STUDIO_ORIGIN),
        log_based=True,
    ))
    return found


def chat_failure_metric():
    return {
        "name": CHAT_FAILURE_METRIC,
        "description": "Mink chat runs that failed or timed out (mink.run: failed, mink.run: timed out). Owner-approved 23 Oct 2026.",
        "filter": f'{WEB_LOGS} AND (jsonPayload.message:"mink.run: failed" OR jsonPayload.message:"mink.run: timed out")',
        "metricDescriptor": {"metricKind": "DELTA", "valueType": "INT64", "unit": "1"},
    }


def channel_body():
    return {
        "type": "email",
        "displayName": CHANNEL_NAME,
        "description": "Production alerts for StoreMink (owner-approved 23 Oct 2026).",
        "labels": {"email_address": EMAIL},
        "userLabels": LABELS,
        "enabled": True,
    }


def uptime_body(check):
    return {
        "displayName": check["displayName"],
        "monitoredResource": {"type": "uptime_url", "labels": {"host": check["host"], "project_id": PROJECT}},
        "httpCheck": {
            "path": check["path"],
            "port": 443,
            "useSsl": True,
            "validateSsl": True,
            "requestMethod": "GET",
            "acceptedResponseStatusCodes": [{"statusClass": "STATUS_CLASS_2XX"}],
        },
        "period": "60s",
        "timeout": "10s",
        "selectedRegions": ["USA", "EUROPE", "ASIA_PACIFIC"],
        "userLabels": LABELS,
    }


def dry_run():
    global EMAIL
    EMAIL = EMAIL or "<alert address>"
    print("# DRY RUN: nothing is sent. Project:", PROJECT)
    print("## notification channel\n" + json.dumps(channel_body(), indent=2))
    for check in UPTIME_CHECKS:
        print("## uptime check\n" + json.dumps(uptime_body(check), indent=2))
    print("## log-based metric\n" + json.dumps(chat_failure_metric(), indent=2))
    for body in policies(["<check-id-1>", "<check-id-2>", "<check-id-3>"]):
        body["notificationChannels"] = ["<channel>"]
        print("## alert policy\n" + json.dumps(body, indent=2))
    print(f"\n# {len(policies(['x']))} alert policies, {len(UPTIME_CHECKS)} uptime checks, 1 log metric, 1 channel")


def apply():
    global ACCESS
    ACCESS = token()

    channels = list_all(f"{MON}/notificationChannels", "notificationChannels")
    channel = next((c for c in channels if c.get("type") == "email" and c.get("labels", {}).get("email_address") == EMAIL), None)
    if channel:
        print("channel exists:", channel["name"])
    else:
        channel = api("POST", f"{MON}/notificationChannels", channel_body())
        print("channel created:", channel["name"])

    existing_checks = {c["displayName"]: c for c in list_all(f"{MON}/uptimeCheckConfigs", "uptimeCheckConfigs")}
    check_ids = []
    for check in UPTIME_CHECKS:
        config = existing_checks.get(check["displayName"])
        if config:
            print("uptime check exists:", check["displayName"])
        else:
            config = api("POST", f"{MON}/uptimeCheckConfigs", uptime_body(check))
            print("uptime check created:", check["displayName"])
        check_ids.append(config["name"].rsplit("/", 1)[-1])

    metric_names = {m["name"].rsplit("/", 1)[-1] for m in list_all(f"{LOGGING}/metrics", "metrics")}
    if CHAT_FAILURE_METRIC in metric_names:
        print("log metric exists:", CHAT_FAILURE_METRIC)
    else:
        api("POST", f"{LOGGING}/metrics", chat_failure_metric())
        print("log metric created:", CHAT_FAILURE_METRIC)

    existing = {p["displayName"]: p for p in list_all(f"{MON}/alertPolicies", "alertPolicies")}
    problems = []
    for body in policies(check_ids):
        if body["displayName"] in existing:
            print("policy exists:", body["displayName"])
            continue
        missing = [t for t in metric_types(body) if not t.startswith("logging.googleapis.com/user/") and not descriptor_exists(t)]
        if missing:
            problems.append(f"{body['displayName']}: metric not found {missing}")
            print("policy SKIPPED (metric not found):", body["displayName"], missing)
            continue
        body["notificationChannels"] = [channel["name"]]
        for attempt in range(4):
            try:
                created = api("POST", f"{MON}/alertPolicies", body)
                print("policy created:", body["displayName"], "->", created["name"].rsplit("/", 1)[-1])
                break
            except RuntimeError as error:
                if CHAT_FAILURE_METRIC in body["conditions"][0].get("conditionThreshold", {}).get("filter", "") and attempt < 3:
                    time.sleep(20)  # a new log-based metric's descriptor can lag
                    continue
                problems.append(f"{body['displayName']}: {error}")
                print("policy FAILED:", body["displayName"], "\n  ", error)
                break

    ours = [p for p in list_all(f"{MON}/alertPolicies", "alertPolicies") if p.get("userLabels", {}).get("managed-by") == "storemink-alerts"]
    print(f"\n{len(ours)} owner-approved alert policies now in {PROJECT}:")
    for p in sorted(ours, key=lambda p: p["displayName"]):
        print(f"  [{'on' if p.get('enabled', True) else 'off'}] {p['displayName']}")
    if problems:
        print("\nPROBLEMS:")
        for line in problems:
            print("  -", line)
        sys.exit(2)


if __name__ == "__main__":
    if "--apply" in sys.argv:
        if "@" not in EMAIL:
            die("--apply needs --email <address>: the address the alerts are sent to")
        apply()
    else:
        dry_run()
