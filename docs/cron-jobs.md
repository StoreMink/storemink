# Scheduled jobs (Cloud Scheduler)

Every scheduled job runs in **Cloud Scheduler in `storemink-prod`,
`asia-south1`**, and this file is the record of what each schedule should be.
Nothing in the repository drives a schedule.

## The gap this documents

Between the Cloud Run cutover and **2026-07-30**, `storemink-prod` had **zero**
Cloud Scheduler jobs in **any** region — verified by sweeping every location.
The go-live checklist listed `Crons → Cloud Scheduler` and
the box was never ticked. So for the whole period after the cutover, none of the
three scheduled jobs ran.

It happened a second time, quietly: the 2026-07-30 fix created the three jobs it
knew about, `seo-refresh` was documented in this file as still to be created, and
it then sat uncreated until **2026-08-06** — with its two required Google APIs
never enabled either. A doc that says "must be created" is not a reminder anybody
receives. If you add a job here, create it in the same sitting and record the
verification below.

**Measured blast radius at the time of fixing (prod, read-only queries): 2
stores, 0 orders, 0 lapsed plans, 0 pending razorpay orders, 0 campaign
recipients.** Nothing was lost, because production has no real traffic yet — but
each job is a landmine the moment it does:

| Job                       | What its absence would have cost under real traffic                                                                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send-emails`             | Coupon email campaigns never send; Phase 5E scheduled campaigns also miss their reviewed delivery time. Since the takedown release it also runs the takedown follow-ups, so without it no complaint deadline alert goes out and no blocked file is copied, replaced or put back.                                                         |
| `plan-expiry`             | A lapsed timed plan keeps its paid features **forever** — the durable half of the plan gate (`lib/plans.ts` `effectivePlan` covers reads only).                                                                                                                                                                                          |
| `expire-pending-payments` | Unpaid Razorpay orders are never reaped, so their stock reservations and coupon uses are held **permanently** — and it also carries the PICKUP sweeps (expired collections never lapse, no collection reminder is sent) and the WhatsApp COD follow-up (no reminder to a customer who has not confirmed, and no automatic cancellation). |
| `domain-reconcile`        | A merchant's custom domain **never goes live** unless they happen to keep the settings tab open for the whole of Google's issuance window.                                                                                                                                                                                               |
| `import-worker`           | A CSV import whose worker chain broke mid-file (a deploy, an OOM, a kick that never landed) **never resumes** — it sits half-applied until someone notices.                                                                                                                                                                              |
| `seo-refresh`             | No sitemap is ever submitted to Google, so nothing on the platform, the help centre or any launched store gets discovered.                                                                                                                                                                                                               |
| `billing`                 | **No merchant is ever charged.** No renewal invoice is issued, no cycle advances, no grace window opens and no unpaid plan is downgraded — the entire subscription business stops silently, looking exactly like nobody has renewed yet.                                                                                                 |
| `help-embeddings`         | Existing published guides never receive semantic chunks after the initial migration, and a failed article-save refresh is never retried. Mink AI still falls back to lexical/category search, but paraphrase and multilingual recall silently degrade.                                                                                   |
| `mink-publications`       | Approved scheduled Mink blogs remain private drafts forever. No data is lost, but the merchant's reviewed publication time is silently missed until the worker runs.                                                                                                                                                                     |

> ⚠ **STALE as of 2026-09-08 — see the measured note under "The jobs" below.**
> Production DOES have the notification system: `notification_email_queue`,
> `email_campaigns`, `email_campaign_recipients` and a schedule-aware
> `claim_email_batch` all exist in the `storemink` database, and mail is flowing
> through it. The paragraph below is kept for the history of the decision.
>
> Note: production currently runs `main`, which has **no notification system** —
> `lib/notifications/` and the `notification_email_queue` table do not exist
> there. `send-emails` on prod drives only the coupon-campaign worker. Once
> `staging` merges, the same job also drains notification email. Phase 5E makes
> its one-minute heartbeat load-bearing for scheduled campaign resolution.

## Schema-drift check (NOT an /api/cron route)

`storemink-schema-drift` is the odd one out: a **Cloud Scheduler job that runs a
Cloud Build trigger**, not an HTTPS call to `/api/cron/*` with a CRON_SECRET
bearer. Everything else in this file follows that pattern; this one cannot.

| Piece     | Value                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------- |
| Scheduler | `storemink-schema-drift`, `0 4 * * *` UTC, region `asia-south1`                                          |
| Target    | `POST .../v1/projects/storemink-prod/locations/global/triggers/c10f45a2-bbc3-4e42-a069-3767e6057c48:run` |
| Auth      | OAuth as `705863961054-compute@developer.gserviceaccount.com`                                            |
| Trigger   | `storemink-schema-drift` (manual), `gitFileSource` → `cloudbuild-drift.yaml` on `refs/heads/main`        |
| Build     | `cloudbuild-drift.yaml` → `db-migrate drift --environment production`                                    |

★★ **Why not an `/api/cron` route.** The check needs BOTH signals — the schema
fingerprint and a digest of which migration ids are recorded — because
`schemaFingerprint()` excludes `schema_migrations`, and that exclusion is what
separates "a migration ran" from "somebody ran DDL by hand". Reading the ledger
needs the postgres SUPERUSER login: migration 0018 revoked the app login's
grants on `schema_migrations`, and a durable verify contract asserts they stay
revoked. Putting that credential in the internet-facing Cloud Run runtime would
be a downgrade. Cloud Build is not internet-facing, already holds
`roles/run.admin` (so it can already deploy code that reaches the database), and
runs the SAME code path a human runs rather than a second implementation.

⚠ **It required two IAM grants** on the Cloud Build service account, which did
NOT already have them: `secretmanager.secretAccessor` scoped to
`CLOUDSQL_PROD_POSTGRES_PW` alone, and project-level `cloudsql.client` (Cloud SQL
has no instance-level binding). The scheduler SA needed nothing new —
`roles/cloudbuild.builds.builder` already includes `cloudbuild.builds.create`.

⚠ **CREATED PAUSED (2026-09-08), and it must stay paused until
`cloudbuild-drift.yaml` reaches `main`.** It lives on `minkai` today, so a run
fails with `NOT_FOUND - File cloudbuild-drift.yaml not found`. Enabling it before
the merge means a failure every morning, which is how a real alarm becomes noise.
After merging:

```bash
gcloud scheduler jobs resume storemink-schema-drift --project storemink-prod --location asia-south1
gcloud scheduler jobs run    storemink-schema-drift --project storemink-prod --location asia-south1
```

★ **The trigger could not be created by `gcloud` or the API.** Five shapes
(`manual` with two URL forms, a raw `sourceToBuild` body, a `github` block
mirroring the working deploy trigger, and `webhook`) all returned a bare
`INVALID_ARGUMENT` with no field detail — this project has a 1st-gen GitHub App
connection and no 2nd-gen connection, and manual triggers appear to need one. It
was created through the Cloud Console instead. Expect the same if it is ever
recreated.

**Verified as far as the merge allows (2026-09-08):** the build itself ran
against production (`cc4d4eda`, 3m8s) and logged `database=storemink`
`environment=production` `drift=clean`; `GET` on the Scheduler's exact trigger
URL returns 200, so the URL and OAuth are right; and `:run` fails with exactly
one message, the missing file. What is NOT yet verified is a green scheduled run
end to end — do that after the merge.

Until then the same check runs by hand from any checkout:

```bash
gcloud builds submit --project storemink-prod --region global --config=cloudbuild-drift.yaml --ignore-file=.gitignore .
```

## The jobs

| Job                                 | Schedule (UTC) | Endpoint                                                 |
| ----------------------------------- | -------------- | -------------------------------------------------------- |
| `storemink-send-emails`             | `* * * * *`    | `https://storemink.com/api/cron/send-emails`             |
| `storemink-plan-expiry`             | `15 0 * * *`   | `https://storemink.com/api/cron/plan-expiry`             |
| `storemink-expire-pending-payments` | `30 * * * *`   | `https://storemink.com/api/cron/expire-pending-payments` |
| `storemink-seo-refresh`             | `0 2 * * *`    | `https://storemink.com/api/cron/seo-refresh`             |
| `storemink-search-metrics`          | `30 2 * * *`   | `https://storemink.com/api/cron/search-metrics`          |
| `storemink-domain-reconcile`        | `10 * * * *`   | `https://storemink.com/api/cron/domain-reconcile`        |
| `storemink-prune-logs`              | `0 3 * * *`    | `https://storemink.com/api/cron/prune-logs`              |
| `storemink-analytics-rollup`        | `40 * * * *`   | `https://storemink.com/api/cron/analytics-rollup`        |

> `analytics-rollup` rebuilds both `storefront_daily` and (since migration 0187) `storefront_daily_dimensions` (sessions by device, source, referrer,
> landing page, campaign and location). While it is paused, every storefront
> traffic card is empty, and raw events older than 14 days are pruned without
> ever being counted.
> | `storemink-import-worker` | `*/10 * * * *` | `https://storemink.com/api/cron/import-worker` |
> | `storemink-billing` | `20 * * * *` | `https://storemink.com/api/cron/billing` |
> | `storemink-help-embeddings` | `50 * * * *` | `https://storemink.com/api/cron/help-embeddings` |
> | `storemink-mink-publications` | `* * * * *` | `https://storemink.com/api/cron/mink-publications` |
> | `storemink-mink-workflows` | `* * * * *` | `https://storemink.com/api/cron/mink-workflows` |
> | `storemink-theme-studio-runs` | `* * * * *` | `https://storemink.com/api/internal/theme-studio/runs` |
> | `storemink-theme-studio-capture` | `* * * * *`, **PAUSED** since 2026-10-10 | Cloud Run Job execution API; the job is started on demand (see below) |
> | `storemink-theme-studio-qa` | `* * * * *` | `https://storemink.com/api/internal/theme-studio/qa` |

> ⚠ **The table above is the INTENDED state. Measured live 2026-09-08 with
> `gcloud scheduler jobs list --project storemink-prod --location asia-south1`,
> production does not match it.** This is the exact gap the section above
> describes, so it is recorded rather than quietly corrected:
>
> | Job                           | Table says   | Actually                        |
> | ----------------------------- | ------------ | ------------------------------- |
> | `storemink-send-emails`       | `* * * * *`  | ✅ fixed 2026-09-08             |
> | `storemink-search-metrics`    | `30 2 * * *` | ✅ enabled (checked 2026-10-24) |
> | `storemink-analytics-rollup`  | `40 * * * *` | ✅ enabled (checked 2026-10-24) |
> | `storemink-help-embeddings`   | `50 * * * *` | ✅ created 2026-10-15           |
> | `storemink-mink-publications` | `* * * * *`  | **absent**                      |
> | `storemink-mink-workflows`    | `* * * * *`  | ✅ created 2026-09-08           |
>
> ⚠ **An earlier version of this note called the `send-emails` schedule a LIVE
> cost. That was wrong, and the correction is the useful part.** Measured on
> production 2026-09-08: the queue was completely healthy — 12 rows, every one
> `status=sent`, `max_attempts=1`, **zero pending**, newest sent that morning —
> and the endpoint reported `remaining: 0` across campaigns, notifications, SMS
> and announcements. Nothing was being delayed.
>
> ★ The reason is the WORKER KICK. `triggerEmailWorker` is called from eight
> production sites (`lib/notifications/record.ts`, `coupon-email-actions`,
> `announcement-actions`, the Mink campaign route, `lib/import-export/trigger.ts`
> among them), so a queued email is drained by the very request that queued it.
> **The cron is a backstop, not the delivery path** — which is what the
> `triggerEmailWorker` note in CODEBASE.md §24 already said.
>
> The daily schedule was therefore a LATENT gap, in two narrow cases:
>
> 1. **Phase 5E scheduled campaigns.** `campaign-worker.ts` claims campaigns
>    where `status='scheduled' AND scheduled_for <= now`. A due campaign has no
>    request to kick it, so one scheduled for 14:00 would not have sent until
>    00:00 UTC the next day. Zero campaigns were scheduled at the time, so nobody
>    had hit it — but the feature was effectively broken whenever used.
> 2. **Retries.** A failed send backs off 5/15/45 minutes and needs a worker run
>    at that moment. `max_attempts=1` across the whole table means this had never
>    actually occurred.
>
> ✅ **Fixed 2026-09-08: the schedule is now `* * * * *`.** Verified by three
> consecutive firings one minute apart (13:41:02, 13:42:06, 13:43:09), all HTTP
> 200, the job's own status code empty, and the queue still `pending 0 /
failed 0`. Overlapping runs are safe because the endpoint is idempotent and
> claim-based (`FOR UPDATE SKIP LOCKED`); it returned in 0.52s, far inside the
> 300s attempt deadline. The cost is ~1,440 mostly no-op requests a day against a
> `min-instances=0` service.
>
> ★ This also makes the note further up STALE: production is NOT missing the
> notification system. `notification_email_queue`, `email_campaigns`,
> `email_campaign_recipients` and a schedule-aware `claim_email_batch` all exist
> in the production database.
>
> The two unrelated absent jobs shown above remain the documented-but-never-created
> failure this file was written about, and `search-metrics`/`analytics-rollup`
> remain PAUSED. Theme Studio's model and capture schedules were added on
> 2026-09-29.
> **None of those were changed:** each needs its own decision about whether its
> migrations and routes are actually deployed first.

✅ **`storemink-theme-studio-runs` exists as of 2026-09-29** (its `-dev`
twin was deleted on 2026-10-11: dev builds no themes). Each call executes up
to two independently leased Theme Studio runs and one visual-QA run
concurrently. A run can take up to 20
minutes, so it needs an attempt deadline of
**1,200 s** (Cloud Scheduler allows up to 1,800 s for HTTP targets), **no
retries** (the next eligible scheduled call claims queued work), and a Cloud
Run service request timeout of
at least 1,200 s — without that, Cloud Run kills the request mid-generation, the
lease expires 20 minutes later, and an attempt is spent for nothing. It is only
needed once an environment sets `THEME_STUDIO_PROVIDER=vertex-gemini`: the
offline provider runs in `after()` and on `mink-workflows`. Until then, model
runs queue and wait; nothing is lost. The path is under `/api/internal/`, not
`/api/cron/`, because it is a worker rather than a heartbeat. Full rollout list:
`docs/mink-ai-theme-studio-phase3.md` §6.

A failed attempt of `storemink-theme-studio-runs` or
`storemink-theme-studio-qa` emails the owner once the Theme Studio alerts are
applied ([monitoring](monitoring.md), alert 20).

**Inside each runs call (TS-3B, with the Theme Studio release):** an idle
lane beside a busy one asks for work every 5 to 10 s (it was every second);
a fresh photo run starts only with 9 minutes of the 19-minute request left,
and one cut by the request's deadline continues in the next request (up to
3 times, no crash attempt spent); automatic repairs are claimed before other
work; Theme Studio's text calls queue on their own capacity row
(`theme-studio-text`); and a text call that fails as `provider_unavailable`
(twice) or `provider_timeout` (once) is waited out, like a 429, instead of
failing the theme. The "theme studio: run settled" line carries `errorCode`.

**Prepared locally, 4 October:** generation and visual QA leases are now
180 seconds with thirty-second renewal and an expiry watchdog; a dead worker
is eligible after its last renewal, plus schedule/capacity wait. The generation
route drains free lanes under a request deadline. Cloud Build deploys private
model/QA services from the serving web digest. Moving schedules off the web
is a separate first-rollout action, with private OIDC/application-header
authentication and a checked shared SQL connection budget. ⚠ The planned
"-peer" schedule per role adds nothing: each worker runs at most one
instance with request concurrency one, so a second request while the first
runs is refused by Cloud Run with HTTP 429, not queued. Routing (plan P1,
after the release, with decision 9) drops the peers. Until that routing
happens, the existing web targets and QA fallback remain. See
[worker rollout](theme-studio-worker-rollout.md); private-service deployment
alone does not change scheduler URLs.

Cloud Scheduler **skips ticks while the previous request is outstanding**; a
one-minute schedule does not create overlapping long workers. The two run
lanes prevent two already-queued themes from serializing, and a separate QA
lane prevents generation from starving visual verdicts. All lanes are awaited
before responding, including when another lane fails. Image calls share a
three-permit pool per process/provider project/location/model to avoid doubling
image quota pressure. Provider 429s and newly queued work can still add delay;
this is not a completion-time guarantee. See
[Scheduler execution behavior](https://docs.cloud.google.com/scheduler/docs/troubleshooting#subsequent_job_executions_arent_starting)
and `docs/theme-studio-reliability.md`.

✅ **The Theme Studio capture job (Track 3.6) is deployed as of 2026-09-29.**
It is a Cloud Run JOB, `storemink-theme-studio-capture`,
with its own image (headless Chromium, `jobs/theme-studio-capture/`), executed
by a Cloud Scheduler job every 5 minutes; each execution claims queued captures
from `/api/internal/theme-studio/captures/claim` with `CRON_SECRET`, photographs
the preview store and posts the pictures back, and exits at once when nothing is
queued. Dev and production each have their own job and five-minute schedule,
and both completed an empty-queue smoke execution before
`THEME_STUDIO_CAPTURE_ENABLED=true` was enabled. Build, deploy and schedule:
`docs/theme-studio-capture-job.md`. Today: the schedule is paused (below) and
the web app starts the job when a capture is waiting, at a minute tick of
the runs or QA route and, since the Theme Studio release, right after the
capture is queued. Builds update production's job only; the dev job is no
longer updated and waits to be deleted (step A6, with the owner's OK).

★ **Dev has no schedules at all (owner, 2026-10-10).** Themes are never built
on dev, so every Theme Studio `-dev` schedule is deleted and Theme Studio is
switched off on the dev trigger (`docs/gcp-ci-cd.md`). Do not recreate them.

✅ **The capture schedule is PAUSED (since 2026-10-10).** A Cloud Run job
execution is billed for at least one minute, so the every-minute schedules in
dev and production cost ₹5,819 of Cloud Run's ₹5,972 for 1–10 October, almost
all of it idle executions. The `-qa` and `-runs` routes now start the job
themselves when a capture is waiting (`lib/theme-studio/capture-start.ts`),
and since the Theme Studio release so does the code that queues a capture,
right after its transaction commits; the minute routes stay as the safety
net. Checked on 2026-10-11: `storemink-theme-studio-capture`'s schedule is
paused (its last scheduled run was 2026-10-10 14:32 UTC, with no job
execution since), no `-dev` schedule exists, and the runtime service account
holds `roles/run.invoker` on both jobs. `resume` brings the schedule back as
a fallback; the order and commands are in
`docs/theme-studio-capture-job.md` ("Start it on demand instead").

Track 5 reuses this job for automatic acceptance and the design review. It captures
every preview surface at five widths and reports browser evidence; the server
records full acceptance before visual review and bounded repair. Both capture
and `_THEME_STUDIO_AUTO_QA_ENABLED=true` remain required.

✅ **Rolled out 2026-10-01 in dev and production.** The independent
`POST /api/internal/theme-studio/qa` route drains two leased QA rows without
waiting on the long model/image request. `storemink-theme-studio-qa` and
`storemink-theme-studio-qa-dev` ran every minute with a 300-second deadline and
no scheduler retries; the database owns retries. (The dev schedules were
deleted on 2026-10-11 and the dev worker services on 2026-10-17: themes are
built on production only.) The existing model endpoint
retains its QA lane as a fallback. Both capture jobs run the image built from
merge commit `621ee75`, and both capture schedules were shortened from five
minutes to one. Leases fence overlapping capture/QA executions. First
scheduled attempts at 11:34 UTC succeeded in both environments.

**Since the Theme Studio release (TS-3A)** the capture job also calls
`POST /api/internal/theme-studio/qa`, with the same `CRON_SECRET` bearer,
right after its captures end (and when it stops at its capture limit or
budget), and waits up to 300 s for the answer, so a design review starts at
once instead of at the next tick. The minute schedule stays as the safety
net. At most 2 design reviews run at once across the platform, and each call
logs `theme_studio.qa_waiting` when reviews have waited over 10 minutes
([monitoring](monitoring.md), alert 18). One call holds either the photo
checks of a theme's unchecked photos (until 250 s after its claim) or a
design review (up to 4 minutes), never both past the 300-second attempt
deadline: when the checks took more than 20 s the review goes back to the
queue, claimable at once, and the next call runs it.

⚠ **`billing` must stay HOURLY.** The cycle boundary and the 48-hour grace
deadline are wall-clock instants, so the interval IS the resolution of the whole
system: on a daily schedule some merchants would get nearly a day of unearned
service and others nearly a day less notice than the 48 hours they are promised.
It runs at :20 to stay clear of the on-the-hour `domain-reconcile`.

**The pre-existing jobs exist** (verified against `gcloud scheduler jobs list`,
2026-08-21). ⚠ **`storemink-help-embeddings` was documented here on 2026-08-25
and not created until 2026-10-15**, seven weeks in which no guide edited by a
migration was ever re-embedded on production: the only other caller of the
reconciler is the Help console's save action. It was created with the command
below (GET, bearer, 300 s, 3 retries) and run once by hand straight after; the
first run's counts are in the Cloud Logging line `help.embedding worker
complete`. ★ Its first four runs all answered 503: the worker indexed one
guide and then got 429 from Vertex, because Google had capped
`gemini-embedding-001` at five requests a minute per project. The fix was a
model switch to `gemini-embedding-2` through `embedContent`
(`lib/help/embeddings.ts`, CODEBASE.md §21), not a quota request; once that
code is deployed the job re-embeds every guide on its own. Production only:
dev has no scheduler, so dev's index is refreshed by hand when it matters.
Also,
**`storemink-mink-publications` is new in Phase 5D and must stay absent/paused
until migration `20260901_0052_mink_phase_5d_blog_publication` and the matching
route are deployed. Create it with the same CRON_SECRET bearer contract only
after both application and database verification pass.** Also,
✅ **`storemink-mink-workflows` EXISTS as of 2026-09-08** (`* * * * *`, 300s
deadline, retryCount 3, same CRON_SECRET bearer contract), created only after
every precondition below was checked against production rather than assumed:
`mink_workflow_runs`, `mink_workflow_steps` and `mink_workflow_events` all
EXIST; the route answers **HTTP 200 on an empty queue** across three calls
(0.25-0.45s) with `claims:0`, which is the specific thing to verify — CODEBASE.md
§20a records a version where `parseClaimedWorkflow` threw on an empty claim, so
the minute cron answered **500 on every idle tick** and the completion fan-out
below it was unreachable; unauthenticated requests get 401; the queue was empty
(0 runs) so nothing was stranded; and 2 stores have Mink enabled, so the feature
is live and did need a worker. Verified after creation by three consecutive
firings a minute apart (13:49:09, 13:50:05, 13:51:05), all HTTP 200, the job's
own status code empty, no app-side errors, tables still clean.

★ **It also carries the Theme Studio preview retention sweep (2026-09-24),**
for the same reason as the reconciler below: it needs a per-minute authorised
backstop, and a new Scheduler entry is the kind that gets documented and never
created. `sweepThemeStudioPreviews` removes up to ten preview stores a pass —
idle past 24 hours, abandoned mid-build, or belonging to an archived project —
and is isolated: its failure is logged, never propagated, so it cannot fail
merchant Mink workflows. The response carries `themeStudioPreviewsRemoved`.
Nothing about the job itself changes.

★ **It also sweeps stalled storefront revamps (2026-10-21).**
`sweepStalledRevamps` (`lib/mink/revamp/jobs.ts`) finishes a card already
made, fails jobs out of attempts or past their four-hour ceiling (since
2026-10-24 a claim counts no attempt, so the ceiling is what ends a job that
never finishes), gives a failed redesign's daily start back, cancels the
ones whose stop no runner will see, kicks up to five waiting ones and
settles finished photo holds; it is isolated like the preview sweep and
reports `revamps`. On dev, which has no scheduler, a stalled revamp moves
when its card's status poll kicks it, or when a runner that turned its kick
away finishes and kicks the oldest waiting one.

★ **It also closes Mink chat runs whose Stop their server never saw
(2026-10-25).** The merchant's Stop is recorded on the run's row
(`POST /api/mink/runs/[runId]/stop`, `lib/mink/run-stop.ts`), and the
instance answering the run sees it within about two seconds. A run still
running three minutes after its Stop lost its instance: `closeStoppedMinkRuns`
closes at most 20 a tick, oldest first, through the stream route's own
failure record as cancelled with code `stopped` (never charged). It runs just
before the dead-run pass below, so a run that is both is recorded as the
stop it was, is isolated (`mink workflow cron: stopped run sweep failed`)
and reports `stoppedRuns` (`{closed, failed}`, or null when the pass failed).

★ **It also closes Mink chat runs a dead server left running (2026-10-24,
robustness audit B7).** `closeStaleMinkRuns` (`lib/mink/persistence.ts`)
closes at most 20 a tick, oldest first: runs still "running" 15 minutes after
they started and after their latest tool call started. Each goes through the
stream route's own failure record (`run_abandoned`), so a redesign it started
is kept with its card and its chat can be deleted again. It is isolated
(its failure is logged as `mink workflow cron: stale run sweep failed` and
never fails the tick) and reports `staleRuns` (`{closed, failed}`, or null
when the pass failed). On dev a dead run is closed when its chat is deleted.
Its query reads `mink_runs` across every store, so it uses the partial index
`mink_runs_running_idx` (`(started_at, id) where status = 'running'`,
migration `20261024_0240`), which holds only running runs in the sweep's own
order and stays small as the table grows (on 200,083 runs locally: 15.7 ms
before, 0.09 ms after).

★ **It also publishes or clears Refine stages (2026-10-26).** A Refine with
Mink AI result is staged in the private bucket until it is paid for
(`lib/mink/refine-stages.ts`). `sweepRefineStages` lists only THIS database's
prefix (`refine-stage/{DB_NAME}/`: dev and staging share one database and one
bucket, and a laptop uses that bucket with `storemink_local`, so no
environment ever decides another's stages), skips stages younger than five
minutes (a stage without a creation time is left, with one warning a pass),
and decides at most twenty a tick with `abandonRefineStage`: a paid photo
whose publish failed is published to the store's `refined/` folder (unless
the merchant has since deleted it from the Media Library, when only its
stage is deleted), and a stage nobody paid for (or can ever pay for) is
deleted. Its ten-second budget covers every storage call, the listing's
included, each cut at what is left of it, and it runs LAST in the
heartbeat, after the database passes, because it is the only one that waits
on storage. It is isolated (a failure is logged as
`mink workflow cron: refine stage sweep failed` and never fails the tick)
and reports `refineStages` (`{published, deleted, failed}`, or null when
the pass failed). Dev has no scheduler: there a deferred publish waits
until the route is run by hand.

★★ **IT ALSO CARRIES THE MINK CREDIT RECONCILER (2026-09-21), and that is
deliberately not a job of its own.** `settleMinkRunCredits` runs after the run
row commits and never throws, because a billing failure must not roll back a
reply the merchant is already reading — so a crash-shaped miss leaves a
`mink_usage_ledger` row with a NULL `credit_source`: answer delivered, credits
never taken, nothing retrying. `reconcileMinkRunCredits` is that retry, added
as one more independent pass here rather than as a new Cloud Scheduler entry,
because this file records **three** jobs that were documented and never
created, and this route is already per-minute, already Mink-scoped and already
authorised. The response gained `creditsSettled`.
⚠ **It is fenced off from the backlog.** Every run older than
`CHARGING_STARTED_AT` was free when it was made, so sweeping "everything
unsettled" would retroactively bill merchants for questions that cost nothing
at the time. Measured against a staging copy: **43 rows** would have been
billed without that fence, and **0** with it. It also has a 24-hour lookback
(settling a run from a previous cycle spends THIS cycle's allowance on last
cycle's work) and a 10-minute minimum age so it cannot race the live path.
⚠ It picks up a second, structural fault too: nothing calls
`settleMinkRunCredits` for a run that FAILED, so every failed run's row is NULL
for ever. Settling those charges nothing — a failed run's band is 0 and
`minkRunCreditCharge` returns only the untaken part — but records the fact,
which is what stops the sweep re-reading them every minute.
★ **IT ALSO DRAINS THEME STUDIO RUNS (2026-09-23)**, again as an independent
pass rather than a new job. Queuing a Studio run kicks the worker in-process, so
this is the backstop that reclaims expired leases and finishes work a recycled
instance left behind. It is isolated in the other direction too: a Studio
failure is logged and never fails the merchant Mink heartbeat. The response
gained `themeStudio`. See `docs/mink-ai-theme-studio-phase2.md`.
⚠ Each execution logs TWO Cloud Scheduler entries — one carrying
`httpRequest.status: 200` and one with the field absent — so a filter of
`httpRequest.status!=200` looks like failures and is not. Judge by the job's
`status.code` (blank = success).

The original caveat, kept because it still applies to any environment where this
has not been done: it **must stay absent/paused until migration
`20260902_0058_mink_phase_6a_durable_workflows`
and the matching route are deployed. Phase 6B/6C additionally requires
`20260903_0072_mink_phase_6bc_workflows` before the matching application deploy.
Create or resume it with the shared CRON_SECRET bearer contract only after the
workflow tables, template constraint and service-only grants verify. A missing
heartbeat leaves workflows queued safely; it must never be worked around by
opening the worker to unauthenticated traffic.** Also,
**the `storemink-send-emails` change from daily to once per minute belongs to
Phase 5E. Apply it only after migration
`20260901_0053_mink_phase_5e_campaigns` and the matching application are live;
before that deployment, the older claim function is not schedule-aware.** Also,
**`storemink-search-metrics` and `storemink-analytics-rollup`
were PAUSED** while their routes were on `staging` and not yet on `main`
(`analytics-rollup`'s first run returned NOT_FOUND at 11:40Z). ✅ Both routes
are live on `https://storemink.com` now (each answers 401 to an unsigned
request) and both jobs were found ENABLED on 2026-10-24, each with a
successful attempt that day (empty status code). If either is ever paused
again, this is how to resume it:

```bash
gcloud scheduler jobs resume storemink-analytics-rollup \
  --project=storemink-prod --location=asia-south1
gcloud scheduler jobs resume storemink-search-metrics \
  --project=storemink-prod --location=asia-south1
```

★★ **THE FLEET DIFF MUST BE AGAINST WHAT IS DEPLOYED, NOT THE WORKING TREE.**
This gate has two halves — a route needs a job, and the job needs a route
_live on the target host_ — and checking `app/api/cron/` against
`gcloud scheduler jobs list` only ever proves the first. Both jobs were created
off a branch where the routes exist; on prod they do not. Diff against
`origin/main` (or curl the endpoint) before creating a job, or the fleet looks
complete while two of its members 404 every hour.

Their ledger migrations ARE applied in BOTH `storemink` and `storemink_staging`
(`store_search_metrics` / `store_search_sources` / `store_search_sync_jobs` /
`store_search_rate_limits`, and `storefront_events` / `storefront_daily` /
`storefront_order_attribution`).

⚠ **`analytics-rollup` HAD TO BE CREATED BEFORE THE FIRST EVENT ARRIVES, NOT
AFTER.** It is what turns raw `storefront_events` into the durable
`storefront_daily` totals — and `prune-logs` deletes both `storefront_events`
and `storefront_order_attribution` at **14 days** (§32). With the rollup absent,
raw conversion data would be collected, never aggregated, and then permanently
deleted, silently. It was caught while both tables were still empty, so nothing
was lost; had a Pro merchant enabled the module first, the loss would have been
invisible until someone asked why the funnel was blank.

★ **THE FLEET DIFF IS THE ONLY THING THAT HAS EVER CAUGHT THIS.** Compare the
`app/api/cron/` directory against `gcloud scheduler jobs list` after ANY deploy
that adds a cron route. A job documented here but absent from Scheduler fails
completely silently — nothing errors, the work simply never happens. That has
now happened four times.

Each job is `GET`, `Etc/UTC`, 300s
attempt deadline, 3 retries, and an `Authorization: Bearer <CRON_SECRET>` header
— the same secret the routes check (`CRON_SECRET` is in Secret Manager and
already wired to the prod service).

## Rotating `CRON_SECRET`

The secret is the ONLY thing in front of every cron endpoint — `prune-logs`
deletes the audit trail, `billing` charges merchants, `expire-pending-payments`
cancels orders and restocks. Treat a leak as urgent. Rotated 2026-08-21 after
the value was pasted into a chat transcript by `jobs describe` (see the trap
below).

The app reads ONE value (`process.env.CRON_SECRET`, compared per route), so
there is no dual-secret window: this is a coordinated flip.

```bash
# 1. New version in Secret Manager (console, or:)
printf '%s' "$(openssl rand -hex 16)" | \
  gcloud secrets versions add CRON_SECRET --project=storemink-prod --data-file=-

# 2. Roll a revision so instances re-read it. The service pins
#    CRON_SECRET=CRON_SECRET:latest, so NO code deploy is needed.
gcloud run services update storemink-web-prod --project=storemink-prod \
  --region=asia-south1 \
  --update-secrets=CRON_SECRET=CRON_SECRET:latest

# 3. Take the value FROM Secret Manager — never retype it (trap 1).
CRON_SECRET_VALUE=$(gcloud secrets versions access latest \
  --secret=CRON_SECRET --project=storemink-prod)

# 4. Every job, so none is left behind.
for J in $(gcloud scheduler jobs list --project=storemink-prod \
             --location=asia-south1 --format="value(name.basename())"); do
  gcloud scheduler jobs update http "$J" --project=storemink-prod \
    --location=asia-south1 \
    --update-headers="Authorization=Bearer ${CRON_SECRET_VALUE}"
done
unset CRON_SECRET_VALUE
```

⚠ **`--update-secrets`, NEVER `--set-secrets`** in step 2. `--set-secrets`
REPLACES the whole set (the warning at the top of `cloudbuild.yaml`), so it
would strip `DB_PASSWORD`, `PAYMENT_CRED_KEY`, both Razorpay secrets and
`POS_SESSION_SECRET` — a total prod outage from a rotation command.

Between step 2 and step 4 the jobs 401. That is unavoidable with one secret and
harmless: every cron is an idempotent heartbeat that re-reads the same rows on
its next run, and each retries 3×. Keep the gap to minutes.

### Three traps, all of which bit on 2026-08-21

**★ 1. NEVER RETYPE THE SECRET INTO A SHELL VARIABLE.** A rotation done by
pasting into `export SECRET='<the new value>'` left the literal `<` on the
front, and all ten jobs were updated with a 33-character value against a
32-character secret. Everything _looked_ right — ten jobs, ten identical
hashes, no errors — because they were consistently wrong. Step 3 above reads
the value from Secret Manager so the jobs match BY CONSTRUCTION.

**★★ 2. `jobs describe` PRINTS THE SECRET.** The full `Authorization` header is
in its default output, which is how the value reached a chat log in the first
place. Always pass `--format="value(...)"` naming only the fields wanted.

**★★ 3. NORMALISE BOTH SIDES WHEN COMPARING HASHES.** `--format='value(...)'`
appends a newline; `$(...)` command substitution strips one. Hashing one side
through a pipe and the other through a variable compares 33 bytes against 32
and reports a MISMATCH on a perfectly good rotation — which then looks exactly
like a real outage. Verify with both sides normalised:

```bash
SM=$(gcloud secrets versions access latest --secret=CRON_SECRET \
       --project=storemink-prod)
h(){ printf '%s' "$1" | shasum -a 256 | cut -c1-12; }
for J in $(gcloud scheduler jobs list --project=storemink-prod \
             --location=asia-south1 --format="value(name.basename())"); do
  V=$(gcloud scheduler jobs describe "$J" --project=storemink-prod \
        --location=asia-south1 \
        --format='value(httpTarget.headers.Authorization)' | sed 's/^Bearer //')
  [ "$(h "$V")" = "$(h "$SM")" ] && echo "✅ $J" || echo "❌ $J"
done
unset SM V
```

**A hash check is not proof it works** — it proves the jobs agree with Secret
Manager, not that the running revision does. Confirm with a real run:
`import-worker` fires every 10 minutes, so it is the fastest signal. An empty
`status.code` is success. ⚠ Check `userUpdateTime` against `lastAttemptTime`
first: an attempt from BEFORE the header change says nothing about the new
secret, and reading a stale success as a pass is how a broken rotation gets
declared finished.

Only after a real run passes, **Disable** (not Destroy — disable is reversible)
the previous secret version.

`seo-refresh` registers the platform/help/themes sitemaps, retries sitemap
coverage for every launched store, and automatically verifies Search Console URL-prefix
properties for connected custom domains. It returns **503 on any partial
failure**, so Scheduler retries are part of its reliability contract. Enable
the Google Search Console + Site Verification APIs and configure the runtime
service account first; see `docs/seo-indexing.md`.

> **⚠ `Search Console rejected sitemap (403)` usually means the APIs are not
> enabled — not a property-permission problem.** The message reads like the
> service account lacks access to the property, which sends you into the Search
> Console UI looking for a grant that is already there. On 2026-08-06 every root
> and every store failed with this, and the entire cause was that
> `searchconsole.googleapis.com` and `siteverification.googleapis.com` had never
> been enabled in `storemink-prod` — a step `CODEBASE.md` §7 lists and that was
> simply skipped. Check this FIRST:
>
> ```bash
> gcloud services list --enabled --project=storemink-prod | grep -E "searchconsole|siteverification"
> ```
>
> Enabling both turned the same request into `200 {"ok":true}` with no other
> change. They are free; there is no reason for either to be off.

> **⚠ `send-emails` must stay once per minute after Phase 5E rollout.** Daily
> digests still become eligible at `DAILY_DIGEST_HOUR_UTC` (23:00 UTC), and the
> next minute heartbeat drains them. Future campaign rows are excluded from the
> worker's remaining count, so this cadence does not self-chain while waiting.

> **★ `send-emails` also runs the takedown follow-ups, last**
> (`runModerationFollowUps`, `lib/moderation/follow-ups.ts`; CODEBASE.md §5
> convention 45). Each minute, in order: complaint deadline alerts (the bell
> and email to every operator, and the WARNING line
> `moderation: complaint due` with `ref`, `kind`, `stage`, `phase`, `dueAt`),
> archive copies, file replacements (no sooner than 35 seconds after a block,
> and only once the archive holds the file), restores after a lift, and store
> notice emails not yet sent (retried for 24 hours after the block). Every row
> is claimed first (`for update skip locked` plus a claim time, 2 minutes), so
> two overlapping calls never do the same work, and every settle is fenced on
> its claim. A run is bounded: 20 rows a step, 50 archive files a run, and a
> deadline of `min(start + 40 s, routeStart + 52 s)`, inside the route's 60 s.
> The follow-ups run even when an email queue throws (the error is re-thrown
> after them, so the scheduler still sees the failure), and the route answers
> their result as `moderation` (null when the run itself failed). A step that
> throws logs ERROR `moderation: follow-up failed` with its `step`; every run
> ends with INFO `moderation: follow-ups ran` and its counts, in a `finally`.
> Alerts 25 to 28 of [`monitoring.md`](monitoring.md) watch those lines and
> this job's own attempts. Dev and staging have no scheduler, so there the
> follow-ups run at the end of each console action instead (a replacement
> then happens at the next action).

> **⚠ Timezone is `Etc/UTC`, not IST.** The cron expressions are written in
> UTC. Re-creating them in `Asia/Kolkata` would shift every job by 5h30m.

## Recreating them

The secret is read straight from Secret Manager so it never lands in a shell
history or a repo file:

```bash
CRON_SECRET_VALUE=$(gcloud secrets versions access latest \
  --secret=CRON_SECRET --project=storemink-prod)
gcloud scheduler jobs create http storemink-plan-expiry \
  --project=storemink-prod --location=asia-south1 \
  --schedule="15 0 * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/plan-expiry" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

Create the SEO job with the same secret/header contract:

```bash
gcloud scheduler jobs create http storemink-seo-refresh \
  --project=storemink-prod --location=asia-south1 \
  --schedule="0 2 * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/seo-refresh" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

Only after the Cloud Run request timeout is at least 1,200 s, create the
Theme Studio model worker (long deadline, no retries — see above):

```bash
gcloud scheduler jobs create http storemink-theme-studio-runs \
  --project=storemink-prod --location=asia-south1 \
  --schedule="* * * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/internal/theme-studio/runs" \
  --http-method=POST --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=1200s --max-retry-attempts=0
```

After deploying the automatic-acceptance web changes, create the separate QA
scheduler (production only: dev has no Theme Studio schedules, owner
2026-10-10):

```bash
gcloud scheduler jobs create http storemink-theme-studio-qa \
  --project=storemink-prod --location=asia-south1 \
  --schedule="* * * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/internal/theme-studio/qa" \
  --http-method=POST --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=0
```

After the pgvector migration and route deploy are verified, create the Help
embedding reconciliation heartbeat:

```bash
gcloud scheduler jobs create http storemink-help-embeddings \
  --project=storemink-prod --location=asia-south1 \
  --schedule="50 * * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/help-embeddings" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

Its source of truth is the published article revision plus the active embedding
model, chunker version, and complete expected chunk count—not a lossy in-memory
queue. The worker rebuilds missing, partial, stale, or old-version sets. A `503`
means provider/indexing work failed and should be retried; a `200` with
`remaining:true` means a one-row lookahead proved more work exists and schedules
a bounded authenticated POST continuation.

After the search-metrics migration and deploy are verified, create its separate
worker heartbeat. The route's GET reconciles the five-day PT correction window;
the internal POST chain only drains its leased buckets:

```bash
gcloud scheduler jobs create http storemink-search-metrics \
  --project=storemink-prod --location=asia-south1 \
  --schedule="30 2 * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/search-metrics" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

This is intentionally not part of `seo-refresh`: a Search Analytics outage must
not make sitemap reconciliation report red, and its durable
`(source_id, PT date, dimension)` cursor can resume independently.

After migration `20260820_0011_storefront_conversion` and the matching deploy,
create the hourly conversion rollup. It rebuilds the still-correctable 14-day
raw window, so retries and delayed purchase events remain deterministic:

```bash
gcloud scheduler jobs create http storemink-analytics-rollup \
  --project=storemink-prod --location=asia-south1 \
  --schedule="40 * * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/analytics-rollup" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

⚠ Each rebuild runs in its own transaction with a 5-minute statement limit
(`setRollupStatementLimit`, 2026-10-24), not the pool's 30 s: 2.2 s and 2.6 s
for 211,473 local events. The job's 300 s attempt deadline is shorter than
that limit, so a rebuild that ever took minutes would be retried while it is
still running (the primary keys keep the counts right). Raising the deadline
to 900 s is a live change for the owner to approve.

The domain backstop is the one **hourly** job. Google's managed certificate takes
up to ~30 minutes after the challenge CNAME resolves, and merchants edit DNS on
their own schedule, so a daily sweep would leave a domain connected at 09:05
waiting a full day to serve:

```bash
gcloud scheduler jobs create http storemink-domain-reconcile \
  --project=storemink-prod --location=asia-south1 \
  --schedule="10 * * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/domain-reconcile" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

Unlike `seo-refresh` it answers **200 even while domains are still waiting** — the
common case is a merchant who hasn't added their records yet, which a retry
within the hour cannot help, and a permanently-red job is one nobody reads. Its
response body lists `waiting[]` with the reason per store.

Log retention runs last, at 03:00, after every other job has written whatever it
was going to write:

```bash
gcloud scheduler jobs create http storemink-prune-logs \
  --project=storemink-prod --location=asia-south1 \
  --schedule="0 3 * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/prune-logs" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

### `import-worker` is a BACKSTOP, not the normal path

Uploading a file kicks the worker directly (`triggerImportWorker`), so an import
starts within a second and self-chains until the file is done — the schedule
exists for the chain that BREAKS. Ten minutes because a stalled import is a
merchant watching a half-finished progress bar, and the sweep costs one query
when there is nothing to do.

```bash
gcloud scheduler jobs create http storemink-import-worker \
  --project=storemink-prod --location=asia-south1 \
  --schedule="*/10 * * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/import-worker" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

It answers **200 even when an import failed** — a failed import is a recorded
outcome on the job that the merchant reads in the log, not an outage, and a 5xx
would make Scheduler retry a job that has already given up.

### `billing` — the subscription heartbeat

```bash
gcloud scheduler jobs create http storemink-billing \
  --project=storemink-prod --location=asia-south1 \
  --schedule="20 * * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/billing" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
unset CRON_SECRET_VALUE
```

Runs seven steps **in one request, in order**: promote a GST change that has
started (`promoteDueTaxChange`), collect at T-4d, reconcile (payments we never
heard about), repair captured drafts (`issueCapturedDrafts`), evaluate at the
cycle turn, downgrade after the 48-hour grace, and last the **refund pass**
(`processBillingRefunds`, `lib/billing/refunds.ts`). Splitting them across jobs
would leave each pass a full interval behind the one before it, so a merchant's
buffer would quietly become 48 hours plus two intervals. The refund pass runs last with the same
clock, so a plan that ends in this run (a cancellation reaching its end closes
its unreached invoices) has its refund owed, and sent when automatic sending is
on, in this run too. No new Scheduler job: the refund pass rides this one.

**The promote step comes first** (`lib/billing/platform-settings.ts`, the GST
release). When a scheduled GST change has started, one UPDATE copies it into
the in-force columns of `platform_billing_settings` (recorded as
`system: scheduled GST change`) and clears the schedule; only then is the
public pricing pages' cached copy refreshed (`bustPlatformTax`, tag
`platform-tax`). Nothing below depends on it, because every invoice reads the
terms at its own instant (`termsAt` applies a started change by time); it keeps
the in-force columns true for anything that reads them directly. A failure
logs `billing.cron.promote_tax_change` (ERROR), counts as an error (503, so
Scheduler retries) and the other passes still run.

**The reconcile pass also finishes closed-tab purchases** (RC-F1b). After it
settles stranded attempts, the same pass looks for payments captured on a
**draft** subscription or add-on invoice: a merchant paid for a first plan, a
plan change or extra locations and closed the tab before the browser confirmed
it. It takes only attempts older than **15 minutes** (`STALE_AFTER_MINUTES`, so
a browser confirm still has time to win), of stores that still exist and not
already held by a person (an open or in-review reconciliation item about the
attempt, or a `purchase_refused:` or `purchase_unapplied:` item in any status),
at most **50 a pass**; the next run takes the rest, and a full recovery batch
does not set `more`. Each one is asked of the gateway again. A purchase that
still applies is finished: the invoice is issued and paid, one receipt goes
out, the plan or the locations are applied, and an enrolment also gets its
welcome email. One that no longer applies, or whose captured amount or currency
differs from the attempt's, is filed for a person in the reconciliation queue,
and nothing is refunded or applied. It runs before the evaluate and downgrade
passes, like the rest of reconciliation, so a merchant whose payment it finds
is never downgraded in the same run, and like the rest of reconciliation it
does nothing without the platform's Razorpay keys.

Its log lines: `billing.reconcile.purchase_completed` (INFO, one per purchase
finished, with the attempt, store, invoice and outcome) and
`billing.purchase_completed` (INFO, from the completion itself);
`billing.recovery.filed` (WARNING, a purchase filed for a person); and the
errors `billing.recovery.scan` (the list of captured drafts could not be read),
`billing.recovery.gateway_read` and `billing.recovery.order_read` (the gateway
or the order could not be read, so nothing changed and the next pass looks
again) and `billing.reconcile.purchase_one` (one purchase threw; the rest go
on).

**The repair pass runs after reconcile and before evaluate** (`issueCapturedDrafts`,
`lib/billing/reconcile.ts`, the GST release). It finds invoices that are still
unnumbered drafts behind money already taken: a subscription or add-on draft
whose attempt was captured more than **60 minutes** ago
(`CAPTURED_DRAFT_WAIT_MINUTES`, so the browser confirm and the reconcile
completion get the first chance), or a Mink credit pack whose purchase is paid.
At most **100 of each a pass** (`CAPTURED_DRAFT_BATCH`), oldest first; a full
batch sets `repair.more`. A subscription or add-on draft goes to its
purchase's own completion first (the same one reconcile uses); when the
completion declines, the pass issues the invoice alone at the capture time,
settles the payment (no receipt: a person checks this purchase) and files one
`captured_draft:<invoice>` reconciliation item for a person, unless a person
already holds that payment. A credit pack's invoice is issued as paid. It runs
before evaluate so a payment repaired here counts as paid at the cycle turn.
A draft it could not issue is asked again next run and is not an error; it
logs `billing.captured_draft_unissued`, a WARNING for its first six hours and
an ERROR after (alert 24, [monitoring](monitoring.md)). Its other lines:
`billing.captured_draft.issued` and `billing.captured_draft.completed` (INFO),
and the errors `billing.captured_draft.scan`, `billing.captured_draft.one`,
`billing.captured_draft.payment_read` and `billing.captured_draft.item_read`.
`deleteStore` runs the same pass for one store first, issuing only and never
completing.

The refund pass repairs leftovers older code made, owes one refund per captured
payment on a closed (`void` or `uncollectible`) subscription invoice, sends the
owed ones (automatic ones only while `platform_billing_settings.auto_refunds` is
on, which it ships off; an operator's always), settles sent ones by the key it
planted, issues credit notes and emails the merchant once per finished refund.
At most 50 rows per step per run.

**Its daily waiting check** runs only in the run whose India-time hour is 9
(`WAITING_CHECK_IST_HOUR`). With this job at `20 * * * *` UTC that is exactly
one run a day, **04:20 UTC (09:50 IST)**. It logs `billing.refund_waiting`
(WARNING, with `owed`, `pending`, `failed` and `oldestAt`) when a refund has
waited more than a day, which the daily alert reads ([monitoring](monitoring.md)).
Refunds held only because automatic sending is off are counted on the console's
banner, not here. ⚠ A Scheduler retry of a 503 in that hour, or a run by hand,
logs it again: the alert opens once and must not page per line. The 09:00 IST
hour is 03:30 to 04:29 UTC, so whatever minute this job runs at, exactly one run
a day falls in it; moving the minute only moves the check.

**Its status contract, which differs from the others in one important way:**

| Situation                              | Status  | Why                                                                                                                            |
| -------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A merchant's payment was **declined**  | **200** | Not an outage. That merchant has not paid, which the grace window already handles; a 5xx would make Scheduler retry a decline. |
| A merchant was **downgraded**          | **200** | The system working as designed.                                                                                                |
| Collection is **unconfigured**         | **200** | See below — it is a known state, not a failure.                                                                                |
| A refund **failed** or is **waiting**  | **200** | A person's job: the pass never retries a refused refund, and the refund alerts fire. Not counted in `errors`.                  |
| A pass threw, or a store errored       | **503** | Money was not collected or a plan was not applied. Worth retrying.                                                             |
| A started GST change was not promoted  | **503** | `promote.errors`; the other passes still ran. Worth retrying.                                                                  |
| The repair pass hit an error           | **503** | Counted in `repair.errors`. A draft it could not issue (`repair.unissued`) is NOT an error: it is logged and asked again.      |
| A renewal could not read the GST terms | **200** | Counted in `collect.pendingReconcile` and logged `billing.renewal_tax_snapshot` (alert 23); the next run tries again.          |
| The refund pass hit a database error   | **503** | Counted in `refunds.errors`, a failed settings read included (fail closed: nothing is sent). Worth retrying.                   |

**The response body** carries each pass's summary: `collectionSkipped`,
`promote` (`promoted`, the GST change made current this run or null, and
`errors`), `collect`, `reconcile` (with `completed`, closed-tab purchases
finished this run; a recovery scan that could not be read counts in
`reconcile.errors`, so the run answers 503), `repair` (`considered`, `issued`,
`completed`, `filed`, `deferred`, `unissued`, `errors`, `more`), `evaluate`, `downgrade` (with `ended`, cancelling plans
ended at grace end, and `advancedAfterGrace`, paid renewals the safety net
advanced) and `refunds` (`repairedInvoices`, `flaggedForPerson`, `detected`,
`sent`, `processed`, `failed`, `stillPending`, `creditNotes`, `notified`,
`waiting`, `errors`, `more`), plus `ok` and `more`. **`more`** is true when any
pass filled its batch: `collect.considered`, the evaluate outcomes, the
downgrade outcomes (`downgraded + ended + advancedAfterGrace`) at 50, or
`refunds.more` or `repair.more`. A backlog draining is 200, not an error.

⚠ **`collectionSkipped` in the response body means AUTOPAY is off, not that
billing is idle.** While the Razorpay subsequent-charge endpoint is unverified
(`lib/billing/gateway.ts`), pass 1 still runs and still **issues** each renewal
invoice — it just does not charge it. The merchant pays it by hand on
`/dashboard/plans`, which is a complete billing path on its own. What is skipped
is only the automatic debit; a stub that always failed would create payment
attempts that can never settle, and because an unreachable provider is an
_unknown_ outcome rather than a decline, each would sit in reconciliation
forever.

★★ **Issuing was coupled to charging until 2026-08-13, and that was a silent
revenue hole.** The whole pass was skipped when the gateway was unavailable, so
no invoice was ever written — pass 2 then found nothing and recorded `waiting`,
grace never opened, nobody was ever downgraded, and every subscriber received
free service past their cycle end. The manual payment surface listed nothing,
because there was nothing to list. The job reported green throughout.

### What `prune-logs` closes

Three tables grew without bound because their retention policy was written down
and never wired to anything:

| Table                            | Window                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notifications`                  | 90 days                           | A read inbox row is history.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `activity_events`                | 365 days                          | The audit trail, so it gets the longest life.                                                                                                                                                                                                                                                                                                                                                                                  |
| `email_logs`                     | 90 days                           | Holds rendered message BODIES, so it is much the heaviest of the three and gets the shortest window.                                                                                                                                                                                                                                                                                                                           |
| `store_search_metrics`           | 488 days                          | Matches the source product's roughly 16-month Search Console history window.                                                                                                                                                                                                                                                                                                                                                   |
| `theme_studio_image_checkpoints` | 30 days after settlement          | Private raw originals; queued/running retry ancestors are protected. Run usage and settled assets remain.                                                                                                                                                                                                                                                                                                                      |
| `whatsapp_logs`                  | 90 days                           | Rendered WhatsApp message bodies with Meta's delivery timeline — email_logs' window, for its reason.                                                                                                                                                                                                                                                                                                                           |
| `whatsapp_inbound_events`        | 30 days                           | Raw webhook payloads (customer text); the facts they produced live on the account, template and log rows.                                                                                                                                                                                                                                                                                                                      |
| `ai_quota_refunds`               | 90 days                           | One row per Generate with AI take that was given back, kept so a second refund of the same take gives nothing; a take is refunded only inside its own request.                                                                                                                                                                                                                                                                 |
| `mink_refine_requests`           | 30 days                           | One row per Refine with Mink AI request: the browser's stop and the charge claim; it decides only while its refine runs.                                                                                                                                                                                                                                                                                                       |
| `help_assistant_feedback`        | 365 days                          | A Help Centre visitor's thumbs up or down on a Mink AI answer, with the question, the answer and its guides, so operators can fix the guides behind bad answers. Nothing in it identifies the visitor.                                                                                                                                                                                                                         |
| `mink_conversations`             | 90 days after last use            | A Mink AI chat is kept 90 days after the merchant last sent a message in it or opened it, then retired: deleted, or reduced when it holds the record of an approved or published change (its words go, the record stays while the store exists). A chat is retired only when both its expiry and its last message are 90 days old; never one with a reply running or a redesign being made.                                    |
| `mink_attachments`               | with its chat; never sent: 2 days | A picture attached to a Mink AI chat (private bucket) is deleted with its chat: the merchant's delete, or the chat's 90 days after last use. One the merchant attached and never sent is deleted 2 days after it was attached. Batch 50, after `mink_conversations`. A store under a legal hold waits: its pictures are marked but not deleted until the hold is released, then go on the next run.                            |
| `content_block_archives`         | 180 days, by `keep_until`         | IT Rules 3(1)(g): what StoreMink removes, with its records, is kept 180 days, or longer when a court or an authority asks (a later date or a legal hold). The archive's files are deleted from the private bucket and the row emptied, keeping its fingerprint. Never a held archive, one of a held store, one whose block is restoring a file, one still being copied, or a file of another environment's database. Batch 20. |
| `moderation_events`              | 3 years (1095 days)               | The record of every takedown action (decision D3), through `moderation_prune_events`, never while its store is held or its archive is kept.                                                                                                                                                                                                                                                                                    |
| `grievance_complaints`           | 3 years after it was resolved     | A complainant's name, contact, reference, addresses and words, and the outcome note, are erased (not deleted); the dates, kind, outcome and blocks stay. Never a held store's, a hold's complaint or one whose block's archive is on legal hold. Batch 500.                                                                                                                                                                    |
| `content_blocks`                 | 3 years after the lift            | A lifted block's item name, address, legal basis, message and lift note, and its conversation's words and senders, are erased ("Erased"); what was blocked, when, why and by whom stays. Never a held store's, a hold's complaint's, or one whose archive is held or not yet purged. Batch 200.                                                                                                                                |
| `mink_attachments_legacy`        | temporary, last entry             | Not a window: the job that sorts pictures attached before they were stored privately (public `media_assets` rows with source `mink_attachment`). One the store still uses is kept as an ordinary upload, one only a live chat uses moves to the private bucket with that chat, one nothing uses is deleted. Batch 25. Removed once production has nothing left for a week (owner step P5).                                     |

For `mink_attachments`, `deleted` counts the rows each batch CLAIMED: deleted,
or kept for a retry because their object would not delete. Each batch first
marks pictures never sent for 2 days, pictures whose chat row was deleted
without the mark (at once, no 2-day wait) and pictures whose chat is no longer
active, then claims up to a batch of marked rows by writing a 15-minute lease
into `purge_failed_at`, so a claimed row is out of every other purge (a retried
sweep, or the purge that runs after a merchant deletes a chat) for exactly 15
minutes, and a run that dies after claiming leaves its rows for a purge 15
minutes later. The log line `mink.attachments: purge batch` gives marked,
claimed, deleted, failed and foreign per batch (and `storeId` for the purge
after a merchant's delete, which runs up to five batches of 20 within 10
seconds and never fails the request). A picture whose object could not be
deleted keeps its row, is stamped `purge_failed_at` and is tried again after 7
days. `foreign` counts rows whose path names another database: the row goes and
the object is left for the database that wrote it.

For `mink_attachments_legacy`, `deleted` counts pictures handled (kept, moved,
deleted, missing or failed), and the line `mink.attachments: legacy batch`
gives kept, moved, deleted, missing, failed, left, givenUp and held. It runs
only against `storemink` and `storemink_staging` with the private bucket set;
anywhere else it logs one warning (`mink.attachments: legacy move skipped`)
and does nothing. It runs last and shares the run's 240-second budget: it
starts no picture within 20 seconds of the deadline, stops its batch and
reports the table as `budget` (so `incomplete: true`, a 200), and with less
than that left when its turn comes it reads nothing and writes no batch line;
the rest waits for the next night. Per picture it may also log
`legacy picture waits` (tried the next night: a chat with a reply running,
which does not count toward giving up, a chat locked or no longer live, or a
public object that would not delete), `legacy picture failed`,
`legacy picture changed underneath` (another run or a delete took the row
first), `legacy failure not recorded` (the picture is left out for the rest of
the run) and, for a private copy it could not judge,
`legacy private copy kept, row check failed` or
`legacy leftover check failed`. `held` counts pictures of a store under a
legal hold, which the job never claims while the hold lasts (they go on the
first run after it is released). A picture given up on before its store was
held counts in both `givenUp` and `held`, so while such a store is held the sum
can read more than `left`. Owner step P5 reads the batch line in
production: once `left` equals `givenUp + held` for a week, delete
`lib/mink/attachments-legacy.ts`, its unit and local tests, the retention entry
and the `mink_attachment_legacy_log` table (a later contract migration). Every
outcome is recorded in that table with its public path, so a mistaken deletion
can be restored from the bucket's soft delete (7 days, owner step P9).

The four takedown entries run in this order, before the legacy job: archives
first (a purged archive is what lets a lifted block's words go), then the
record, then complainants' details, then lifted blocks; each skips anything a
hold covers, so a held store keeps all four. For `content_block_archives`,
`deleted` counts archives HANDLED (purged, skipped, failed or busy), so a batch
with a skip still reads as full; it reads the sweep's batch context (it stops 5
seconds before the deadline and an archive it sets aside stays aside for the
run), and `keep_until` decides what is due, not the sweep's floor. A purge
first empties the row in its transaction, then deletes the objects; a skip or a
failed delete rolls the row back. A path naming another environment's database
is never deleted and is recorded as `archive_purge_skipped`. Erasing lifted
blocks logs `moderation.retention: blocks erased`.

For `mink_conversations`, `deleted` in the response counts chats retired
(deleted or reduced), and the log line `mink.retention: batch` gives healed,
stripped, deleted, reduced, skipped and failed per batch (each batch first
moves forward the expiry of chats a revision without the 90-day rule used,
and strips redesigns nobody applied whose chat is already gone). A chat
whose retirement failed is marked and skipped for 7 days
(`mink.retention: chat not retired`, ids only).

`email_logs.sql` documented the 90-day intent and even carries an
`email_logs_created_idx` built "for retention sweeps". `pruneNotifications` had
the right windows and a docstring saying it was "called by the daily cron".
**Nothing called it** — a grep returned the definition and nothing else. So
every one of these tables had grown unbounded since the day it was created.

That function has been deleted, not wired up, because it was also a live
security hole: it sat in `app/actions/notification-actions.ts`, a `"use server"`
file where **every export is a publicly reachable endpoint**, with no gate of
any kind, running under `withService` (which bypasses RLS), taking its retention
windows as _parameters_. An unauthenticated caller passing zeroes would have
deleted every notification, every email log and the whole of `activity_events`
— the append-only audit trail — for every store on the platform. The windows and
the sweep now live in `lib/retention/prune.ts`, which is not a `"use server"`
file, and the cron route is the gate (CODEBASE.md §30 applies the same rule to
`lib/domains/reconcile.ts`).

Behaviour worth knowing before you read a response:

- **It deletes in batches of 1000 (fifty for heavy image checkpoints), each its own transaction**, so it never holds
  one enormous lock and a run that dies half way is resumable — the committed
  batches stay deleted and the next night carries on.
- **It stops itself** at 50,000 rows per table or 240 seconds, whichever comes
  first, and reports `stop` per table (`drained` / `cap` / `budget` / `error`).
  A first sweep over a long backlog will legitimately report `cap` for a few
  nights; `incomplete: true` in the body says so.
- **`incomplete` is a 200, a failed table is a 503.** A draining backlog is
  normal and must not turn the job permanently red (the `domain-reconcile`
  lesson); an actual failure should engage Scheduler's retries (the
  `seo-refresh` contract). One table failing never stops the next.
- Pruning `activity_events` cascades to any surviving `notifications`
  (`notifications.event_id` is `ON DELETE CASCADE`), which is why notifications
  are swept first and at the shorter window. **Financial records — orders,
  refunds, credit notes — live in their own tables and are never touched.**

> **`data_jobs` and `data_job_issues` are swept too** (90 days each), with the
> same shape and the same unbounded growth: `ISSUE_CAP` bounds issues per job,
> but nothing else bounds the number of jobs. Their two `RETENTION_POLICIES`
> entries (`lib/retention/prune.ts`) run **issues before jobs**, because
> `data_job_issues.job_id` is `ON DELETE CASCADE` from `data_jobs`, the same
> shape as notifications→events.
>
> Both tables' `(store_id, created_at)` composite indexes cannot serve a sweep
> that filters on `created_at` **alone**, so each has a plain `created_at`
> index in its own file, `retention_01_prune_indexes.sql` (an
> applied `CREATE TABLE IF NOT EXISTS` file is never edited). Without it the
> sweep works but seq-scans, which is precisely the cost that matters once
> the table is big enough to need pruning. (Until 2026-10-25 this note said
> they were not swept yet, long after both entries were added.)

## Verifying

Trigger one by hand and confirm Cloud Run answered 200 — a job can be `ENABLED`
and still be failing every night, so check the _response_, not just the state:

```bash
gcloud scheduler jobs run storemink-plan-expiry --project=storemink-prod --location=asia-south1
```

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND httpRequest.requestUrl=~"/api/cron/"' --project=storemink-prod --limit=10 --format="value(httpRequest.status,httpRequest.requestUrl)"
```

The original three were verified this way on 2026-07-30.

`storemink-seo-refresh` was created and verified on **2026-08-06** — it had never
existed, so sitemap submission had never run on a schedule. Verified by calling
the endpoint directly (`200 {"ok":true}`, the then-configured platform/help
roots registered, both eligible stores ready) after enabling the two APIs above.
The themes catalog joined that same retry-backed root registration in Phase 4;
the response names each root so a rejected themes sitemap is visible rather
than an ambiguous array position.

### ★★ The fleet diff — run this, do not read the table

Three times a job has been documented here and absent from Cloud Scheduler, and
every time it was found by DIFFING, never by re-reading this file. So the diff
is a command rather than an instruction:

```bash
diff <(grep -oE 'storemink-[a-z-]+' docs/cron-jobs.md | grep -v storemink-prod | sort -u) <(gcloud scheduler jobs list --project=storemink-prod --location=asia-south1 --format='value(name.basename())' | sort -u)
```

Lines with `<` are **documented and do not exist** — the failure this file keeps
recording. Lines with `>` exist and are undocumented, which is the same drift
pointed the other way.

⚠ It needs interactive `gcloud auth login`; Application Default Credentials
(what the Cloud SQL proxy uses) are NOT enough, so this cannot be automated into
CI as it stands.

Schedules drift too, and the diff above only compares NAMES. To compare cadence:

```bash
gcloud scheduler jobs list --project=storemink-prod --location=asia-south1 \
  --format='table(name.basename(),schedule)'
```

`storemink-domain-reconcile` was created on **2026-08-06** alongside the fix it
backs. Its route ships in the same change, so verify its **response** once that
reaches production — the job authenticates (its baked-in header matches the
current `CRON_SECRET`) but will 404 until the deploy lands.

`storemink-prune-logs` and `storemink-import-worker` were created on
**2026-08-11**. Both had been listed in this file as though they existed and were
absent from Cloud Scheduler in **every** region — the failure this file records,
for the **third** time. Found by diffing the documented list against
`gcloud scheduler jobs list` rather than by reading the file, which is the only
method that has ever caught it.

Verified by triggering `storemink-import-worker` by hand: Cloud Run answered
**200** to `Google-Cloud-Scheduler`, which also proves the baked-in header
matches the current `CRON_SECRET` — and since all jobs share that secret, it
clears the auth path for every one of them. `import-worker` was chosen for the
probe deliberately: with no queued import it is a no-op, whereas triggering
`prune-logs` deletes rows.

⚠ `prune-logs` has NOT been triggered by hand — its first run is its scheduled
03:00 UTC one. Expect `{"ok":true,...}` with a large first `deleted` count and
possibly `"incomplete":true` for a few nights while the backlog drains, since
retention has never run.

`storemink-billing` was created and verified on **2026-08-13**. Triggered by
hand: Cloud Run answered **200** to `Google-Cloud-Scheduler`, which also
re-confirms the shared `CRON_SECRET`. Safe to probe because
`billing_subscriptions` was empty, so all three passes were no-ops.

It was deliberately withheld until then, on the reasoning that it "would report
green hourly while charging nobody" — true while the whole collection pass was
skipped for a missing gateway. Since the issuance/charging split it always
**issues** each renewal invoice, which the merchant can pay by hand, so it does
real work independently of autopay. Automatic collection was enabled for
verification on 2026-08-16; the same job now attempts eligible mandate debits
when platform credentials exist.

⚠ **Watch its first real run**, which is the first hour after a merchant
subscribes — that is when pass 1 stops being a no-op. For an eligible active
mandate expect an automatic attempt; otherwise expect `collect.manualRequired`
and a renewal email. `collectionSkipped` should appear only when credentials or
the charge function are unavailable.

## Staging

Staging has no scheduled jobs, deliberately — `SEARCH_INDEXABLE` keeps it out of
search, and a staging cron sending real email or cancelling real orders is a
liability, not a test. Exercise a cron route on staging by curling it with that
environment's `CRON_SECRET`.

## If you rotate `CRON_SECRET`

The header is baked into each job at creation. Rotating the secret without
updating the jobs makes every configured job start returning 401 — silently,
because a failing cron looks identical to one that had nothing to do. Use the
coordinated rotation procedure above, then re-verify with the logging query.
