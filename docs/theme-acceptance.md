# StoreMink theme acceptance

This is the release gate for every StoreMink storefront theme. A theme is not
"done" because its definition compiles, its homepage looks attractive, or its
demo was reviewed once. It is done only when the automated, storefront, and
design gates below all pass for the release being published. The design gate
is one reviewer's scorecard for a hand-built theme, and the automatic checks
and design review for a Theme Studio theme, which one superadmin then
publishes (section 5). No step needs a second person.

- **Theme implementation plan:** `docs/vertical-templates-plan.md`
- **Theme packages:** `lib/themes/`
- **Automated package checks:** `lib/themes/validation.ts` (production
  functions), asserted for every bundled theme by `lib/themes/themes.test.ts`
  and run over Theme Studio candidates by `lib/theme-studio/acceptance-gates.ts`
- **Asset provenance:** `docs/theme-assets.md`
- **★ marks a non-obvious invariant** that deserves explicit regression
  coverage.

The word **theme** below means one catalog choice presented to a merchant. When
theme families and presets are introduced, each preset is still evaluated as
its own catalog choice because that is what the merchant sees and selects.

---

## 1. Release states

| State     | Meaning                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------- |
| Draft     | Design or implementation is in progress. It must not appear on the Storefront page.            |
| Candidate | Package-integrity tests pass and a demo is available for review.                               |
| Approved  | Every required story in this document passed for the current release.                          |
| Published | Approved and visible in the merchant catalog and the dashboard Storefront page.                |
| Blocked   | A required gate failed. Record the failure in the baseline table before more catalog exposure. |

Approval belongs to a specific theme release. A change to shared storefront
chrome, a theme layout variant, seeded content, or theme imagery moves every
affected theme back to Candidate until the impacted gates are rerun.

---

## 2. Automated package gate

These checks are production functions in `lib/themes/validation.ts`. Vitest
runs them for every definition registered in `THEME_DEFINITIONS`, and Theme
Studio runs the same functions over every generated candidate. They are necessary, but they do not approve a theme on
their own.

**TA-2.1 ★ — Catalog metadata and definitions agree**

Every catalog id has exactly one server definition, ids are unique and
URL-safe, demo slugs follow `demo-{id}`, and the default id resolves.

**TA-2.2 — Catalog copy is publishable**

Name, description, brand tagline and brand blurb are non-empty. Placeholder
labels such as "Theme 1", "Lorem ipsum", and "Coming soon" are not allowed.

**TA-2.3 ★ — Seeded pages are valid and addressable**

There is exactly one homepage sentinel (`slug: ""`). Page slugs and section ids
are unique, every page has a title and SEO description, and every section
passes strict publish validation.

**TA-2.4 — The homepage has enough authored structure**

The homepage contains at least five enabled sections spanning at least four
distinct section types. This is a floor, not a design target: five generic
bands do not pass the human distinctness gate.

**TA-2.5 ★ — Seed data can render a credible demo**

The package has at least four categories and eight products, including at least
one featured product. Slugs are unique, category references resolve, product
copy is non-empty, and prices are positive and internally consistent.

**TA-2.6 ★ — Shared assets are safe and production-sized**

Every referenced theme asset exists under `public/themes/{theme-id}/`, is WebP
or AVIF, is at least 800 px wide, and is no larger than 500 KiB. The catalog
preview is at least 800 × 600, uses a 4:3 aspect ratio, and is no larger than
250 KiB.

**TA-2.7 — The design system is complete**

Every palette, typography, shape, and selected layout value is valid and can be
flattened into the storefront CSS-variable contract.

**TA-2.9 ★ — Links and colours hold up as rendered**

Every link that names a category, product or page reaches something the store
seeds, or a storefront route. Menus are read as the storefront renders them, so
an empty legal row's default links count; merchant-written policy pages
(terms, refund, shipping, privacy, cookie) are exempt. Six colour pairs meet
WCAG AA as rendered: body, card, muted and ink-surface text, header text, and
muted labels on sand. Button labels on the accent need 3:1.

**TA-2.8 ★ — Shared capability contracts are enforceable**

Every seeded video/newsletter/editorial section passes strict publish
validation. Header, card, product-detail, cart, and footer defaults use the
allowed variant registry; the pure resolver preserves pinned legacy grocery
stores and applies merchant overrides per surface. Newsletter action tests must
prove host-derived tenancy, normalized email, explicit consent, rate limiting,
source allowlisting, idempotent upsert, and a safe persistence-failure response.

---

## 3. Storefront behavior gate

Run these stories against the theme's pristine demo store. Test at 1440 × 900,
768 × 1024, and 390 × 844. Record the browser, date, theme release, and reviewer
in the release evidence.

**TA-3.1 ★ — The demo is real**

Open homepage, `/shop`, one product detail page, `/cart`, one seeded content
page, and a missing route.

**Expect:** the first five return the themed storefront, not the platform 404,
an error boundary, or another tenant. The missing route returns the themed
storefront 404.

**TA-3.2 — Header and navigation**

Use every visible desktop and mobile navigation control, search for a seeded
product, and open header/footer links.

**Expect:** controls have visible focus states; menus do not clip or overflow;
search reaches a useful result; no seeded link is broken.

**TA-3.3 ★ — Product cards survive real catalog content**

Check normal, sale, sold-out, missing-image, long-name, and multi-variant
products.

**Expect:** price hierarchy remains clear, badges do not collide, quick-add
never chooses a variant silently, and cards remain usable at every viewport.

**TA-3.4 — Product detail is commerce-ready**

Change variants, inspect media, add to cart, use buy-now when present, and read
all product-information controls.

**Expect:** selection, price, stock, and cart state agree; important actions
remain reachable without layout jumps; keyboard use is complete.

**TA-3.5 ★ — Cart states are complete**

Review empty cart, one item, many items, a long product name, quantity changes,
removal, coupon feedback, and totals.

**Expect:** totals remain trustworthy, controls do not move off-screen, and the
merchant's theme never hides functional error text.

**TA-3.6 — Content pages belong to the same system**

Open seeded story/FAQ pages, blog list/detail when enabled, enquiries, profile,
authentication modal, and storefront 404.

**Expect:** typography, spacing, controls, and semantic colors feel native to
the theme rather than falling back to the legacy storefront.

**TA-3.7 ★ — Content extremes do not break layout**

Exercise empty collections, 500+ item catalog fixtures, very long headings,
long translated button labels, absent optional imagery, and large navigation
menus.

**Expect:** no horizontal page overflow, invisible controls, overlapping text,
or unreachable content.

**TA-3.8 — Motion is optional**

Repeat the main journey with `prefers-reduced-motion: reduce`.

**Expect:** meaning and controls do not depend on animation; autoplay pauses or
becomes non-disruptive; focus is never stolen.

**TA-3.9 ★ — Layout variants stay editable and coherent**

For every surface variant claimed by the theme, switch the Brand inspector
between Theme default and an explicit alternative, then preview, reload the
draft, publish, and revert.

**Expect:** header, product cards, PDP, cart, and footer each change only their
owned surface; preview matches the published storefront; theme inheritance
returns exactly to the pinned preset; search, variant selection, quick-add,
quantity controls, checkout links, footer navigation, focus states, and mobile
controls remain functional in every treatment.

**TA-3.10 ★ — Video and newsletter are real storefront capabilities**

Test direct MP4/WebM, YouTube and Vimeo video with autoplay on/off, loop on/off,
controls on/off, missing poster, and reduced motion. Submit both footer and
section newsletter forms with invalid email, missing consent, a new email, a
repeat email, and a simulated persistence failure; inspect the owning store's
saved subscriber row.

**Expect:** video keeps its configured aspect and accessible label, embeds use
constructed privacy-safe URLs, and reduced-motion behavior satisfies TA-3.8.
Newsletter feedback is announced, a consent checkbox is required, the displayed
consent copy and source are recorded under the request-host store, repeat
submissions reactivate one store/email row, and no address crosses tenants or is
revealed through response wording.

**TA-3.11 ★ — The public catalog tells the release truth**

Open the theme on `themes.storemink.com`, filter to each declared industry, and
compare its card with `THEME_META`, signup, and the live demo.

**Expect:** name, description, preview, industries, plan gate, and availability
agree everywhere; hidden themes never render; blocked or unhealthy demos never
open a broken preview; a healthy preview uses the declared `demo-{id}` host;
catalog/signup links preserve the StoreMink platform host; keyboard focus,
mobile layout, canonical, robots host, sitemap host, and social preview all
belong to `themes.storemink.com` rather than a merchant store or the apex.

**TA-3.12 ★ — The catalog stays one compact, newest-first row**

Open `themes.storemink.com` at desktop, tablet and mobile widths.

**Expect:** every filtered theme stays in one horizontal, snap-aligned row;
touch/trackpad scrolling works natively and the visible previous/next buttons
move one card at a time, wrapping at either end. The latest `releasedAt` theme
is first. Cards are compact enough to show the preview, identity, features and
actions without occupying a full viewport height on desktop or mobile.

---

## 4. Accessibility and performance gate

**TA-4.1 — Automated accessibility**

Run the agreed browser accessibility scan on homepage, shop, product detail,
cart, and one content page.

**Pass:** no critical or serious violations and Lighthouse Accessibility ≥ 95.

**TA-4.2 — Keyboard and screen-reader smoke test**

Complete navigation, search, product selection, add-to-cart, cart editing, and
authentication-modal dismissal without a pointer.

**Pass:** logical focus order, visible focus, meaningful accessible names,
announced state changes, and no keyboard traps.

**TA-4.3 — Contrast**

Check every theme-controlled foreground/background pair, including hover,
disabled, sale, error, success, badge, header, and footer states.

**Pass:** WCAG AA for normal text and interactive components.

StoreMink's shared labels, flags and badges are replayed on every shipped
palette by `node scripts/theme-studio-contrast-check.mjs` (CI renderer job). A
new shared label, flag or badge needs a fixture and a broken copy there.

**TA-4.4 — Mobile performance**

Measure a production build with the pristine demo data.

**Pass:** Lighthouse Performance ≥ 90, LCP ≤ 2.5 s, CLS < 0.1, and INP ≤
200 ms. A lab run is evidence, not a substitute for production monitoring once
the theme is live.

**TA-4.5 ★ — Asset discipline**

Inspect the initial homepage request.

**Pass:** no theme downloads unused font families or original-resolution media
for a small render; the LCP image is correctly prioritized and sized.

---

## 5. Design gate

Every theme is judged on the eight rows below. A hand-built theme is judged by
one reviewer; a Theme Studio theme by its automatic design review, after its
automatic checks, and one superadmin then publishes it. No step needs a second
person (owner decision 5, 24 Oct 2026).

### Hand-built themes: one reviewer

One reviewer scores every row from 1 to 5, and may be the theme's author.
Approval requires every row ≥ 4, an average ≥ 4.2, and none of the rejection
conditions below.

| Dimension              | What reviewers judge                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Art direction          | A coherent and intentional point of view, not a collection of fashionable effects.                                   |
| Distinctness           | Homepage, shop, product, cart, header, and footer cannot be mistaken for another StoreMink theme with new colors.    |
| Commerce clarity       | Discovery, price, variant, stock, add-to-cart, cart, and checkout affordances remain more important than decoration. |
| Typography             | Clear hierarchy, readable measures, suitable weights, and graceful long-content behavior.                            |
| Imagery                | Consistent crop language, useful focal points, licensed sources, and no obvious stock-photo collage.                 |
| Responsive composition | Mobile is deliberately composed rather than a collapsed desktop design.                                              |
| Detail quality         | Spacing, icons, borders, motion, empty states, and error states feel finished.                                       |
| Brand adaptability     | A merchant logo, primary color, and real catalog content can replace the seed without destroying the design.         |

Rejection conditions (`REJECTION_CONDITIONS`, `lib/theme-studio/scorecard.ts`;
the rows, the bar and these conditions live there, so change them together).
Naming any one rules out a clean pass. For a hand-built theme any of them
rejects it. For a Theme Studio theme, serious ones stop Publish once the
automatic repairs are used up, and taste ones are warnings.

Serious:

- It copies another company's theme, screenshots, copy or proprietary assets
  (`copied`, owner decision 2).
- A shop, product, cart or mobile view is unfinished: placeholder or blank
  artwork, a headed section with nothing under it, or missing products, prices
  or buttons (`unfinished_surface`).
- Placeholder copy is visible in the demo (`placeholder_copy`).
- Copy a shopper cannot read is visible: over a photograph, a gradient or an
  overlapping layer, clipped, or too small or too faint (`inaccessible_copy`).
- It shows an award, certification, endorsement, rating, review count, press
  mention or clinical result the brief does not support (`unsupported_claim`).

Taste:

- It is an existing StoreMink theme with only palette, font, radius or
  section-order changes (`palette_only`).
- Shop, product, cart or mobile views are finished but generic: they could
  belong to any store (`generic_surface`).
- It needs custom code to render its core advertised design
  (`needs_custom_code`).

Very low scores (owner decision 3, `SERIOUS_SCORE_LIMITS`): for a Theme Studio
theme, 2 or below on commerce clarity, responsive composition, brand
adaptability, typography or detail quality is serious; every other score under
the bar (every row 4, total 34 of 40) is a warning.

### Theme Studio themes: the automatic checks, the design review and one Publish

A Studio theme has no human scorecard and no separate approval (since 3 Oct
2026, migration 0151). Theme Studio checks it, repairs what it can in up to
three automatic rounds, and then one superadmin publishes it from Studio →
project → Release (`docs/mink-ai-theme-studio-phase6.md`). The rule is "Fix it,
then allow Publish" (owner, 24 Oct 2026): serious findings block, smaller ones
are warnings the operator may publish past.

- **The automatic checks.** A Studio check run passes when no serious finding
  is left (rules version `severity-v1`, `lib/theme-studio/finding-severity.ts`).
  Serious: broken, unthemed or unfetchable pages, broken links, security
  findings (including an off-site resource in rendered markup), text at or
  below the AA contrast line (4.5 to 1, 3 to 1 for large text) whatever its
  cause or with no readable ratio, sideways scrolling, clipped text of 3 px or
  more, broken, missing, wrongly formatted or too small pictures, placeholders,
  missing licence notes or alt text, serious or critical accessibility rules,
  and anything the checks could not check or did not classify. Warnings, kept
  with the run and shown, which the operator may publish past: small tap
  targets, tight crops, speed (unless the performance gate is required), a
  picture narrower than its slot, image byte budgets, unused files,
  StoreMink's preview noindex, page language and image alt attribute, moderate
  or minor accessibility rules, and clips of 1 or 2 px. Clipped text is listed
  largest first before any limit, so many small clips can never hide a large
  one. A finding in StoreMink's own shared storefront code is labelled "Needs
  a StoreMink fix"; the label changes the words, never the severity. A check
  that could not finish stops the theme as "The checks could not finish" and
  asks for Check again, never for a change to the theme.
- **The design review.** An AI reviewer scores the eight rows above on today's
  screenshots and names the rejection conditions it sees. Taste is repaired
  for up to three rounds and then becomes warnings; a serious finding left at
  the ceiling, or no review at all, stops the theme with its reason. A drawn
  photo whose own photo check has not passed on its exact bytes, or found a
  hard problem, is serious whatever the review says.
- **Publish.** A Studio theme publishes only on a check run and a design
  review made together on today's StoreMink build. When either is missing or
  older, Publish starts a re-check on today's build first (about 3 to 5
  minutes, nothing redrawn), and the warnings the theme carries are recorded
  with the publish, with the rules version.
- **No lookalikes (22 Nov 2026).** Publish refuses a theme that is under 50%
  different from any theme already in the public catalogue (its own earlier
  release excepted). The theme's page says so before Publish is pressed,
  names the theme it resembles and what the two share (the layouts, the
  product card, the homepage opening, the page colour, the fonts, the button
  style, the style rules). The way past is a change to the theme, never an
  override: ask for one that sets it apart, then publish
  (`lib/theme-studio/fingerprint.ts` `publicationSimilarityBlocker`).

The database enforces the core of it: a project reaches Ready to publish, or a
publish attempt, only with a passed check run over the version's exact package
(migration 0151), and it is published only with a published publication.

---

## 6. Release evidence

Every Candidate keeps this evidence in its launch PR or linked release record:

| Evidence                                                           | Required                      |
| ------------------------------------------------------------------ | ----------------------------- |
| Theme id and release/version                                       | Yes                           |
| CI run containing `lib/themes/themes.test.ts`                      | Yes                           |
| Live demo URL and route-health results                             | Yes                           |
| Desktop, tablet, and mobile screenshots for homepage/shop/PDP/cart | Yes                           |
| Browser matrix and date                                            | Yes                           |
| Accessibility report                                               | Yes                           |
| Production-build Lighthouse report                                 | Yes                           |
| Reviewer scorecard (one reviewer)                                  | Yes                           |
| Asset licenses/source log                                          | Yes                           |
| Known exceptions with owner and expiry                             | Only when an exception exists |

An exception cannot waive tenant isolation, broken purchasing, critical/serious
accessibility violations, or a non-working demo.

A **Theme Studio** release keeps its evidence in the database instead of a PR,
bound by digest:

- the acceptance run (package, asset bytes, build) and its rules version;
- the design review bound to that run (its scorecard, serious findings and
  warnings);
- the warnings accepted at publish, on the publish events;
- the publication attempt;
- the demo render check;
- the catalog audit.

Production-build Lighthouse and the browser matrix are still manual for Studio
releases.

---

## 7. Current baseline — 2026-08-23

| Theme   | Package gate                                                                                                                   | Demo gate                                                                                                                                         | A11y/performance                                                                                                                              | Human gate                                                                            | Release state              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------- |
| Basket  | Passes the package gate; registered as preset `basket@1.0.0` on engine `storefront-grocery@1`                                  | **Production blocked:** public demo is still the StoreMink 404 and manifest preview is disabled.                                                  | Not recorded against this gate                                                                                                                | Prior visual review is historical and does not satisfy this release gate              | Blocked                    |
| Studio  | Passes the automated package gate as published preset `studio@0.1.0` on `storefront-editorial@1`; asset provenance is recorded | Production demos were reseeded and the desktop/tablet/mobile route and commerce sweep passed on 2026-08-12. Catalog and signup exposure are live. | Five-page accessibility is 98–100. **Performance remains open:** 67, LCP 7.26 s, CLS 0.008; anonymous-auth deferral awaits deployment/retest. | Not reviewed; authoring review does not count toward the two-reviewer gate            | Published; acceptance open |
| Ritual  | Passes the automated package gate as published preset `ritual@0.1.0` on `storefront-editorial@1`; asset provenance is recorded | Production demos were reseeded and the desktop/tablet/mobile route and commerce sweep passed on 2026-08-12. Catalog and signup exposure are live. | Five-page accessibility is 98–100. **Performance remains open:** 73, LCP 6.73 s, CLS 0; anonymous-auth deferral awaits deployment/retest.     | Not reviewed; authoring review does not count toward the two-reviewer gate            | Published; acceptance open |
| Vitrine | Passes the automated package gate as published preset `vitrine@0.1.0` on `storefront-classic@1`; asset provenance is recorded  | Production demo seeded and route-checked on 2026-08-22 (shop, PDP, content pages, all ten assets). Catalog and signup exposure are live.          | Passed; accessibility and Lighthouse gates confirmed on 2026-08-23                                                                            | Passed the required two-person review, including a non-author reviewer, on 2026-08-23 | Published                  |

The Human gate column records the two-person review these themes were judged
under before 24 Oct 2026. From then on a hand-built theme needs one reviewer's
scorecard (section 5); Studio and Ritual still have none recorded.

The baseline is intentionally strict. Basket remains the default theme in code,
but it is not evidence that the new professional-theme acceptance bar has been
met. Studio and Ritual are public, but publication does not erase their open
performance and human-review gates; they must not be described as fully
approved until those rows close. Vitrine completed its accessibility,
Lighthouse and two-person human-review gates on 2026-08-23 and is now published
in the catalog and signup picker. Studio and Ritual's detailed production record
is `docs/theme-release-audit-2026-08-11.md`; Vitrine's gate closure is recorded
in this baseline and its asset log.
