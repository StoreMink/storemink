# Theme Studio screenshot-led benchmark

This benchmark answers one question: if an operator gives Theme Studio a name, a
description and screenshots of a store they like, how often does the first build
reach **Ready to publish**, how long does it take, and how closely does it
follow the screenshots?

It runs eight themes through the real deployed pipeline (generation, images,
browser capture, acceptance, visual QA, automatic repairs). Nothing is
published, and no existing theme is edited.

## The cases

`evals/theme-studio/reference-benchmark.json` lists eight cases, two per
industry, each referencing a public Shopify theme demo store:

| Case               | Industry       | Reference demo    |
| ------------------ | -------------- | ----------------- |
| `apparel-impulse`  | clothing       | Impulse (Fashion) |
| `apparel-prestige` | clothing       | Prestige (Allure) |
| `food-crave`       | food-and-drink | Crave             |
| `food-taste`       | food-and-drink | Taste             |
| `beauty-sense`     | beauty         | Sense             |
| `beauty-beyours`   | beauty         | Be Yours (Beauty) |
| `home-craft`       | home           | Craft             |
| `home-trade`       | home           | Trade             |

Every brief asks for an **original** store that follows the reference's
layout, palette, typography and photography style, and forbids copying its
brand name, logo, wording or product photos.

## 1. Capture the reference screenshots (free)

```bash
node scripts/theme-studio-benchmark-references.mjs
```

Uses local Chrome. For each case it saves seven screenshots to
`.theme-studio-references/<case>/`: three desktop screens of the homepage
(1440×900), a collection page, a product page, and two phone screens of the
homepage (390×844). Newsletter and cookie popups are removed before each shot.
The folder is **git-ignored**: these are third-party screenshots used only as
design references and must never be committed. `--only=<case-id>` recaptures
one case. Demo stores change, so recapture before each benchmark and look at
the images before spending money on them.

## 2. Run the benchmark (paid)

Run against the production deployment (the same database the workers use),
with Vertex generation, capture and automatic QA enabled:

```bash
npm run theme-studio:benchmark -- --create \
  --references=.theme-studio-references \
  --actor-id=<superadmin platform_admins.id> --yes \
  --concurrency=2 --wait-minutes=120 \
  --out=evals/theme-studio/reference-live-<date>.json
```

Each case's screenshots are uploaded exactly as an operator's would be (same
sanitiser, same limits) and cited by the brief message. At most two themes are
in flight. The report is saved every 15 seconds; if the window ends first,
resume reporting without creating anything new:

```bash
npm run theme-studio:benchmark -- --projects=<id1,id2,…> \
  --references=.theme-studio-references --wait-minutes=60 \
  --out=evals/theme-studio/reference-live-<date>.json
```

**Expected cost:** the 2026-10-04 batch spent about $3–3.60 per theme that drew
a full image set (about $16.90 for eight themes, of which five drew images),
excluding final visual reviews. Plan for roughly **$25–35** for eight
screenshot-led themes, more if automatic repairs redraw images.
**Expected time:** the last batch's median was about 68 minutes per successful
theme; with two in flight, allow 4–5 hours for all eight.

## 3. Score how closely each theme follows its screenshots (paid, small)

```bash
npm run theme-studio:benchmark -- --projects=<id1,id2,…> \
  --references=.theme-studio-references --score-fidelity --yes \
  --out=evals/theme-studio/reference-live-<date>.json
```

For each finished theme, `lib/theme-studio/reference-fidelity.ts` sends the
reference screenshots and the theme's final QA screenshots — home against home,
collection against shop, product against product, phone against phone — to
Gemini 3.8 Flash. It scores **layout, palette, typography, imagery and
overall** from 1 to 5, flags `copiedBrand` if the theme reproduced the
reference's name, logo or wording, and lists matched and missed traits. Scores
and their cost are saved under `fidelity` in the report, with means under
`fidelityMean`. A project already scored is not scored again. Each score costs
cents.

The score is a benchmark measure only: nothing in generation, QA or
publication reads it. It is a model's judgement, so read it alongside the
screenshots rather than instead of them.

## What the report shows

Per theme: final status, wall time, whether the first final QA passed, whether
it passed without any automatic repair, design revisions, image redraws and
failures, spend, and (after step 3) the fidelity scores. A successful run of
this benchmark is evidence about these eight briefs, not a guarantee for every
brief.
