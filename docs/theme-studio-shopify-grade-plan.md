# Theme Studio — Shopify-grade themes that look different from one another

> **Status:** Proposed 2026-10-08. Supersedes nothing; extends
> `theme-studio-variety-and-fidelity.md` (Tracks V/R/F) and
> `theme-parity-plan.md` with two owner decisions taken 2026-10-08:
> (1) the model may author a **validated, scoped theme stylesheet** in
> addition to package data; (2) product, collection, blog and account pages
> become **section-composed templates**. The cart stays a layout variant.
> Reliability is proven on the current vocabulary **before** the vocabulary
> grows.
>
> **Progress (2026-10-08):** Phase 0 guards 1–2 landed (manual-acceptance
> visual-QA gate; storefront `error.tsx` + per-section boundary). Guard 3
> (default spend ceiling) is dropped by owner decision — no ceiling, matching
> `config.ts`'s 2026-09-29 note. Phase 1 item 2
> landed early (deterministic copy floors + brief-aware claims check); the
> closing-newsletter case became a renderer fix, not a floor.
> Phase 1 item 1 is built but not yet run live: `visual-qa-request.ts`
> (pure request builder), `visual-fixtures.ts` (10 defect + 10 clean pages)
> and `npm run theme-studio:visual-fixtures` (offline mechanism check passes
> for all 20; `--live --yes` grades the reviewer at the 90% bar). Phase 1 item 3
> landed: the probe opens the menu drawer, search sheet, cart drawer, account
> menu and sign-in dialog on the home page and audits each
> (`studio-acceptance-states.ts`), keeps axe's unresolved-contrast nodes as
> reviewer evidence, the coverage gate fails on a state that would not open or
> close, and the offline contrast script covers header × drawer combinations.
> Phase 1 item 4 landed behind `THEME_STUDIO_PERFORMANCE_REQUIRED` (default
> false): the 3.0 s / 0.1 thresholds at phone390 and desktop1440, renderer
> routing of a failure, and the probe fix that freezes LCP/CLS before its
> scroll-through are in; the flip waits for one live batch of frozen numbers,
> because the Oct 4 figures (LCP to 25.9 s, CLS to 1.38) measured the
> scroll-through, not the page. Phase 1 item 5 landed: `getPublishedPage`
> validates `published_sections` on read (`salvageSections`, draft-mode rules
> per section, each drop logged). Phase 0 items 1, 2 and 4 (deploy, route,
> re-benchmark) are ops and still open. Phase 2a landed: 31 fonts and a
> 26-pairing library in `lib/themes/fonts.ts`, chosen by Stage B under prompt
> v25 (measured: about 5 KB gzipped more font CSS per page, no font bytes
> until used, build 59 s locally); the Phase 2 exit (every new vocabulary item on a hand-authored
> exemplar) waits for 2b–2e. A slice of 2d landed on 2026-10-09 by owner's
> rule ("a full picture on the homepage carousel just like Shopify"): the
> `fullbleed` hero variant (photo fills the band, copy over it) and prompt v26,
> under which every new theme opens with a `hero_carousel` or a fullbleed hero
> at full width (`lib/theme-studio/opening.ts`, checked in generation only;
> revisions keep their base's opening). The rest of 2d (stacked, offset-card,
> collage, text-only, video, carousel-split heroes; the transparent-sticky
> header that would float over this opening) is still open. v27 (same day)
> makes that opening a two- or three-slide `hero_carousel` with arrows and
> dots; the first live v26 run on Bubble stopped before artwork on four
> shared-chrome renderer defects, all fixed (CODEBASE §11), which is the kind
> of stall Phase 1's "reliability first" exists to remove.
> v28 (owner's decisions, same day): a Stage A brief may allow adults where
> the picture is about the product being worn or used, with the provider,
> prompt and reviewer following that one choice; wide slots are stored at
> 2400px and up to 1000 KiB. Phase 2b landed (same day, prompt v29): a block
> registry (`SECTION_BLOCKS`) over every list-shaped section, media_text
> stories, the new `accordion` and `comparison` sections with typed rows, one
> shared builder block list (adopted by usp_bar, tile_grid, testimonials and
> the new sections), the Studio vocabulary gated so pre-v29 requests replay
> byte for byte, and renderer fixtures for the new markup at the five widths.
> Not yet run against live Gemini; the 2b exit (every new item on an
> exemplar theme per direction) is folded into the Phase 2 exit. Phase 2c,
> first slice (same day, prompt v30): seven of the fourteen candidates
> landed — multicolumn, image marquee, image hotspots (Bubble's gap),
> before/after, product spotlight, logo strip and countdown (the last two
> builder-only) — plus the tile grid's collage layout, each with builder
> form, thumbnail, validator, renderer fixtures and prompt vocabulary. Of
> the rest: comparison table landed in 2b; lookbook is the gallery's
> editorial layout; the video-background hero exists (`hero.video_url` on
> every variant); split banner duo is a two-column tile grid; collection
> list is `shop_by_category` in cards. Still open from the pool: the
> announcement bar, which belongs in the header group above the header
> (chrome, not a page section — the v27 opening rule puts the carousel
> first on the homepage), and a true collection list with descriptions.
> Phase 2d, first slice (same day, prompt v31): nine variants — hero
> `stacked` and `offset`, header `transparent` (the owner-flagged gap: the
> bar floats over the opening photograph with its controls in the colour
> that reads over it, solid once scrolled) and `hamburger`, cards
> `centered`, `soft` and `wide`, footers `centered` and `compact` — each a
> CSS treatment of existing markup, in the builder selects, the package
> contract and the Studio vocabulary (gated so v30 requests replay byte for
> byte), with the offline checks widened to cover them. Of the plan's list:
> collage is the tile grid's collage layout, text-only is a minimal hero
> without media, video is `hero.video_url`. The second slice (same day,
> same prompt version, unused by any run) closed the list: the split
> carousel (`hero_carousel.layout: "split"`, copy beside the photo, never
> the homepage opening) and the `stacked` (logo centred, menu below) and
> `utility` (double row) headers, which needed the header fit rule to judge
> rows rather than one line. Not yet run against live Gemini.
> Phase 2e, first slice (same day, prompt v32): the product and collection
> pages compose from `templates` (an optional `preset.templates`, no schema
> bump) — a gallery shape and the ordered blocks of the information column
> (price, options, buy box, description, delivery, share, trust row,
> accordion, rich text, then reviews, recommendations and the sticky bar)
> for the product page; filters placement (sidebar, drawer, top-bar), paging
> (load more, numbered pages, infinite) and promotional tiles for the
> collection page — rendered by the block renderers in
> `product-detail-client.tsx` and `shop-client.tsx`, overridable per store
> in the Brand row, written by Stage B under v32 and normalised by the
> compiler; `productDetail` gains `stacked`. The second slice (same day,
> same prompt version) closed the field: the `size_guide` block, the blog
> template (index grid / list / featured; article narrow / wide / sidebar),
> the account template (plain / tabs / sidebar, plus a scheme) and
> `renderer.minVersion` enforced in the runtime registry. Schema v3 was
> not needed: `templates` is an optional field and `defaultTemplates`
> reproduces today's pages, so the "v2→v3 migration" is a pure function and
> every published release round-trips unchanged. Not yet run against live
> Gemini; the 2e exit's hand-authored exemplar per direction is folded into
> the Phase 2 exit. Out of 2e by decision: cart templates (the cart stays a
> layout variant); the fingerprint axes for templates are Phase 3.
> **Phase 2 closed offline (same day; v32 extended in place, unused by any
> run).** The two 2c candidates left open landed: the announcement bar
> (header chrome, `preset.announcement` + `HeaderConfig.announcement`,
> rendered in the fixed header's top border so the reserved height includes
> it) and the collection list (`shop_by_category.display: "list"`, rows with
> descriptions). The exit evidence exists: seven hand-authored exemplar
> themes, one per design direction (`lib/themes/exemplars/`, hidden drafts
> borrowing the bundled themes' photography through linked folders), each
> using every vocabulary item 2a–2e added, held by `exemplars.test.ts` to
> the content floors, copy floors, contract, opening rule and visible-choice
> vocabulary, and by `npm run theme-studio:exemplars` to the real package
> gates (6/6 pass for all seven) and, against a local server, to the route,
> link and markup gates and the probe's deterministic browser rules at the
> five widths (see CODEBASE §11 for what that run found). Seeding them as
> stores found a Phase 2e defect before any browser ran: `templateIssues`
> compared with `JSON.stringify`, so a stored package with `templates` was
> refused by the registry's parse and rendered un-themed; the comparison is
> key-order independent now (`lib/themes/canonical-json.ts`) and every
> exemplar's package is validated through a jsonb-shaped re-order. The
> browser run itself found nine shared-renderer defects, none a theme
> setting (CODEBASE §11 lists them: the transparent header's tone rule
> reaching the drawer, the collage's fixed row height, the promotional
> tile's inverted `theme`, four small-text labels on faint or accent
> colours, two aria-hidden clones with focusable links), and one gap in
> the contract: the 3:1 on-accent floor lets a candidate through whose
> every button label fails axe at 4.5:1, so the Studio now holds
> `button_label_contrast` at compile time and in the package gate. With
> those in, all seven exemplars pass every gate the script runs. Still open, and
> needing a deploy: the deployed acceptance run per exemplar (LCP/CLS, the
> probe's clipped-text scan, the chrome states through the real probe) and
> one live Gemini batch under v32, which is also where the 2a–2e prompt
> bullets get their first live reading.
> **Phases 3 and 4 built offline (22 Nov 2026, prompt v34; owner: "build
> step 3, the per-theme style rules ... all the themes should not look
> same").** Phase 3: the scoped theme stylesheet as structured data
> (`lib/themes/stylesheet.ts`: 60 hooks, 32 properties, closed value scales,
> colour only as readable pairs checked against the theme's palette and its
> section schemes), written by Stage B as `stylesheetJson`, compiled under the
> storefront root and served by the layout; a stylesheet's faults are repair
> issues and are salvaged on the last attempt, never a failed theme. The
> exit evidence: the seven exemplars re-styled by hand
> (`lib/themes/exemplars/stylesheets.ts`), all passing the package gates and
> `npm run theme-studio:stylesheets` (every rule in effect over the
> production CSS in local Chrome, contrast clean, no sideways scroll), and a
> 10,000-case random and hostile test that nothing compiled leaves the
> storefront root. ⚠ One exit number was NOT met on purpose: two themes that
> share every layout pick and differ only in stylesheet score 0.28, not the
> 0.45 written above. Reaching 0.45 would need styling to outweigh every
> layout axis together, and a catalogue of themes that differ only in styling
> is one theme in several hands; styling is a quarter of the score when both
> themes carry rules, and one of eight major axes. Phase 4 items 1 to 3:
> layout commitments (`commitments.ts`, a new theme is handed what its
> direction allows and the catalogue uses least), fourteen design directions
> (`STUDIO_DESIGN_DIRECTIONS`; the redesign keeps its seven), the fingerprint's
> styling axis, and publication blocked under 0.50 against the public
> catalogue. Still open: the first live Gemini batch under v34 (which is also
> where Phase 4's exit, G4, is measured), the blind test (item 4), a builder
> panel for the rules, and exemplars for the seven later directions.
>
> **Audience:** StoreMink platform engineers and the owner. Not merchant-facing.

## 0. Where we are (evidence, not opinion)

| Fact                                                                              | Source                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 5/8 fresh briefs reached candidate; 2/8 without an automatic revision             | `theme-studio-live-benchmark-2026-10-04.md`                   |
| Median 68 min to candidate; 7 OOMs at 1 GiB; 11–19 min idle queue waits           | same                                                          |
| All 3 failures were rendered-surface contrast the package could not repair        | same, P1 #2 / #4                                              |
| Visual QA saw the homepage at 55 px wide and scored it 5/5                        | same, P1 #5                                                   |
| Every draft chose `pageWidth: wide` + `cardHoverImage: true`; Track V exit failed | same, §Commerce and variety                                   |
| 2/6 existing Studio themes pass on the current build                              | same, §Existing eight-theme regression                        |
| All five P1 fixes are implemented locally, **not deployed, not re-benchmarked**   | `theme-studio-worker-rollout.md` status line; commit f3775d45 |
| Screenshot-reference benchmark has never been run                                 | `theme-studio-reference-benchmark.md`                         |
| Manual acceptance path moves `ready → candidate` without a visual-QA verdict      | `lib/theme-studio/acceptance.ts` ~508–548                     |
| No `error.tsx` under `app/(storefront)`; `published_sections` cast unvalidated    | `lib/storefront/queries.ts` ~315–343                          |

### Why themes look alike — the real cause

The model does not choose layouts; it chooses from enums. Header 4 variants,
card 5, PDP 3, cart 3, footer 3, page width 4, hero 3, 9 fonts (2 expressive),
17 sections with no nested blocks, and product/collection/blog pages are code
routes a theme can only tint. Two themes with the same enum picks are the same
skeleton in different paint. Prestige and Impulse look different because their
**markup** differs. Prompt tuning cannot widen a choice space this small; only
the renderer can.

## 1. Goals

| #   | Goal                                         | Measure                                                                                                            |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| G1  | Reliable completion                          | Two consecutive fresh 8-brief batches at **8/8 candidates**, 0 OOMs, 0 false quality passes                        |
| G2  | Fast and affordable                          | Median ≤ 25 min brief → candidate; ≤ US$4 per theme including images                                               |
| G3  | Shopify-grade surface                        | Product, collection, blog, account composed from blocks/templates; ≥ 30 sections; ≥ 30 fonts; scoped stylesheet    |
| G4  | Themes look and feel different               | 8 fresh themes: median pairwise distinctness ≥ 0.60; no non-required setting shared by > 50%; blind human test 8/8 |
| G5  | Reference fidelity (existing Track F target) | ≥ 85 median on the golden reference set                                                                            |
| G6  | Safe by construction                         | Still no executable model output; stylesheet is structured data validated before compile                           |

Non-goals: a template language, app blocks, third-party theme developers,
metafields, localisation, cart templates (cart stays `classic/grocery/compact`;
parity 1.9 drawer upsell is unchanged).

## 2. Phases

Durations assume one engineer full-time plus the owner reviewing benchmarks.
Two engineers roughly halve Phases 2–4, which parallelise cleanly.

### Phase 0 — Ship what is already built (weeks 1–2) · reliability

Nothing new is written here except three small guards. Everything else is
deploy-and-prove.

1. Deploy `f3775d45` web + capture + private workers via the existing Cloud
   Build path; apply migration `20261004_0154`.
2. Verify Cloud SQL `SHOW max_connections`; run
   `scripts/theme-studio-workers.py --plan` then `--route-schedulers` for dev,
   then prod (`theme-studio-worker-rollout.md` §Release and capacity gate).
3. Guards (new code):
   - **Close the manual-acceptance bypass.** `startThemeStudioAcceptance` must
     require a passing visual-QA verdict on the same digest/build before
     `candidate`, or the operator records a human scorecard row. Fix the
     comment in `publication-core.ts` to match what is enforced. (Closed on
     2026-10-08 by requiring the review; the human scorecard had been removed
     on 3 Oct. Since 24 Oct 2026 Publish also needs a passed review bound to
     the very check run it publishes.)
   - **Storefront error boundaries.** `app/(storefront)/error.tsx` plus a
     per-section boundary in `homepage-section-renderer.tsx` so one bad
     section config degrades to nothing, never a blank store.
   - ~~Default spend ceiling~~ — **not wanted** (owner, 2026-10-08, confirming
     the 2026-09-29 "no limitation in terms of cost" decision recorded in
     `config.ts`). `THEME_STUDIO_DAILY_SPEND_USD` stays opt-in.
4. Re-run the same eight briefs (`npm run theme-studio:benchmark -- --create
--repeats=2 --concurrency=2`). Save as
   `evals/theme-studio/full-live-<date>.json`.

**Exit:** 8/8 candidates, 0 OOM/503, median < 40 min, queue waits < 3 min,
zero duplicate settlements. If not met, fix and repeat before Phase 1.

### Phase 1 — Trustworthy quality signal (weeks 3–4) · reliability

The LLM reviewer is the only judge of design quality, and it has never been
proven able to see a defect. Make the signal honest before the surface grows.

1. **Defect fixture benchmark for visual QA.** Ten known-bad packages
   (duplicate newsletter, cut-off chandelier, white-on-gold hero, invented
   award copy, placeholder lorem, 55 px thumbnails, etc.). The reviewer must
   flag ≥ 9/10 and pass ≥ 9/10 known-good fixtures. Runs in CI against the
   fake provider for shape and on demand against Vertex for judgment.
2. **Deterministic checks for what should never need a model:** duplicate
   section signatures on one page, lorem/placeholder phrases, claims
   vocabulary ("award-winning", "as seen in", "#1") absent from the brief,
   empty `image_alt`, headings > N words. Added to `package.content`.
3. **Rendered-surface contrast everywhere.** Extend the browser probe to
   every text node in the six surfaces, not only sampled selectors; keep
   4.5/3.0. Add light/dark header × light/dark drawer fixtures to the offline
   Chrome script.
4. **Performance from advisory to required** on the production build:
   LCP ≤ 3.0 s, CLS < 0.1 at phone390 and desktop1440 (relaxed from 2.5 s
   because preview is not CDN-fronted; tighten later).
5. **Validate `published_sections` on read** with the same registry
   validator (cheap; already runs at write).
6. Second fresh 8-brief batch.

**Exit:** two consecutive batches at 8/8; fixture benchmark ≥ 90% both ways;
median ≤ 30 min. **This is the "production-robust on the current vocabulary"
claim.** Publish two of the candidates to the catalogue.

### Phase 2 — Renderer vocabulary (weeks 5–10) · diversity

Track R from the variety doc, widened by the owner's template decision.
Every item is a platform PR with builder UI, registry validation, section
thumbnails, acceptance fixtures and a prompt-vocabulary entry.

**2a. Fonts 9 → ~30.** Add via `next/font/google` with `preload: false` and
per-theme `font-display: swap`; ship a curated **pairing library** (~25
display/body pairs with mood tags) that Stage B picks from, rather than two
independent font fields. Measure build time and CSS weight; cap at 32 families.

**2b. Nested blocks.** Introduce `blocks: Block[]` on sections (Shopify's
block model). First adopters: `media_text` (multiple stories), `tile_grid`
(tiles), `usp_bar` (items), `testimonials` (items), new `comparison`,
`accordion`. Registry validates block types per section; builder gets a block
list under each section. This is what makes "structure" an authored choice.

**2c. New sections (~14).** Announcement bar · logo/press strip · countdown ·
image hotspots (Bubble's gap) · bento/collage · product spotlight (one hero
product) · collection list · lookbook · before/after · comparison table ·
split banner duo · video-background hero · scrolling image marquee ·
multi-column rich text. Prioritise by the capability-gap report once Track F2
produces it; this list is the candidate pool.

**2d. Variants.** Hero 3 → 8 (full-bleed, split, stacked, offset-card,
collage, text-only, video, carousel-split). Card 5 → 8. Header 4 → 7
(transparent-sticky, logo-centre-nav-below, utility-bar double row,
hamburger-only). Footer 3 → 5.

**2e. Templates.** New package field `templates`, schema v3:

```
templates: {
  product:    { layout: "classic"|"editorial"|"grocery"|"stacked"|"gallery-grid",
                gallery: "thumbs-left"|"thumbs-bottom"|"stacked"|"carousel"|"grid",
                blocks: [ variant_picker | price | buy_box | accordion | trust_row |
                          delivery_estimate | size_guide | rich_text | reviews |
                          recommendations | sticky_bar ]  // ordered, configurable
              },
  collection: { banner: ..., filters: "sidebar"|"drawer"|"top-bar",
                density: ..., promoTiles: [{ afterIndex, section }],
                pagination: "load-more"|"paged"|"infinite" },
  blog:       { index: "grid"|"list"|"featured", article: "narrow"|"wide"|"sidebar" },
  account:    { layout: "tabs"|"sidebar", scheme: ... }
}
```

`app/(storefront)/(pages)/shop/[slug]/page.tsx` (423 lines, two hard-coded
compositions) becomes a block renderer over `templates.product.blocks`.
Collection likewise. Existing variants map 1:1 onto a v2→v3 migration so
installed stores keep rendering; `renderer.minVersion` is finally enforced.

**Exit:** all new vocabulary renders at 360/390/768/1024/1440 with the
acceptance gates green on a hand-authored exemplar theme per direction;
builder can edit every new field; schema v3 migration round-trips every
published release.

### Phase 3 — Scoped theme stylesheet, "Track S" (weeks 8–12, overlaps 2)

The owner's decision: the model may author CSS, but **as structured data,
never text**. This keeps validation tractable, keeps `targeted-repair.ts`'s
path-based repairs working, and keeps diffs reviewable.

```
stylesheet: ThemeStyleRule[]            // max 200 rules, 32 KiB compiled
ThemeStyleRule = {
  hook: "product-card" | "product-card.title" | "hero[variant=split].heading"
        | "header" | "button.primary" | "section[type=newsletter]" | ...   // closed grammar
  state?: "hover" | "focus-visible" | "active",
  viewport?: "phone" | "tablet" | "desktop",
  declarations: Record<AllowedProperty, ValidatedValue>
}
```

- **Hooks**, not selectors. The renderer emits `data-sm="product-card"` style
  attributes; the grammar is a parsed list of hook + optional variant filter
  - optional child part. No descendant combinators the model invents.
- **Allowed properties:** letter-spacing, text-transform, font-size (clamp
  from a token scale), font-weight, line-height, padding/margin/gap (token
  scale), border, border-radius, box-shadow (preset names), background
  (palette tokens or two-stop gradients of tokens), color (tokens), opacity,
  aspect-ratio, object-position, grid-template-columns (pattern list),
  transform (translate/scale within ±8 px / 0.9–1.1 on `hover` only),
  transition (preset), text-decoration, mix-blend-mode (multiply/screen).
- **Denied:** position, z-index, display:none on commerce hooks, `url()`,
  `content`, `!important`, `@import`, free `@keyframes`, filter beyond
  grayscale/blur ≤ 4 px, pointer-events, overflow on root/page hooks.
- **Compile** server-side to CSS scoped under
  `.storefront-root[data-theme-release="<digest>"]`, emitted in the layout
  after the token block and before merchant overrides. Cached by digest.
- **Validate** in `validateThemePackageV2`: grammar, property allowlist,
  value types, contrast for any colour declaration against the hook's known
  surface token, rule count/size.
- **Prompt:** Stage B receives the hook catalogue and allowed properties;
  repairs may target `/stylesheet/<i>/declarations/<prop>` like any scalar.
- **Builder:** read-only "Theme styles" panel listing rules; merchants'
  existing override layer stays above it. Per-rule disable is a v2 feature.
- **Why not raw CSS:** a sanitizer for free-form CSS is a permanent security
  tax; the gate would be regex (the thing we are trying to stop relying on);
  and the model's repairs could not be path-targeted.

**Exit:** the same exemplar themes, re-authored with stylesheets, pass every
gate; distinctness between two themes that share enums but differ in
stylesheet ≥ 0.45; a fuzz test of 10 k random rule sets never escapes scope
or breaks the gates.

### Phase 4 — Diversity mechanics (weeks 10–13)

With the vocabulary in place, make the model _use_ it differently each time.

1. **Structural commitments before Stage B.** The pipeline samples a
   commitment set — header, hero, card, PDP template, collection template,
   font pairing, two signature sections, stylesheet "voice" — weighted
   against catalogue fingerprint frequencies (`variety-context.ts` already
   freezes those). Stage B receives the commitments as constraints and may
   object once with a reason. This removes the degree of freedom that let
   eight briefs all pick `wide` + `cardHoverImage`.
2. **Design directions 7 → 14**, each with a _structural signature_ (which
   families of header/hero/card/PDP/stylesheet voice it mandates), not only
   adjectives. Add: brutalist, Scandinavian-utility, maximal-pattern, dark
   luxury, retro-catalogue, tech-spec, artisan-craft.
3. **Fingerprint axes** gain templates, header/footer variant, font pairing,
   stylesheet signature. `DISTINCTNESS_THRESHOLD` 0.35 → 0.50 for
   publication; publication is blocked below it against the published
   catalogue (today it only steers the prompt).
4. **Blind test.** Eight candidates shown to three people who did not run
   the batch; each must be identified as a distinct theme by ≥ 2/3.

**Exit:** G4 met on a fresh 8-brief batch while G1/G2 still hold.

### Phase 5 — Reference fidelity (weeks 13–16)

Run `theme-studio-reference-benchmark.md` for the first time; execute Track
F1–F3 from the variety doc against the new vocabulary. Target ≥ 85 median.
Feed the capability-gap report back into Phase 2c's section pool.

### Phase 6 — Production claim and merchant exposure (week 17+)

Two more fresh batches (one in dev with worker-interruption and provider
cooldown injected), 8/8 each. Publish five Studio themes to the catalogue
across five directions. First merchant installs. Help Centre article. Only
now say "production-level" externally.

## 3. Metrics dashboard (track per batch, store in `evals/theme-studio/`)

candidates/8 · first-pass/8 · median minutes · p90 minutes · US$/theme ·
OOM/503 count · queue wait p50 · 429 retries · false quality passes
(human-found defects on model-passed themes) · fixture catch rate ·
median pairwise distinctness · max setting share · fidelity median ·
sections used/available · stylesheet rules/theme.

## 4. Risks

| Risk                                                       | Mitigation                                                                                                            |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Vocabulary growth makes the builder unusable for merchants | Section library gets search + categories; blocks collapse by default; thumbnails for every variant                    |
| 30 fonts bloat the build and first paint                   | `preload:false`, swap, per-release font subset list emitted in `<head>`; cap 32; measure LCP in gate                  |
| Schema v3 breaks installed stores                          | Stores stay pinned; v2 renderer path retained one release cycle; migration round-trip test on every published release |
| Structured stylesheet still finds an escape                | Hook grammar + allowlist + fuzz test + existing browser gates; no raw text anywhere in the pipeline                   |
| Bigger prompt → more `MAX_TOKENS` truncations              | Stage B split: structure call, then per-template calls; hook catalogue sent as compact table                          |
| Model objects to commitments too often                     | Log objection rate; tune weights; cap objections at one per run                                                       |
| Reviewer fixture benchmark is gamed by prompt overfitting  | Hold out half the fixtures; rotate quarterly                                                                          |
| Solo engineer bandwidth                                    | Phases 0–1 are mostly ops; Phases 2–4 can be split by page (product vs collection vs stylesheet)                      |

## 5. Decisions needed from the owner

1. Approve the phase order (reliability → vocabulary → stylesheet → diversity → fidelity).
2. Approve structured-stylesheet over raw CSS (recommended; see Phase 3 "why not").
3. ~~Default daily spend ceiling value.~~ Decided 2026-10-08: none.
4. Whether the manual-acceptance path keeps a human scorecard row or simply requires the model verdict.
5. Font cap (proposed 32) and the first 25 pairings — owner taste matters here. **Proposed 2026-10-09:** 31 families and 26 pairings in `lib/themes/fonts.ts`; swap any face or pairing by editing that one file (`fonts.test.ts` holds `app/layout.tsx` to it).
6. Who runs the blind test in Phase 4.
