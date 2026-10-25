# Theme Studio capture job (Track 3.6)

> **Deployment status (2026-10-01):** deployed and scheduled in dev and
> production. `storemink-theme-studio-capture-dev` targets
> `https://dev.storemink.com`; `storemink-theme-studio-capture` targets
> `https://storemink.com`. Both schedules run every minute (shortened from five
> on 2026-10-01), both jobs run the image built from merge commit `621ee75`,
> both web services have capture and automatic QA enabled, and the first
> one-minute executions completed successfully.
>
> **2026-10-10:** those schedules were 97% of the Cloud Run bill. The web app
> now starts the job only when a capture is waiting; see
> [Start it on demand instead](#start-it-on-demand-instead-2026-10-10) for the
> permission, deploy and pause steps. Dev has no schedules at all and Theme
> Studio is switched off there (owner decision; themes are never built on dev,
> see `docs/gcp-ci-cd.md`).
>
> **Today (Theme Studio release, 25 Oct 2026):** production's schedule is
> PAUSED (since 2026-10-10, checked 2026-10-11). The web app starts the job
> right after a capture is queued, and the minute ticks of the runs and QA
> routes start it for any capture still waiting (the safety net). Cloud Build
> updates production's job only, before the private workers (plan P4); the
> dev job (`storemink-theme-studio-capture-dev`) is no longer updated and
> waits to be deleted (step A6, with the owner's OK). When its captures are
> done the job wakes the design-review route (below).

Publication needs a theme's catalog card and two screenshots, and an image
model cannot draw them: they are pictures of the storefront itself. The
capture job opens a version's private preview store in headless Chromium,
photographs its home page at the card, desktop and phone sizes, and posts the
pictures back to the web app, which saves them as a new version.

Since TS-2 (25 Oct 2026) there is no capture button: every final check takes
the catalogue pictures, and the theme page's Pictures tab only shows them. An
operator starts this job with **Check again** (the theme page's main button
where it is offered, and the Checks tab). Automatic QA first uses this job for
a layout preflight before image generation, then returns for final acceptance
after artwork. Since 24 Oct 2026 (TS-1E), with automatic checks on, every
capture an operator queues is automatic (the "Capture catalog pictures" button
of that time made a hidden version that went through the full checks and the
design review at the repair ceiling, never a paid restyle). **Check again**,
Make current and Publish on evidence from an earlier build use this job too: a
re-check measures the current version on today's build, in place for a version
that passed before (no new pictures, no new version).

The server action remains fail-closed until the web service has
`THEME_STUDIO_CAPTURE_ENABLED=true`. Deploy the job and scheduler first, then
set the corresponding `_THEME_STUDIO_CAPTURE_ENABLED` Cloud Build substitution
to `true` for that environment and deploy the web service. Never enable the
flag while either worker component is absent.

The automatic checks are a second, stricter switch. Set
`THEME_STUDIO_AUTO_QA_ENABLED=true` (Cloud Build substitution
`_THEME_STUDIO_AUTO_QA_ENABLED`) only after capture is enabled and the long
Theme Studio model worker is deployed. The runtime treats auto QA as disabled
unless capture is enabled too.

**Automatic acceptance rollout (2026-10-01, not yet deployed):** deploy the
updated web service and rebuild this job together; automatic claims now include
`qa.buildId`, which the job must return. Old job responses are retried and cannot
mark a theme ready. Enable the separate one-minute QA scheduler described in
`docs/cron-jobs.md`. Change the capture scheduler to once per minute after the
new image is deployed; the five-minute schedules above describe the previous
verified deployment. Overlapping executions claim different leased rows.

## How it fits together

```
operator ── queue ──▶ web app (theme_studio_captures, project → generating)
                         ▲            │
            claim / finish (CRON_SECRET, /api/internal/theme-studio/captures)
                         │            ▼
                 capture job (Cloud Run job, headless Chromium)
                         │
                         └── opens https://studio-preview-….<domain>/ with a
                             capture cookie good only while THAT capture runs
```

- The web app owns every decision: which capture runs next, the preview store,
  the shots and sizes, and whether the pictures are usable. The job knows only
  a capture id, a lease token, an origin, a cookie and the shots to take.
  Automatic claims also provide the package digest, build and complete QA plan.
  The job records navigation/probe/screenshot timings and returns bounded initial
  server HTML from that same claim, allowing acceptance to check markup and links
  without fetching the measured routes twice. Redirected/oversized responses and
  older jobs keep the fresh server-fetch path. There is no cache between captures.
- The capture cookie (`sm_studio_capture`) is signed like the preview grant
  and accepted by the preview gate only while its capture is `running` with an
  unexpired lease, for exactly that version (`lib/theme-studio/preview-access.ts`).
- A manual capture (only with the automatic checks off) holds the current
  version. An automatic capture is bound to an internal version, an operator's
  explicit retry of a failed current version, or the current version itself
  for a re-check (its key starts `recheck_`, as a deploy re-capture's starts
  `auto_recapture_`), and keeps the project generating until the design
  review settles. **Stop** in the workspace fails a queued or running capture
  at once (stop code `cancelled`); the job's late answer is refused (409).
- A reported error is retried with a fresh browser after every browser failure;
  automatic captures get up to five attempts and manual captures keep the
  database default of two. A lease that lapses is claimed again while attempts
  remain; after the final attempt the capture fails and the project returns to
  `ready`. The workspace identifies this as a capture failure so it is not
  confused with a visual-quality verdict.
- Since the Theme Studio release (owner, 24 Oct 2026), an error a retry
  cannot fix fails at once (`captureErrorKind`, `lib/theme-studio/capture-core.ts`):
  - deterministic, failed on its first report: a screenshot over 512 KB
    (`qa_screenshot_too_large`), a report or screenshot set the server
    refuses (`qa_report_invalid`, `qa_screenshots_invalid`,
    `qa_screenshot_unusable`, `capture_unusable`), and a job too old to
    report its build (`capture_job_outdated`);
  - transient, every try kept: `capture_timeout`, `qa_measure_timeout`,
    `capture_network`, `acceptance_route_fetch`, `capture_build_changed`,
    and a 429 or 5xx;
  - anything else fails when the same code comes back on two tries in a
    row. That includes one of our own preview pages answering 404 or
    another 4xx (`preview_status_<code>`): a preview answers 404 while the
    database is briefly out of reach too (the preview gate and the store
    lookup fail closed, and the storefront layout then answers not found),
    for example when one of the web's 5 pooled connections does not come
    free within 5 s. So a 404 is tried again, and the same 404 on the next
    try fails the capture.

  The job's error body names the preview page a status error came from
  (`failedSurface`), which the failed try's log line carries (`surface`);
  the finish route answers a malformed picture, QA report or screenshot
  under its lease as that try's error, instead of a bare 400 that left the
  lease to lapse. Each failed try logs `theme_studio.capture_attempt_failed`
  (WARNING), and the theme reads "Couldn't finish the checks" with Check
  again.

## Build

The image is Node 24 with Debian's Chromium and the Noto fonts
(`jobs/theme-studio-capture/Dockerfile`). Build from its own folder:

```bash
gcloud builds submit jobs/theme-studio-capture \
  --project storemink-prod \
  --tag asia-south1-docker.pkg.dev/storemink-prod/storemink/theme-studio-capture:latest
```

## Deploy the job

**Since 2026-10-04 Cloud Build does this on every web deploy** (`capture-build`
and `capture-deploy` in `cloudbuild.yaml`): the image is built from this folder,
tagged like the web image (`theme-studio-capture:prod` / `:dev`), and
production's job is pointed at it by digest with `gcloud run jobs update`,
which changes only the image, right after the web deploy and before the
private workers (plan P4). Since the Theme Studio release the dev build only
builds the image: it no longer updates `storemink-theme-studio-capture-dev`,
which waits to be deleted (step A6, with the owner's OK). The job takes the
build to measure from each claim, which binds it to the commit (plan P3,
`THEME_STUDIO_BUILD_ID`). The commands below remain for creating a job or
changing its settings. Before this, the job was deployed by hand and drifted:
production ran a 1 Oct image against 3 Oct code until a manual redeploy on
2026-10-04 (`sha256:fb1212e2…`).

```bash
gcloud run jobs deploy storemink-theme-studio-capture \
  --project storemink-prod --region asia-south1 \
  --image asia-south1-docker.pkg.dev/storemink-prod/storemink/theme-studio-capture:latest \
  --service-account storemink-run@storemink-prod.iam.gserviceaccount.com \
  --memory 2Gi --cpu 2 --task-timeout 600 --max-retries 0 \
  --set-env-vars APP_ORIGIN=https://storemink.com \
  --set-secrets CRON_SECRET=CRON_SECRET:latest
```

- `APP_ORIGIN` is the web app the job claims from, and the origin of the
  design-review route it wakes (`https://storemink.com` reaches both); the
  preview origin comes back in each claim, so the job needs no other
  address. There is no dev job to configure: themes are built in
  production only.
- `--max-retries 0`: a failed execution is simply the next scheduled one.
- 2 GiB: Chromium rendering a 3× phone page needs more than the default.

## Schedule it

**Paused since 2026-10-10; keep it paused.** The job is started on demand
(next section). This command is kept for re-creating the schedule as a
fallback only.

```bash
gcloud scheduler jobs create http storemink-theme-studio-capture \
  --project storemink-prod --location asia-south1 \
  --schedule "* * * * *" --time-zone Etc/UTC \
  --uri "https://asia-south1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/storemink-prod/jobs/storemink-theme-studio-capture:run" \
  --http-method POST \
  --oauth-service-account-email <scheduler-invoker>@storemink-prod.iam.gserviceaccount.com
```

The invoker needs `roles/run.invoker` on the job. An execution with nothing
queued exits in a few seconds, **but it is billed for a full minute**: a Cloud
Run job is charged a one-minute minimum per execution.

For an existing schedule, use `gcloud scheduler jobs update http` with the
same job name and `--schedule "* * * * *"` (and the location/project above).
There is no dev schedule and none is to be created (owner, 2026-10-10).

## Start it on demand instead (2026-10-10)

The two every-minute schedules were 97% of Cloud Run's bill: "Jobs CPU" and
"Jobs Memory" came to ₹5,819 of ₹5,972 for 1–10 October 2026, which is
2,880 one-minute executions of 2 vCPU / 2 GiB a day, nearly all of them idle.
Since that deploy, the per-minute Theme Studio QA and runs routes start the job
only when a capture is claimable (`lib/theme-studio/capture-start.ts`), so the
job's own schedule is no longer needed. Rolled out in this order (all four
steps done by 2026-10-11, except that no capture had been queued to see
step 3's line); keep the order if it is ever repeated, or captures stop:

1. Let the runtime service account start the job (the loop below also
   covered the dev job, which waits to be deleted, step A6):

   ```bash
   for job in storemink-theme-studio-capture storemink-theme-studio-capture-dev; do
     gcloud run jobs add-iam-policy-binding "$job" \
       --project storemink-prod --region asia-south1 \
       --member serviceAccount:storemink-run@storemink-prod.iam.gserviceaccount.com \
       --role roles/run.invoker
   done
   ```

2. Deploy the web service (merge to `dev` / `main`).
3. Queue one capture and check Cloud Logging for
   `theme_studio.capture_job_started` (a refusal logs
   `theme_studio.capture_job_start_failed` with the HTTP status; 403 means
   step 1 is missing).
4. Pause the production schedule. `resume` brings it back as a fallback.
   Dev has no schedule at all (owner decision, 2026-10-10).

   ```bash
   gcloud scheduler jobs pause storemink-theme-studio-capture \
     --project storemink-prod --location asia-south1
   ```

Since the Theme Studio release (TS-3A) a capture starts the job right after
it is queued: the code that queued it calls `startCaptureJobForQueued` once
its own transaction commits, or `startCaptureJobAfterCommit`, which waits
(about 16 s at most) for a caller's transaction to commit. The next QA or
runs call is the safety net, and one start per 90 s per job is still the
limit. Failed attempts and lapsed leases start the job at those calls. A
capture nobody takes within 15 minutes (queued that long since it was queued
or sent back, or running on a lease that lapsed 15 minutes ago) is failed as
`capture_not_started` by the same per-minute call, which logs
`theme_studio.capture_stale`; the theme returns to Ready, and Check again
starts a fresh one (TS-1E, 24 Oct 2026). (A capture still waiting after 6
hours also stops starting the job; the 15-minute rule now reaches it first.)

For an automatic claim the same execution also visits every available home,
shop, product, cart, content and not-found surface at 360, 390, 768, 1024 and
1440 px. It returns raw layout/accessibility/performance measurements and a
compressed full-page screenshot for each pair in final mode. Layout preflight
(`qa.phase=layout`) measures the same pairs but returns empty `images` and
`screenshots` arrays. It creates no catalog snapshot, acceptance row or visual
model call, and cannot make a candidate. Planned placeholder ratios permit crop
checks before artwork. The web app validates and
stores that evidence; the browser job never decides pass or fail. Three
isolated viewport contexts run concurrently since the Theme Studio release
(`MAX_QA_CONTEXTS`; two before, which peaked at 24% of the job's 2 GiB on
4 Oct; the first production theme measures three), preserving the original
page/sample order.
The finish endpoint uses the still-valid capture cookie to run shared server
acceptance checks, then binds all gates and evidence to the final version after
its catalog images are saved. Expected coverage comes from the package, not the
submitted samples. Its saved report appears under **Checks** automatically.
Only a check run with no serious finding left (`severity-v1`) plus a passed
design review reveals a successful candidate (Ready to publish); warnings are
kept with it. Theme failures enter the bounded three-repair loop; runtime failures
stop with recovery information, and transient route fetch failures retry capture.

**The job wakes the design review (Theme Studio release, TS-3A).** The web
app settles a layout check inside the capture's finish (it needs no model
call), and a finish that leaves a design review queued says so
(`designReview: "waiting"`: every automatic final capture, and a layout
check left queued). When its captures are done, the job POSTs
`/api/internal/theme-studio/qa` with the same `Bearer CRON_SECRET` headers
and waits for the answer, at most 300 s (`WAKE_TIMEOUT_MS`, the route's own
limit) and never past its budget less a 10 s margin; with under 60 s left
(`MIN_WAKE_MS`) it skips the wake. It does the same when it stops at its
capture limit or budget, since that route starts the job again for any
capture still waiting. The review's paid work runs inside that web request,
never in the job, and at most 2 design reviews run at once across the
platform. The job logs `design review wake: HTTP <status>`,
`design review wake failed: <code>` or
`design review wake skipped: too little time left`, and never fails for
it: a review it could not wake waits for the minute
schedule. The 600-second task timeout still bounds the whole execution.

The expected response is 200 except for the deliberate `not_found` surface,
which must return 404. The job waits up to 20 seconds for the hydrated QA
probe and 45 seconds per measurement. The probe handles SVG icons without
calling HTML-only text APIs. It waits for fonts/images itself, so automatic
QA does not also pay a 15-second network-idle wait on every sample.

Browser launch and capture work are bounded to five minutes or the execution's
remaining budget minus the finish timeout. The default budget is 570 seconds
(the 600-second task timeout less 30 seconds for claims and shutdown). Claims
have a 60-second timeout; finish has a 270-second timeout. Cloud Run does not
cut the finish request off (`maxDuration` is not enforced self-hosted and the
service timeout is 1200 seconds), so this wait is the bound server acceptance
is sized against, and it is generous enough that a healthy finish is not
abandoned mid-commit.
A new claim starts only when at least three minutes of browser time remain;
starting one with less would only burn an attempt on a certain timeout. Leases
still expire at ten minutes. Server route checks use bounded two-page batches,
the normal 90-second first-page and 45-second page timeouts, and a 150-second
total budget (a page is not started with under two seconds left). A failed
fetch (a reset or dropped connection) retries capture rather than paying for a
redesign. A page that times out (`timeout`) or a spent budget (`budget`) goes
straight to needs-attention instead, because the same slow preview would fail
the same way on every retry. A capture job too old to report its build fails at once
as `capture_job_outdated` instead of using its remaining attempts.
Browsers that arrive after their launch deadline are closed. Failed or
timed-out browsers are closed before a subsequent capture. A 409 finish (the
lease was lost) is recorded and the job continues; any other rejected finish
fails the execution for monitoring, and lease expiry/retry recovers it.

**Layout-preflight rollout (migration 0148):** rebuild and deploy this job
with the web service. Its new claim field `qa.phase` defaults older queued
captures to final behavior. An older job that returns screenshots for a layout
claim is rejected; it cannot create publication evidence. Retry failed automatic
QA after both components have been updated. Existing failed drafts retain their
artwork; only unfinished slots are generated after preflight passes.

**Deploy the capture image separately from the web service.** Web-only deploys
do not update this job's 404/readiness/timeout behavior. (Since 2026-10-04
Cloud Build does it with every production web deploy; see "Deploy the
job".) Regression evidence and the Crave/Luxe incident are in
`docs/theme-studio-reliability.md`.

**Capture profiling rollout:** rebuild this job with the web service to record
browser/catalogue/QA and per-page navigation/probe/screenshot timings in QA
reports. The new job also echoes the claim's package digest and returns bounded
initial HTML from the first viewport. The web service validates the exact build,
package and lease before reusing it for route/markup checks. Body-read failures,
redirects, oversized pages and older jobs use fresh server fetches. Browser
measurements and screenshot requirements remain mandatory. No response HTML is
stored or reused between captures. Full-theme benchmark instructions and limits
are in `docs/theme-studio-performance.md`.

## Run it locally

With the dev server running on port 3000 and the local database:

```bash
cd jobs/theme-studio-capture && npm install && cd ../..
```

```bash
APP_ORIGIN=http://localhost:3000 CAPTURE_CHROME_CHANNEL=chrome CRON_SECRET=<from .env> npm run theme-studio:capture
```

`CAPTURE_CHROME_CHANNEL=chrome` drives the machine's installed Chrome, so no
browser download is needed. Local captures hide Next's development badge.

## Checking it worked

- The theme page's Log tab shows the capture in Activity, and its Pictures tab
  shows the catalogue pictures it took ("Taken by the checks").
- The project's events include `capture_requested` then `capture_succeeded`
  (or `capture_failed` with a code; the theme page words each one, and the
  Log tab shows the code).
- `theme_studio_captures` holds the record; a finished row cannot change.
- Automatic runs additionally write `theme_studio_visual_qa_runs` and events
  `auto_qa_browser_finished`, then `auto_qa_passed`,
  `auto_qa_revision_queued` or `auto_qa_failed`.
