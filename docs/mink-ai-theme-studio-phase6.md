# Mink AI Theme Studio: Phase 6 publication and rollback

> **★ ONE STEP, ON TODAY'S EVIDENCE. Read this first.** Publication is ONE
> superadmin step, and no step needs a second person. The two-chair human
> scorecard and the separate approval of the original design ended on
> 3 Oct 2026 (migration `20261003_0151_theme_studio_single_step_publish`;
> §2 is their short history). Since wave TS-1 (24 Oct 2026) a theme is Ready
> to publish (`candidate`) once its automatic checks leave no serious
> finding and its design review passes, with smaller findings kept as
> warnings ("Fix it, then allow Publish"; `docs/theme-acceptance.md` §5).
> Publish needs a check run and a design review made together on today's
> StoreMink build; when they are older, or the newest check has no review of
> its own, Publish starts a re-check on today's build instead (about 3 to 5
> minutes, in the capture job, no tab to keep open) and the operator presses
> Publish again once it passes. "Try again" on a publish that did not finish
> follows the same rule. The confirmation is an in-app dialog naming the
> version, the reach and the warnings that go live. `approved` survives only
> as the state a publish that did not finish waits in; the screens call it
> **Publish didn't finish**. `theme_studio_reviews` is kept and no longer
> written, and no `project_approved` event is written for new publishes.
>
> **Since 25 Oct 2026 (wave TS-2) the release screen is gone.** Publish and its
> dialog (it names the design and when it was made) sit in the theme page's
> header, the live panel offers **Stop offering this theme** or **Offer
> again** and **Start a new theme from this brief** (there is no release
> picker or Restore button; the server's restore stays for live updates), and
> `…/release` redirects to the theme page's Log tab, which holds Publish
> history and the catalog audit. `docs/operator-console.md` describes today's
> screens; the sections below keep the record.

Phase 6 turns a theme that is Ready to publish into a theme merchants can
install:

1. Theme Studio's automatic checks and design review make it Ready to
   publish (Phase 5 and the automatic QA in `CODEBASE.md`);
2. one superadmin presses Publish, which stores an immutable release, then
   seeds and checks its demo store, then exposes it in the theme catalog
   (themes.storemink.com) and every store's Theme library;
3. hide, show and restore change what **new** stores can pick. A store that
   already installed the theme keeps its exact version.

It is operator-only: nothing a merchant, their staff or a shopper does
changes, so there is no Help Centre migration. A published theme simply
appears in the existing catalog and Theme library, which are already
documented. Plan: `docs/mink-ai-theme-studio-plan.md` §3.4, §7.3, §8 and §10;
the TS-1 changes: `revamp-handoff/tasks/theme-studio-plan.md` (outside the
repo).

## 1. What an operator sees

Since TS-2 (25 Oct 2026) there is no release screen: everything below sits on
the theme page (`/dashboard/themes/studio/<id>`), and `…/release` redirects to
its Log tab.

- **Publish.** A theme that is Ready to publish shows **Publish** in the theme
  page's header (on a phone also in the bar at the bottom); a publish that did
  not finish shows **Try again** with the last attempt's reasons beside it.
  Publish opens an in-app dialog that names the design and when it was made and
  the reach (the theme catalog on themes.storemink.com and every store's Theme
  library, with a live demo store; stores that install it keep that exact
  version), and lists the warnings that go live, in words. When the checks are
  not from today's StoreMink build, or the newest check has no design review of
  its own, the dialog says so and its button reads **Re-check now**. A re-check
  is news, not an error: the theme then reads **Checking on today's StoreMink
  build**, and the operator can leave and come back. When the operator is
  looking at another design, the dialog says which design goes live and opens
  the Design list. While an attempt runs, the header shows its steps and no
  button. Anything a package rule refuses (a placeholder image, a finding from
  the production theme validator) is written under the button instead.
- **Live theme.** Shown whenever a published release exists: **Open live demo**,
  **Stop offering this theme** (it also leaves the Theme library of every store
  that has not installed it) or **Offer again**, each behind a dialog, and
  **Start a new theme from this brief**, because live themes can't be changed
  yet. There is no release picker or Restore button (a project has one release
  today; the server's restore stays for live updates). The audit records a plain
  sentence as the reason, and every change is written to it.
- **History.** The Log tab holds the publication attempts with their reasons,
  and the catalog audit.

## 2. History: two reviewers and a separate approval (25 Sep to 3 Oct 2026)

The original Phase 6 had two superadmins score a candidate on the eight
`scorecard.ts` rows (a product/design chair and a commerce/QA chair, one of
them not an author), a third step to approve it, and a typed theme id to
publish. Migration 0134 enforced it: `theme_studio_reviews` with the bar as a
CHECK, one review per chair, one chair per person, reviews bound to a passed
check run, and a project guard that needed both approving chairs to enter
`approved`. The owner found it too complex, and it was redundant: a theme
that is Ready to publish has already passed the automatic checks and the
automatic design review on the same eight rows. On 3 Oct 2026 migration 0151
replaced the guard (entering `approved` needs a passed check run over the
current version's exact package) and `submitThemeStudioReview`,
`approveThemeStudioCandidate`, `validateScorecard` and `approvalReadiness`
were removed. Production runs 0151 (its migration ledger, read on 23 Oct
2026). The empty `theme_studio_reviews` table and the `review_submitted` and
`project_approved` event types are kept, because events are append-only;
nothing writes them now, and the screens hide old rows of them. Since TS-1C
(24 Oct 2026) the unused `themeStudioReviews` export is gone from
`drizzle/schema.ts`; the table stays.

## 3. What Publish checks first (24 Oct 2026)

`currentPublishEvidence` (`lib/theme-studio/acceptance.ts`) decides whether a
theme can publish now:

- the newest check run of the current version that reached a verdict must
  have passed, over the version's exact package and pictures (a newer failed
  check is never outweighed by an older pass);
- it must have run on today's StoreMink build;
- a passed final design review must be bound to that very run (same package
  and build), so the in-browser runner's checks never publish directly.

Otherwise the answer is `old_build`, `no_review` or `none`, nothing is
written, and Publish queues the re-check (`queueThemeStudioRecheck`, reason
`publish_recheck`) outside the publish transaction. The re-check measures the
same design again in the capture job, in place for a version that passed,
with its repair rounds already used up, so it can never buy a paid
redesign. With the automatic checks off (local development only) the review
is not asked for, and old evidence is refused as before. Stored findings are
never judged again: a passed run's warnings are recorded with the publish,
and only the package itself can refuse (`publicationBlockers`).

## 4. Publication

`publishThemeStudioProject` follows plan §8, in this order:

1. **Lock and re-read.** Lock the project and the theme id. Refuse unless the
   project is Ready to publish (`candidate`) or waiting after a publish that
   did not finish (`approved`), and the revision matches. Refuse a package
   `publicationBlockers` blocks, and a publish still running. Then ask
   `currentPublishEvidence`: the newest check run must have passed on today's
   build with a passed design review bound to it. If not, nothing is written,
   and Publish starts a re-check on today's build instead (about 3 to 5
   minutes), for a first publish and a retry alike (owner decision 4,
   24 Oct 2026). Otherwise move `candidate` to `approved` (no
   `project_approved` event; one click is one `publication_started` line,
   which records the check run, the design review, the rules version
   `severity-v1` and the warnings accepted).
2. **Write the attempt.** Insert a `theme_studio_publications` row
   (`publishing`), and allocate the version with `nextReleaseVersion`: 1.0.0
   first, then the next minor, never reusing one. A failed attempt of the
   same version that already stored a release is **resumed**: the release row
   is immutable, and rebuilding it on another day would change its release
   date, its digest, and collide with itself. An attempt still `publishing`
   after 15 minutes is treated as abandoned.
3. **Build the release** (`buildPublishedPackage`, pure):
   - every `theme-asset://<slot>` path becomes that slot's public object;
   - the release is `published` and dated in India time, noting the source
     version;
   - the catalog entry is `public` and the demo `healthy`;
   - it must pass the package contract and the production validator.
4. **Promote images.** Each image is read from the project's stored `image`
   asset and its bytes re-hashed against the package's digest. It must be
   WebP. It is then uploaded to
   `theme-releases/<theme>/<version>/<slot>-<sha16>.webp` with a one-year
   immutable cache header.
5. **Store the release** in `theme_releases` (`source = 'theme-studio'`)
   through the registry's own validated insert, and record it on the attempt.
6. **Seed the demo.** Create or reset `demo-<theme>`, seed it from the exact
   release (zero seeding errors), and render `/`, `/shop`, one product and
   `/cart` over loopback — the same technique acceptance uses. Each must be a
   themed 200.
7. **Expose it.** In one transaction:
   - upsert the catalog entry (public, this release);
   - write the `publish` audit row;
   - mark the attempt `published`;
   - move the project to `published` (the guard requires that publication);
   - record `theme_published`.
8. **Invalidate caches** with immediate expiry: the registry, stores, pages,
   products, categories and chrome.

★ **Exposure is the last step.** A release row nobody points at is invisible
to the Theme library and the public catalog. So a failed demo leaves nothing a merchant
can see, and the retry resumes the same release. `visibility: public` and
`demo: healthy` are written into the immutable package before the demo is
seeded. That is safe because the catalog **pointer** is what decides exposure,
and it is written only after the demo renders.

★ **A refusal before the attempt row is a thrown error, and evidence that is
not today's is a re-check. A failure after it is recorded.** Publish answers
`kind: "rechecking"` (with the capture it queued and one sentence) when it
starts a re-check, and `kind: "failed"` with the attempt's reasons (at most 20) when an attempt fails. The project stays `approved`, the screen reads
**Publish didn't finish**, and **Try again** resumes the stored release.

## 5. Rollback

`changeThemeStudioCatalog` takes one of three changes, each with an optional
reason (a blank one records a plain sentence):

- `hide` — visibility becomes `hidden`;
- `show` — visibility becomes `public`, only for a published release whose
  demo is healthy;
- `select_release` — points the catalog at another **published** release of
  the same theme.

Each change writes an audit row and a project event, and expires the caches.

★ **No action here touches an installed store.** Every store pins its theme
id and exact version in `stores.settings.theme`, and an exact pin keeps
resolving while its release is published. Hiding a theme stops new installs;
it does not re-skin anybody. Forcing existing stores onto another release is
out of scope (plan §8), because it could overwrite merchant-edited content.

A Studio project publishes one release line (`published → archived` is its
only exit), so `select_release` matters once a theme has several releases. It
is built now so rollback does not wait for that.

## 6. Decisions worth knowing

- **Images live in the media bucket, under their own root.** The package
  contract admits exactly one kind of https path:
  `https://storage.googleapis.com/<bucket>/theme-releases/<theme>/<version>/<slot>-<sha16>.webp`.
  The theme id must be the package's, the version the release's, the slot the
  asset's, and the digest prefix the asset's own. An arbitrary URL, or
  another theme's object, is refused by the contract rather than by a caller
  remembering to check.
- **No store's clean-up may delete a published image.** Seeding copies the
  URL into a merchant's product and page rows. Every orphan sweep would
  otherwise read "a URL in our bucket this store no longer uses" and delete
  an object the theme, and every other store on it, still renders.
  `deleteStorageUrls` therefore skips any `theme-releases/` path
  unconditionally — even with no tenant scope, even in the platform store
  purge — and counts it as `shared`.
- **Publication needs today's evidence (since 24 Oct 2026).** A check run
  from an earlier StoreMink build, or one with no design review bound to it,
  is never published. Publish, and Try again, measure the design again on
  today's build first, in the capture job, and the operator publishes once
  it passes. Publication itself never writes an acceptance row, so old
  browser data is never stored under a new build id.
- **The demo store is recorded, not referenced.** `demo_store_id` is not a
  foreign key. Every store foreign key cascades (migration 0014), and a
  cascade would delete an append-only audit row along with the store.
- **Generated pages always get an SEO description.** The draft schema lets a
  model leave one null, and the production validator needs 20+ characters on
  every page. So a generated theme could pass everything else and fail
  acceptance for a sentence it was never asked for. The compiler now fills a
  missing description from text the draft already has: the page title, the
  theme name and the theme's description. It never invents copy.

## 7. Schema — migration `20260925_0134_theme_studio_publication`

- **`theme_studio_reviews`**: one scorecard per chair per acceptance run,
  bound by trigger to passing evidence, and immutable. Empty and no longer
  written since 3 Oct 2026; kept, because dropping it gains nothing.
- **`theme_studio_publications`**: one row per attempt.
  - One attempt `publishing` at a time, and one `published` ever, per project.
  - A lifecycle CHECK: completion matches status, a published row names its
    release, and the release and its digest arrive together.
  - A guard: final rows are immutable apart from the operator-removal
    `created_by → NULL`; the release may be set once; no deletes.
- **`theme_catalog_audit`**: append-only, one row per publish, hide, show or
  release selection.
- **Project guard** (replaced here, and replaced again by migration 0151 on
  3 Oct 2026):
  - 0134: entering `approved` needed the latest passing run to carry an
    approving design review, an approving commerce review, one of them
    independent, and no rejection; since 0151 it needs a passed check run
    over the current version's exact package, and no review;
  - an approved project cannot change its version in place;
  - entering `published` needs a published publication of that version.
- **Events**: `review_submitted`, `project_approved`, `publication_started`,
  `publication_failed`, `theme_published`, `catalog_visibility_changed`,
  `catalog_release_selected`. The first two are no longer written (the events
  rule still allows old rows, and the screens hide them).

All three tables are service-only (RLS on; `app_user` holds nothing), and
`app_service` cannot update a review or the audit.

The migration is additive for the revision being replaced, which never moves
a project into `approved` or `published`. It is applied locally, and the
local drift baseline is refreshed.

## 8. Code map

| File                                                                           | Role                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/theme-studio/scorecard.ts`                                                | the eight rows, the bar, the rejection conditions and which are serious, the very-low-score limits; no imports, client-safe                                                              |
| `lib/theme-studio/publication-core.ts`                                         | pure: `publicationBlockers` (`{ blocking, warnings }`), the publish warning log, versions, the published-package builder, catalog changes                                                |
| `lib/theme-studio/publication.ts`                                              | server-only: one-step publish (a re-check first when the evidence is not today's), catalog changes, read model; publication I/O injectable (`PublicationDeps`)                           |
| `lib/theme-studio/acceptance.ts`                                               | `currentPublishEvidence` / `publishEvidenceWithDb` (may this theme publish now); `verifyCandidateEvidenceWithDb` (transaction-aware)                                                     |
| `lib/theme-studio/capture.ts`                                                  | `queueThemeStudioRecheck`: the re-check Publish starts                                                                                                                                   |
| `lib/themes/runtime-registry.ts`                                               | `insertThemeReleaseWithDb` and `loadExactReleaseWithDb` now exported                                                                                                                     |
| `lib/theme-studio/contracts.ts`                                                | published release image paths, pinned three ways                                                                                                                                         |
| `lib/storage/paths.ts`, `lib/storage/cleanup.ts`                               | `THEME_RELEASE_OBJECT_ROOT`; sweeps never delete one                                                                                                                                     |
| `app/actions/theme-studio-actions.ts`                                          | superadmin-gated adapters; publish answers `published`, `failed` or `rechecking`                                                                                                         |
| `…/studio/[projectId]/release-controls.tsx`, `…/release/release-workspace.tsx` | since TS-2 the theme page header's release controls: the Publish dialog, the publishing steps, Try again with its reasons, the live panel; `…/release/page.tsx` redirects to the Log tab |

## 9. Production runbook

Before the first production publication:

1. **Apply migrations 0134 and 0151.** The pipeline applies them before
   deploy; production runs both.
2. **Confirm `GCS_BUCKET` is set** on the service. Without it, publication
   refuses with "Media storage is not configured". Confirm the runtime service
   account can write objects under `theme-releases/`. The bucket is already
   public-read, as all media is.
3. **Confirm the loopback render works**: acceptance's server stage uses the
   same path. If the server is not reachable at `127.0.0.1:$PORT`, set
   `THEME_STUDIO_ACCEPTANCE_ORIGIN`.
4. **One superadmin.** No step needs a second person; whoever built the
   theme may publish it.
5. **Measure design-review prompt v7 first** (plan step A2, after the TS-1
   release, with the owner's OK): run the 20-page fixture benchmark live once
   (`npm run theme-studio:visual-fixtures -- --live --yes`, about $0.50 to
   $1.50; it reads no production data). It must pass graded on findings:
   every serious page produces its serious finding, both warning pages at
   least a warning, and at least 9 of 10 clean pages no serious finding.
   ⚠ Until it passes, nobody presses Publish or Check again on an existing
   production theme, because each runs reviewer v7 live. Then one Check again
   on an existing finished theme (plan step A4) proves the on-demand capture
   start and v7 in production. Themes are never built on dev.
6. **Publish**: open the theme; once it reads Ready to publish, press
   **Publish** in its header. Read the warnings the dialog lists before
   pressing **Publish now**. If the button reads **Re-check now** (StoreMink
   was updated since the checks, or the newest check has no design review of
   its own), press it, leave the page if you like, and publish once the theme
   is Ready to publish again (about 3 to 5 minutes).
7. **After publication**: open the demo store; confirm the theme appears in
   the catalog and in a store's Theme library; create a fresh store on it and
   confirm `settings.theme` pins the release. If anything looks wrong,
   **Stop offering this theme** (the theme page's live panel) is immediate
   and harmless to stores that installed it.

**Emergency switches** (environment variables on the web service, set with
`gcloud run services update --update-env-vars`, no build; the next deploy
replaces the whole environment and drops them unless they are added to
`cloudbuild.yaml`): `THEME_STUDIO_GENERATION_ENABLED=false` stops new runs
(viewing, cancel, Stop and archive keep working), and
`THEME_STUDIO_DISABLED_MODELS=<model key>` switches off one model. Switching
off `gemini-3.8-flash` also switches off the per-photo check, which merchant
storefront redesigns share: their photos then stay unreviewed, and a Theme
Studio theme with unchecked photos stops at its final check. See
`CODEBASE.md` §7.

To undo a publication entirely: stop offering it (the catalog's hide). The
release row, the images and the audit are permanent records and are never
deleted.

## 10. Verified, and not

**Since 24 Oct 2026 (TS-1C), a committed rollback-only regression:**
`lib/theme-studio/publication-postgres.test.ts`
(`THEME_STUDIO_RECOVERY_DB_TEST=1`, against `storemink_local`) covers publish
with warnings, a failed demo and its resume, a stale tab, live and abandoned
attempts, hide and show, the re-check before Publish and Try again, a newer
failed check beside an older pass, and the in-browser runner (its checks
never publish without a design review bound to them).
`lib/theme-studio/frozen-releases.test.ts` re-reads the stored releases the
renderer checks, so a contract change cannot un-theme a published theme
unnoticed.

**Verified against the local database and the running dev server on
25 Sep 2026** (a scratch end-to-end test, not committed; its review rules are
history, see §2):

- **Setup.** A project was generated with the offline provider. A publishable
  version was attached: a bundled theme's content as a generated package,
  with every slot an operator image stored for the project. Passing evidence
  was recorded directly; the browser stage was not driven.
- **Review rules** (the two-chair design, removed on 3 Oct 2026).
  - A below-bar approval was refused.
  - The author's design review was stored as _author_.
  - The same person was refused the second chair.
  - Approval was refused without a commerce review.
  - A commerce rejection made the theme unapprovable on that evidence.
  - New evidence cleared the old reviews.
  - Superseding evidence with no reviews was refused **by the database**,
    even though an older run carried two approving reviews.
  - Two approvals on the new evidence then approved it.
- **Publication.**
  - A wrong confirmation was refused.
  - A demo check reporting a 500 failed the attempt. No catalog entry was
    written, and the project stayed `approved`.
  - The retry resumed the same 1.0.0 release.
  - The demo store rendered `/`, `/shop`, a product and `/cart` from the dev
    server as themed 200s.
  - The project became `published`. The theme appeared in the public catalog
    at `themes.localhost` with its demo link.
- **Install and rollback.**
  - A fresh store installed it and pinned 1.0.0.
  - Hiding it removed it from the catalog while the fresh store still
    resolved 1.0.0.
  - Showing it restored it.
  - The audit read `publish, hide, show`, and the attempts read
    `failed, published`.
- **Offline provider gaps found.** The first run found two things the
  offline provider's minimal theme gets wrong: an empty homepage SEO
  description and too few homepage sections. The first is fixed in the
  compiler for every generated theme; the second is by design (see §11).
- **Database probes.** In a rolled-back transaction, each of these was
  refused by the database:
  - an approval with a 3, an approval with a rejection ticked, and a
    rejection with no reason;
  - a second review for the same chair, and a review with a forged evidence
    digest;
  - editing or deleting a review;
  - editing or deleting a finished publication, two publications in flight,
    and a published row with no release;
  - editing the audit;
  - marking a project published without a publication, and an approved
    project changing its version.

**Not verified:**

- **The Publish dialog and the live panel in a browser** (since TS-2 in the
  theme page's header). They are behind the superadmin login, which was not
  entered; the real-browser pass follows wave TS-2. They typecheck and lint;
  their actions and components are unit-tested.
- **A real GCS upload.** The e2e injected storage, to keep test objects out
  of the shared bucket. The upload call is the same `gcsUploadObject` media
  uploads already use.
- **A live publication since TS-1.** It needs real model runs, which are
  paid; the live design-review benchmark, one Check again and one new theme
  come after the release, each with the owner's OK (§9 steps 5 and 6).
- **A production build.**

## 11. Known limits

- **The offline provider's theme cannot be published.** It is too thin for
  the production validator (three homepage sections, "Placeholder copy from
  the test provider"). That is correct: it exists to exercise the pipeline,
  not to be a theme.
- **Only the attempt row records a failure.** An attempt that fails between
  storing the release and exposing it leaves an unexposed release row. That
  is harmless, and it is what the retry resumes.
- **No automatic retry.** A failed attempt waits for an operator.
- **Images are WebP only.** Slot uploads always produce WebP. A future AVIF
  path would need the published-path pattern widened.
