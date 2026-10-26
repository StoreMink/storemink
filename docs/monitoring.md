# Production monitoring and alerts

Production alerting for StoreMink, set up on 23 Oct 2026 at about 19:15 IST
with the owner's approval. Until then there were no alert policies, no uptime
checks and no notification channels in production or staging (robustness
audit, 23 Oct). Five Theme Studio alerts (16 to 20) were defined on 25 Oct
2026 (Theme Studio plan P6) and are applied after the Theme Studio release
with the owner's OK (step A1). Alert 10 (Google AI refusals) was made quieter
on 25 Oct 2026, also with the owner's OK.

Everything below lives in the **storemink-prod** project, carries the label
`managed-by=storemink-alerts`, and emails one channel named **"StoreMink owner
email"**. The address is never written into the repo. Every alert email
carries a "What it means" and a "First thing to check" paragraph and points
back here.

| What                       | How many              | Notes                                                                        |
| -------------------------- | --------------------- | ---------------------------------------------------------------------------- |
| Email notification channel | 1                     | "StoreMink owner email"                                                      |
| Uptime checks              | 3                     | below                                                                        |
| Log-based counter          | 1                     | `mink_chat_run_failures`                                                     |
| Alert policies             | 15 applied, 5 defined | below, in the order the script creates them; 16 to 20 are applied at step A1 |

The repo copy of what created them is
[`scripts/prod-monitoring.py`](../scripts/prod-monitoring.py); read it for the
exact filter of any policy. How to run it is at the end of this page.

## How an alert behaves

- A metric alert opens an incident when its condition holds and closes it when
  the condition stops holding, or after 30 minutes with no data, and emails
  both times. Alert 10 is the exception: it emails only when it opens, and
  closes itself after an hour with no data.
- A log-based alert (marked **log** below) fires on a matching log entry,
  emails at most once an hour, and closes itself after 30 minutes.
- Severity is one of WARNING, ERROR or CRITICAL. CRITICAL means shoppers,
  merchants or tills are probably affected right now.
- The alerts watch the production web service (`storemink-web-prod`) and the
  database instance (`storemink-prod-db`, which also holds dev's
  `storemink_staging` database). The Google AI and Cloud Run quota alerts
  cover the whole project. The Theme Studio alerts (16 to 20) also match the
  two private Theme Studio workers and the capture job in production, and
  the Theme Studio schedules' own attempt log. The dev service, the dev
  capture job and the storemink-staging project are not watched.

## Uptime checks

Each check sends `GET` over HTTPS (port 443, certificate validated, 10 s
timeout) every 60 seconds from the USA, Europe and Asia Pacific. Only a 2xx
answer passes.

| Check                                                     | URL                                       |
| --------------------------------------------------------- | ----------------------------------------- |
| Uptime: storemink.com                                     | `https://storemink.com/`                  |
| Uptime: a merchant store (echoss.storemink.com)           | `https://echoss.storemink.com/`           |
| Uptime: dashboard login (echoss.storemink.com/auth/login) | `https://echoss.storemink.com/auth/login` |

They feed the last alert below ("Uptime: a StoreMink page is down").

## The alerts

### 1. Web: server errors (5xx) (ERROR)

- **Fires when** `storemink-web-prod` answers more than 5 requests with a 5xx
  status in one minute, **or** more than 20 in one hour (Cloud Run
  `request_count`, response code class 5xx).
- **Means** shoppers, merchants or Mink chat may be seeing failures.
- **Check first** Cloud Run, `storemink-web-prod`, Logs, filtered to severity
  Error. A burst at minutes 51 to 54 of an hour is usually the hourly Help
  indexing job retrying against a Google limit, which no shopper sees (144 of
  the 252 server errors in the 30 days before 23 Oct).
- **Why this threshold** absolute counts: at our traffic a percentage would
  page on a single bot error.

### 2. Database: serious Postgres errors (CRITICAL)

- **Fires when** the Postgres log of `storemink-prod-db` has 10 or more entries
  at severity ALERT, CRITICAL or EMERGENCY (FATAL-class) in one minute.
- **Means** the database is refusing work. On 1 Oct it logged 239 such errors
  in one minute while running out of connections, and 57 requests failed.
- **Check first** Cloud SQL, `storemink-prod-db`: connections and the Postgres
  log. Then the web service's server count: a jump to several servers opens
  many connections at once.

### 3. Database: connection storm from the web service (ERROR)

- **Fires when** `storemink-web-prod` makes more than 30 new database
  connection requests in one minute (Cloud Run's Cloud SQL
  `connection_request_count`). Normal is 1 to 8.
- **Means** the first sign of a connection storm. On 1 Oct the web service grew
  to 4 servers and made 265 connection attempts in one minute against about 20
  free slots. The database's own once-a-minute connection count read only 4
  that minute, which is why this watches attempts from Cloud Run instead.
- **Check first** Cloud Run, `storemink-web-prod`: how many servers are running
  and whether a traffic burst started. The database (`db-f1-micro`) allows
  about 25 connections.

### 4. Database: down (CRITICAL)

- **Fires when** `storemink-prod-db` reports it is not up (`database/up` below 1,
  the minimum over each minute) for 2 minutes.
- **Means** every store, dashboard and till is affected, dev included.
- **Check first** Cloud SQL, `storemink-prod-db`: Operations and Logs. A
  maintenance restart or a tier change takes a few minutes, and the incident
  closes itself.

### 5. Database: CPU above 60% (WARNING)

- **Fires when** the database's mean CPU stays above 60% for 10 minutes.
- **Means** it runs on a shared core, so it slows down sharply above this.
- **Check first** Cloud SQL, `storemink-prod-db`: which queries are busy, and
  whether a background job or a traffic burst is running. Query Insights is
  not available on a shared core.

### 6. Web: memory above 95% (WARNING)

- **Fires when** a `storemink-web-prod` server stays above 95% of its memory
  for 10 minutes (the 99th percentile of each server's memory use, the highest
  server).
- **Means** at 100% Cloud Run kills that server and every request it is
  serving fails. Production runs with 2 GiB since 23 Oct
  ([`gcp-ci-cd.md`](gcp-ci-cd.md), "Production memory").
- **Check first** Cloud Run, `storemink-web-prod`, Metrics: memory, and which
  requests were running. Image resizing (`/_next/image`) and uploads are the
  usual cause.

### 7. Web: a server ran out of memory (ERROR, log)

- **Fires on** Cloud Run's own kill message ("Memory limit of … exceeded") in
  `storemink-web-prod`'s system log.
- **Means** a server was killed and restarted; the requests it was serving
  failed.
- **Check first** Cloud Run, `storemink-web-prod`, Logs: the minutes before the
  kill. Repeated kills mean the memory limit is still too low. Raise it on the
  service (`gcloud run services update`), never in `cloudbuild.yaml`, whose
  deploy step dev shares.

### 8. Web: at its maximum number of servers (WARNING)

- **Fires when** `storemink-web-prod` has more than 3 active servers, that is
  4, for 5 minutes.
- **Means** the service has no room left to grow; extra traffic queues or
  fails.
- **Check first** Cloud Run, `storemink-web-prod`: the request count and where
  it comes from. A bot burst is the usual cause, and database connections are
  the next thing to fail.
- ⚠ **This assumes a maximum of 4 servers** (`_MAX_INSTANCES` on the
  production trigger). If the maximum changes, change this threshold too.

### 9. Cloud Run: quota exceeded (ERROR)

- **Fires when** any Cloud Run quota in storemink-prod is exceeded.
- **Means** Cloud Run refused something. On 17 Oct it refused a deploy for
  memory: Mumbai (asia-south1) allows 20 vCPU and 40 GiB across every Cloud Run
  service in the project.
- **Check first** IAM & Admin, Quotas, filtered to the Cloud Run Admin API in
  asia-south1 (CPU and memory per region).

### 10. Google AI: a model refusing more than 30% of calls (WARNING)

- **Fires when**, for one Gemini model at one location, more than 30% of the
  last 30 minutes' calls came back refused (429) or cut off by our side (499),
  there were at least 20 calls in those 30 minutes, **and** both stayed true
  for 15 minutes in a row (one PromQL condition over Vertex AI
  `model_invocation_count`, grouped by model and location). It emails once
  when it opens and not when it closes.
- **Means** for 429s, Google's shared pool is busy. It is not our quota,
  refused calls are not billed, and it usually passes within the hour. Mink
  chat fails over to gemini-3.5-flash in Mumbai; redesign photos and Theme
  Studio wait and retry. Generate with AI, WhatsApp answers and the
  attachment reader fail over to the same model, and chat images and Refine
  ask again twice at the same location. 499s are calls our side cut off: a
  per-try clock (redesign and Theme Studio photos 180 s, studio product
  photos 75 s, chat images 45 s, Refine 60 s, storefront personalisation
  45 s for the whole call), a stopped job, or, for the text models, Mink
  chat's stall watchdog.
- **Check first** Vertex AI, Model Garden metrics for the model named in the
  alert, split by response code: mostly 429 is Google, a cluster of 499 is us.
- **Why this threshold** a redesign makes about 20 image calls in 15 minutes,
  so one call moves the share by 2 to 4 points. The first version (15
  minutes, at least 10 calls, no hold time, two conditions, emails on close)
  opened and closed several times an hour and sent two emails each way. On
  25 Oct 2026, 16:05 to 16:35 IST, gemini-nano-banana-2.1 had 42 calls, 12
  refused (all 429, no 499) while a redesign finished normally; this rule
  stays quiet on that afternoon (the 30-minute share peaked at 30.4% for one
  five-minute reading) and still emails once for a quarter hour of real
  refusals.

### 11. Mink chat: the fallback model refused (ERROR, log)

- **Fires on** a `mink.model: fallback refused` log line from
  `storemink-web-prod`.
- **Means** the chat's fallback model (gemini-3.5-flash at asia-south1) refused
  outright (404 or 403), so for the next minute chat on that server depends on
  the main model alone. That model at that location was verified on staging
  only.
- **Check first** Cloud Run, `storemink-web-prod`, Logs: search "fallback
  refused" for the status. A 404 means the model id or location is wrong for
  this project; a 403 means it is not enabled there.
- From the next release only a 404 or 403 fires this. Any other refusal from
  the fallback (a 400 on one request) is logged as `mink.model: fallback
rejected the request`, a warning: the turn goes back to the main model and
  the fallback stays in use.

### 12. Mink chat: more than 3 failed runs in 10 minutes (ERROR)

- **Fires when** the log-based counter `mink_chat_run_failures` counts more
  than 3 in 10 minutes. It counts `mink.run: failed` and `mink.run: timed out`
  lines from `storemink-web-prod`.
- **Means** Mink chat is failing for merchants.
- **Check first** Cloud Run, `storemink-web-prod`, Logs: search "mink.run:
  failed" and "mink.model: attempt failed". Check alert 10 too.

### 13. Mink redesign: a redesign failed (WARNING, log)

- **Fires on** a `mink.revamp: failed` log line (which also matches
  `mink.revamp: failed after its attempts or its time ran out`, and the
  `mink.revamp: failed redesign's start given back` line that follows a
  failure; one email an hour at most, so a failure still sends one).
- **Means** a storefront redesign ended as failed. The merchant was not
  charged, and the store's daily redesign start was given back. Since the
  robustness fixes a redesign that only waited on Google is not failed for
  it: it fails after four real failures in a row at one step, or four hours
  after it first started (`error_detail` `run_ceiling`).
- **Check first** Cloud Run, `storemink-web-prod`, Logs: search "mink.revamp:"
  around the time of the alert for the step and its error code.
- ⚠ Watches a log line production does not have yet: it arrives with the
  next release (the work in progress on 23 Oct), so the alert stays silent
  until that release is deployed.

### 14. Theme Studio: a photo came back below the size asked for (WARNING, log)

- **Fires on** a `theme_studio.image_below_requested_size` log line: an image
  model answer whose picture's long edge is under 85% of the size asked for
  (under 1,741 px for a 2K request).
- **Means** an AI photo came back smaller than asked. On 22 Oct this was the
  parser keeping Google's 1K draft instead of the 2K picture.
- **Check first** the `theme_studio.image_answer` line just before it (image
  parts, thought drafts, width and height).
- ⚠ Watches a log line production does not have yet: it arrives with the
  next release (the work in progress on 23 Oct), so the alert stays silent
  until that release is deployed.

### 15. Uptime: a StoreMink page is down (CRITICAL)

- **Fires when** the latest result of one uptime check is a failure from at
  least 2 of its 3 regions, for 1 minute.
- **Means** storemink.com, the merchant store or the dashboard login is not
  answering.
- **Check first** open the page yourself. Then Cloud Run `storemink-web-prod`
  and the load balancer: a deploy, a certificate, or the database.

Alerts 16 to 20 watch Theme Studio. Each of 16 to 19 matches one
content-free log line wherever theme work runs in production: the web
service, the two private Theme Studio workers
(`storemink-theme-studio-model-prod`, `storemink-theme-studio-qa-prod`) and
the capture job (`storemink-theme-studio-capture`), never dev. They are
definitions in the script until step A1.

### 16. Theme Studio: a theme run failed or lost its lease (WARNING, log)

- **Fires on** a `theme studio: run settled` log line whose `outcome` is
  `failed` or `lost`. A run that is simply tried again settles as
  `requeued` and does not fire it. Nor does a photo run whose style photo
  was refused or rejected, or that drew nothing, while fill rounds remain:
  it settles as `failed`, but a fill round draws its photos again and the
  theme keeps building, so its line carries `continues: true` and the filter
  leaves it out (`AND NOT jsonPayload.continues=true`; a line without the
  field matches, so check the filter once at step A1).
- **Means** a design, change or photo run ended as failed (the theme shows
  why), or the run's lease ran out before it could finish, so the run was
  taken back from that server: for example database connections ran short
  (each renewal waits at most 5 seconds for one), or the server stalled.
- **Check first** Logs Explorer in storemink-prod: search "theme studio: run
  settled" for the `runId` and its `errorCode`. A failed run carries its
  error code; a requeued one carries why it waits (`rate_limited`,
  `provider_unavailable`, `provider_timeout`, `image_review_unavailable`,
  `run_timeout` for a photo run its request deadline cut, `worker_error`,
  `lease_renewal_failed`). Then "theme studio: run execution threw" and the
  memory and database alerts around the same minute.
- The line also carries `provider`, `modelKey`, `attempt` and `rssMiB`;
  `errorCode` and `continues` arrive with the Theme Studio release.

### 17. Theme Studio: the capture job failed to start (ERROR, log)

- **Fires on** a `theme_studio.capture_job_start_failed` log line: Theme
  Studio found a capture waiting (at a minute tick, or right after the
  capture was queued), asked Cloud Run to start the capture job
  (`storemink-theme-studio-capture`), and was refused or the call failed.
- **Means** theme checks wait meanwhile. A capture nobody takes within 15
  minutes is failed as `capture_not_started` (a `theme_studio.capture_stale`
  line), and the theme goes back to Ready with Check again.
- **Check first** Logs Explorer: the line's `status` field is Google's HTTP
  answer. 403 means the runtime account `storemink-run` lacks
  `roles/run.invoker` on the job
  ([`theme-studio-capture-job.md`](theme-studio-capture-job.md), "Start it
  on demand instead"); 404 means the job is missing. An `error` field
  instead of a status means the call itself failed (a timeout or the
  network); one such line followed by `theme_studio.capture_job_started` is
  a blip.

### 18. Theme Studio: design reviews are not draining (WARNING, log)

- **Fires on** a `theme_studio.qa_waiting` log line. Each call of the
  design-review route (`POST /api/internal/theme-studio/qa`, from its minute
  schedule and from the capture job when its captures end) logs it only
  when at least one review has waited more than 10 minutes to start, so it
  repeats every minute while the queue is stuck. Its fields: `waiting`
  (reviews queued, or running on a lapsed lease, for more than 10 minutes),
  `oldestMinutes`, `overMinutes` (10) and `cap` (2).
- **Means** those themes stay at their final check until their review
  runs.
- **Check first** whether the `storemink-theme-studio-qa` schedule is
  answering (alert 20), then Logs Explorer for "theme studio: QA worker
  failed". At most 2 design reviews run at once across the platform, so two
  slow ones also hold the rest back. A review waiting for its photo checks
  ("Checking pictures") waits at most 20 minutes, then stops as "Couldn't
  finish the checks".
- ⚠ The line arrives with the Theme Studio release, so the alert is silent
  until then.

### 19. Theme Studio: a problem in StoreMink's own storefront code (WARNING, log)

- **Fires on** a `theme_studio.platform_finding` log line: a theme check
  found a problem in StoreMink's shared storefront code, not in the theme
  (`isPlatformFinding`, `lib/theme-studio/finding-severity.ts`). It names the
  check (`gate`), the finding `code`, its `findingSeverity` and `count`,
  never a selector or a store's content.
- **Means** a serious one blocks that theme's Publish until our code is
  fixed; a minor one is a warning. Live stores whose theme has similar
  colours may show the same fault.
- **Check first** Logs Explorer: search "theme_studio.platform_finding" for
  the gate and code, find the shared selector in that theme's check report,
  and fix StoreMink's storefront code. For contrast,
  `scripts/theme-studio-contrast-check.mjs` replays the known cases offline.

### 20. Theme Studio: a schedule attempt failed (WARNING, log)

- **Fires on** Cloud Scheduler's own attempt log (there is no app line):
  `resource.type="cloud_scheduler_job"`, the log
  `cloudscheduler.googleapis.com/executions` at ERROR or above, for
  `storemink-theme-studio-runs` (1,200 s attempt deadline) or
  `storemink-theme-studio-qa` (300 s).
- **Means** the route answered an error (503 when its work threw, 401 when
  the shared secret does not match) or did not answer within the attempt
  deadline. Queued theme work waits for the next call that succeeds;
  nothing is lost. One QA call holds either the photo checks of unchecked
  photos (until 250 s after its claim) or a design review (up to 4 minutes),
  never both past the 5-minute deadline (`PHOTO_CHECK_INLINE_MS`,
  lib/theme-studio/visual-qa.ts), so a failed attempt there is a real
  fault.
- **Check first** Cloud Scheduler, the job named in the alert: its last
  attempts and their status. Then Logs Explorer at that minute: "theme
  studio worker route failed" (runs) or "theme studio: QA worker failed"
  (qa).

## Four things to know

1. **Alert 8 assumes a maximum of 4 web servers.** If `_MAX_INSTANCES` on the
   production trigger changes, change that alert's threshold (in the console
   and in the script).
2. **Two alerts watch log lines production does not have yet**
   (`mink.revamp: failed` and `theme_studio.image_below_requested_size`).
   They arrive with the next release (the work in progress on 23 Oct) and the
   alerts stay silent until it is deployed; silence before then proves
   nothing.
3. **The channel only emails.** There is no SMS, phone call or chat message,
   so an alert at night is read in the morning.
4. **Alerts 16 to 20 are definitions until step A1.** The dry run prints
   them; an `--apply` run before then creates them too. Alert 18 watches
   `theme_studio.qa_waiting`, which arrives with the Theme Studio release,
   so it is silent until then.

## Not watched yet

From the robustness audit's monitoring list (section 7 of the plan), these
were not set up on 23 Oct: load-balancer logging, a redesign queued for more
than 10 minutes or running for more than 75, chat runs stuck as "running"
(the clean-up in bug B7 is built and closes them after 15 minutes, logging
the lines below; an alert on `mink.run: abandoned run not closed` and on the
rate of `mink.run: abandoned run closed` is the natural one once it is
deployed), and the weekly dashboard of calls per model. Spend is watched by the existing billing budget alerts (₹5,000 and
₹10,000), not here.

Log lines worth searching when something looks wrong, with no alert of their
own yet (most arrive with the next release):

- `db.too_many_clients_retry`, errors named `DatabaseBusyError`, and
  `db.checked_out_client_error` (code 25P03 means a transaction was ended by
  the 60 s idle limit); Postgres 57014 "canceling statement due to statement
  timeout" (the 30 s limit).
- `ai.generate: failed` and `ai.generate: main model refused` (Generate with
  AI).
- `ai.quota: refund failed` (ERROR): a Generate with AI request failed and its
  credit could not be given back after two tries. The line names the store and
  whether it was a plan or a top-up credit; grant one credit back from the
  operator console. `ai.quota: rate limited` (a warning) is a store or a
  person asking for AI copy faster than 20 a minute, 200 an hour per store or
  10 a minute per person.
- `mink.tool: write outlived its grace` (ERROR): a Mink tool's last write was
  still running a minute after its deadline, so the merchant may have been
  charged for something the chat reported as timed out. The line names the
  request, store, admin and tool; check the store's drafts and credits.
- `mink.model: main refused` (chat), `whatsapp mink: main refused` (WhatsApp
  answers: the main model refused outright and the fallback was asked),
  `whatsapp mink: fallback refused`, `mink.model: fallback rejected the
request` (a warning), `mink.input.failed` (the attachment reader),
  `mink.revamp: runner crashed`.
- `whatsapp mink: model busy` (a warning): Google was still busy after every
  attempt, so the customer was handed to a person (reason `busy`).
- `mink.run: abandoned run closed` (a warning) and `mink.run: abandoned run
not closed` (ERROR): a chat run a dead server left "running" was closed by
  the minute heartbeat or a History delete, or could not be (the line names
  the store and run). `mink.history: dead runs not closed` (ERROR) is the
  delete's own attempt failing; that chat stays undeletable until the next
  pass.
- `mink.run: unseen proposals kept beside a redesign card` (ERROR): a
  failed chat run kept its storefront redesign card, but its other unseen
  proposals could not be discarded, so they stay charged; the line names the
  store, the run and how many.
- `mink.revamp: late start not withdrawn` (ERROR): a redesign started after
  the chat had said the tool took too long and could not be stopped; the
  line names the revamp, which may run without a card in the chat. Stop it
  by hand.
- `mink.revamp: failed redesign's start not given back` (a warning): a
  failed redesign kept the store's daily start it should have returned.
- `mink.revamp: earlier redesigns could not be read` and `mink.revamp: the
theme for the distinctness check could not be read` (warnings): a full
  redesign went on without the redo memory's check, so it may come out
  close to an earlier redesign of the same store; the job's
  `result.distinctness` says `skipped` and why. Every check also logs one
  `mink.revamp.distinctness` line (its status, the bar, the distances and
  the number of changes).
- Theme Studio (with the Theme Studio release, content-free):
  `theme_studio.capture_attempt_failed` (WARNING) for each failed capture
  try, with `errorCode`, `errorKind` (`deterministic`, `transient` or
  `other`), `attempt`, `maxAttempts`, `outcome` (`requeued` or `failed`;
  a capture-retry alert can be built on it) and, for a preview page's
  status, the page it came from (`surface`, such as `home`);
  `theme_studio.image_review_fallback` (WARNING) for each photo check that
  went on from Google's US endpoint to global, with `code` and Google's
  status (a count grouped by `code` shows how often the US refuses or times
  out); `theme_studio.photo_check`, `theme_studio.photo_check_unrecordable`
  and `theme_studio.photo_check_deferred` for the check of a photo still
  unchecked before a design review; and
  `theme_studio.operator_notice_failed` (ERROR) when the in-app notice and
  email to the operator who started a theme could not be recorded.

## Re-running the script

`scripts/prod-monitoring.py` needs only Python 3 and a gcloud **user** login
that may edit Monitoring and Logging in storemink-prod (it calls
`gcloud auth print-access-token`).

```bash
# Dry run: prints every body it would send. No network.
python3 -I scripts/prod-monitoring.py

# Create whatever is missing, then list the owner-approved policies.
python3 -I scripts/prod-monitoring.py --apply --email <alert address>

# Change one existing policy to match the script: preview, then write.
python3 -I scripts/prod-monitoring.py --update "<display name>"
python3 -I scripts/prod-monitoring.py --update "<display name>" --apply
```

- It writes only to storemink-prod: the channel, the three uptime checks, the
  log counter and the 20 policies (16 to 20 only once the owner approves step
  A1). It reads only configuration (channels,
  checks, policies, log metrics) and metric descriptors, never time series,
  log entries or secrets.
- `--apply` is idempotent by display name: an existing channel (matched by
  its address), check, counter or policy is left alone, so it never updates or
  deletes anything. To change a policy, change it in the script, preview with
  `--update "<display name>"` (reads the live policy and prints each field
  that would change; writes nothing), then run it again with `--apply`. That
  replaces the policy's conditions, combiner, alert strategy, documentation,
  severity, labels and on/off flag, keeps its notification channels and
  display name, needs no `--email`, and reads the policy back to confirm.
  Replacing conditions closes any incident open on the old ones, so update
  while the alert is quiet. Renaming a policy in the script creates a second
  one.
- A policy whose metric does not exist yet is skipped and reported; the run
  then exits with status 2. If `gcloud` has no valid login it stops before
  touching anything.

Cost: alerting and uptime checks are free today (Google documents alerting
charges starting no sooner than 1 September 2027, and uptime checks are free
up to 1 million checks a project).
