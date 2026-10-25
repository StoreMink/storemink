# Mink storefront redesign speed

Why a Mink storefront redesign took 48 to 72 minutes, what the owner decided
on 23 Oct 2026, what Phase 0 changed in the code, how to run the Priority
test, and what is left for Phases 1 and 2. The build contract is
`docs/mink-storefront-revamp.md`; the code map is the "Mink storefront
revamp" section of `CODEBASE.md` and its Theme Studio shared-capacity
paragraph.

Every figure below says whether it was **measured** or is an **estimate**.
The measurements come from storemink-staging (Cloud Monitoring, Service
Usage, the `mink_revamps` and `mink_revamp_images` rows of the live runs, and
two capacity samplers), read-only, plus one owner-approved paid probe of
about $2 on 23 Oct. The raw evidence (run JSON such as
`run3/runs/crumb-and-co.json`, the run logs, the Monitoring pulls and
`capacity-samples.tsv`) is kept with the owner's revamp hand-over notes,
outside this repository. A verifier re-checked 49 claims of the first
diagnosis (25 confirmed, 23 weakened, 1 refuted); the numbers here are the
corrected ones.

## In short

- Measured: crumb-and-co took 48.5 min and neem-ritual 71.7 min (run 3,
  23 Oct, current code, two shops at once). The models were working for
  about 11 and 22 min of that (estimate); the rest was waiting.
- The waiting has two causes. Google's shared pay-as-you-go pool refuses
  many of our requests (429 RESOURCE_EXHAUSTED) although we are its only
  caller, and our own code turned each refusal into minutes: one 429 paused
  every shop, a photo check's clock counted its own 429 waits, and its tries
  started over at every 18-minute hand-over.
- Every photo since 22 Oct came back at 1K although 2K was asked for. The
  cause was ours: the model now sends a 1K draft before the final picture,
  and the image readers kept the first image part. Fixed in Phase 0.
- Phase 0 (no new spend) is built and tested offline. Expected, an
  estimate until a live run: about 16 to 18 min for a crumb-like shop and
  30 to 34 for a neem-like one. The robustness audit of 23 Oct, from a
  calibrated simulation, puts it at about 34 and 50 min (also an estimate;
  it calls the first one about twice too optimistic).
- Phase 0's corrections, the same day (robustness audit P0-1 and P0-3):
  image starts are spaced between 10 and 45 s, where the first build held
  25 to 90 (owner: "Change to 10 to 45 s"), and the logs carry each move of
  that gap, Google's own words on every refused photo and check, and each
  photo's size.

## The measured diagnosis

### Where the time went

Crumb-and-co, run 3, 2,907.9 s in 3 invocations (`runs/crumb-and-co.json`):

- Plan 103.6 s (1.7 min); compile 0.04 s.
- Photos 1,874.1 s (31.2 min). The first 16.3 min drew 16 photos for 15
  slots; the model drew for about 7.8 min of it (16 draws at the run's 29.3 s
  mean, Monitoring), and the log has 14 photo-model refusals with 460 s of
  logged waits (a sum of per-request sleeps that overlap across lanes, so the
  wall-clock pause was at most that). Then 14.9 min went on ONE photo's
  check (`faq-counter`: it also failed one check before a hand-over, so 4
  failed checks and 16.9 min from draw to settle), after which it was let in
  unchecked.
- Products 927.2 s (15.5 min): 12 refusals of the product-photo model in the
  first 2.5 min; one product failed `wrong_subject` three times (its attempt
  count restarted at a hand-over); one product check took 12.85 min (3
  timeouts). The merchant's own photo was kept for 2 of 3 products.
- Assemble, checks and card 2.6 s.
- Shares (estimate from the measured times): model work about 11 min (23%),
  waiting on the photo checker about 28 min (57%), waiting on photo-model
  refusals about 7 to 8 min (16%), the rest product refusals and hand-overs.

Neem-ritual, run 3, 4,304.6 s in 5 invocations: plan 243.9 s plus compile
67.5 s with one repair (5.2 min), photos 64.9 min, products 1.6 min. Its
anchor step took 6.75 min, about 6 of them waiting behind crumb's draws.
About 29.5 min of drawing followed (about 28 of its 32 draws, for 17 slots),
then 28.7 min of delayed checks: six parked photos passed late, one photo
was redrawn three more times, two were replaced by crops, and one
(`hero-slide-workshop`) was let in unchecked 52.1 min after it was parked.

Run 2 (22 Oct, four shops at once, older code): 55.9 to 63.3 min per shop,
48 to 52 of them in photos; the platform got about 0.84 photos a minute
(Monitoring) and 28 of 42 photos shipped unchecked.

Spend, by the app's own list-price estimate in `mink_revamps.usage` (not
Google billing): about $2.91 for crumb and $4.96 for neem. Refused calls
carry no tokens (every 429, 499 and 504 point sits in the smallest token
buckets), so they most likely cost time, not money (an inference).

### Why Google refuses

- It is not our traffic (measured, 6 weeks). Every revamp-model call came
  from the gcloud application-default login (no service account or deployed
  service called Vertex) with at most 3 requests per model in flight, all on
  Google's standard shared pool at the global endpoint
  (`request_type=shared`, `shared_request_type=standard`). Google's own page
  says a 429 in that pool "doesn't indicate that you've hit a fixed quota.
  It indicates temporary high contention", and image models get no
  spend-based tier.
- Refusal rates (measured, Monitoring `model_invocation_count`, 22 Oct
  12:30 to 22:36 UTC): `gemini-3-pro-image` 43% (71 of 164),
  `gemini-3.1-flash-image` 62% (64 of 103), `gemini-3.8-flash` 16% (16 of
  100), with 19 more of its calls ending when our own clock gave up (HTTP
  499). The rate swings by day at similar volume: 3.8 Flash had 1 refusal in
  131 calls on one quiet day and 149 in 228 on another.
- The photo model refuses requests that come too close together (measured,
  sampler 04:01 to 04:30 IST on 23 Oct, 21 requests, one shop, one night):
  it refused 5 of 7 requests sent the moment the previous photo finished and
  both sent 8 s after a refusal, and accepted 11 of 12 sent 12 s or more
  after (the twelfth timed out). Starts 40 s or more apart were accepted;
  30 to 35 s apart mostly refused. It never finished more than 2 photos in
  any minute in 6 weeks, though our own limiter also held it near that.
- The checking model holds a request about 40 to 90 s and then refuses it
  (measured, lease sampler); it has no per-project request quota.
- Staging lists "Generate content with image generation requests quota for
  global endpoint" at a default of 2 a minute, never raised. The evidence
  leans away from it being the limit: Google's quota counter recorded none
  of our generate calls in 6 weeks, the model pages say "Fixed quota: Not
  supported", and `gemini-3.1-flash-image` went over 2 a minute twice. A
  quota request and a support question are free and still worth sending;
  only Google can say which limit binds.

### How our code made it worse (the code before Phase 0)

- One 429 set that model's shared capacity to one request for every
  process and paused everyone for the refused caller's own backoff, 7.5 to
  120 s (`provider-capacity-store.ts`, `rate-limit-backoff.ts`); capacity came
  back one permit per three successes. In the first 12.5 min of sampling,
  the photo line had nothing in flight 43% of the time, 27 points of it
  inside 429 pauses (measured).
- A photo check ran on one 180 s clock that also counted its 429 sleeps
  (`gemini-vertex.ts`), so a try that got through after two refusals could
  be cut off half way. A parked photo was asked again only after 60 and
  120 s and only after the whole image run, and its tries lived in memory,
  so they restarted at every 18-minute hand-over.
- The planner and its repairs held the same `gemini-3.8-flash` permits as
  the photo checks, each call 97 to 244 s (measured), and that model's
  permits sat at one in 73 to 87% of samples.
- Product studio photos went three at once outside the shared permits,
  each with its own retries.
- Nothing recorded why a photo was drawn again: neem drew 32 photos for 17
  slots and the causes could not be read afterwards.

### Why every photo came back at 1K

2K worked on 21 Oct (run 1: the kesar hero stored 2520x1080 from a
3168x1344 draw) and every photo from 22 Oct 13:05 UTC was about 1 MP. Our
request did not change (it still asks `imageSize: "2K"`). The paid probe on
23 Oct showed that `gemini-3-pro-image` now answers with four parts: thought
text, a **thought image at 1K** (`thought: true`, 1584x672 for a 21:9
request), thought text, then the **final image at 2K** (3168x1344, carrying a
thought signature). All ten saved Pro answers had that shape;
`gemini-3.1-flash-image` answers had a single image part. The readers in
`image-vertex.ts`, `media-generation.ts` and `image-refine.ts` kept the first
inline image, which was the draft. At 2K a Pro draw took about 21% longer
(run 1: 35.5 s against 29.3 s at 1K, 6 draws). Nano Banana 2.1, the one
image model since 25 Oct 2026, sends a draft before every picture too; the
readers keep the last image part that is not a thought.

## The owner's decisions, 23 Oct 2026

Asked with options; each is followed exactly.

1. **Run the full Priority-tier test on storemink-staging**, about $24, at
   both busy hours. The script is built in Phase 0
   (`scripts/revamp-priority-test.ts`); the main session runs it, never a
   build agent.
2. **When a photo check cannot finish within about 4 minutes in all**, use a
   crop of an already-checked photo from the same shoot that fits the frame;
   if none fits, let the photo in unchecked and say so on the card under
   "Not done this time".
3. **Show the design early**, in Phase 1, not now.
4. **Start Phase 0 now.**

Later the same day, from the read-only robustness audit
(`mink-robustness-plan.md`, section 6a, kept with the hand-over notes
outside this repository):

5. **Image start pacing between 10 and 45 s** (P0-1): "Change to 10 to 45
   s". The first build held 25 to 90 s. The 40 s start, x0.9 per success
   and x1.5 per 429 stay.
6. **The Priority test's additions** (P0-4): a Standard-only spacing ladder
   for Pro photos, run alone first; Flash photos at the us and eu
   endpoints; Google's whole refusal body for every 429. The Pro A/B is
   trimmed from 15 + 15 to 10 + 10 calls so the two passes stay inside the
   approved $24.

The plan's other questions (the free quota request, fewer drawings, paying
for Priority on production calls, a revamp worker, the ready email, the
order of the photo line, a second image model, reserved capacity) were not
part of this round.

## The plan in three phases

Times for one redesign and for ten at once are estimates built from
measured call times (the verifier's corrected figures); today's are
measured.

| Phase              | What                                                                                                         | One redesign                                                                                                               | Ten at once                                                                                                                                  | Cost and effort                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Today (measured)   |                                                                                                              | crumb 48.5 min, neem 71.7 min                                                                                              | last about 3 to 6 h (estimate)                                                                                                               | $2.91 to $4.96 of model calls a redesign                                                                                                                     |
| 0, no spend        | check clocks and budget, start pacing, gentler 429s, planner lane, paced product photos, records, the 1K fix | crumb-like about 16 to 18 min (14 to 28), neem-like about 30 to 34 (30 to 46)                                              | last about 2 to 2.3 h; first four at about 49 to 55 min                                                                                      | no new spend; about 5.5 to 6.5 engineer-days and one migration                                                                                               |
| 1, pipeline        | early preview, honest progress and an email, products beside photos, fewer drawings, many at once            | first preview about 2 min (crumb-like) and 5 (neem-like); done about 12 min (10 to 16) and 20 to 25                        | a design within 2 to 7 min for light shops (up to about 17 for heavy ones); last card about 1.6 to 1.8 h; about 5.5 to 6.5 redesigns an hour | about 18 to 28 engineer-days; a worker service still to be priced, and about $18 a month more for a larger Cloud SQL tier before going past about 10 at once |
| 2, Google capacity | Priority PayGo or a raised quota, more lanes                                                                 | about 5 to 6 min (crumb-like) and 10 to 13 (neem-like), only if 6 or more photo requests run at once at run-3-like latency | about 7 to 15 min each, only if Google admits about 30 photo requests at once and the 3-permit cap is lifted; otherwise about 26 to 28 min   | the test about $11.57 a pass by its own estimate (about $24 approved for two); Priority adds about 80% to each call it covers                                |

Notes on the estimates:

- Phase 0's figures assumed each draw spaced from the END of the last one:
  about one every 44 s at run 3's 29 s draws, slower when draws take
  longer (the 28 min end assumed run 2's 51 s draws). The pacer that was
  built spaces STARTS instead, overlap allowed: about 1.5 a minute at the
  40 s gap it begins with and up to about 6 at its 10 s floor (where the
  three permits bind too, at about run 3's 29 s draws), fewer while
  refusals widen the gap (one every 45 s at most, about 1.3 a minute). So
  long draws should no longer slow the line above the floor (an inference
  until a live run), but a busy pool still can. Add about 6 min for a shop
  with one capped photo check and one capped product check.
- The table's Phase 0 figures are the plan's. The robustness audit of
  23 Oct re-estimated Phase 0 as built, from a simulation calibrated on the
  measured traces: about 34 min for a crumb-like shop and 50 for a
  neem-like one, the last of ten at once at about 4.4 h. It calls the
  plan's figures about twice too optimistic, and expects the 10 to 45 s
  bounds to help a little (100 at once at a busy hour: about 38 h instead
  of 40). Both are estimates until a live run.
- Ten at once stays slow on Google's standard pool: the whole platform
  still gets about 1.3 to 1.5 photos a minute (estimate).
- Phase 1's neem-like figure assumed fewer redraws; neem's 15 extra draws
  had no recorded causes. Phase 0 now records them.
- Phase 2 needs a migration: `theme_studio_provider_capacity` keeps the
  0149 CHECK of 1 to 3 permits per key. Priority on every call takes crumb
  from about $2.91 to $5.24 and neem from $4.96 to $8.94 (estimate);
  Priority on the checks and the planner alone adds about $0.15 to $0.30 a
  redesign today and about $0.3 to $0.6 after 1 Jan 2027, when the
  `gemini-3.8-flash` launch price ends.

## What Phase 0 changed (23 Oct 2026)

Built and tested offline and against the local database. Nothing here has
run against live Vertex yet.

**Start pacing for image models** (`lib/theme-studio/provider-capacity.ts`,
`provider-capacity-store.ts`, migration
`20261023_0236_theme_studio_provider_pacing`). The shared capacity spaces
the STARTS of requests on an image model's key (`isImageProviderModel`:
`/image|nano-banana/i`), across every process, so Theme Studio, the
redesign's shoot and its product photos are all paced with no change of
their own. A paced claim needs `next_start_at <= clock_timestamp()`, and an
admission stamps the next start in the same statement, so `next_start_at`
is always the latest admission plus `gap_ms`. Requests may overlap up to
the existing 3 permits. Text model keys never read the new columns.

| Constant                             | Value                                                         |
| ------------------------------------ | ------------------------------------------------------------- |
| `IMAGE_START_PACING.initialGapMs`    | 40,000 (equals the `gap_ms` default)                          |
| `IMAGE_START_PACING.minGapMs`        | 10,000 (was 25,000; owner, 23 Oct)                            |
| `IMAGE_START_PACING.maxGapMs`        | 45,000 (was 90,000; owner, 23 Oct)                            |
| `IMAGE_START_PACING.successFactor`   | 0.9 per current-epoch success                                 |
| `IMAGE_START_PACING.rateLimitFactor` | 1.5 per 429                                                   |
| `SHARED_RATE_LIMIT_PAUSE_MAX_MS`     | 15,000                                                        |
| `PACE_LOG_MIN_CHANGE_MS`             | 1,000 (the least a gap moves for its log line)                |
| Permits per key                      | 3, unchanged (0149 CHECK)                                     |
| Recovery                             | one permit back per current-epoch success (was one per three) |

The bounds were corrected on 23 Oct from 25 to 90 s (robustness audit B28;
owner: "Change to 10 to 45 s"). x0.9 per success and x1.5 per 429 cancel
at about 21% of starts refused (ln(1/0.9) / ln(1.5/0.9)), so a line refused
more often sits at the ceiling and one refused less at the floor: the
bounds, not the factors, set the pace, and retuning the factors only moves
the 21%. With the 90 s ceiling, a line refused more often than that would
have started once every 90 s, half the line, even when the refusals were not
about our spacing. 45 s is close to the busy-hour accepted rate fitted to
the 23 Oct trace (one start per about 39 s, an estimate), so a pinned line
keeps near what Google was taking; 10 s lets a quiet hour run near the
three permits, where the 25 s floor gave away about a third of the line
(simulation, an estimate). The 40 s start and the x0.9 descent are the
gradual ramp-up Google's docs ask for.

Migration 0236 adds `next_start_at timestamptz NOT NULL DEFAULT now()` and
`gap_ms integer NOT NULL DEFAULT 40000` with
`theme_studio_provider_capacity_gap_ms_check` (1,000 to 300,000, a sanity
bound wider than the app's 10 to 45 s, so the bounds are tuned without a
migration; the migration's own comment and manifest description give the
same 10 to 45 s). It is expand-only: the
revision it replaces names neither column, and
its pauses of up to 120 s are cut back to 15 s by the new revision's next
pause on that key. Applied to `storemink_local` only so far.

**Gentler 429s on every key.** A refusal holds the other requests on its
key back at most 15 s, and a longer pause already on the row is cut back to
it; the key still drops to one permit and gets one back per success, in the
database row and in the process pool (`image-request-pool.ts`). The image
client (`image-vertex.ts`) waits at most that same 15 s and then queues
again through the pool and the pacer, five retries at most; it used to sleep
its own 7.5 to 120 s on top.

**The planner's own lane.** `sharedProviderCapacity` takes an optional
`scope`, a capacity row of its own on the same model (no scope hashes the
original three parts, so existing rows are kept). `site-planner.ts` uses
`REVAMP_PLANNER_CAPACITY_SCOPE` (`revamp-planner`) for plans and repairs
alike, so a planning call never holds a photo check's permit. The scope has
its own 3 permits, so `gemini-3.8-flash` can have three planning calls and
three others (photo checks, visual QA) in flight at once.

**A clock per check try** (`lib/theme-studio/gemini-vertex.ts`, the
`image_review` stage only). Each try has its own 75 s clock
(`IMAGE_REVIEW_TRY_TIMEOUT_MS`) from the moment it is admitted; a 429 waits
a jittered 10 to 20 s (`IMAGE_REVIEW_RATE_LIMIT_WAIT_MS`) on the caller's
signal, not the dead try's, with two retries
(`IMAGE_REVIEW_RATE_LIMIT_RETRIES`). The plan proposed 30 s; the verifier
found that in run 2 the median successful check took about 42 s and 11 of
20 took over 30 s (up to 164 s), so 75 s. Other stages keep their one
whole-call clock. Since TS-3D (25 Oct 2026) every photo-check setup gives
its client `capacityAt`. A check goes to Google's US endpoint first and once
to global when the US refuses (a 429, a 5xx, an outright 403 or 404) or its
try times out. Each try runs on its location's shared row and on the
caller's clock (`imageReviewTryTimeoutMs`: the redesigns keep 75 s, Theme
Studio sets 120 s). There is never a third try and no 429 wait inside the
call. A one-location client keeps the waits above. The US is priced at 1.1
times global (`gemini-api-list-2026-09-us-1.1x`), and each US try that goes
on to global logs `theme_studio.image_review_fallback`.

**A four-minute check budget that survives hand-overs**
(`lib/mink/revamp/photos.ts`). A parked photo is asked again after about 15,
30 and 60 s (`REVAMP_REVIEW_RETRY_DELAYS_MS`), during the shoot as well as
after it, within about 4 minutes from its first ask
(`REVAMP_PHOTO_CHECK_BUDGET_MS`); a try in flight when the budget ends is
cut off and a wait that would end past it is not waited. Its tries, first
ask, last try, verdict and redraws are kept on the job row
(`result.photoReviews`, by shot, written fenced by `recordRevampPhotoReviews`
in `jobs.ts`; each entry names the parked photo's sha256, so a record about
another picture is never applied), so a later invocation never asks again
for a known verdict and never restarts the clock. No migration: it is a key
of the existing `result` jsonb.

**Decision 2.** When the budget runs out with no verdict, the shot takes a
crop of an already-checked photo of the same shoot (passed, or flagged with
minor problems only; never the anchor or another crop) that keeps at least
70% of its picture (`REVAMP_CHECKED_CROP_MAX_LOSS`, 0.3). When none fits,
the photo is shown unchecked and the card lists it under "Not done this
time": "Mink AI could not check this photograph in time, so it is shown
unchecked." (`REVAMP_UNCHECKED_PHOTO_REASON`). Both are `failed` outcomes,
so neither is charged (`assemble.ts` charges only `generated` photos). A
photo let in unchecked is stored again with the `unchecked` problem on its
own row (`REVAMP_UNCHECKED_PROBLEM`) rather than adopted, since an adopted
row carries no problems and the job row's record of the expired check is
best-effort: a later invocation reads the marker and keeps it unchecked.

**Product studio photos** (`lib/mink/revamp/products.ts`). Every draw takes
a turn on its image model's shared capacity (`MINK_IMAGE_MODEL` at
`MINK_IMAGE_LOCATION`, `gemini-nano-banana-2.1` by default since 25 Oct
2026, the same model and so the same paced photo line as the redesign's
photos; `gemini-3.1-flash-image` before), on its own 75 s clock, sharing a 429 with the other callers
(`permit.rateLimited`), and nothing is sent once the deadline's drain has
begun. A draw still waiting for its turn when the drain begins stops
waiting and is never admitted (`ProviderRunOptions.admission`), so it takes
no paced start from the other callers on the model; the shoot's draws and
checks do the same (`revampDrainingCapacity` in `photos.ts`). A 429 is
asked again five times, each after at most 15 s,
the pacer spacing the tries. The check gets the photos' clocks:
`PRODUCT_REVIEW_RETRY_MS` 15, 30 and 60 s (was 60 and 120) and
`PRODUCT_PHOTO_CHECK_BUDGET_MS` 4 min per invocation, after which the
merchant's own photo is kept and the card says "Mink AI could not check the
studio photo against your photo in time, so your own photo is used."

**Records for the next diagnosis.** `usage.calls` counts each model's 429s
and timeouts (`rateLimited`, `timeouts`), summed across hand-overs; why each
photo was drawn again is kept on the photo outcomes (`redraws`, the anchor's
under `@anchor`, a refused draw as `refused`) and in
`result.products.redraws`. `npm run revamp:live-check -- --report` prints
them with each photo's check record. Three log lines, all content-free
(robustness audit P0-1 and P0-3, 23 Oct), shared with Theme Studio:

- Each move of an image key's gap of a second or more logs
  `theme_studio.provider_pace`: model, location and scope, never the
  project; outcome `success` or `rate_limited`; `gapBeforeMs` and
  `gapAfterMs`; and `refusals`, the key's epoch, so two lines' difference
  counts the 429s between them, including those at the ceiling. The
  statement that moves the gap returns these, so the log costs no read.
- Google's own answer for every refused or failed photo or check, on the
  retry line and on one final line when a call fails for good
  (`theme_studio.image_provider_error`, `theme_studio.provider_error`):
  the HTTP status, the error status, the message cut to 500 characters
  and `quotaNamed`, the quota it names (null for the shared pool's 429,
  which names none). A project quota would show here first.
- One `theme_studio.image_answer` line per photo with its image parts,
  thought drafts and size (read from the picture's header) and the size
  asked for, plus `theme_studio.image_below_requested_size` when the long
  edge is under 85% of that size's square edge (1741 px for 2K): the
  warning that 1K photos have returned.

**The 1K fix.** The three image readers keep the last image part that is
not a thought and never a thought image, even alone: a draft, and the final
picture may have been withheld. An answer holding only a draft is a refusal
when it names a stop and a failure otherwise. Theme Studio's own theme
photos share the reader, so they get their 2K back too (production was not
checked).

**The Priority test script** (`scripts/revamp-priority-test.ts`, below).

Tests: the suites beside every file above, a DB-free test of the capacity
SQL and its pace lines (`provider-capacity-store.test.ts`), the opt-in
Postgres capacity test (`THEME_STUDIO_CAPACITY_DB_TEST=1`, which pins the
10 and 45 s bounds against real SQL), the refusal and image-size lines in
`gemini-vertex.test.ts` and `image-vertex.test.ts`, a `jobs.local` test of
the fenced `photoReviews` write (`MINK_REVAMP_LOCAL_TEST=1`), and the
script's drift tests against the production requests it copies.

### What Phase 0 does not do

- The pacer has no priority: whichever waiter claims first after
  `next_start_at` starts. Theme Studio builds and redesigns share one paced
  line per image model, and Mink chat's own image calls
  (`media-generation.ts`) take no permit, so they are neither paced nor held
  back.
- A claim already on its way to the database when the deadline's drain
  begins can still be admitted and stamp one paced start; its permit is
  given back and nothing is sent, but the next caller on the model may wait
  one gap it did not need to.
- The planner's capacity takes no admission signal: a planning call waiting
  for a permit when the drain begins keeps waiting, until its turn or the
  hand-over's hard stop, and is then refused unsent. Its key is text, so it
  takes no paced start from anyone; the cost is a later hand-over.
- A Theme Studio photo check try has its own 120 s clock
  (`THEME_STUDIO_IMAGE_REVIEW_TRY_TIMEOUT_MS`, TS-3D; the redesigns keep
  75 s): it goes to the US endpoint first and once to global, so a check
  that needs more than 120 s on both is cut off as unavailable and deferred,
  Theme Studio's existing rule for a review it could not have; watch review
  durations after the deploy.
- The product check budget restarts at each invocation, and a product's
  redraw reasons are saved only when the products step finishes. 429 counts
  can come out slightly low when a run stops during a wait, and a check the
  budget cuts off is counted as a timeout without its tokens.
- The 40 s starting gap comes from one 30-minute trace; the pacer adjusts
  itself, but the first live run (a redesign or a Theme Studio image run
  after the deploy) is its first real measurement. The Priority test never
  goes through the shared capacity, so it does not measure the pacer.
- By design the gap spends most of its time at a bound: refused more than
  about 21% of the time, the line runs one start per 45 s; less, near the
  floor. Whether 45 s is the right ceiling depends on whether Google's
  busy-hour limit is about spacing (one start per about 39 s fits the 23 Oct
  trace) or random; the Priority test's spacing ladder is what settles it.
- The pace lines give the gap, not the exact refusal share: a success at
  the floor and a refusal at the ceiling move nothing and log nothing
  (`refusals` still counts the latter). Cloud Monitoring's
  `model_invocation_count` by response code gives the share.
- A gap left outside the bounds by a future retune comes back only
  gradually: a success shrinks a high one 10% at a time, a refusal grows a
  low one 1.5x at a time.

## Running the Priority test

The owner approved about $24 for the two passes on storemink-staging
(decisions 1 and 6); one pass costs about $6.43 at list prices by the
script's own estimate since its photo lanes moved to Nano Banana 2.1 on
25 Oct ($11.57 on the 23 Oct models; the dry run always prints the current
figure). Only the main session runs it, never a build agent.

1. Refresh the Application Default Credentials, which a live pass checks
   before its first call (it asks for a token and refuses without one):
   `gcloud auth application-default login`. Your ADC quota project may be
   storemink-prod: Vertex bills the project in the request path
   (storemink-staging), where every earlier staging run was measured, so the
   script prints a note, not a refusal.
2. Dry run, which calls nothing and writes nothing:
   `npm run revamp:priority-test -- --out=<dir>`. It prints the plan: 152
   calls, at most 6 in flight, the spacing ladder's last start due 6.3 min
   in and the pass's 9.8 min after the pass starts, the cost at list prices
   (about $6.43 since 25 Oct; $11.57, Standard $6.90 and Priority $4.67, on
   the 23 Oct models) against the `--max-usd` budget (default 15, at most
   25), and each model's per-call ceiling.
3. Evening pass, about 18:30 IST, on the default $15 budget:
   `npm run revamp:priority-test -- --live --yes --label=evening --out=<dir>`.
4. Night pass, about 03:30 IST, on what is left of the $24:
   `npm run revamp:priority-test -- --live --yes --label=night --lead=priority --max-usd=<24 less the evening's spend, at most 15> --out=<dir>`.
   The evening's spend is `spentUsd` in its results JSON (the "Spend at
   list prices" line of its summary), a timed-out call counted at its
   ceiling. `--lead=priority` so neither arm always opens a pair. An evening
   that spent the estimate leaves about $17.57 (about $12.43 on the 23 Oct
   models), enough for a full pass. A
   budget below the dry run's estimate is refused before the first call,
   since the pass would stop part way: ask the owner before raising it.

Each pass takes about 17 to 22 minutes, in two stages. First the spacing
ladder, alone: 12 Standard photos at global (`photo-ladder@global`:
`gemini-nano-banana-2.1` at HIGH since 25 Oct, `gemini-3-pro-image` on
23 Oct), three
each 60, 40, 30 and 15 s apart, widest first (starts at 0, 60, 120, 160,
200, 240, 270, 300, 330, 345, 360 and 375 s), so the photo model's
busy-hour limit is measured against the spacing with nothing else running;
any refusals come at the end and cannot colour the wider rungs. The pass
starts once the ladder's last answer is in: 140 calls in seven lanes, the
arms alternating call by call within a lane. Theme Studio's photo
(`studio-photo@global`, HIGH) 10 Standard and 10 Priority photos (4:5);
Mink's photo (`mink-photo@global`, `@us` and `@eu`, MINIMAL) 10 and 10 at
global and 10 Standard each at the us and eu endpoints (3:4), all on
`gemini-nano-banana-2.1` since 25 Oct (the 23 Oct passes drew with
`gemini-3-pro-image` and `gemini-3.1-flash-image`); the photo
check on `gemini-3.8-flash` 20 and 20 at global and 20 Standard each at us
and eu. A two-arm lane starts a call every 15 s (`--gap`), a one-arm lane
every 30 s, so every arm on every endpoint starts once per two gaps. Every
photo asks for 2K. Every call is sent once, never retried. A call starts
only while the spend so far, the ceiling of every call in flight and its
own ceiling stay within `--max-usd`; a call that timed out counts at its
ceiling, since it may have been billed. Ctrl-C once stops new calls; twice
abandons the calls in flight. It refuses any project but storemink-staging,
any project variable containing "prod" and an overridden Vertex endpoint
(`GOOGLE_VERTEX_BASE_URL`). It never touches the database, a bucket or the
shared provider capacity and its pacer.

Priority sends `X-Vertex-AI-LLM-Shared-Request-Type: priority` with
`X-Vertex-AI-LLM-Request-Type: shared`; the answer's
`usageMetadata.trafficType` says `ON_DEMAND_PRIORITY` when it was served as
Priority and `ON_DEMAND` when Google downgraded it (billed at Standard).
Under `--out` go the results JSON (`version` 2, rewritten after every call),
the markdown summary beside it and the photos in an `-images` folder. Per
model, arm and endpoint the summary gives the 429 share, p50 and p95
latency of the 200s, how long a refused request was held, the share really
served as Priority, the photo sizes (the final image part kept, the thought
drafts counted), the cost and the most 200s started in any 60 s. Every
refusal keeps Google's whole error body (`errorBody`), its details
(`errorDetails`: ErrorInfo, QuotaFailure, Help) and the quota it names
(`quotaNamed`, null for the shared pool's 429, which says only "Resource has
been exhausted (e.g. check quota)."). Every call records
`gapSincePrevStartMs`, the time since the last call to the same model at the
same endpoint started, whatever its lane or arm: the spacing Google's
limiter saw.

Reading the ladder: the summary's "Spacing ladder" section gives each
rung's calls, 200s, 429s, measured spacing (p50) and the quotas named, then
the most photos admitted within 60 s, in the ladder and across the pass.
Three or more admitted inside 60 s means the 2-a-minute paper quota does not
bind. A 429 that names a quota is a project quota, which a quota increase
raises. 429s that name none and fade as the spacing widens are the shared
pool's busy-hour gate: the narrowest rung with none is where the photo pacer
can settle, so `IMAGE_START_PACING`'s bounds (10 to 45 s) are retuned from
it, a constant change with no migration (0236's CHECK allows 1 s to 5 min).
The us and eu photo rows against the global row say whether Mink's photos
(product studio photos included) should move to another endpoint; 2.1 is
confirmed at global only, so a 404 at us or eu is free and is itself the
answer.

Reading the rest: its checks run on one 180 s clock per call, while
production now gives each redesign try 75 s (Theme Studio 120 s) and sends
checks to the US first, so apply those cuts when reading check latencies.
Its photo calls carry no reference images, so absolute latencies run lower
than a real shoot's; the Standard against Priority comparison is still like
for like. If Priority cuts the refusals, the owner decides what to pay for
(the plan suggests the checks and the planner first, the photos too if
their refusals drop); Priority must then be priced at 1.8x in
`lib/theme-studio/cost.ts`, `products.ts`'s fixed estimate and
`lib/mink/cost.ts`, so the estimates and the daily spend cap stay right.

## Left for Phase 1 and Phase 2

Phase 1 (pipeline):

- Show the design early (decision 3): a "being made" preview on phone and
  desktop once compile finishes, each photo appearing once it passed its
  check, Apply locked until every check passed, the photos shoppers see
  first drawn first.
- Honest progress read from stored photos, and "you can leave, Mink will
  email you" with a link straight to the card (today the ready notice is
  in-app only; since 24 Oct it opens the chat that holds the card,
  `/dashboard?chat=<conversation id>`, robustness audit B20).
- Product photos drawn beside the shoot, right after compile (needs one
  photo claim per step and a memory check in the web container, 2 GiB in
  production since 23 Oct and 512 MiB on dev).
- Fewer drawings: draw a subject once and cut its second shape, redraw only
  for blocking problems. The redraw causes Phase 0 now records say how many
  that saves.
- Many redesigns at once: plan every shop at once, a production-only worker
  service started on demand (never on dev), first come first served on the
  photo line (oldest redesign first, art direction and opening photos
  first, redesigns ahead of Theme Studio builds, Mink chat first), and the
  platform photo budget measured from the last 10 minutes instead of the
  assumed 400 an hour.
- A second endpoint for the planner, only if the Priority test finds the us
  or eu endpoint quieter (`gemini-3.8-flash` is served there). Photo checks
  already go to the US endpoint first, then global, since 25 Oct 2026
  (TS-3D, the owner's decision of 23 Oct).
- Alerts on staging and production for a model's 429 share, downgraded
  Priority calls and queue length.

Phase 2 (capacity from Google):

- The free quota request and support question for storemink-staging and
  storemink-prod.
- Priority on production calls, if the test shows it works and the owner
  agrees to the cost.
- A migration lifting the 3-permit cap (0149) and more lanes per redesign,
  which Phase 2's ten-at-once times depend on.
- A side-by-side test of Nano Banana 2.1 (`gemini-nano-banana-2.1`) for
  category and gallery tiles is no longer needed: since 25 Oct 2026 every
  picture is drawn with it (the owner's decision).
- No Provisioned Throughput for now: one unit costs about $2,700 a month and
  draws about 23 to 25 Pro photos an hour (estimate, on Pro).

## Help Centre

None. No merchant step changes: a merchant asks, waits, reviews and applies
exactly as before. The card's own words say when a photo or a studio photo
could not be checked in time.
