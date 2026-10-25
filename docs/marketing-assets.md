# Marketing asset provenance

Source and transformation history of the photographs under
`public/marketing/`. Release evidence, in the same shape as
`docs/theme-assets.md`. These are StoreMink's own images: they appear only on
storemink.com's marketing pages, never in a merchant's store.

## The rule

Every picture on the marketing site is generated for it. None is a theme's
seed image, a catalogue product photo or a stock photo (owner's rule,
2026-10-09: "do not use the reference of existing theme or product pictures;
create new pictures which are in parity with Shopify"). No third-party
photograph, logo, branded product or real person is used or referenced.

## The set (`public/marketing/**`)

Themes are never represented by generated photography: the homepage's theme
rail and the Themes tile read the live catalogue and show each theme's own
preview image (`ThemeMeta.catalog.previewImage`). Four generated "store
scenes" were made for that rail on 2026-10-09 and retired the same day.

- **Created:** 2026-10-09
- **Source:** Google's `gemini-3-pro-image` on Vertex AI (project
  `storemink-staging`, location `global`) by `scripts/marketing-photos.mjs`,
  which holds the exact prompt for every file. Images carry SynthID. From
  25 Oct 2026 `scripts/marketing-photos.mjs` draws with
  `gemini-nano-banana-2.1` (and keeps the last image part that is not a
  thought, never 2.1's draft); record the model in each new file's entry.
- **Safety settings:** the four harm filters at `BLOCK_LOW_AND_ABOVE`,
  prominent people blocked, `personGeneration: ALLOW_ADULT` (people are the
  subject of many of these, unlike the theme assets, which allow none).
- **Art direction:** shopify.com's register. Premium editorial photography,
  candid, 35mm or 50mm, soft daylight, a muted warm palette, Indian settings
  and people; no text, logos, signage, price tags or readable screens. Any
  phone, tablet or laptop screen is a soft blur.
- **Human inspection:** each output was checked for invented text, logos,
  watermarks, extra limbs and readable screens before being kept. The first
  `channels/in-store` output showed the till as a tablet home screen of app
  icons and was regenerated with the prompt tightened to a blurred sales list.

| File                         | Slot                            | Scene                                                        |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------ |
| `hero/model.webp`            | Homepage hero, the phone screen | A woman in a linen shirt against a terracotta wall, lookbook |
| `hero/float-sunglasses.webp` | Homepage hero, floating tile    | Tortoiseshell sunglasses on a poolside ledge                 |
| `hero/float-sneaker.webp`    | Homepage hero, floating tile    | An off-white sneaker on a stone step                         |
| `scenes/builder-desk.webp`   | Online store page hero          | A laptop and phone on a desk showing a store being built     |
| `stories/start.webp`         | Stories, Why StoreMink menu     | A founder packing her first orders                           |
| `stories/grow.webp`          | Stories, Why StoreMink menu     | A small team packing and scanning orders                     |
| `stories/scale.webp`         | Stories                         | A flagship-style store at golden hour                        |
| `steps/product.webp`         | Three steps                     | A maker photographing a candle                               |
| `steps/customise.webp`       | Three steps                     | Hands on a laptop arranging a store, swatches beside         |
| `steps/payments.webp`        | Three steps                     | A customer tapping her phone on a card terminal              |
| `details/fabric.webp`        | GST card, floating tile         | Folded block-printed cotton                                  |
| `details/sandals.webp`       | GST card, floating tile         | Tan leather sandals in sunlight                              |
| `channels/online.webp`       | Sell on every channel           | A woman browsing a store on her phone at home                |
| `channels/in-store.webp`     | Sell on every channel, menu     | A customer handing a tote to a shopkeeper at a tablet till   |
| `channels/enquiry.webp`      | Sell on every channel           | A maker on the phone noting a customer's order               |
| `channels/wholesale.webp`    | Sell on every channel           | A buyer and a supplier checking cartons in a stockroom       |

### Derived files

Each 2K JPEG source is cropped to its slot's size (`fit: cover`, attention
position) and encoded as WebP at quality 82, stepped down until the file is
under 360 KiB. Sizes: hero model 1000×1250, floating and detail tiles 800×800,
the desk scene 1600×900, everything else 1200×900. The
raw JPEGs are kept locally under `.marketing-raw/` (gitignored) so a crop can
be redone without another paid call.

### Regenerating

```bash
node scripts/marketing-photos.mjs                         # dry run, prints the plan
node scripts/marketing-photos.mjs --live --yes            # everything
node scripts/marketing-photos.mjs --live --yes --only hero-model
node scripts/marketing-photos.mjs --live --yes --skip-existing
```

Needs Application Default Credentials and `GCP_PROJECT_ID`. One paid Vertex
call per photograph; only a 429 (refused before the model runs, so never
billed) is retried, with a 20s to 120s backoff, because the shared project's
image quota rate-limits a batch of this size after four or five calls in a
row. A `reauth related error (invalid_rapt)` means the Google login has
lapsed: run `gcloud auth application-default login` and try again. Inspect
every new output before committing it.
