# Mink storefront revamp

The build contract for "customise my store". Owner's decisions (21 Oct 2026)
and the evidence behind them are in the memory note `mink-storefront-revamp`
and in the investigation of the echoss session (20 Oct 2026). This document is
what the code must do. When the code and this document disagree, fix one of
them in the same change.

## 1. What the merchant gets

A merchant says "customise my store for my business" (typed or spoken, any
language). Mink:

1. Reads the store (`get_storefront_revamp_context`) and asks at most three
   short questions in ONE message, only for what it cannot read or infer:
   what they sell and who buys it, the look and feeling they want, and the
   real facts and products to use (name, sizes, price and a phone photo of
   each product). When the merchant has already said enough, it asks nothing
   and starts. When the context lists categories that came with the theme
   (`fromTheme`) or do not fit what the merchant sells, the same message
   names them and asks whether to hide, rename or replace each.
2. Starts the revamp (`start_storefront_revamp`). The chat answer ends at
   once with one short sentence; a revamp card appears with the answer and
   shows live progress while the store is rebuilt in the background. The
   code sets no expected duration: one invocation runs to an 18-minute
   deadline and then hands over to the next, as many times as the work
   needs, for up to four hours from its first run (section 4.3). The
   merchant can keep working or leave. While it is being made, the card
   offers Stop. A chat reply that is stopped or interrupted after the revamp
   started does not stop it: the card stays in the chat, and a tab that
   stopped reading the reply fetches it (section 4.3). When the card is
   ready, a notification opens the chat that holds it (section 11).
3. When the build is finished and its checks have run (the card lists each
   one as passed or not; a failed check does not hold the card back), the
   card becomes a review card: what changed (each new product with every size at
   its own price, each category change in words), a full before/after
   preview (phone and desktop, every page), and three buttons, named
   exactly: **Apply to Website Builder draft**, **Publish to your store**,
   **Undo**. The preview is the storefront's own renderer without the
   Builder's edit controls; its "after" side also shows the new categories
   and leaves out the samples Apply takes off. Once applied, it compares the
   live store ("Live now") with the Builder draft ("Your draft"), which is
   what Publish would put live.
   - How the preview works (`mink-revamp-preview.tsx`): each page loads in a
     390 px and a 1280 px frame at `?preview=1&review=1`. `preview=1` is the
     Builder preview's draft canvas; `review=1` leaves out the Builder's edit
     layer (add-section pills, outlines, hit areas) and its draft badge. The
     proposed sections go to the frame as `sm-draft` (with the new products,
     the categories and the samples to hide as datasets), the proposed
     header and footer as `sm-chrome`, and the new tagline and footer
     description as `sm-brand` (only the halves the redesign changes, and
     only before Apply) to the storefront's BrandProvider, which keeps a
     tagline to 200 characters and a footer description to 1,000. A page
     the redesign creates borrows the homepage's frame. The storefront's
     ChromeProvider keeps the chrome it was sent (filled with the theme's
     defaults) instead of falling back to the chrome the server sends when
     the frame refreshes (the saved Builder draft, or the live chrome when
     there is none), and both providers accept messages only from their
     parent window. The page behind the dialog is inert, and Escape works
     inside the frames.
4. Follow-ups refine the same revamp (`refine_storefront_revamp`): "make it
   warmer", "redo the hero photo", "change the colours", "add my products".
   A ready card that was not undone offers three of these as one-tap chips
   (`MINK_REVAMP_REFINE_PROMPTS`: "Make the colours warmer", "Redo the
   opening photo", "Add my products"), each sent as an ordinary chat message.
   A refinement builds a new version of the card and retires the old one;
   section 10 says what it carries over and what an applied card keeps.

What shoppers see after Apply and Publish:

- A homepage rebuilt for the business: an opening photograph filling the
  band, then sections chosen for the business (value points, categories,
  products, the story of the facility or the process, a gallery, questions,
  newsletter) in one of the structures its industry suits (two or three
  that really differ), in a rhythm of coloured bands.
- On the pages it writes, every theme photo, every picture an earlier Mink
  run drew (never a Mink product photo) and every photo that no longer
  loads, replaced by photographs from one shoot (one art direction, palette
  and light), each showing the merchant's own products as their own photos
  show them, or no products at all (section 8). A category's photo changes
  only when the merchant agreed to a new one (section 5).
- New colours, fonts and corner radii; header, footer and product-card
  styles chosen for the business; menus that point at the store's real
  categories and pages; an announcement line; newsletter wording.
- A design of its own: whatever the plan leaves open is picked for the
  store, never one default for every store; the page colour suits the
  chosen style; and a new redesign of the whole store is held apart from
  the store's own earlier redesigns in what the merchant did not ask for
  (section 5).
- About, Contact and Questions pages rewritten from the merchant's facts;
  new pages only when the business needs them (for example "Our process").
- The merchant's real products, each with a clean studio photo made from
  the merchant's own phone photo, at the prices the merchant gave. A product
  the store already has (one of its own, not a theme sample, with the same
  name, case and spacing aside) is not created again and gets no studio
  photo; product sections show the store's own published products.
- English copy, and no claim the merchant did not make.

What is never touched: policy pages (terms, refund, shipping, privacy),
custom code sections, the merchant's own photos that still load, the words
and links of sections the merchant wrote themselves (kept, possibly moved;
a theme or earlier Mink photo inside one is redrawn, section 9), the theme
itself (no theme switch), prices of existing products, orders, customers.

## 2. Owner's rules that bind every part

- One design straight away; no "pick a direction" step.
- Products come from the merchant. Mink never invents goods, prices, sizes
  or reviews. Sample products stay hidden; product sections show only the
  merchant's real products. A redesign's banner, content and category
  photographs show the merchant's REAL products, from their own product
  photos, or scenes with no products at all, never invented goods (owner,
  23 Oct 2026, robustness audit B16; Theme Studio's demo themes keep their
  fictional goods).
- Each store's first full revamp is free. Later revamps and refinements are
  charged per item at today's prices (page 3, photo 3, look 2, header and
  footer 2, category 1, product photo 5), only for what they make and still
  show; a failure never charges. Neither the dashboard nor the model ever
  sees a number of credits (rule `no-credit-prices-on-dashboard`): refusals
  and the out-of-credits stop name no figure, and the tools tell the model
  only whether a revamp started.
- Sections may be added, removed and reordered, and header, footer, card and
  product-page styles changed, within the current theme. Everything goes to
  the private Builder draft until the merchant publishes, except what the
  card lists before the Apply button (section 10), which changes on the
  shop at Apply.
- Nothing the merchant changed after Apply is overwritten by Publish or
  Undo: it is kept and named.
- Categories change only after the merchant agrees to each change.
- Drafted text is in English (the merchant may insist on another language
  after one reminder).
- No em or en dash in anything Mink writes.
- Human approval for every change: Apply, Publish and Undo are clicks.
- A redesign learns only from its own store's earlier redesigns, and only
  their design choices: never another store's plan, and never words, names,
  products, links or photos. Reading other stores' design choices (the
  robustness audit's step 7), an extra correction call (step 8) and photo
  style choices (step 9) wait for the owner's OK.

## 3. Architecture

```
chat run ──start_storefront_revamp──▶ mink_revamps row (queued)
                                         │  kick (fetch, CRON_SECRET)
                                         ▼
            /api/internal/mink/revamps/run  (maxDuration 1200, leased)
              snapshot → plan → compile/repair → photos → products
              → assemble → checks → card (draft, free or charged)
                                         │
card ◀── GET /api/mink/revamps/[id] (polls every 3 s; kicks a stalled job)
  │
  ├─ Stop    → POST /api/mink/revamps/[id] {action:"cancel"} (while it is being made)
  ├─ Apply  → /api/mink/drafts/[draftId]/personalization-action (approval, one transaction)
  ├─ Publish → POST /api/mink/revamps/[id] {action:"publish"}
  └─ Undo    → POST /api/mink/revamps/[id] {action:"undo"}
```

`/api/mink/revamps/[id]` answers only the requester, same-origin, with
private no-store JSON. `GET` (Builder view, 120 reads a minute per admin)
returns the status view (`RevampStatusView`): status, step progress, the
error sentence, the lifecycle times, the review once ready,
`cancelRequested` (a Stop is recorded and the runner has not stopped yet)
and `undo` (what Undo did, once undone). Reading it also settles a job no
runner is moving: a recorded stop is cancelled, a job out of attempts or
past its 4-hour ceiling is failed, and a finished job's photo allowance is
given back; after the
response it kicks a stalled job. `POST` (10 a minute, body at most 1 KB)
takes only `{action: "cancel" | "publish" | "undo"}`.

### 3.1 Modules (all new under `lib/mink/revamp/` unless named)

| Module                                      | Kind              | Job                                                                                                                                                               |
| ------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.ts`                               | pure, client-safe | Types, statuses, steps, limits, prices, plan v2 shape, summary for the card                                                                                       |
| `request.ts`                                | pure              | Reads the tools' arguments into a `RevampRequest`, every issue at once                                                                                            |
| `site-schema.ts`                            | pure              | JSON schema of the site model call and the prompt that goes with it                                                                                               |
| `site-planner.ts`                           | server            | The one planning call and its repair call, through Theme Studio's client                                                                                          |
| `fake-plan.ts`                              | pure              | The offline planner (`MINK_REVAMP_PROVIDER=fake`), each choice picked per store and redesign                                                                      |
| `provider.ts`                               | server            | Vertex or the offline fakes, read once per call                                                                                                                   |
| `site-compiler.ts`                          | pure              | Model output → validated pages, chrome, design, shot list; repair issues; per-store picks for what a v5 answer leaves open                                        |
| `copy-checks.ts`                            | pure              | English check, claims check (food and FSSAI words), dashes, the shared claim evidence and shop names                                                              |
| `distinctness.ts`                           | pure              | Theme Studio's fingerprint of a plan over its theme, the same-theme bar, earlier redesigns' summary, the changes a redo makes, the check again on the fitted plan |
| `ownership.ts`                              | server            | Classifies every section and photo as theme, mink or merchant                                                                                                     |
| `snapshot.ts`                               | server            | Everything the run reads about the store, once                                                                                                                    |
| `photos.ts`                                 | server            | Shot list → slots; Theme Studio image set with review; the merchant's own product photos as references (section 8); stores each image                             |
| `image-store.ts`                            | server            | Stores each photo and its Media Library row (hidden until `apply-v2.ts` reveals the ones its card uses); the photo allowances                                     |
| `photo-hold.ts`                             | server            | The photo allowance held on the job row, given back when not drawn                                                                                                |
| `products.ts`                               | server            | Merchant products → studio photos, checked against the merchant's photo (section 8)                                                                               |
| `assemble.ts`                               | pure              | Fits a paid plan to its budget; assembles plan version 2 and its charges                                                                                          |
| `checks.ts`                                 | server            | Deterministic self-checks before a card is shown                                                                                                                  |
| `card.ts`                                   | server            | Writes the card (a free or charged draft)                                                                                                                         |
| `review.ts`                                 | pure, client-safe | The review a ready card shows, built from the stored plan                                                                                                         |
| `digests.ts`                                | pure (server)     | The page, chrome and brand digests Apply locks against                                                                                                            |
| `lifecycle-types.ts`                        | pure, client-safe | What Apply and Publish record so Undo can put the store back                                                                                                      |
| `ready-notice.ts`                           | pure              | The `mink.revamp_ready` notice and its link to the chat, built in one place                                                                                       |
| `jobs.ts`                                   | server            | The `mink_revamps` repository: create, claim, renew, advance, finish; a failed revamp's start given back; earlier plans                                           |
| `actor.ts`                                  | server            | Rebuilds the requester's authority from the database at every claim                                                                                               |
| `ports.ts`, `deps.ts`, `step-error.ts`      | server, pure      | The runner's step ports, their production binding, the closed error codes                                                                                         |
| `runner.ts`                                 | server            | Runs the steps in order with checkpoints and the lease; the redo memory's check after compile and on the plan the budget fit leaves                               |
| `trigger.ts`                                | server            | Self-kick of the runner route                                                                                                                                     |
| `apply-v2.ts`                               | server            | Apply of a v2 plan (called by the existing personalisation actions)                                                                                               |
| `publish.ts`                                | server            | Publish and Undo                                                                                                                                                  |
| `lib/mink/tools/storefront-revamp-tools.ts` | server            | The three tools                                                                                                                                                   |
| `app/dashboard/mink-revamp-card.tsx`        | client            | Progress, review, buttons; opens the preview                                                                                                                      |
| `app/dashboard/mink-revamp-preview.tsx`     | client            | The before and after preview (phone and desktop, every page)                                                                                                      |

Theme Studio code reused as is: `gemini-vertex.ts` (structured model client,
429 back-off), `image-vertex.ts` (image client), `image-prompt.ts` (anchor and
asset requests), `image-review.ts` (vision review), `slot-images.ts`
`prepareSlotImage` (crop and compress to the slot), `industry-playbooks.ts`,
`design-directions.ts`. Three additive changes: `image-generation.ts` gains
`runSlotImageGeneration({slots, direction, anchorLead, reviewer, seed})` with
the `onAnchor` and `onSlotSettled` callbacks (each drawn photo is stored the
moment it settles), and `runThemeImageGeneration` delegates to it;
`claims.ts` exports `unsupportedClaimLabels` for the revamp's copy checks;
and `image-fake.ts` takes `{ size: "model" }`, the image model's own 2K
sizes, for the revamp's offline photos. Phase 0 of the speed plan (23 Oct
2026, `docs/mink-revamp-speed.md`) then changed shared Theme Studio code for
every caller: start pacing for image models, a 15 s ceiling on the pause one
429 sets for the others, one permit back per success and an optional
capacity `scope` (`provider-capacity.ts`, `provider-capacity-store.ts`,
`image-request-pool.ts`, `rate-limit-backoff.ts`, migration
`20261023_0236_theme_studio_provider_pacing`); the image client's short
429 wait and its final image part (`image-vertex.ts`); a clock per try and
an `onRetry` hook for checks (`gemini-vertex.ts`); and a `cancelled` code
for a check its caller stopped (`image-review.ts`). Its corrections the
same day (robustness audit P0-1 and P0-3) hold the pacing gap between 10
and 45 s and log each move of it (`theme_studio.provider_pace`), Google's
own words on every refused or failed photo and check (`gemini-vertex.ts`,
`image-vertex.ts`) and each photo answer's image parts and size, with a
warning when it is under the size asked for. The real-goods rule (B16, 24
Oct 2026) adds the image prompt's `{{goods}}` placeholder (`goodsRule`;
Theme Studio's rendered requests unchanged byte for byte, pinned by
`lib/theme-studio/image-prompt.golden.json`), a people rule for a redesign
picture with no products (`NO_GOODS_PEOPLE_RULE`, `peopleRule(people,
goods)`), the reference role `product` labelled `PRODUCT:`
(`image-provider.ts`, `image-vertex.ts`), and an optional `goods` on the
review input (`image-review.ts`; the review system text and version
unchanged). The uniqueness wave (24 Oct 2026) changes no Theme Studio file:
it reads `fingerprint.ts` (`themeFingerprint`, `fingerprintDistance`,
`DISTINCTNESS_THRESHOLD`, `colourBand`, `paletteFamilyIssues`),
`industry-playbooks.ts`'s variety form (`industryPlaybookPrompt(..., true)`)
and `schemas.ts`'s layout variants as they are. Two revamp tests hold Theme
Studio on purpose: `site-schema.test.ts` (Stage A's variety prompt carries
the cream sentence the revamp's prompt repeats, `REVAMP_CREAM_SENTENCE`) and
`site-compiler.test.ts` (`REVAMP_SECTION_CHOICES` stays within
`style-choices.ts`'s `VISIBLE_SECTION_CHOICES`), so a Theme Studio change to
either fails there first.

### 3.2 The draft and the approval

The card's draft keeps kind `storefront_personalization` and the approval
keeps tool `apply_storefront_personalization`. The stored plan gains
`schemaVersion: 2`, which tells Apply it is a revamp. This reuses every
vocabulary, approval and audit check 0232 installed; on the drafts side only
the free first revamp needs schema, the widened credit check (section 6).

## 4. The job

### 4.1 Table `mink_revamps` (service-only: RLS enabled with no policies, app_user revoked)

| Column                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id uuid pk`                                               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `store_id uuid`                                            | FK stores ON DELETE CASCADE                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `admin_id text`                                            | the requester                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `requester_email text null`                                | how the runner finds a platform operator (no admins row) at each claim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `conversation_id uuid null`                                | FK mink_conversations ON DELETE SET NULL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `origin_run_id uuid null`                                  | the chat run that started it; FK mink_runs ON DELETE SET NULL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `parent_id uuid null`                                      | the revamp a refinement builds on; FK ON DELETE SET NULL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `superseded_by uuid null`                                  | the newer card that retired this one (section 10); FK ON DELETE SET NULL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `kind text`                                                | `full` or `refine`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `status text`                                              | `queued`, `running`, `ready`, `failed`, `cancelled`, `superseded`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `step text`                                                | current step key; starts at `snapshot`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `progress jsonb`                                           | `[{step,state,detail}]`, state `waiting`/`running`/`done`/`skipped`; the card names each step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `request jsonb`                                            | brief, products, categories, pages, refinement instruction (validated)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `snapshot jsonb`                                           | the store as read at the start (digests, versions)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `plan jsonb`                                               | `{stage:"raw", raw, repairs, issues, repairFailed?}` while the plan is repaired, then `{stage:"compiled", plan, productPhotoKeys, unfitted?}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `result jsonb`                                             | `{photos.outcomes, products.failed, stored, checked, photoHold, photoReviews, firstClaimedAt, interruptions, distinctness}`: the v2 plan after assemble (replaced by the checked plan), whether the checks ran, the photo allowance held, the photo checks asked; firstClaimedAt is the epoch-ms time of the first claim, which starts the 4-hour ceiling and is kept by every save; interruptions counts claims that found the claim before them gone with nothing handed back, and is for the logs only; distinctness is the redo memory's check of a full redesign, written with the compiled plan and kept by every save (section 5): its status (not-compared, distinct, changed, too-close or error, or skipped with the reason earlier_unreadable or theme_unavailable), whether it passed, the same-theme bar, the distances to this store's earlier redesigns before and after, and the choices changed and kept, in numbers and closed words only |
| `draft_id uuid null`                                       | the card's draft once ready; FK mink_drafts ON DELETE SET NULL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `free boolean`                                             | this revamp is the store's free one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `budget_credits int null`                                  | what a paid revamp may spend (section 6); null when free or unmetered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `credits int`                                              | what the card charged (0 when free)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `lease_token uuid null`, `lease_until timestamptz null`    | the runner's lease                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `attempts int`, `max_attempts int`                         | a step's real failures (a claim, a wait on Google, a hand-over of a step that calls a model, and a claim that died count none); 4 by default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `cancel_requested_at timestamptz null`                     | when a Stop was asked for (section 4.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `last_kick_at timestamptz null`                            | the last poll or sweep kick (one per job per 30 s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `error_code text null`, `error_detail text null`           | closed codes; detail never shown raw                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `applied_at`, `published_at`, `undone_at timestamptz null` | lifecycle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `publish_snapshot jsonb null`, `apply_snapshot jsonb null` | what Undo restores                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `usage jsonb`                                              | input, output and thinking tokens, images, reviews, estimated cost                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `created_at`, `updated_at`, `finished_at`                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Constraints: one active revamp per store (`mink_revamps_one_active_idx`,
`unique (store_id) where status in ('queued','running')`); the status, kind
and step vocabularies; `free` only on `full`; a refinement always has a
parent; `credits` between 0 and 200 and 0 when free; `budget_credits` null
when free; `max_attempts` between 1 and 10; a `failed` revamp always has an
error code; a lease token and its expiry set together; `request` an object
and `progress` an array. A `ready` revamp always has its draft
(`mink_revamps_ready_check`), which is why nothing may delete a ready card's
draft without settling the revamp first (sections 4.3 and 11). The store
foreign key cascades; every other foreign key is `ON DELETE SET NULL`.

The insert takes a per-store advisory lock (`createRevampJob`), and that is
what serialises one active revamp per store and decides the free revamp; the
unique index is the backstop.

### 4.2 Table `mink_revamp_images` (service-only)

One row per stored photo: `revamp_id`, `store_id` (both cascade), `slot_id`,
`role` (`anchor`, `slot`, `product`), `url`, `path`, `sha256`, `width`,
`height` (1 to 8192), `review` (`passed`/`flagged`/`unreviewed`),
`problems jsonb` (besides the check's problems, `unchecked` marks a photo
shown unchecked and `smaller-than-frame` one still smaller than its frame:
both listed under "Not done this time" and never charged), `created_at`,
unique per (`revamp_id`, `role`, `slot_id`).
A shot's phone crop is a second row under `<shot>~phone`, and a photo
waiting for its review is parked under `<shot>~review`, which no section
reads (section 8). A resumed run skips every slot with a row and reuses the
stored anchor as the shoot's reference. Every drawn photo is paid, so it
is stored the moment it settles, never at the end.

### 4.3 Steps

| Step       | What                                                                                                                                       | Bounded in the code by                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot` | read pages, chrome, design, theme, categories, products, facts, ownership                                                                  | at most 100 pages and 1,000 products (samples first), plus a lookup of up to 100 named products past that cap; the broken-image read checks 80 images, 6 at a time, 3 s each, 6 s in all |
| `plan`     | one structured model call writes the whole site (section 5)                                                                                | 6 minutes per call from its admission to the shared capacity; a second call in the same run only with 6 minutes left                                                                     |
| `compile`  | validate; up to 2 repair calls with the issues, then the lenient finaliser; then, for a full redesign, the redo memory's check (section 5) | `REVAMP_MAX_REPAIRS` (2); a repair call that fails finalises at once; the earlier plans are one narrow read and the check is pure (about 2 ms); neither fails or delays the step         |
| `photos`   | anchor, then every shot 3 at a time, reviewed, redrawn up to 2 times                                                                       | at most 26 shots; the store's day (120 photos) and the platform's hour (400), claimed before drawing                                                                                     |
| `products` | a studio photo for each new merchant product with a photo                                                                                  | 3 at a time, 75 s per attempt, up to 5 waits when the model is busy                                                                                                                      |
| `assemble` | photos into sections, fallbacks, the v2 plan                                                                                               | pure, no I/O                                                                                                                                                                             |
| `checks`   | the self-checks in section 7                                                                                                               | each photo the plan uses is asked of storage (`gcsObjectInfo`); a storage error never counts as missing                                                                                  |
| `card`     | the draft (free or charged), status ready, notification                                                                                    | the lease is renewed (and a Stop seen) before the charge                                                                                                                                 |

The code sets no time target per step; a step runs until it is done or the
invocation's deadline comes.

The runner claims the lease (`lease_until = now() + 5 min`), renews it every
60 s, runs steps until its own deadline (18 minutes inside a 1,200 second
route), writes each step's output before the next, and fences every write on
the lease token: a lost lease aborts the work in flight, and nothing is
written after the lease is gone. At the deadline the step drains: it starts
no new paid call (a photo draw, or a check of a shoot photo, still waiting
for its turn stops waiting and is never sent), lets the calls in flight
finish and be stored, and is
stopped 90 s later if it is still running (`REVAMP_DEADLINE_GRACE_MS`). The
runner then hands over:
it gives the lease back and kicks the next invocation. ⚠ A provider call that
runs past the 90 s can still be cut off and paid for again.

The requester's authority is rebuilt from the database at every claim
(`actor.ts`): a requester who lost drafting or Builder manage ends the job as
`not_allowed`. One server process runs one revamp at a time
(`REVAMP_RUNS_PER_PROCESS`, 1): the run route answers a kick it turns away
with 429 and `Retry-After: 30`, claiming nothing, and the run that ends
kicks the oldest waiting job (`kickWaitingRevamp`). The run route answers
503 and claims nothing while Mink AI is switched off.

Stop (the card's button): a queued revamp, or a running one nobody holds, is
cancelled at once; a running one records the request, which the runner sees
at its next renewal and again just before the card step makes and charges
the card, and the card says "Stopping" until then. A build stopped before
its card exists is charged nothing.

Who kicks the runner:

- `start_storefront_revamp` and `refine_storefront_revamp`, after insert.
- The runner at its deadline, when it stops with work left, and a run that
  turned a kick away while it held its process's slot, which kicks the
  oldest waiting job once it frees the slot.
- `GET /api/mink/revamps/[id]` when the job is queued or running with no
  live lease, no Stop recorded, attempts left and inside its 4-hour ceiling
  (at most once per 30 s per job, the cooldown claimed in `last_kick_at`;
  the route allows 120 reads a minute per admin), so a merchant watching the
  card keeps a job moving with no scheduler (owner's rule: no schedulers on
  dev).
- Production's existing minute job `/api/cron/mink-workflows`
  (`sweepStalledRevamps(5)`): it finishes cards already made and paid for
  (up to 25), fails jobs out of attempts or past their ceiling (detail
  `run_ceiling`), cancels stops no runner will see, kicks up to 5 stalled
  jobs (one kick each) and gives back the photo allowance finished jobs
  still hold. The same job closes chat runs a dead server left running
  (`closeStaleMinkRuns`, at most 20 a tick), keeping their revamps (below).

Failure policy: a step that fails for a transient reason gives the lease
back under a token nobody holds and is claimed again after 60 s
(`REVAMP_RETRY_AFTER_MS`, `attempts < max_attempts`). Attempts count a
step's real failures (robustness audit B8). The claim counts none. A parked
release counts one unless the runner says the failure was only a wait on
Google (a transient `model_unavailable` or `photos_unavailable`, or any
`RevampRetryLaterError`), which is parked and not counted. A deadline
hand-over counts one only when it caught a step that calls no model
(snapshot, assemble, checks, card) still running, and none when the step
waits on Google (`REVAMP_GOOGLE_BOUND_STEPS`) or the job is between steps. A
claim whose process died with nothing handed back counts none
(`result.interruptions`). A step change resets the count to 0, and so does
a deadline hand-over that stored new photos. What ends a job that never
finishes is `REVAMP_RUN_CEILING_MS`, 4 hours from `result.firstClaimedAt`:
past it the claim refuses the job, nothing kicks it, and the status read or
the sweep fails it as `out_of_attempts` (detail `run_ceiling`); a card
already made still ends ready. A step that knows its own wait (the
platform's photo hour is used up) is parked for that long, 20 minutes for
photos (`photos_unavailable`). The plan step's model errors are
retried with the Theme Studio back-off inside the call, and the plan is
asked once more in the same run when the first call failed busy or slow
(section 5). A job that runs out of attempts is `failed` as `out_of_attempts`
(the status read and the sweep both settle it); its paid photos stay in
storage, hidden from the Media Library, since only Apply reveals them. A
failed full revamp does not use the store's free revamp. A failed redesign
gives the store's day's start back once (B5), after the transaction that
failed it commits, to the window that counted it (`releaseSpendLimits` with
`claimedAt` = the job's creation time). A job someone asked to stop keeps
its start, as a cancelled one does; a ready, applied or superseded one
never gives it back.

- A card already made and charged is never cancelled or failed by a Stop, a
  failure, a spent attempt budget or a chat run that fails or is stopped. A
  Stop, a failure or a spent attempt budget that lands between the card step
  making the card and the job recording it finishes the job as `ready` with
  that card, charged exactly what its draft charged, whoever settles it (the
  runner, the status poll, the sweep or the Stop itself), and retires the
  same older cards a ready card retires (section 10).
- A revamp outlives the chat run that started it (B4, 24 Oct 2026). When
  the run fails or is stopped (a barge-in, Stop, a closed tab, a stalled
  last turn, or a server that died, closed later as `run_abandoned`), its
  failure record (`failMinkRun` in `persistence.ts`) cancels nothing, asks
  nothing to stop and refunds nothing. A queued or running revamp carries
  on, and a ready card stays ready and charged. The run's other unseen
  proposals are still discarded and refunded, never the card's draft (the
  draft whose id is the revamp's, or the revamp's `draft_id`). The card
  reached the merchant only in the run's answer, so the record saves that
  answer: one assistant message under the run, with the revamp's
  `storefront_revamp` artifact under a plain line ("Your storefront redesign
  is being made. You can follow it here." or "Your storefront redesign is
  ready. You can review it here."), marked `interrupted: true`. The stream
  route sends it before its error while the merchant is still watching. A
  tab that stopped reading first (Stop pressed there, or the reply cut off)
  and saw the start or refine tool called with no answer asks for the chat
  again after 1.5, 4, 10, 30 and 70 s until a card saved under that run is
  there, then shows it after its question (`awaitKeptCard` in
  `app/dashboard/mink-ai.ts`; the record can wait a minute for a tool's
  write). History, a reload and the ready notification show it too. The
  merchant stops a revamp with Stop on its card (the Stop paragraph above),
  which gives the free revamp back. A run that succeeded is untouched. A
  chat run that has stopped never starts a revamp (section 11).

Failure codes: a failed job carries one closed code (`REVAMP_ERROR_CODES` in
`contract.ts`; a step throws the `step-error.ts` subset, and a code outside
the list is stored as `internal`), and the card shows that code's sentence
(`REVAMP_ERROR_MESSAGES`), never the detail, which is logged. A transient
failure is a wait (the failure policy above); the rest end the job at once.

| Code                 | When                                                                                                                                                                                                     | The card says                                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model_unavailable`  | the design model was busy, slow or out of reach (a wait), or refused the request for a configuration fault (for good)                                                                                    | "Mink AI could not reach its design model for long enough to finish. Nothing was changed. Ask Mink to try again in a few minutes."                                                  |
| `model_refused`      | the design model declined the request, or the image model declined the shoot's anchor photograph after every redraw                                                                                      | "The design model declined part of this request. Nothing was changed. Try describing the store a little differently."                                                               |
| `plan_invalid`       | nothing usable was left of the plan after its repairs (`finalizeRevampSite`)                                                                                                                             | "Mink AI could not put together pages that pass its own checks this time. Nothing was changed. Ask Mink to try again."                                                              |
| `photos_unavailable` | a wait, never how a job ends: while a shot can still be drawn, for the platform's photo hour (20 minutes), or while the image model is busy, slow or out of reach for the shoot's anchor photograph      | "The photo service was too busy to finish the new photographs. Nothing was changed. Ask Mink to try again in a few minutes."                                                        |
| `photos_failed`      | every shot left is a parked photo a check blocked, with nothing kept to crop from (`nothingToCropFrom`, 24 Oct 2026), or the shoot's anchor photograph failed its check after every redraw; never a wait | "The new photographs did not pass Mink AI's own checks this time. Nothing was changed. Ask Mink to try again."                                                                      |
| `store_changed`      | in the list; no step raises it today                                                                                                                                                                     | "Your store changed while Mink AI was working on it. Nothing was changed. Ask Mink to start again from the store as it is now."                                                     |
| `theme_missing`      | the store has no theme a redesign can work within (`snapshot.ts`)                                                                                                                                        | "Your store needs a theme before Mink AI can redesign it. Choose one under Online store, Storefront."                                                                               |
| `not_allowed`        | the requester can no longer change the Website Builder (rebuilt at every claim)                                                                                                                          | "Your role cannot change the Website Builder, so Mink AI stopped. Ask the store owner."                                                                                             |
| `out_of_attempts`    | four real failures in a row at one step (detail `attempts_exhausted`) or past the 4-hour ceiling (`run_ceiling`), settled by the status read or the sweep                                                | "Mink AI tried several times and could not finish. Nothing was changed. Ask Mink to try again later."                                                                               |
| `limit_reached`      | the store's own day of photographs refused the shoot, with nothing to crop from                                                                                                                          | "Your store has made as many new photographs today as Mink AI allows, so this redesign stopped. Nothing was changed. Ask Mink again tomorrow."                                      |
| `cancelled`          | a Stop (the status view's sentence; the card's Stopped state shows its own line, section 11)                                                                                                             | "You stopped this redesign. Nothing was changed."                                                                                                                                   |
| `internal`           | anything else, StoreMink's own setup included: media storage or the image model not set up, or the shoot's anchor photograph failing for any reason but an outage                                        | "Something went wrong while Mink AI was working. Nothing was changed. Ask Mink to try again."                                                                                       |
| `out_of_credits`     | the store's balance fell below what the card costs while it was being made (section 6)                                                                                                                   | "This store ran out of Mink credits while the redesign was being made, so it stopped. Nothing was changed. Buy Mink credits or upgrade under Plans & Billing, then ask Mink again." |

Each permanent photo failure carries the code whose sentence is true for it
(`anchorFailureError` in `photos.ts`, 25 Oct 2026): they all used to be
`photos_unavailable`, whose sentence blamed a busy photo service and asked
the merchant to wait, which no wait fixed.

## 5. The site plan (one model call)

Model: `gemini-3.8-flash` through the Theme Studio structured client
(`site-planner.ts`) on the planner's own scope of the shared provider
capacity (`REVAMP_PLANNER_CAPACITY_SCOPE`, plans and repairs alike, apart
from the photo checks on the same model), HIGH thinking, JSON
schema output, no output cap. One call may run 6 minutes from the moment the
shared capacity admits it (`REVAMP_PLANNER_TIMEOUT_MS`); a call that fails
because the model was busy or slow is asked once more in the same invocation
when at least 6 minutes are left before the deadline
(`REVAMP_PLAN_CALLS_PER_RUN`, 2). The prompt version is
`mink-revamp-site-v5`. Inputs, each a block fenced as data:

- `<brief>`: the shop's name, the language, what the shop sells, the look,
  who buys, the merchant's facts and what to avoid. `<brand_voice>`: the
  store's saved brand voice (the guide saved under Branding, cut to 3,000
  characters), when there is one; the planner follows its tone, and it is
  never an instruction, never changes the language and never evidence for a
  fact or claim. `<products>`: the merchant's products (name, description,
  sizes at their prices and MRP, category, whether it has a photo a shot may
  show), each marked when the store already has it, whether real products
  will exist, up to 40 of the store's own published products, each with its
  goods key (`shop:<slug>`) and whether it has a photo, and the goods keys a
  photograph may show. `<categories>` and `<category_changes>`: the store's
  categories and the confirmed changes.
- `<store_facts>`: delivery promise, free delivery threshold, returns, cash
  on delivery, online payment, pickup, and the city and state.
- `<theme>`: the theme's name, palette and layout variants, the current
  design overrides and appearance, the variants the plan may pick, and what
  the announcement bar shows today.
- `<scope>`: every page with whether to write it, each section with its
  owner and a one-line summary, the merchant's and custom-code sections
  marked KEEP (kept by id), and the pages the merchant named.
- `<refill_shots>`, `<category_shots>`, `<link_targets>` and
  `<owned_photos>` (up to 40): the shots to write as listed, the link
  targets, and the photo URLs the store already owns.
- The section vocabulary: every allowed section type with an example config
  (the fields of `EMPTY_CONFIG`; a list it leaves empty is shown with
  example items, field for field, and its key and bounds are named, so the
  model never guesses an item field the validator drops). Each example is
  printed complete and with nothing to copy (prompt v5,
  `revampPromptExample`): every closed setting is "choose one: ..." with its
  options listed from a place seeded per store and redesign, every word
  field an instruction ("write in English: ..."), every link "choose one: a
  path listed in link_targets, or leave it empty", every photo field a shot
  (`revamp-slot://<shot id>`), a list holds the items its minimum asks for,
  what the compiler sets itself (a product or category band's source and
  ids, the trust bar's and the ticker's text colour) is left out, and the
  opening's examples offer its height. Then the font pairing library, the
  design directions with the palettes each is painted on, cream explained
  as the page background in Theme Studio's words, and the industry
  playbook's homepage structures for the business (Theme Studio's variety
  form: after the opening, only the types a redesign may add, in an order
  seeded per store; the photo-carousel opening stays every store's; only
  structures at least a third apart by Theme Studio's sequence distance, so
  a trade whose discovery and catalogue-first differ by one section gets
  two; never the playbook's `defaults`, one value per trade),
  its industry from `revampIndustryGuess` (every industry scored over the
  merchant's words, product and category names three times, the business
  line twice, descriptions, audience and facts once, phrases before single
  words, a tie to the table's order; beauty's oils are phrases, such as
  "face oil", "hair treatment oil", "beard oil" and "argan oil", and a bare
  "oil" counts for food only when no word reads as beauty or wellness), and,
  for a refinement, the previous
  plan, the instruction and the refinement's scope. The rules are the
  revamp's own system instruction (`revampSiteSystem`), not Theme Studio's
  Stage B prompt.
- `<earlier_designs>`, after the playbook: a summary of this store's own
  earlier redesigns, when the runner has one (never another store's),
  fenced and cut to 4,000 characters (`REVAMP_EARLIER_DESIGNS_MAX`); the
  planner chooses differently on every choice the merchant did not ask
  about. Absent or blank prints nothing, so the prompt is the same byte for
  byte, and a refinement never gets one.

Output (closed schema, `site-schema.ts`):

```
{
  promptVersion,               // "mink-revamp-site-v5"; absent on a v4 answer
  summary, industry, direction,
  design: { palette: {cream, creamDeep, surface, ink, inkSoft, inkFaint, border, accent},
            fontPairing, radii: {card, control, sm, pill} },
  appearance: { header, card, productDetail, footer },      // null keeps the theme's
  announcement: { text, href },
  brand: { tagline, blurb },
  newsletter: { heading, subtext, buttonLabel },
  pages: [ { slug, title, seoTitle, seoDescription,
             sections: [ { keep: "<section id>" }
                       | { type, configJson, style: {scheme, padding, width} } ] } ],
                       // one shape: keep "" for a new section
  menus: { header: [ {label, href, children: [{label, href, children}]} ],
           footerGroups: [ {title, links: [{label, href}]} ] },
  shots: [ { id, purpose: "hero"|"content"|"category", goods: "merchant"|"none",
             productKeys, subject, artDirection, aspectRatio,
             people: "none"|"adults", category } ],  // category slug, or null
  productCopy: [ { key, description } ]
}
```

Rules the prompt states and the compiler enforces:

- Image fields hold `""`, `revamp-slot://<shot id>` or a URL the store
  already owns (a kept merchant photo or a product photo).
- Real goods or no goods (owner, 23 Oct 2026): a banner, content or category
  photograph shows one or two of the merchant's own products, named by
  goods keys from `<products>` (a request product's key or `shop:<slug>`,
  only products with a photo of their own that the store owns, never one
  under another store's prefix, and only a photo the photos step can read,
  an object under this store's own prefix: `revampGoodsCatalogue`, from the
  snapshot's `photos.readable`), or a scene with no products at all (a
  setting, materials, ingredients, or a still life of props). The compiler
  drops a key that names no such product, keeps a category's photograph to
  that category's products, keeps at most two, and turns a shot meant to
  show goods with no key left into a scene with no products, asking the
  model to fix it in a strict compile. A shot that lost any of its products
  is described in the compiler's own words, exactly the products it shows or
  the store's setting with no products in the picture
  (`revampShotSubjectFor`), because the model's may name the lost ones; a
  shot with no products has nobody in it (`people` "none"). A carried
  photograph keeps its words. A shot compiled before v5 reads as one with no
  products (`revampShotGoods`). Theme Studio's demo themes keep their
  fictional goods.
- A menu link labelled Home (any case, Home page, Homepage) goes to `/`,
  silently, in a menu the plan writes or a refinement copies, unless it goes
  to the store's own category or product called Home (or at the address
  "home") or a page titled Home (`homeNamedLinks`): a lifestyle shop's Home
  category keeps its link. A theme sample is never such a target.
- One colour that fails never costs the whole palette (B18): a page, card,
  text or accent colour that is not a colour follows the theme's; a soft
  band, muted or faint text or hairline that is not one is worked out from
  the page and text colours (SCHEME_MIX); text that does not read moves
  toward black on a light page (white on a dark one) in 5% steps, the least
  that reads everywhere; a background even black text cannot read on moves
  toward white (toward black on a dark page); a tinted band no text can read
  on gives up the new accent; a page that would flip light to dark keeps the
  theme's page and text colours with the new accent (`repairRevampPalette`).
  The mended palette must pass the same rules, or the theme's colours are
  kept as before; the card says which.
- Distinct by default (v5; robustness audit, section 5): whatever a v5
  answer leaves out (a section setting, the direction, the opening's
  height, button, side and text colour, the header's one link, the
  newsletter lines, a search description's close) is picked for the store
  from the same closed list (`revampSeededPick`, seeded by the store and
  the redesign), never one default for every store; a story alternates
  sides, a row with a photo is an image row and a trust bar's icon follows
  its words. The default art direction names no light: a photo look varied
  across stores is step 9, which waits for the owner. Copy fallbacks are
  neutral English lines that pass the claim checks and promise no
  frequency of email (`REVAMP_NEUTRAL_COPY`). An example's instruction
  copied into the answer is asked for again in a strict compile and
  cleared in the lenient one; the issue names the field and the
  instruction's opening words, never what follows. Text on a plain background
  is dark on a light page and light on a dark one, or against its own
  background colour (a trust bar, a ticker, a hero not over its photograph,
  a split carousel's slides, a plain tile or banner). An answer that names
  no prompt version (planned under v4) compiles exactly as it did.
- The page colour suits the chosen direction (palette honesty): cream is
  the page background, and a page that none of the direction's palette
  families accepts (Theme Studio's `paletteFamilyIssues`: a tinted-neutral
  page is never near-white, a colour-field page is coloured itself) is
  moved toward the store's accent in 5% steps, the least that fits and at
  most 60%, never across light and dark, with text the move leaves
  unreadable mended by the B18 rules; when nothing fits, the theme's page
  if it fits, else the palette as it was. Silent and free: never a repair
  call, and never where B18 kept the theme's page. Only a page colour Mink
  chose moves: never in a refinement, and never when the merchant's words
  name a page colour (`revampMerchantNamesPage`: a page or background word
  beside a colour, or white, off-white, cream, light, dark and the like in
  the look, what to avoid or the instruction). The prompt asks for that
  colour first and a direction whose palettes allow it; when the answer
  pairs it with another direction, both stay as answered.
- Links are site paths: `/`, `/shop`, `/collections/<slug of a category that
will exist>`, `/<slug of a page that will exist>`, a policy page,
  `/shop/<slug of a product that will exist>`, or the storefront's own blog
  and enquiry form (`/blogs`, `/enquiries`), which every store serves. A
  post (`/blogs/<slug>`) is not a target, since the snapshot reads no posts;
  the checks leave alone a link the store's own header, footer or bar
  already has to a route the storefront always serves (the blog and its
  posts, the enquiry form, cart, orders, profile, notifications).
- The homepage opens with a full-band photograph at full width, large or
  screen height, with no colour scheme: a `hero_carousel` of two or three
  slides, each its own shot of the same shoot, or a single `fullbleed` hero
  only when the business really has one picture to show.
- The store is led by photographs. Besides the opening, the homepage has at
  least one band led by photographs (a gallery of four to six, a
  `tile_grid` whose tiles, or a `multicolumn` whose items, each have a
  photo, or a `media_text` with two stories, each with a photo); every other
  page written carries at least one photograph; a redesign of the whole
  store describes about 10 to 20 shots. For a full redesign, the compiler
  asks for a repair when the homepage it writes shows fewer than 3
  photographs outside product sections, or, when the merchant named no
  pages, the plan has fewer than 8 shots; a shot counts only when an image
  field names it. This is a style
  floor, not a defect: the lenient pass after the repairs takes the plan as
  it is, and the card says nothing about it. A list section whose items were
  all dropped gets a repair sentence naming its list key and item fields.
- The homepage has at least four sections chosen for the business; a
  strict compile asks for more when it has fewer. After the opening it
  follows one of the structures the playbook offers, or blends two (a rule
  of the prompt; the repair sentence names the structures, v5).
- Sample-claim sections are never used: testimonials, logo strip, countdown,
  comparison, before/after, hotspots, video, and no blog feed. Custom code is
  never added.
- A newsletter section is only the last section of a page, at most one, and
  none on a page that keeps the merchant's own; the compiler moves or drops
  one that breaks the rule.
- `featured_products` and `product_spotlight` appear only when the store
  will have real published products. A product band shows `featured`
  products when the redesign creates a product (each one is created
  featured) or one of the store's own published products is featured;
  otherwise it names the store's own published products (never a sample),
  most recently changed first, up to its limit, because `products.featured`
  defaults to false and a `featured` band on such a store would publish
  empty. The checks apply the same rule to the stored plan.
- A product the merchant names that the store already has (one of its own
  products with the same name, case and spacing aside; a sample never
  counts) is never created again. The prompt marks it, a published one is
  linked where it is (`/shop/<its slug>`), a draft one is never linked, and
  the card says it was already on the shop, or is a draft to publish under
  Products.
- `shop_by_category` appears only when at least two real categories will
  exist.
- On the homepage two or three sections (never the opening) wear a colour
  scheme, on other pages one or two; neighbours never share one. The
  compiler holds every page to three schemed sections, and a strict compile
  asks for at least two on a homepage of four or more sections. The
  merchant's kept sections count first and are never changed, so only
  the model's own schemed sections are held to the room left (none when the
  kept ones already wear three); a page whose kept sections wear more asks
  for nothing.
- Copy: English, original, from the merchant's facts only. A word in the
  claims list (section 7.3) needs the merchant's own words behind it.
- `summary` (the card's explanation) is one or two short, plain sentences to
  the merchant about what their shoppers now see, the homepage first, in
  "you" and "your" (never "we", "our" or "us") and with no judging or
  marketing words.
- The model writes no notes for the card. The card's notes are the code's
  own sentences (the compiler's mechanical fixes, the permission and
  already-on-your-shop notes, the theme's announcement line switched off);
  what was left out is under "Not done this time" and the checks are
  listed beside them. A free note from the model was checked against
  nothing, and the second live run's were wrong or repeated the card.
- No long dashes.
- The announcement bar: the prompt says what the bar shows today. A blank
  announcement writes none: a bar that would show the theme's sample line
  (left on with no text, or holding exactly the theme's words) is switched
  off in the draft and the card says so; a line of the merchant's own, or a
  bar they switched off, stays as it is.

Repair: the compiler returns a list of issues. Up to two repair calls send
the previous output and the issues and ask for the whole corrected output.
After the second, remaining problems are fixed mechanically where possible
(drop the section, drop the link, clear the claim) by the lenient
finaliser, and noted. The job row keeps only the compiled plan, so each
repair and the finalising pass log their issues (`mink.revamp: compile
repair`, `mink.revamp: compile finalized`). A repair call the model could
not answer is not asked again: the plan is finalised at once, and
`repairFailed` is checkpointed on the job so a later invocation finalises
too instead of repeating the call.

Distinct from this store's earlier redesigns (robustness audit section 5,
step 6). The planner sees up to five earlier redesigns of this store as
`<earlier_designs>` (`earlierDesignsSummary`: one line each of closed words
only, the direction, font pairing, palette family and page band, corners,
homepage skeleton with its colour bands, image sides, opening, card, header
and footer, never the store's words, names, links or photos). After
compiling, before any photo is drawn, a full redesign is measured against
each of them over the store's current theme with Theme Studio's fingerprint
(`revampFingerprint`, in `distinctness.ts`). It must be at least the
same-theme bar apart from each (`revampDistinctnessBar`: 0.35, Theme
Studio's bar for two themes, times the share of the fingerprint the theme
leaves to a plan, 0.289 on every bundled theme). The bar is calibrated, not
copied: two redesigns on one theme can never differ in what the theme fixes
(buttons, headings, page width, grid and motion, 18 of the fingerprint's 104
points on each bundled theme), so the bar asks of the rest the share Theme
Studio asks of two themes. The audit's pairs, re-measured by
`distinctness-calibration.test.ts`: the same bakery planned twice on Basket,
0.166, below the bar; that bakery against the skincare shop on Ritual,
0.452, above it. When a redesign is closer, `makeDistinct` changes, once
each and in this order, only what the merchant's words do not name
(`revampRequestedChoices`; words that ask to keep or reuse the design, such
as "keep the same layout" or "as before", and any letter outside the Latin
script, name every choice, so nothing changes) and only for a strict gain: the band rhythm (same
number of bands, as many quiet and strong ones, readable in the plan's
colours), the image sides (only when they repeat a redesign it is too close
to), the opening's height (large or screen), the card style (only a card the
plan chose, never grocery), the font pairing (only in a plan with a look of
its own). It never changes words, products, links, photos, the palette or
the merchant's sections, never a refinement, and never the store-wide card
and fonts in a redesign of named pages. A redesign that cannot clear the bar
keeps its best plan (`too-close`), and the check never fails or delays a
redesign.

In the job (`runner.ts`, `jobs.ts`): a full redesign's runner reads the
earlier plans once per invocation (`readEarlierRevampPlans`: this store's
redesigns whose card is ready or was superseded, with a compiled plan,
newest first, at most 5, never the job asking, the plan alone), passes their
summary to the plan call and to every repair, and passes the redesign's id
to every planning, compile and finalise call, which seeds the choices picked
for it. The check runs once the plan is compiled, before the budget fit and
before any photograph, over the store's current theme from the runtime
registry, and again on the plan the fit leaves (`makeDistinctAfterFit`), and
on a plan fitted again to a fallen balance before the photographs: the fit
can drop what it counted on (a balance below the design drops the colours,
fonts and corners), so the record's distances and verdict are those of the
plan shoppers will see. Its report is saved as `result.distinctness` with the compiled
plan and logged once as `mink.revamp.distinctness` (the redesign's id, the
status, whether it passed, the bar, the distances and the number of changes;
no words). Earlier redesigns that cannot be read, or a theme the registry
cannot serve, skip the check (`skipped`, with the reason), and a check that
throws keeps the plan as compiled (`error`): the redesign goes on either
way. A refinement has no memory and no check, and a compile step resumed
with a compiled plan is not checked again.

The paid measurement (step 10) is `scripts/revamp-uniqueness-test.ts`
(section 14); it has run only offline, so how often the model follows
"choose one" and the instructions, and how far apart its designs land, are
not yet measured.

## 6. Charging and the free revamp

- `free` is decided when the job is created, in the same transaction that
  inserts it, under a per-store advisory lock (`createRevampJob`): true for
  a full revamp when the store has no other free full revamp that is
  queued, running, ready or superseded (one that failed or was cancelled
  does not count). The unique active index is only the backstop.
- At the `card` step (`card.ts`): a free revamp, and a paid one whose bill
  came to nothing, inserts the draft with `expected_credits = 0`,
  `charged_credits = 0`, `credit_source = 'free'` and does not call the
  charge function. A paid one charges the plan's total through
  `createMinkDraftProposal`, capped at 200; the draft's id is the revamp's
  id, so a card step that runs twice finds its draft and charges nothing
  again. A malformed total fails the job rather than reading as free.
- The budget a paid revamp may spend is set when it starts: the store's
  remaining credits less the most the chat run that starts it can still
  cost (`MINK_MAX_RUN_CREDITS`; that run is settled from the same balance
  after the tool returns), never below nothing; a free revamp, or one on an
  unmetered plan, has no budget. A paid start whose budget cannot cover the
  card's fixed floor (`revampFixedCreditCeiling`: the homepage's words, the
  header and footer, the opening photograph and each confirmed category
  change) is refused before the job exists ("This store doesn't have enough
  Mink credits left for a redesign. Buy Mink credits or upgrade under Plans
  & Billing.", no figure). A refinement's floor counts only what it does not
  carry: the homepage's words when it writes the homepage, the header and
  footer when it changes the words, the layout or the look, the opening
  photograph when it is redrawn or the homepage is written again, and the
  category changes its parent did not make.
- Before paid work, the plan is cut to the budget in the order a shopper
  notices it: the fixed floor first, never dropped; then the look, the
  confirmed categories' photographs, the homepage's other photographs, each
  other page with its photographs, and studio photos of the merchant's
  products. What did not fit is listed under "Not done this time". The
  uncut plan is kept beside the cut one (`unfitted`).
- The balance is read again just before the photos (`fitToBalance`): when
  the store can no longer pay the plan's estimate, the plan is fitted again
  from the uncut plan to what is left, and when even the fixed floor no
  longer fits, the job fails as `out_of_credits`. A card whose charge finds
  too few credits fails the same way. The merchant reads: "This store ran out
  of Mink credits while the redesign was being made, so it stopped. Nothing
  was changed. Buy Mink credits or upgrade under Plans & Billing, then ask
  Mink again."
- The card charges for what this revamp made and still shows, item by
  item: the pages it writes; each photograph drawn in this revamp that a
  page or category still shows (a slot that got a recrop of another photo
  instead, a photo shown unchecked because its check could not be had in
  time, or a photograph still smaller than its frame after its redraw, B14,
  is listed under "Not done this time" and never charged); a look
  of its own; the header and footer; the confirmed category changes; a
  studio photo shown on a product it creates. The self-checks recount after
  they take anything out (a photo, a page, a look reverted for contrast),
  so the card never bills for something it does not show. A product the
  store already has is not created (section 5), so its studio photo is
  neither drawn nor charged.
- A refinement is charged only for what it makes. The compiler records what
  it carries in the plan's basis (`basis.carried`: pages, shots, look,
  header and footer, category changes and products), and the estimate, the
  budget fit and the card's charge all read it: the parent's work (and an
  earlier version's, section 10) costs nothing again and is never dropped
  for want of credits. A carried product's studio photo is the earlier
  version's own photo, taken over at no charge and drawn only when there is
  none to take; it is charged and drawn afresh only when the refinement is
  about the products.
- A failure never charges: a build that fails, or is stopped before its
  card is made, charges nothing. A ready card stays charged when its chat
  run fails, because the card is kept (section 4.3).
- Migration 0234 widens `mink_drafts_credit_check` so
  `storefront_personalization` may hold 0 credits with source `free`, and
  adds `free` to the credit source vocabulary.

## 7. Self-checks (before any card is shown)

### 7.1 Deterministic

The card lists nine checks, each passed or failed (with notes): "Every
photo is new and loads", "No sample text from the theme is left", "Every
page is ready to publish", "Every link goes somewhere real", "Product
sections show your own products", "Text is easy to read", "Written in
English" (only when the brief is in English), "No claims you did not make"
and "Looks right on phones". In order, `checks.ts`:

- No `revamp-slot://` left; every image URL is ours and exists
  (`gcsObjectInfo` for our bucket; a storage error never counts as
  missing). A photo that does not load is taken out.
- No theme photo and no earlier Mink photo left in any revamped page.
- No theme sample text left: a theme section left exactly as the theme
  seeded it is taken out. A theme section with new photos but the theme's
  own words is named in a note, never removed (it may be the page's
  opening). An earlier Mink section is kept on a refinement (it is the work
  being refined) and replaced on a full revamp.
- Product sections are present only when real products will exist, and a
  product band follows `revampFeaturedBinding` (section 5).
- No long dash; no claim word without support (7.3). Plain-text copy also
  loses `<` and `>` (`cleanRevampCopy`). The tagline and footer description
  Apply writes reach the homepage's Organization JSON-LD, and every ld+json
  script on the storefront is written through `serializeJsonLd`
  (`lib/seo/json-ld.ts`), which escapes `<`, `>`, `&`, U+2028 and U+2029
  (guarded by `lib/seo/json-ld-coverage.test.ts`).
- Every header and footer link reaches a page, category or product that will
  exist after Apply. A link of the store's own header or footer to a route
  the storefront always serves is left alone.
- Every section validates in publish mode; every page has a title and an
  SEO description of at least 20 characters (`fallbackSeoDescription` fills
  a short one).
- The design passes the contrast rules (`validateStorefrontDesign`,
  `contrastIssuesFor`); every solid hero passes `solidHeroContrast`.
- English: at least 90% of letters in Latin script in every field
  (`REVAMP_MIN_LATIN_SHARE`), measured after the shop's, its products' and
  its categories' names are taken out; only when the brief is in English. A
  field that fails is a note to read before publishing.
- Phone: the header keeps at most 7 top-level links. The opening photograph
  should have a phone crop; when it has none (section 8), the check fails
  with the note: "The opening photograph has no phone crop, so phones show
  the wide photo cut to fit."
- Then the photo list is pruned to the photographs a page or category still
  shows, and the charge is recounted.

### 7.2 What happens on a failed check

Mechanical fixes first (drop, replace, crop); anything left is a note on the
card. A card is never shown with a missing image or a dead link. A new look
that fails the contrast rules is reverted to the store's current colours,
and not charged; a solid hero whose text does not read gets the text colour,
or the theme's own field, that does. After the fixes the card's charge is
recounted from what is left (section 6).

### 7.3 Claims list

From Theme Studio's `claims.ts` plus the food and personal-care words FSSAI
treats as conditional claims, checked for every store whatever it sells:
pure, 100%, natural, fresh, organic,
traditional, original, authentic, chemical-free, preservative-free,
no added, healthy, nutritious, nutrient, immunity, heart, cholesterol,
small-batch, handmade, artisanal, award, certified, best, number one,
doctor, clinically, guaranteed (`REVAMP_CONDITIONAL_CLAIMS`). A sentence
with one of these is kept only when the merchant's own words contain the
same claim; otherwise the whole sentence is dropped, and a section left with
no words is taken out. A field that cannot go blank (a menu link, the
announcement bar) keeps its words and the card says to change it before
publishing. The evidence (`revampClaimEvidence`, one for the compiler and
the checks) is the store's name, the brief and its facts, a refinement's
instruction, the merchant's products' names and descriptions, the category
changes they confirmed, the names of the store's own products and
categories (never a theme sample's), and the store's facts (delivery,
returns, free delivery threshold, city and state). What the merchant asked
to avoid is never evidence, and neither is the saved brand voice (the
planner reads it for tone only). Process facts the merchant stated ("cold
pressed in our own facility") are fine.

## 8. Photos

- Shot list from the plan, at most 26 shots, each bound to the slots that
  use it. Slot frames come from the section config (`revampFrameKeyFor`,
  sizes from `lib/media/image-specs.ts`): a hero or carousel slide 21:9
  (`hero_wide`, 2520×1080), or 4:5 beside copy (`hero_side`, 1200×1500) for
  a banner or split layout; a hero's phone image 4:5 (`hero_phone`,
  1080×1350); promo_banner 21:9; tile_grid and accordion 4:3 (`landscape`,
  1600×1200); media_text and its stories by `media_ratio`; gallery grid by
  `image_ratio`, otherwise 4:3; multicolumn and image_marquee by
  `image_ratio`; a video poster 16:9; a category square (1200×1200).
- The anchor is drawn first from the homepage hero's shot and gates the run.
  Every later shot is matched to it, on one art direction. Model
  `gemini-nano-banana-2.1` at 2K with MEDIUM thinking (since 25 Oct 2026;
  `gemini-3-pro-image` before), reviewer `gemini-3.8-flash`, 3 at a time, 2
  redraws, anchor 3. Every draw takes its turn on the image model's shared
  capacity, which spaces starts across the platform (40 s apart to begin
  with, between 10 and 45 s as Google accepts or refuses, overlap allowed)
  and holds the others back at most 15 s after a 429. The picture kept is
  the last image part of the answer that is not a thought: the model sends
  a 1K draft first, which is never used.
- Real goods or no goods (owner, 23 Oct 2026): a shot of the merchant's
  goods sends each named product's own photograph (this store's objects
  only, read through `readStoreOwnedImageBytes`, a WebP of at most 1536 px)
  as a PRODUCT reference after the anchor, at most three references in all,
  and its prompt and its check both say to show exactly those products.
  Every other shot, and the anchor, shows no products at all, and with no
  products its people rule asks for nobody (`NO_GOODS_PEOPLE_RULE`). The
  anchor follows the opening shot's art direction, never its goods: a
  merchant opening shot gives it the store's setting as its subject
  (`noGoodsAnchorLead`). A product photo that cannot be found or read makes
  the shot a no-products shot (or one of the products read), described by
  what it now shows (`revampShotSubjectFor`); goods are never invented. The runner hands the photos step the job's
  request, so a product the merchant sent in the chat (a request key such
  as "p1") resolves as well as one the store sells (`shop:<slug>`). The
  check reports `wrong_subject` for a no-products shot that shows a packaged
  product, and for a merchant shot that shows a different, extra or
  invented product; label artwork on the merchant's own product is not
  `text_or_logo`. ⚠ Not yet seen live: how faithfully the image model keeps
  a real product's shape and label.
- A photograph narrower than its frame is drawn again once, inside the two
  redraws (cause `too_small`), when its check found nothing blocking. If the
  redraw is small too, the larger checked picture is kept and the card lists
  it under "Not done this time" ("The new photograph came back smaller than
  this place on the page needs, so it may look a little soft here."); it is
  not charged, also on a later invocation (the `smaller-than-frame` problem
  on its row). With no reviewer there is no retake; a small photo is still
  listed.
- The photo allowance is claimed before anything is drawn: 120 photos per
  store per day and 400 per platform hour (`claimSpendLimits`). When the
  store's day refuses, only the homepage's photographs are claimed and the
  rest are cropped from the shoot; with nothing to crop from, the job fails
  as `limit_reached`. When the platform's hour refuses, the step draws and
  crops nothing and waits 20 minutes for a later claim
  (`photos_unavailable`). What a step claims is held on the job row
  (`result.photoHold`) before it draws, so when a runner dies the next one,
  or the sweep for a finished job, gives back only what was never drawn; a
  photo parked for its review counts as drawn.
- Each image is cropped to its slot's frame and compressed
  (`prepareSlotImage`: WebP, never enlarged; at most 500 KiB, 1000 KiB for a
  frame 16:9 or wider; never narrower than 800 px) and stored the moment it
  settles, at
  `stores/<store>/mink-generated/revamp/<revamp>/<role>-<slot>-<sha8>.<ext>`,
  with a `media_assets` row filed as `mink_prepared` (hidden from the Media
  Library). Apply reveals the photos the card uses as `mink_generated`
  ("Made by Mink AI").
- A photo whose review was unavailable, or never started before the
  deadline, is stored parked under `<shot>~review` (no section reads it) and
  asked again after about 15, 30 and 60 s (`REVAMP_REVIEW_RETRY_DELAYS_MS`),
  during the shoot and after it, inside about four minutes from its first
  ask (`REVAMP_PHOTO_CHECK_BUDGET_MS`), by a later invocation too, which
  never draws it again and carries on from the tries, first ask and verdict
  saved on `result.photoReviews`. Each check goes to Google's US endpoint
  first and once to global when the US refuses (a 429, a 5xx, an outright
  403 or 404) or its try times out, each try on its own 75 second clock and
  its location's capacity row, with no 429 wait inside the call (TS-3D,
  25 Oct 2026). Only a pass or a minor problem makes it the
  shot's; a blocking problem never reaches a page. When the budget runs out
  (owner's decision, 23 Oct 2026) the shot takes a crop of an
  already-checked photo of the shoot that fits its frame
  (`REVAMP_CHECKED_CROP_MAX_LOSS`, never the anchor or another crop), else
  it is shown unchecked and listed under "Not done this time"; neither is
  charged. A photo shown unchecked is adopted (or, if the adopt fails,
  stored again) with the `unchecked` problem on its own row, so a later
  invocation keeps it unchecked even when the job row never recorded that
  its check ran out.
- A shot's phone crop is a centred 4:5 cut of the picture the model drew (a
  resumed run cuts it from the stored copy), stored under `<shot>~phone`.
  When the picture is too small for a cut of 800 px (a 21:9 picture drawn at
  1K is 672 px tall), no phone crop is made and phones show the wide photo
  (section 7.1). ⚠ Not built: a dedicated 4:5 draw for the phone.
- Every paid call is reported to the runner as it returns (`onUsage`), so a
  step that hands over has still counted what it spent.
- A slot whose photo failed after its redraws gets a crop of another photo
  the shoot kept for a page (one shown on another page when there is one,
  the least cut first), drawn under its own goods rule and checked as a page
  photo unless that check could not be had; never the anchor, a hidden
  reference whose check never looked for goods, never a theme photo and
  never an empty frame; the card notes it, and it is not charged. With
  nothing kept to crop from, the step fails: tried again later while a shot
  can still be drawn (`photos_unavailable`, a wait), and for good when every
  shot left is a parked photo a check blocked (it is never drawn again), as
  `photos_failed`: "The new photographs did not pass Mink AI's own checks
  this time. Nothing was changed. Ask Mink to try again." (section 4.3).
- An anchor that cannot be drawn stops the step, since nothing drawn without
  it belongs to the same shoot: a wait while the image model is busy, slow or
  out of reach (`photos_unavailable`), and for good when the model declines
  it after every redraw (`model_refused`), when it fails its check after
  every redraw (`photos_failed`), or for any other failure (`internal`), each
  with that code's sentence (section 4.3).
- A photo a redesign still holds cannot be deleted from the Media Library
  (`lib/media/image-usage.ts`): while the redesign is being made, while its
  card is ready, not applied, not undone and in a chat that still lists it,
  or while a refinement being made may carry it over. Once a card is applied,
  a photo is protected only where a page, the header or footer or a category
  still shows it. Nothing prunes either revamp table: a revamp and its photo
  rows live as long as the store, and a failed or cancelled revamp's paid
  photos stay in storage.
- Product studio photos: Mink's existing product photo path
  (`generateMinkMediaImage`, purpose `product`, the merchant's photo as the
  only reference, the store's card shape), 3 at a time. Ownership of the
  merchant's photo is checked again before it is read. Every one is asked
  for on the same backdrop, the redesign's page colour (the theme's when the
  redesign keeps it, white when no hex colour is known), so the shop grid
  reads as one shoot. Each draw takes its turn on the image model's shared
  capacity, start-paced like the shoot (a 429 is shared with every other
  caller on the model, nothing is sent once the drain began, and a draw
  still waiting for its turn then stops waiting, so it takes no start from
  the others). A product
  the image service is still turning away with 429 is asked for again five
  times, each after at most 15 seconds (jittered), the pacer spacing the
  tries, each try with its own 75 second clock, while one more whole
  attempt fits before the hand-over; otherwise it is left for the next run.
  A refusal, a timeout or a 5xx is never asked again here, since the last
  two may have been billed.
- Every studio photo is checked against the merchant's own photo before it
  is stored: the Theme Studio reviewer is shown both and asked whether it is
  the same item, with no added words. A problem means one redraw with the
  reason; a blocking problem that persists keeps the merchant's own photo. A
  check that cannot be made is asked again after about 15, 30 and 60
  seconds, each try on its own 75 second clock (the US endpoint first, then
  global, as for the shoot's checks), inside four minutes
  (`PRODUCT_PHOTO_CHECK_BUDGET_MS`, per invocation), and one that still
  cannot keeps the merchant's photo too, the card saying it could not be
  checked in time; only when an operator switched the review model off is a
  studio photo kept unchecked. No check is started once the drain has
  begun; a studio photo drawn as it began is made again on the next run,
  and a check already sent finishes.
  A product whose studio photo cannot be made keeps the merchant's own
  photo, and the card says why. ⚠ This check has not yet seen a real
  merchant's photo: the live check's phone photos are drawn by Mink's own
  image client (section 14).
- A product the store already has gets no studio photo (section 5). A
  refinement takes over the studio photo an earlier version made of a
  product it carries, when the key, name and photo all match, instead of
  drawing it again.
- Offline (`MINK_REVAMP_PROVIDER=fake`) the merchant's own photo is placed on
  a card-shaped canvas of the backdrop colour instead of calling a model.

## 9. Ownership

A section on a revamped page is:

- `theme`: its `{type, config}` digest matches the theme's installed copy of
  that page (`themeSectionIdsFor`);
- `mink`: its digest matches a section an executed Mink approval wrote
  (personalisation v1 or v2, or a layout proposal) for that store, read from
  the newest 50 executed approvals per tool; a section an approval only
  carried across, rather than wrote, does not count;
- `merchant`: anything else, and always a `custom_code` section. When in
  doubt, a section is the merchant's.

Ownership is by content (`{type, config}`), not by id, so a merchant who
changes one character of a Mink section has made it theirs. Theme and mink
sections are replaced. Merchant sections are kept by id; the planner may
move them, never rewrite or delete them. Their words and links stay word for
word, but a replaceable photo inside one is redrawn (a refill shot,
`revampRefillSlots`), and one that cannot be redrawn (a logo) is cleared
(`keepMerchantSection` in `site-compiler.ts`). A photo is replaceable
(`isReplaceablePhotoUrl`) when it is a theme file, an object under this
store's `mink-generated/` folder (except `mink-generated/product-photos/`,
a Mink catalogue photo of a real product), or broken. Broken means our
bucket or the theme's files say the file is not there (`findBrokenImages`);
an external host is never counted broken, and a timeout reads as loading. A
merchant's working upload or a product photo is never replaced.

## 10. Apply, Publish, Undo

- **Apply** (existing route, approval, one transaction). Needs Mink drafting
  and Builder manage, plus the permission each live part needs everywhere
  else: Categories manage for category changes, Products manage to add
  products or take samples off the shop, Branding manage for the tagline and
  footer description. It writes each page's `sections` (the Builder draft),
  creates new pages as drafts with their own title and search text,
  replaces the whole chrome draft (header, footer, appearance, design,
  announcement, newsletter), writes the store tagline and footer
  description and the confirmed categories, creates the merchant's
  products, and takes the theme's samples off the shop
  (`assertRevampPartAuthority` checks each part's permission before the
  first write). A card built for a requester without Branding manage
  carries no tagline or footer description at all, and says so: "Your store
  tagline and footer description were left as they are, because changing
  them needs Branding manage permission."
  - For each existing page Apply records what is live as it found it
    (`live: {status, publishedDigest}`, the digest of `published_sections`),
    beside the draft digest it wrote. Apply never publishes, so that is what
    is live until a Publish.
  - What waits and what is live. Page sections, new pages and the chrome go
    to the private draft. An existing page's title and search text have no
    draft layer (page settings save them straight to the row), so Apply
    leaves them as they are and records the redesign's in its snapshot;
    Publish writes them. Categories, products, the samples taken off the
    shop and the tagline and footer description change on the shop at once,
    and the card lists exactly those before the button.
  - Products. Each is published in its category and featured (the plan's
    product bands show featured products), with the studio photo first and
    the merchant's photo after it, sizes as options and variants at the
    prices and MRPs the merchant gave, and stock untracked. A category that
    does not exist files the product without one, and the card says so. A
    product the store already has is not created (section 5). The store
    plan's product limit is re-checked under its own lock.
  - Every target is locked and compared with the snapshot digest before the
    first write. A changed target, custom code no longer kept byte for
    byte, a new photo the store no longer owns, a page, category or product
    address taken meanwhile, or a sample no longer on the shop is a conflict
    that writes nothing. A store with no header and footer row yet gets one
    only if none was saved meanwhile; one that was is a conflict too.
  - One Apply per revamp. The revamp's job is locked first (the order
    Publish and Undo take), and a revamp already applied or undone is
    refused, at the preview and at the write.
  - A card whose refinement is still being made is refused ("A newer version
    of this redesign is being made"): that refinement carries the card's
    products and category changes. A refinement whose earlier versions were
    applied or undone after it was asked for is refused too, saying which;
    each earlier version's job is locked after the card's own, nearest
    first, so an Apply or Undo of one waits instead of changing the store
    between the check and the write.
- **Publish** (Builder manage): for every page Apply wrote and the chrome, in
  one transaction, with the Builder's own rules (strict section validation,
  rich text sanitised, the header and footer contrast gate), cache refresh,
  indexing and `page.published` events.
  - Each page's whole current Builder draft goes live, edits made since
    Apply included, as the Builder's own Publish does, and the card says so.
    Whether a page's draft is still the one Apply wrote is decided, as in
    Undo, by its sections' digest and what is live against Apply's `live`
    fingerprint, never by the page clock (a title or search text edit
    moves the clock without touching the draft); a page the redesign
    created, or a snapshot without the fingerprint, falls back to the clock.
    A page deleted since, or one that fails the publish bar, is skipped and
    named; the rest goes live.
  - The redesign's titles and search text go live field by field: a field
    still what it was before Apply gets the redesign's; a field the merchant
    changed after Apply keeps theirs and is named.
  - What was live before is stored in `publish_snapshot`. When nothing could
    go live, nothing is recorded: the card says "Nothing went live yet" with
    the reasons and offers Publish again. A second click returns the stored
    answer.
- **Undo** (Builder manage, plus Categories manage, Products manage and
  Branding manage when it would write categories, products or the tagline
  and footer description, as Apply needs; refused rather than half done,
  because an Undo cannot be repeated; `assertUndoPartAuthority` asks for
  Branding manage only over a field Apply actually changed). Every target
  is put back only while it is still what the redesign left; anything the
  merchant changed since is kept and named.
  - Newest first. A version is not undone while a newer version of the
    same redesign (a refinement of it, any generation) is applied and not
    undone, because that version's pages show the products and categories
    this one made; the card says to undo the newer version first. The
    newer versions are read, never locked: a newer version's Apply locks
    this version's job (its earlier versions, nearest first), so one being
    applied meanwhile waits and is then refused as undone after it was
    asked for. The refusal is a 409 (`REVAMP_NEWER_VERSION_APPLIED_MESSAGE`):
    "A newer version of this redesign is applied and builds on this one.
    Undo the newer version on its card first, then undo this one."
  - Pages: the Builder draft and, after a Publish, the live page with its
    status, title and search text, each judged on its own. A page the
    merchant unpublished since stays unpublished; one they published again
    keeps its live version; a title they edited keeps theirs. An existing
    page's draft goes back while its sections are still the redesign's and
    what is live is still what the redesign left (`draftStillRevamps`: the
    section digest and the live fingerprint, the page clock only without
    one). Before a Publish, what is live is what Apply found on the page and
    recorded (Apply never publishes), so a title or search text edit between
    Apply and Publish leaves the draft the redesign's and Undo puts it back,
    while a version the merchant published themselves makes the draft
    theirs. A page the redesign created is removed only while neither its
    draft nor what is live is the merchant's.
  - Header and footer: the draft and, after a Publish, the live version,
    each on its own. With no row before Apply the row is deleted, so the
    store's own menus return; if by then the draft is the merchant's but the
    live version is still the redesign's, only the live version comes down.
  - The tagline and footer description, each on its own.
  - A product the redesign created is removed while nothing changed it since
    Apply (the row or any size's stock) and no order, offer or review uses
    it; one that is used is taken off the shop (made a draft) instead, and
    one that changed is kept; both are named. A category it created is
    removed unless products are filed under it or an offer is scoped to it;
    a category it changed or hid is put back.
  - A sample goes back on the shop, with its first publish date, only if it
    was on the shop before Apply and nothing changed it since.
  - The answer is stored with the apply snapshot, so a reload shows it and a
    second click returns it. The card says the store is "back the way it
    was" only when nothing was kept.
- **Samples.** A sample is a product the installed theme seeded that nobody
  renamed: a name containing "(Sample)", or still at the address and with
  the name a product seed of that theme gave it (several themes name their
  samples like real goods). A renamed sample is the merchant's. The
  snapshot reads samples only for a requester with Products manage (a
  sample they cannot see is left alone); a sample never counts as a product
  the store already has; Apply takes off only the samples on the shop.
- **Refinements.** A refinement carries every product and category change
  any earlier version of the redesign asked for that no applied, not undone
  version has put on the store, each version judged by its state when the
  refinement is asked for: what is on the store already is never created
  again at Apply, and what an Undo took back off is created again. New
  products get keys no earlier version used. The parent is the newest
  version of the chat that is ready, or replaced after it was applied, and
  not undone; the chat's routing counts a redesign as ready by the same
  rule. A named parent must be a finished version (ready, or replaced after
  it was applied). A redesign takes at most 10 refinements, and a
  refinement reads at most 11 versions of its chain. Photos to redraw are
  named by the parent plan's shot ids, which the context read lists with
  where each one is, by "opening" for the homepage's opening photographs, or
  by `["all"]`; an id the plan does not have is refused with the ids it has.
  Every other photo is carried over instead of drawn: the parent's, and an
  older version's where that version's shot is the same one (subject and
  shape), with the phone crop cut again from the photo carried over; and
  the studio photo an earlier version made of a product the refinement
  carries, when the key, name and photo all match. Carried work is never
  charged again (section 6). When a refinement's card is ready its parent
  is superseded, and so is every other ready, unapplied card of the chat. A superseded card that was never
  applied only says a newer version replaced it; an applied one keeps its
  review, Publish and Undo, with a note that a newer version exists.

## 11. The chat

- Tools: `get_storefront_revamp_context` (Builder view, read, repeat safe):
  the store's context, the chat's redesigns (id, kind, status, summary,
  applied, published, undone, created) and, for the one a refinement would
  build on, its photos (id, where, what each shows);
  `start_storefront_revamp` (drafting + Builder manage, not repeat safe);
  `refine_storefront_revamp` (same). The personalisation tools left the
  model's registry; their card and Apply route stay for existing drafts.
- A revamp state reference is added to every turn of a conversation that
  has one: the newest three redesigns, each with its id, status, whether it
  was applied, published, undone and whether it is a refinement, then the
  card's button names, marked as data, not instructions. Flags only: no
  stored summary, so nothing a model wrote earlier comes back as an
  instruction.
- Guards, each decided before the job exists (both tools unless named): no
  theme yet ("Choose a theme for your store first, under Online store,
  Storefront."), Categories manage for category changes, Products manage
  for products, a photo the store does not own, the plan's product cap, the
  day's starts (6 per store, claimed before the job and released when no
  job comes of it or when the redesign fails), refinements per redesign (10,
  refine), a refinement with no finished redesign to build on (refine), a
  ready, unapplied revamp in
  the conversation (start: a new start only with `replace_earlier: true`;
  the refusal tells the model to point at the card), a paid start below the
  card's fixed floor (section 6), one active revamp per store, and a store
  whose earlier revamp is still stopping (Stop was pressed on its card, or a
  late start was withdrawn, and its runner has not stopped yet), which is
  told to try again in a minute ("The earlier redesign is still stopping.
  Try again in a minute."). The model never sees a credit figure, only
  whether the revamp started; the tools return their output without the
  card's artifact.
- A revamp started by a chat run that then fails or is stopped is kept,
  and the run's failure record saves its card to the chat (section 4.3). A
  tool whose run has stopped never starts one: `queueRevamp` refuses before
  it claims the day's start, the job insert is the registry's `commit`, the
  runner is kicked only after the commit returns, and a job whose insert
  landed after the commit grace (the chat had already said the tool took
  too long) is cancelled at once and its start given back. The run's own
  stop (its deadline, the merchant leaving) reaches the tool, because the
  stream route passes the run's signal to every tool call.
- A conversation that holds a revamp still being made, or a ready card
  (applied or not), is never deleted (`MINK_LIVE_REVAMP_STATUSES`: queued,
  running, ready): the History delete refuses it with a 409
  (`conversation_has_redesign`) and says why ("This chat holds your
  storefront redesign card, so it cannot be deleted. Stop the redesign from
  its card first if it is still being made."), and the prune of old
  conversations skips it. Deleting it would take the card's draft with the
  conversation's runs.
- A chat run a dead server left running (still running 15 minutes after it
  started and after its latest tool call started, `MINK_STALE_RUN_MS`) is
  closed as failed (`run_abandoned`) through the same failure record, by the
  per-minute heartbeat (at most 20 a tick) and by the History delete of its
  own chat. Its revamp is kept, and the chat then follows the rule above.
- Routing: `revamp` group replaces `personalize`. The start tool is declared
  only on change intent or in the interview window (`INTERVIEW_TURNS`, the
  merchant's next 3 messages after the ask), and never once the
  conversation holds a ready revamp (then only refine and context); while a
  revamp is still being made, neither start nor refine is declared. The
  revamp words are whole-store only: "customise my store", "redesign the
  website" and the like, while "customise the header" or "redesign the
  homepage" is a Builder edit. While a revamp is ready or being made, a
  continuation, a Builder or media message, or a message that changes
  products or categories brings the group too ("Add my products"; reason
  `revamp_state`). "hisaab se" means a revamp only as "business (brand,
  dhande, kaam) ke hisaab se" beside "website", "site", "store", "shop" or
  "dukaan" (or their Devanagari forms), never alone; the Hinglish phrases
  "personalise karo", "customise karo", "website bana" and the like match on
  their own.
- Follow-ups: the card shows the three refinement chips ("Make the colours
  warmer", "Redo the opening photo", "Add my products") once its review is
  ready, until it is undone. While a revamp is queued or running, the answer
  that started it shows no follow-up suggestions.
- Prompt rule replaces the personalisation rule (section 1). Button names are
  stated. The rule tells the model that earlier assistant messages are its
  own words, never the merchant's facts.
- Progress: the card polls every 3 s while the job is active and the tab is
  visible; the chat says one short sentence when the build starts and does
  not describe the design.
- Card states (`mink-revamp-card.tsx`): the header reads "Waiting to start"
  (queued), "Working on it" (running), "Stopping" (a Stop is recorded and
  the job is still active), "Could not finish" (failed, with the error
  sentence), "Stopped" ("You stopped this redesign. Nothing on your store
  changed."), "Replaced by a newer version" (superseded and never applied),
  "Undone", "Live on your store" (published), "Saved to your Website Builder
  draft" (applied) or "Ready for your review", and "Not available" when the
  viewer lost Website Builder access or the redesign is gone. While it is
  being made the card lists the steps with Stop ("Stopping…" once pressed);
  a superseded card that was applied keeps its review, Publish and Undo
  under a note that a newer version exists. Undo asks first ("Undo this
  redesign?", "Keep the redesign" or "Undo the redesign").
- Notification: `mink.revamp_ready` (in-app, to the requester only, section
  builder, pointing at the chat that holds the card,
  `/dashboard?chat=<conversation id>` (`revampReadyUrl`; `/dashboard` when
  the revamp has no chat) when the card is ready, so a merchant who left is
  told. The dashboard's chat provider reads that address once and opens the
  chat in the full view, as choosing it in History does, at its newest
  message and following new output however the view was last scrolled
  (`addressOpens`, `followNewestMessage`); only the
  viewer's own chat opens, and any other id opens a new chat. The chat
  already open is loaded again, its draft kept, since its card may have been
  saved after the tab last read it. Built once (`ready-notice.ts`) and sent by the card step
  and by every settlement that finishes a card already made: the claim, a
  failure, a Stop, the status poll and the sweep.

## 12. Limits

| Limit                             | Value                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Active revamps per store          | 1                                                                                                           |
| Revamps started per store per day | 6 (given back when no job comes of it or when the redesign fails)                                           |
| Refinements per revamp            | 10                                                                                                          |
| Revamp photos per store per day   | 120 (claimed for every photo a step is about to draw, before the first is drawn; given back when not drawn) |
| Platform revamp photos per hour   | 400                                                                                                         |
| Shots per revamp                  | 26                                                                                                          |
| Merchant products per revamp      | 20                                                                                                          |
| Sizes per product                 | 8                                                                                                           |
| Category changes per revamp       | 12                                                                                                          |
| Pages per revamp                  | 10                                                                                                          |
| Credits a card may charge         | 200 (`REVAMP_LIMITS.maxCredits`)                                                                            |

The values are `REVAMP_LIMITS` in `contract.ts`. A refusal says which limit
in plain words, and the daily ones say when to try again ("Try again
tomorrow.", or `limit_reached`: "Ask Mink again tomorrow."); a request over
a count limit is told the most it may hold. No refusal names a figure of
credits.

## 13. Help Centre

Migration `20261021_0235_mink_storefront_revamp_help` edits three guides in
place. In `manage-your-website-with-mink-ai` it replaces the personalisation
paragraph with three: what Mink asks (the theme's categories included), what
a redesign changes, what it keeps of a section the merchant made (the words
and links; only theme, earlier Mink and broken photos in it change), that
each studio photo is checked against the
merchant's photo, that a product the store has is not added again; the card,
the three buttons, what changes on the live store at once, the Branding
permission note, refining with a new version, that a card cannot be applied
while a newer version is being made and that a newer applied version is
undone first; and what an interrupted reply means, that the chat cannot be
deleted, the free first redesign, what is left out when credits run short
and the out-of-credits stop. In `upload-and-manage-store-media` it says
when a redesign's photos appear in the Library and which images cannot be
deleted. In `use-mink-ai-in-your-dashboard` its Media Library sentence
(pictures Mink creates are listed, chat attachments are not) gains the same
qualification: the photos a redesign uses are listed once it is applied. No
mechanism, no prices.

Migration `20261024_0239_mink_storefront_revamp_robustness_help` replaces
three of those sentences in place after the robustness fixes: what a stopped
or interrupted reply means (the redesign goes ahead and its card stays in
the chat; Stop on the card stops it, and nothing is charged before the card
is ready; a reply stopped before the redesign started means asking again),
what the new photographs show (the merchant's own products as their product
photos show them, or a setting with no products), and that the ready
notification opens the chat with the card; and, in
`use-mink-ai-in-your-dashboard`, the sentence saying a failed or stopped
reply discards its unseen proposals and gives their credits back gains the
storefront redesign exception (it carries on, its card stays in the chat,
Stop on the card ends it). A failed redesign giving back its day's start
needs no edit: no guide states the daily limit. Nor do the follow-ups of 24
Oct 2026: no guide quotes a card's failure sentence (section 4.3), so
`photos_failed`'s own sentence changes no guide, and the notification
opening the chat at its newest message is what the guide already says it
does. The same holds for the fixes of 25 Oct 2026: a permanent photo
failure shows a sentence already in the closed list, and a chat opened in
the panel or the full view starts at its newest message. ⚠ 0235 and 0239
are applied to `storemink_local` only (24 Oct 2026).

The uniqueness wave (24 Oct 2026, section 5: distinct by default, palette
honesty, the homepage structures and the redo memory) needs no Help edit
either. No merchant step, button, permission or charge changes; the guide
describes a redesign as a design built for the business and never says or
implies that a new one repeats an earlier one; and a merchant who wants to
keep a redesign and change part of it is already told to tell Mink what to
change, which makes a new version of the card (a refinement, which has no
memory and no check).

## 14. Acceptance

- Unit: a suite beside 26 of the 31 modules in `lib/mink/revamp/` (request,
  schema, planner, fake plan, compiler, copy checks, distinctness with its
  calibration against the audit's plans, ownership, snapshot, photos, photo
  hold, image store, products, assemble, checks, card, review, digests,
  jobs, actor, ports, ready notice, runner, trigger, Apply, and Publish with
  Undo; none beside contract, deps, lifecycle types, provider and step
  error), plus the tools, both routes, routing, the card and the
  preview, the chat's failure record (`persistence-revamp`), History
  (`conversation-history`), the stream and cron routes, and the chat
  address (`chat-session`, `chat-context`, `mink-ai`); and
  `codebase-map.test.ts`, which fails when CODEBASE.md stops naming a module,
  table, route or variable.
- Local integration (opt-in, `MINK_REVAMP_LOCAL_TEST=1`, local database):
  `jobs.local`, `apply.local`, `apply-v2.local`, `refinement-apply.local` and
  `e2e.local`, where a fake model and fake image client build a full revamp,
  Apply, Publish and Undo against real tables, `redo-memory.local`, where a
  store's redo is planned with a summary of its first redesign and an
  identical one is moved past the same-theme bar before any photograph
  while another store's identical design is never read, and
  `lib/mink/persistence.local`, the failure record that keeps a revamp and
  closes a dead run, run as `app_service`. `jobs.local` also proves the
  claim rules: eight hand-overs that waited on Google and six lease expiries
  survive, four identical real errors fail the job, and a job past its
  ceiling is refused and failed as `run_ceiling`; and that the redo memory
  reads only this store's ready or superseded compiled plans, newest first,
  never the job asking.
- Live: `npm run revamp:live-check` (`scripts/revamp-live-check.ts`,
  `scripts/revamp-live-fixtures.ts`) sets up four made-up shops in the local
  database (Kesar Ghani, mustard oil on Vitrine, a fashion theme; Crumb and
  Co, a bakery on Basket; Tara Jewels, a jeweller on Studio; Neem Ritual,
  skincare on Ritual), runs each redesign through the real runner, then
  applies, publishes, undoes and reports. Offline by default (the fakes);
  `--live --yes` uses the real models in storemink-staging. It never touches
  production. Its report lists every shop's page addresses, so every page
  can be photographed on phone and desktop, before and after, for the
  owner. Its runner loop (`scripts/revamp-live-check-core.ts`, tested)
  waits out a parked lease, naming the step's failures in a row, and
  settles a job nobody may claim again (stopped, out of failures, or past
  its 4-hour ceiling) with the card's status read.
- Uniqueness (robustness audit section 5, step 10):
  `scripts/revamp-uniqueness-test.ts` (tested; run with
  `npx tsx --tsconfig tsconfig.scripts.json scripts/revamp-uniqueness-test.ts`)
  plans three bakeries and three skincare shops on one bundled theme
  (`--theme`, default basket), a first redesign and a redo each (12
  planning calls, text only, no database), and prints the targets: every
  pair in the same trade at least the same-theme bar apart, every redo at
  least the bar from its first redesign after the check, under half of the
  closed section settings equal to the value the v4 prompt printed, and
  pages not all near-white, beside the audit's v4 figures and a modelled v4
  (the v4 prompt no longer exists). Offline by default ($0, the fake planner
  only); `--live --budget-usd=<n>` (at most 2) plans with
  `gemini-3.8-flash` in storemink-staging only and never starts a call its
  budget cannot cover (about $1.15 expected). The paid run needs the
  owner's approval and has not been run; the offline run met every target
  on all four bundled themes, which shows the harness and the check work,
  not how the model behaves.
- The run after the last fixes (23 Oct 2026, real models) did two of the
  four shops at once: Crumb and Co was ready in 2,907.9 s and Neem Ritual in
  4,304.6 s, both free, 8 of 9 checks (every photo came back at 1K, so the
  opening photograph got no phone crop). Its studio-photo check kept the
  merchant's photo for two of Crumb and Co's products, one that failed the
  check and one it could not check. The 1K photos were the model's thought
  draft, kept because the image readers took the first image part; they now
  take the last one that is not a thought (23 Oct 2026, not yet seen on a
  live run). Why the run took so long, what Phase 0 changed and what is
  left: `docs/mink-revamp-speed.md`.
- ⚠ Still to do: a live run of all four shops on the current code with the
  real models. The live check's phone photos are drawn by Mink's own image
  client, so no run has yet checked a studio photo against a real
  merchant's photo. And the uniqueness test's paid run (above), the only
  check of prompt v5's choices against the real model.
