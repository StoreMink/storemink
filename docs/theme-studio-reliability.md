# Theme Studio reliability — Crave and Luxe, 2026-09-29

The fixes in this change are local until the web service and separate Chromium
job are deployed. No production records were changed during diagnosis.

## Fresh Bubble build: wrong-page contrast repair — 5 October 2026

Read-only inspection of project `888f138b-958a-4bf9-bf08-f3621af55da6`
confirmed that version 1 completed generation but failed the layout preflight.
Its About hero used white text on the gold `creamDeep` field (`#f5d061`).
Automatic version 2 changed only
`/definition/preset/pages/0/sections/1/config/theme`, the **homepage** hero.
The About hero remained `variant-split theme-light`, and the homepage became
`variant-banner theme-light`. Both rendered white text on gold, with heading
contrast 1.49:1 and subheading contrast about 1.40:1. `qa_no_progress` stopped
the pipeline before its 17 artwork slots and three catalogue pictures were
created. The displayed successful run meant model execution, not completed QA.

The repair received generic scalar paths and viewport findings without resolved
hero colour semantics. Package checks covered palette and scheme pairs but
omitted hero text on its actual field; they consequently accepted the wrong-page
edit as a valid new version. Increasing the iteration limit would allow more
paid ineffective repairs without addressing that validation gap.

Local correction: `lib/themes/hero-contrast.ts` resolves each enabled solid-field
hero's real background and text, including the 85% subheading opacity and scheme
card-reset specificity. `validateThemeDesign` applies this check during compiler
content-floor validation, acceptance and targeted patch validation. A bad
initial draft receives a bounded correction **within generation**, before the
first saved version. A wrong-page patch is rejected within the settings call's
existing correction budget. Findings name the affected page, section and exact
path and suggest another text mode only when it passes both contrast thresholds.
Prompt v23 provides these semantics and per-hero evidence; older paid requests
keep their original prompt/context shape. No renderer CSS, revision ceiling or
acceptance threshold changes are included.

Coverage includes a replay of the initial draft defect and wrong-page repair,
opaque explicit fields, derived schemes, banner resets and muted-copy contrast.
The existing offline Chrome script adds the white-on-gold heading/subheading
negative controls and corrected hero variants across 360/390/768/1024/1440px.
Photographic/video heroes and non-hex or translucent fields remain browser checks;
this is not proof that every generated design passes on its first model response.

Verification: 345 focused tests passed across 19 files; the additional request
compatibility/recovery run passed 98 tests across five overlapping files. The
offline Chrome regression passed 40 cases with five failing negative controls,
including Bubble's exact 1.49:1 and 1.40:1 pairs. TypeScript, changed-file ESLint,
formatting, `git diff --check` and `npm run help:lint` passed. No paid production
generation or deployment was performed for this fix.

Bubble's requested interactive image hotspots remain a real native capability
gap. A settings repair cannot implement them or promise a pixel-perfect Shopify
theme: Studio produces StoreMink data for its shared renderer. Existing drafts
need a normal revision after deploying the web and generation-worker changes,
then the normal artwork, final browser and visual-QA stages. No production
records were changed during this diagnosis. No merchant-visible change, no
Help Centre update; POS/location/inventory/fulfilment behavior is unchanged.

## Confirmed production evidence

Read through the existing Cloud SQL proxy in a read-only transaction using the
application service role, scoped to the two project IDs in the screenshots.
Times below are IST on 29 September 2026.

| Stage              | Crave                                                       | Luxe                                                        |
| ------------------ | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Initial generation | 10:05–10:11:42                                              | 10:12–10:15:53                                              |
| First image run    | 10:16–10:31:09; 5 slots rate-limited                        | 10:32–10:51:01; 5 rate-limited, 1 cancelled at run deadline |
| Missing-slot fill  | Queued 10:31, started 10:52; finished 10:59:12, all 5 drawn | Queued 10:51, started 11:00; finished 11:06:34, all 6 drawn |
| Browser capture    | Failed twice; `capture_browser_error`, 11:01:36             | Failed twice; `capture_browser_error`, 11:11:05             |
| Project state      | `ready`, current version present                            | `ready`, current version present                            |

Crave's “Generating / No version” at 11:15 was stale UI: polling stopped once
the last image run settled, even though the project was still capturing.
Luxe's three outstanding placeholders are catalog pictures produced by browser
capture. Its requested artwork completed; three retained images have minor
review flags, which is distinct from three missing images.

Cloud logging was unavailable because the saved gcloud login required
reauthentication. The database records establish terminal capture codes, not a
production browser stack trace. The SVG failure was reproduced by inspecting
and testing the actual probe: it called `.innerText.trim()` on every element,
including SVG. Independently, the job incorrectly required HTTP 200 for the
mandatory not-found surface. Both are deterministic defects.

## Changes and guarantees

- Two leased run lanes and a separate visual-QA lane start together. All settle
  before the HTTP request returns, even if one fails. Same-project concurrent
  work remains fenced by the existing database constraints and leases.
- Image requests across both lanes share three permits per provider
  project/location/model within the process. This is not a distributed quota
  controller. Provider 429 backoff and missing-slot fills remain bounded;
  external quota availability still controls throughput.
- HIGH reasoning, the selected text/image models, image resolution and output
  allowances stay unchanged. Whole-call deadlines include SDK auth and retries.
  Image review has a 180-second deadline; other structured requests ten minutes;
  image attempts 180 seconds. Run cancellation takes precedence.
- A single throwing provider call or image decoder no longer discards the
  other completed images. Cancellation unwinds queued image permits and hung
  SDK waits; late results cannot mutate a completed worker result.
- Capture handles SVGs and expected 404s, waits for probe hydration, bounds
  measurement/work/HTTP waits, reports launch failures and replaces broken
  browsers. A rejected finish response fails the job for observability.
- Automatic captures now receive five leased attempts (manual captures keep
  two), and the workspace labels a terminal browser-capture error separately
  from a visual QA failure. An explicit **Retry automatic QA** from Images
  collects fresh browser evidence and re-enters visual review instead of
  producing an unchecked manual capture (since TS-2, 25 Oct 2026, that button
  is gone: **Check again** on the theme page measures again, never buying a
  repair). Current-version, revision, digest
  and idempotency checks apply to recovery too.
- The compiler previously allowed categories without image slots, so an empty
  category tile could be absent from every placeholder count. Draft schema,
  prompt and compiler now require a declared asset brief per category and send
  omissions through bounded repair. Legacy versions show missing categories
  separately and capture refuses them until revised. This is a reproduced code
  defect consistent with the later Crave screenshot; the latest production
  version's package has not been inspected in this session.
- The workspace polls through capture and QA and refreshes on tab visibility.
  Empty-version copy explains the private pipeline; summaries distinguish
  artwork from catalog pictures. Publication gates still reject placeholders.
- (TS-1E, 2026-10-24) A lease renewal that throws (a 5-second pool wait
  running out, a dropped connection) is retried at the next 30-second tick
  instead of aborting paid work; paid work stops only when a renewal answers
  that the lease is gone, or when the watchdog fires 5 s before the last
  renewed lease could lapse. Each retry logs
  `theme_studio.lease_renewal_retry`.
- (TS-1E) A capture nobody takes within 15 minutes fails as
  `capture_not_started` (log `theme_studio.capture_stale`), and Stop ends any
  capture, design review, run or abandoned in-browser check on a theme, so no
  theme stays "generating" for ever and Archive and Delete always work
  afterwards.
- (TS-1E) Opening a preview never evicts, and the retention sweep never
  removes, the preview store of a version that a queued capture, or a running
  capture on a live lease, is measuring.
- (TS-1B) One design review that cannot settle can no longer stall the queue
  for every theme on the platform: a review updates a version only while it
  is hidden and pending, and each worn-out row is settled, or closed, on its
  own. A deploy during a check still re-captures the same version, at most
  twice per check.
- (TS-1D) Every change an operator makes by hand (saved pictures, a photo run,
  a Retry, Make current) is checked automatically before it can be published,
  so no version is left that Publish can never take.

## Verification

- 413 targeted tests passed across 44 files (411 in the full focused run,
  plus two added provider-deadline regressions): Theme Studio libraries, worker
  routes, actions, capture job, Studio UI and browser probe.
- `tsc --noEmit --incremental false`, ESLint on changed code and
  `npm run help:lint` passed.
- Real headless Chrome 154 ran the production probe and capture function on a
  local fixture containing SVG icons, deliberately clipped text, a 200 home
  page and a 404 missing page at 360 and 1440 px. All four samples and screenshots
  completed and retained the clipping finding. This verifies browser mechanics,
  not the visual quality of the two production themes.

## Deployment and incident recovery

1. Deploy the web changes and rebuild/deploy `jobs/theme-studio-capture/` using
   `docs/theme-studio-capture-job.md`. No schema migration is needed.
2. Refresh both project tabs; the existing generated versions are preserved.
3. Capture the existing versions' catalog pictures from **Images**, then run
   **Checks** on the resulting current versions. This does not redraw artwork.
   A manual catalog capture does not itself rerun the automatic vision verdict.
4. Verify a new automatic pipeline using the deployed job: expected 404 surface,
   complete browser evidence, queued visual verdict and eventual visible version.
   Keep publication blocked until the existing acceptance and human gates pass.

These steps are the 29 September recovery as it was run. Since then the
human gates are gone (one superadmin publishes, 3 Oct 2026), and since TS-1
(24 Oct 2026), with automatic checks on, a catalog capture makes a hidden
version that gets the full checks and the design review, and **Check again**
re-measures a version on today's build; a version is published only on a
check run with no serious finding left and a design review bound to it.

No merchant-visible change, no Help Centre update. POS, inventory, locations
and fulfilment behavior are unchanged, so their roadmap/acceptance docs do not
change.

## Automatic acceptance and generation latency — 2026-10-01

This follow-up is local until the coordinated web/capture deployment and
scheduler changes described in the runbooks are applied. No production themes,
acceptance records or schedules were changed during this implementation.

Automatic capture settlement runs the same package, asset, route, link, markup
and browser gates used by manual acceptance. The final report is bound to the
version containing the captured catalog images, stored asset bytes and current
build. Catalog slots cannot double as storefront artwork. Coverage is derived
from expected pages, so missing a whole page cannot make checks pass.

`automatic-qa-policy.ts` distinguishes theme repairs from security/runtime
failures. Theme failures produce an exact-version repair prompt and repeat the
pipeline, with at most three repairs (four attempts including the original,
matching migration 0145's iteration constraint). Expensive vision is deferred
until deterministic gates pass. A successful visual verdict then revalidates
acceptance bindings and atomically reveals a candidate. One superadmin then
publishes it; since 3 Oct 2026 there is no human review step, and since
24 Oct only a serious finding stops a theme, smaller ones being warnings
(`docs/theme-acceptance.md` §5). Exhausted repairs or runtime faults preserve
the work: serious problems left after the repairs read **Needs a fix**
(**Needs a StoreMink fix** when they are all StoreMink's own code), and checks
that could not run read **Couldn't finish the checks**, with Check again;
security faults block. The worker never
calls an unsuccessful result a passed theme. Performance remains advisory.

Browser capture measures two isolated viewport contexts concurrently (three
since the Theme Studio release, `MAX_QA_CONTEXTS`) and
preserves sample order. It avoids redundant catalog network-idle waits and
includes launch in its deadline. A dedicated authenticated two-lane QA endpoint
can run independently of the long model/image scheduler. Compatible images
continue to carry over on revisions; no model quality setting was reduced.

Verification for this follow-up includes worker settlement, repair/stop/stale
binding cases, automatic acceptance persistence and omitted-page coverage,
authenticated QA draining, capture deadlines and the existing Studio regression
suite: 455 tests across 49 files (454 in the full focused run, plus one added
low-score repair regression). Type checking, changed-file ESLint, formatting,
Help lint and diff checks passed. A real Chrome 154 fixture used the production
probe and capture function
on home and 404 pages at all five widths: both serial and parallel runs returned
ten screenshots and ten measurements, retaining deliberate clipped-text
findings. Sequential capture took 15,465 ms; two lanes took 9,319 ms (~40% less
wall time). This is one local fixture measurement, not a production theme ETA.
The local PostgreSQL cluster was unavailable; a deployed end-to-end run is still
required to validate actual provider latency and database/worker integration.

Roll out the web app and rebuilt capture job together (`qa.buildId` is part of
the automatic claim/finish protocol), add the independent minute QA scheduler,
and shorten the capture schedule to one minute. Older queued visual-QA evidence
without an acceptance binding fails closed and can be recovered with **Images →
Retry automatic QA** (since TS-2, **Check again** on the theme page). No schema migration is required. Verify a new generation
and a revision in dev, including concurrent projects and a failed gate, before
production rollout. No merchant-visible change, no Help Centre update.
