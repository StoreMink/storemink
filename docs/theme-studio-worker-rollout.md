# Theme Studio worker isolation and validation

Status: implemented locally on 4 October 2026; deployment, scheduler routing and
a fresh complete-theme benchmark are still required. The baseline production
batch produced 5/8 candidates with a 68.28-minute successful median. These
changes do not establish a new completion-time or production-readiness result.
The private workers are deployed (production only, one instance each since
17 October) but unrouted: theme work still runs inside the web service, and
routing waits for decision 9 after the Theme Studio release (plan P1 and
P9). The Theme Studio release (TS-3, 25 October) changes what each request
does (below) and the release order (capture job first).

## Runtime changes

Generation/image runs and visual QA use 180-second leases renewed every 30
seconds. Renewal requires the same running owner and an unexpired lease using
the database wall clock. A failed renewal or an independent expiry watchdog
aborts provider work. Claim time and renewal request time count against the
watchdog; a delayed successful response cannot revive an aborted owner.
Settlement still requires the current unexpired owner. A crashed worker becomes
eligible for reclamation after its last three-minute renewal, plus scheduler
and capacity wait. Existing paid response/image checkpoints are reused;
provider completion before checkpoint commit can still cause a repeated call.

The generation route drains eligible work as a lane becomes free, bounded by
eight claims and an absolute 19-minute request budget. It reserves four minutes
before starting another claim and 15 seconds inside the run for settlement.
Full generation/manual creative revisions require ten minutes of remaining
request time; shorter remaining windows admit checkpointed image work or
focused automatic repairs. Otherwise the request returns so its schedule can
start a fresh budget, rather than repeatedly cutting full generation short.
Text deadlines requeue within the existing claim limit; the final timed-out
claim closes rather than leaving a poisoned queued row at its attempt ceiling.
Image deadlines preserve the existing checkpoint/partial-image behavior.

Since the Theme Studio release (TS-3B):

- An idle lane beside a busy one asks for work every 5 to 10 s, jittered
  (`IDLE_LANE_WAIT_MS`); it was every second, about two transactions a
  second for up to 19 minutes.
- A FRESH photo run needs 9 minutes of the request left
  (`FRESH_PHOTO_RUN_MIN_MS`); one already started continues with less. A
  photo run cut by the request's deadline goes back to the queue as it is
  (no crash attempt spent) and the next request replays its saved draws and
  checks, up to 3 times (`PHOTO_RUN_CONTINUATIONS`); a later cut settles
  what it has and the fill rounds finish it.
- Automatic repairs are claimed before any other work (a repair takes 3 to
  23 s of model time but waited a median 117 s on 4 October).
- Theme Studio's text calls queue on their own capacity row
  (`theme-studio-text`) and the design review on its own
  (`theme-studio-review`), so neither holds a permit a photo check needs.
- A text call that fails as `provider_unavailable` is waited out twice and
  one that fails as `provider_timeout` once (about 2, then 4 minutes), like
  a 429; the saved answers replay, so nothing completed is paid twice.
- The "theme studio: run settled" line carries `errorCode`, which a P6
  alert reads (`docs/monitoring.md`, alert 16).

The private topology separates model work from QA and storefront requests:

| Role              | Production service                  | HTTP request bound | Independent schedules                                             |
| ----------------- | ----------------------------------- | ------------------ | ----------------------------------------------------------------- |
| Generation/images | `storemink-theme-studio-model-prod` | 1,200 seconds      | `storemink-theme-studio-runs`, `storemink-theme-studio-runs-peer` |
| Visual QA         | `storemink-theme-studio-qa-prod`    | 300 seconds        | `storemink-theme-studio-qa`, `storemink-theme-studio-qa-peer`     |

There are no dev workers. Themes are built on production only, so the two dev
services were deleted on 2026-10-17 and Cloud Build deploys workers for
`storemink-web-prod` alone. Each service has 2 GiB memory, two CPUs, request
concurrency one, maximum ONE instance (two until 2026-10-17) and minimum zero:
every worker instance counts against the asia-south1 Cloud Run quota of 40 GiB
and 20 vCPU for the whole project, which `storemink-web-prod` shares, and
Theme Studio is a staff-only tool. One lane runs in each private request. The
two "-peer" schedules in the table were meant to start a second request while
the first is busy, but with one instance at request concurrency one Cloud
Run refuses that second request with HTTP 429; it does not queue it. So the
peers add nothing, and routing (plan P1, after the release) drops them: do
not create them. Every paid call remains awaited. The public web endpoint retains its
two draining lanes and QA fallback until routing is changed.

Each worker pool has one database connection with a five-second acquisition
timeout, 30-second statement timeout and 60-second idle-transaction timeout.
One connection is enough only because no transaction is held through a
model call and none is opened inside another: on a pool of one the inner
transaction waits the five seconds and fails as busy. Until 25 October the
photo check before a design review did exactly that (it held a transaction
while each photo's claim opened its own), so on the QA worker no unchecked
photo could ever be claimed and the theme would end as could not finish
after 20 minutes of "Checking pictures". It now opens its transactions one
at a time, and `lib/theme-studio/photo-check-pool-postgres.test.ts` runs that
path on a pool of one (`THEME_STUDIO_RECOVERY_DB_TEST=1`, local database).
Check that it passes before routing (plan P1, step A8).
Sharp uses one decoder thread and a 16 MiB cache on private workers only. The
web's Sharp settings are unchanged; since 2026-10-23 the web pool has the same
three database limits (`lib/db/client.ts`), and every process holds one pool.
Worker logs include settled-run
RSS; a memory ceiling is not proof that peak memory remains below it.

## Release and capacity gate

Cloud Build updates the Chromium capture job, then deploys both private
services from the **serving web image digest** (capture first since the Theme
Studio release, plan P4, so a refused worker deploy cannot leave the capture
job on old code). Workers use the web's acceptance build ID:
`THEME_STUDIO_BUILD_ID`, which Cloud Build sets to the commit (plan P3), or
the web's serving revision when it is empty (a manual build); their own
revision names must not invalidate screenshots taken on the web service. Only Studio/DB
configuration and required secret references are copied. Payment credentials
and database administrator credentials are excluded.

Normal CI uses the existing Cloud Run deployment permissions. First scheduler
routing additionally needs Scheduler administration, service-account act-as,
and access to the application `CRON_SECRET`. Cloud Run requires authenticated
invocation; the script refuses public IAM bindings. Scheduler supplies OIDC
with the service URL as audience, and the application secret in
`X-Theme-Studio-Secret`. That header is accepted only when
`THEME_STUDIO_WORKER_ONLY=true`; public routes still require the existing bearer
secret. Secret values are not printed or placed in CLI arguments.

**Check the shared database before routing.** Cloud Run configuration read on
17 October showed prod maximum 4 instances × pool 5, and dev maximum 2 × pool 3
(both web services use the one Cloud SQL instance). The production workers add
at most two connections (two roles × one instance × one connection): 28
application connections at steady state. Revision-level instance ceilings
permit old/new pools during deployment, so routing conservatively budgets
56 connections for overlap plus five spare for administration and other jobs
(61 with the current settings). Cloud SQL is currently `db-f1-micro`;
the actual `SHOW max_connections` value was not verified because the existing
local proxy reset its connection. Do not infer headroom from idle traffic or
the tier name. Verify the SQL limit and tune aggregate service/pool capacity
or database resources first. This implementation changes neither SQL tier nor
merchant web capacity.

After the coordinated web/worker/capture deployment succeeds, inspect the plan:

```bash
python3 -B scripts/theme-studio-workers.py --plan --web=storemink-web-prod --project=storemink-prod
```

Then route the two existing schedules. ⚠ Today the script also adds their
peers, which at one instance only collect HTTP 429s (above); plan P1 removes
that step before any routing, which in any case waits for decision 9 after
the Theme Studio release:

```bash
python3 -B scripts/theme-studio-workers.py --route-schedulers --web=storemink-web-prod --project=storemink-prod --max-db-connections=<verified-SQL-limit>
```

There is no dev equivalent: the script refuses `--web=storemink-web-dev`. Routing refuses an
insufficient combined connection budget, a stale worker image/build/role or a
split worker rollout. Both roles are validated before moving any schedule.
Confirm each schedule is enabled, targets the correct
private URL and answers a scheduled empty-queue request successfully. Observe
first real claims on both roles. Once routing is active the web's
design-review route refuses, and the capture job's wake (which knows only
`APP_ORIGIN`, storemink.com) must reach the review worker instead, or the
worker's minute schedule drains it (plan P1). Private service deployment
alone does not move existing schedules off the storefront service.

If reverting routing, remove any peer jobs and restore the original
schedules' web URLs and bearer authentication through a secret-safe flags file.
The web fallback remains available; leases/checkpoints prevent two owners from
settling the same work. Do not expose the private services publicly.

## Evidence and quality changes

Capture preserves full-page phone width and limits screenshot width to 1440px,
without the old 4096px height cap. Migration `20261004_0154` allows tall QA
sources up to 50 million pixels; non-QA artwork retains its original dimension
and WebP rules. Sources above WebP's 16,383px dimension limit use PNG storage,
with the existing 10 MiB asset limit; review attachments remain small WebPs.
Apply the migration through the normal release before using the new capture
code. QA loads and decodes one source at a time.
Five layout overview sheets remain; separate native-width top/middle/footer
strips for each page at phone390 and desktop1440 make prices and copy readable.
Six surfaces produce up to 17 screenshot attachments, plus actual artwork
requiring explicit assessment. Grey strip separators are labelled as capture
boundaries. This increases review evidence; latency and peak memory must be
measured in the new live batch.

Visual prompt v4 receives the original brief and requires concrete assessments
for every current generated image whose exact SHA has a flagged or missing
review in version ancestry. A missing/duplicate assessment or an unapproved
image with no specific redraw repair invalidates the verdict. Owned/licensed
art is preserved. The reviewer can approve a historical style flag only after
seeing the actual artwork and supplying a reason. Duplicate full newsletter
modules and unsupported factual claims are explicit review defects. Visual
judgment remains model-based and requires human spot checks of known bad cases.

The browser probe retains actual contrast ratios and required thresholds.
Measured deficit improvement above 10%, without worsening another measured
pattern, can justify the next bounded repair even when the same selectors
still fail. Acceptance still requires the full threshold. Legacy evidence
without measurements cannot earn ratio-based progress. Shared renderer fixes
pair discount badge backgrounds/foregrounds, compare prices and mobile market
delivery controls correctly in light and dark themes.

## Complete-theme validation after deployment

Local validation passed 594 focused tests and six rollback-only PostgreSQL
regressions, including lease ownership, checkpoint recovery and tall screenshot
storage. Nine offline deployment checks cover private/build/resource binding,
database headroom and refusal to route one role if the other is stale. The
browser renderer passed 607 cases; ten light/dark contrast fixtures passed with
three broken negative controls. Type checking, changed-code ESLint, migration
lint and Help lint also passed.

The reproducible synthetic evidence profile uses thirty sources at five widths,
26,000–32,000 pixels tall, with sequential decoding and private Sharp settings:

```bash
NODE_OPTIONS=--max-old-space-size=768 UV_THREADPOOL_SIZE=2 node --import tsx scripts/theme-studio-visual-evidence-check.mts
```

Two local runs produced all seventeen attachments in 4.24–9.31 seconds, with
process peaks of 310–446 MiB including fixture construction. Synthetic copy,
shared source fixtures and local hardware make this a mechanism check; it is
not a production memory, timing or visual-quality result.

Run eight fresh unpublished themes through normal intake, at most two
unfinished at a time:

```bash
npm run theme-studio:benchmark -- --create --actor-id=<superadmin-UUID> --yes --repeats=2 --concurrency=2 --wait-minutes=120 --out=/tmp/theme-studio-isolated-benchmark.json
```

The 120-minute bound applies to the entire creation batch. IDs are saved before
queueing; completed reports are saved while waiting. Timeout stops additional
creation without cancelling paid work. Resume observation with the saved IDs:

```bash
npm run theme-studio:benchmark -- --projects=<saved-UUIDs> --wait-minutes=120 --out=/tmp/theme-studio-isolated-benchmark.json
```

Compare candidates, initial first-pass quality, generation/image/capture/QA
queue waits, total time, attempts, revisions, spend, 429s, RSS peaks and OOM/503
events against the saved baseline. Report unqueued cases as incomplete. Inspect
home/shop/product/cart/content at five widths, including menu/delivery controls,
cart interactions, repeated signup modules and actual flagged images. Do not
publish or submit orders during the benchmark.

Require 8/8 current-build candidates, zero false quality passes, zero OOMs,
bounded recovery without duplicate settlements, and materially shorter queue
waits and total times before claiming this batch passes. Repeat a second fresh
batch and controlled worker interruption/provider-cooldown cases before
making a production-readiness claim. Local tests prove mechanisms; they do not
prove live visual quality or latency. Reference fidelity and the strict variety
exit criteria remain separate unfinished tracks.

⚠ Since the Theme Studio plan of 24 Oct, every live run is in production (dev
builds no themes: no schedules, no workers, Theme Studio off) and needs the
owner's OK. Until routing (P9), build one theme at a time outside shopper
peaks (P10); the first live runs are plan P7 (one Check again on an existing
theme) and P8 (one theme at a quiet hour, then two at once), which also
measure the three capture contexts, the 9-minute photo floor, the deadline
continuations and the provider waits.

No merchant-visible workflow change, no Help Centre update. One forward-only
asset-constraint migration is included.
