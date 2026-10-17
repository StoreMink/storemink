# Image-matting service

`services/image-matting/` is a small Cloud Run service that cuts a product out
of a photo. It is the first piece of the "keep the real product, replace the
background" image pipeline: StoreMink composites the merchant's own product
pixels onto a white, coloured or generated background, instead of asking an
image model to redraw the product (which is what Refine with Mink AI and the
catalogue-photo purpose do today, and why their products can drift).

Status (2026-10-17): built, deployed privately and benchmarked. **Not yet
called by the web app.** Nothing a merchant sees has changed.

## Why a self-hosted model

Google has no usable option for us. Verified against `storemink-prod` on
2026-10-17:

| Vertex model                                                         | Result                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `imagen-3.0-capability-001` / `-002` (background swap, mask editing) | 404, retired (Google's notes: 2026-06-30)                                                  |
| `imagen-product-recontext-preview-06-30`                             | 404, retired                                                                               |
| `image-segmentation-001`                                             | Exists, but a real image returns "image-segmentation-001 is unavailable" (allowlist-gated) |

Gemini's image models take no mask: they redraw the whole picture.

So the service runs **BiRefNet**, MIT-licensed (code and weights; confirmed on
GitHub and the Hugging Face model card). RMBG-2.0 was ruled out: its weights
are CC BY-NC 4.0, non-commercial without a BRIA agreement.

## The model

`BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx` ("lite", Swin-Tiny), from
the official `v1` release:

- 224,005,088 bytes
- SHA-256 `5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333`
- input `input_image` float32 [1, 3, 1024, 1024]; output `output_image`
  float32 [1, 1, 1024, 1024] (logits; the service applies the sigmoid)

The release publishes no checksums, so the hash above is the one we measured.
`fetch-model.mjs` refuses any download that does not match it, so a file
replaced upstream fails the image build instead of shipping.

The full model (`BiRefNet-general-epoch_244.onnx`, 972,666,916 bytes, SHA-256
`58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c`) was
benchmarked and rejected: same quality on every test photo, about 20 s per
photo instead of 11–15 s, and a 13.9 GB peak that needs a 16 GB instance.

## API

```
POST /v1/matte?output=mask|cutout
  body: the photo's bytes (JPEG, PNG or WebP; type sniffed from the bytes)
  200 image/png   mask (8-bit grey, white = product) or cutout (RGBA)
  headers         X-Matting-Model, X-Matting-Verdict (ok | empty | full),
                  X-Matting-Coverage, X-Matting-Soft, X-Matting-Width,
                  X-Matting-Height, X-Matting-Rss-Mb, X-Matting-Peak-Mb,
                  Server-Timing (decode, prepare, infer, encode, total)
  4xx             {"error": "<code>"}: unsupported_type, unreadable_image,
                  too_large (> 20 MB), too_many_pixels (> 40 MP),
                  bad_output, empty_body, unauthorized
GET /healthz      {"model": "...", "ready": true}
```

The mask is always returned at the photo's own size (after EXIF rotation, and
scaled down to fit 4096 px if larger). The web app should ask for the mask,
since it already holds the photo; `cutout` exists for tooling.

`X-Matting-Verdict` is a report, not a refusal: `empty` (under 0.5% product
pixels) means the model found nothing, `full` (over 98%) means it separated
nothing. The web app decides what to tell the merchant.

## Security

- **Private.** Deployed with `--no-allow-unauthenticated`; callers need
  `roles/run.invoker` on the service and send a Google identity token.
- **No permissions of its own.** It runs as
  `storemink-matting@storemink-prod.iam.gserviceaccount.com`, which holds no
  roles. It never touches the database or a bucket: photo bytes in, mask out.
- **Untrusted input handling** matches `lib/theme-studio/references.ts`:
  the type is sniffed from the bytes, the body is refused past 20 MB while
  streaming, and sharp refuses images over 40 MP.
- **Telemetry off.** ONNX Runtime 1.30's Linux build includes Microsoft's
  telemetry client; the image sets `ORT_DISABLE_TELEMETRY=1`.
- **Optional shared secret.** Set `MATTING_SECRET` and every POST must send it
  as `X-Matting-Secret` (defence in depth on top of IAM).

## Measurements (Cloud Run, asia-south1, 4 vCPU, 2026-10-17)

Four 2K test photos: sandals on busy stone with leaves and hard shadows, a
sneaker on a step, sunglasses on a ledge by a pool, a shopkeeper holding fruit.

| Setting                                      | Inference per photo | Peak memory |
| -------------------------------------------- | ------------------- | ----------- |
| lite, graph `all`, arena on                  | killed at 8 GB      | > 8 GB      |
| lite, graph `all`, arena off                 | 13.6–15.0 s         | 6.9 GB      |
| lite, graph `extended`, arena off            | 13.3–13.9 s         | 7.0 GB      |
| lite, graph `basic`, arena off (**default**) | 11.3–15.0 s         | 6.8–7.0 GB  |
| full, graph `all`, arena on                  | 19.3–21.2 s         | 13.9 GB     |

- Masks were identical across graph settings. Timing varies between
  instances by as much as between settings (each instance may land on a
  different CPU; the start-up log names it, e.g. Intel Xeon Platinum 8481C).
- Model load: about 4 s for lite.
- **Cold start** (after 20 idle minutes, scaled to zero): the instance was up
  and the model loaded about 7 s after the request arrived (3.4 s of that is
  the model load). The request took 24.2 s end to end against 18.7 s warm,
  measured from a laptop in India; about 3.7 s of either is the upload, which
  a call from the web app in the same region does not pay.
- Hosts differ: the same revision ran at 11–15 s on an Intel Xeon Platinum
  8481C and 14.6–16.1 s on an older "Intel Xeon @ 2.20GHz". One request just
  after a deploy took 29 s; the next three were back to normal. Budget for
  about 15 s, with occasional outliers.
- The first inference was no slower than later ones (13.3 s against 14 s),
  so the start-up warm-up is off by default (`MATTING_WARMUP=1` enables it).
- Between requests the process holds about 650–750 MB.
- Running this on an 8 GB Mac is not a benchmark: the model's real 7 GB peak
  pushes the machine into swap (43–139 s per photo measured).

**Quality.** Lite and full produced near-identical masks. Both removed busy
backgrounds cleanly, kept fine detail (laces, stitching, straps), left the
cast shadow behind, and kept lighting that is part of the real photo (a sun
streak across the sneaker; the later relight step is for that). BiRefNet cuts
out the **most prominent subject**: in the shopkeeper photo it returned the
person, not the fruit. A "choose the subject" correction tool is therefore
needed before photos with people or several items can be relied on.

## Cost

Mumbai is Tier 1 for request-based billing: $0.000024 per vCPU-second and
$0.0000025 per GiB-second (Google's billing catalogue, 2026-10-17). At 4 vCPU
and 8 GiB the service costs $0.000116 per second:

- one photo (11–15 s): about $0.0013–0.0017, roughly ₹0.12–0.15
- 1,000 photos a month: roughly ₹120–200 including some cold starts
- idle: ₹0 (min instances 0, request-based billing)
- image storage: one ~600 MB image in Artifact Registry

For comparison, a Gemini-generated 2K scene is about $0.10 per image, and
Photoroom's API is about $0.02 per image.

## Quota: read before raising max instances

Cloud Run's regional quotas in `storemink-prod` are **40 GiB of memory and
20 vCPU for asia-south1, shared by every service in the region**, including
`storemink-web-prod`. During this benchmark, a 16 GB test instance plus a
second deploy were refused with "Quota exceeded for total allowable memory
per project per region". The matting service is therefore deployed with
`--max-instances=1` (8 GiB, 4 vCPU).

Before launch, pick one:

1. Request a higher asia-south1 memory and CPU quota (free; usually approved
   quickly), then raise max instances; or
2. Deploy the service to `asia-south2` (Delhi), which has its own quota. Delhi
   is Tier 2 (about 40% dearer per second).

Theme Studio's workers were cut back on 2026-10-17 to make room: the two dev
workers were deleted (themes are built on production only) and the two
production workers now run one instance each, so together they can claim at
most 4 vCPU and 4 GiB, down from 16 vCPU and 16 GiB.

## Build and deploy

```bash
# Build and push (from the repository root). Lite is the default.
gcloud builds submit services/image-matting \
  --config=services/image-matting/cloudbuild.yaml \
  --project=storemink-prod --substitutions=_TAG=lite

# Deploy.
gcloud run deploy storemink-image-matting \
  --image=asia-south1-docker.pkg.dev/storemink-prod/storemink/image-matting:lite \
  --project=storemink-prod --region=asia-south1 \
  --service-account=storemink-matting@storemink-prod.iam.gserviceaccount.com \
  --no-allow-unauthenticated --ingress=all \
  --concurrency=1 --min-instances=0 --max-instances=1 \
  --cpu=4 --memory=8Gi --timeout=300 --cpu-boost --execution-environment=gen2 \
  --set-env-vars=MATTING_THREADS=4
```

Why each setting:

- `--concurrency=1`: inference already uses every CPU; two photos at once would
  each run at half speed while holding two sets of buffers.
- `--min-instances=0`: nothing runs while idle. Never keep one warm: an
  always-on 4 vCPU / 8 GiB instance would cost about ₹6,800 a month (the
  capture-job lesson).
- `--memory=8Gi`: the measured peak is 7.0 GB.
- `MATTING_THREADS=4`: start-up CPU boost briefly shows more CPUs than the
  instance keeps (the first deploy picked 9 threads).
- The service is deliberately not part of the web app's `cloudbuild.yaml`:
  the image changes only when the model or this service changes.
- In zsh, put shared flags in an array (`"${FLAGS[@]}"`), not a string:
  zsh does not split `$FLAGS`, and gcloud then reads every flag as the
  project name.

## Benchmark

```bash
cd services/image-matting
npm install                    # once; ONNXRUNTIME_NODE_INSTALL=skip is fine
node bench.mjs --url https://storemink-image-matting-705863961054.asia-south1.run.app \
  --runs 3 --out ./bench-out photo1.jpg photo2.jpg
```

It asks gcloud for an identity token for an https URL, prints a table
(round trip, Server-Timing, verdict, peak memory) and writes, per photo, the
mask, the cut-out on white, the cut-out on a checkerboard, and a contact
sheet. Run the service locally with `MATTING_MODEL_PATH=<file.onnx> node
server.mjs`, but see the note about the Mac above.

## Tear down

```bash
gcloud run services delete storemink-image-matting --project=storemink-prod --region=asia-south1
gcloud artifacts docker images delete \
  asia-south1-docker.pkg.dev/storemink-prod/storemink/image-matting:lite --delete-tags
gcloud iam service-accounts delete storemink-matting@storemink-prod.iam.gserviceaccount.com
```

## Not built yet

- The web app's client: grant `storemink-run@` `roles/run.invoker` on the
  service, call it with an identity token (google-auth-library is already a
  dependency), and set the URL in the web service's environment.
- The merchant features: Remove background, Background colour, New background
  (scene generation plus compositing), Extend, and the chat edit tool.
- Subject correction (click to include or exclude) and harmonisation
  (contact shadow, colour-temperature match, relight).
