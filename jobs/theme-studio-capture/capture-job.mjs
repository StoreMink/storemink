// Theme Studio capture job (Track 3.6).
//
// Photographs a Theme Studio version's private preview store in headless
// Chromium and posts the catalog card and screenshots back to the web app,
// which saves them as a new version. Runs as its own Cloud Run job (see
// docs/theme-studio-capture-job.md); locally, `npm run theme-studio:capture`.
//
//   APP_ORIGIN      the web app, e.g. https://storemink.com (required)
//   CRON_SECRET     the internal-route bearer secret (required)
//   CHROMIUM_PATH   a Chromium binary (the container's); or
//   CAPTURE_CHROME_CHANNEL=chrome   use the machine's installed Chrome
//
// ★ IT KNOWS NOTHING BUT WHAT A CLAIM HANDS IT: a capture id, a lease token,
// the preview's origin, a cookie good only while that capture runs, and the
// shots to take. It never touches the database, and every picture it sends
// is re-decoded, cropped and compressed by the web app.
//
// ★ EACH SHOT IS A FRESH BROWSER CONTEXT at its own size, scale and device,
// with reduced motion, so a carousel is on its first slide and nothing is
// mid-animation, and every scroll-revealed section is shown.
//
// ★ WHEN ITS CAPTURES ARE DONE IT WAKES THE DESIGN REVIEW (TS-3A, plan
// optimisation 2). A finish that left a design review queued says so
// (`designReview: "waiting"`), and the job then calls the review route with
// the same bearer secret, waiting for its answer, so the review starts at
// once instead of at the next minute tick and its paid work stays inside
// that request on the web service. It does the same when it stops with
// captures possibly left (its capture limit or its time budget): that route
// also starts the job again when a capture is waiting. The minute schedules
// stay as the safety net.

import { pathToFileURL } from "node:url";

/** Longest a capture's browser work may run. */
export const CAPTURE_WINDOW_MS = 5 * 60_000;
/** A claim is only taken when at least this much browser time remains;
 * starting one with less only burns an attempt on a certain timeout. */
export const MIN_CAPTURE_MS = 3 * 60_000;
/** Finish runs server acceptance (route checks bounded to 150s, preview, one
 * transaction). Cloud Run does not cut that request off (`maxDuration` is not
 * enforced self-hosted; the service timeout is 1200s), so THIS wait is the
 * bound the server work is sized against: generous enough that a slow but
 * healthy finish is not abandoned mid-commit. */
export const FINISH_TIMEOUT_MS = 270_000;
/** The job's task timeout is 600s; keep 30s for claims and shutdown. */
export const DEFAULT_BUDGET_MS = 570_000;
/** Most QA browser contexts measured at once. Each holds full-page renders,
 * and the job runs with 2 GiB; callers may ask for fewer, never more. Three
 * since TS-3A (plan optimisation 6): with two the job peaked at 24% of its
 * 2 GiB, measured on 4 Oct; the first production theme measures three. */
export const MAX_QA_CONTEXTS = 3;
/** Longest the job waits for the design-review route it wakes: that route's
 * own limit (app/api/internal/theme-studio/qa/route.ts maxDuration). */
export const WAKE_TIMEOUT_MS = 300_000;
/** Less time than this left in the budget, and the job leaves the review to
 * the minute schedule instead of cutting a review off mid-call. */
export const MIN_WAKE_MS = 60_000;
/** Kept back from the budget for the job's own shutdown. */
const SHUTDOWN_MARGIN_MS = 10_000;

/** The most one review screenshot may weigh: the web app refuses more
 * (lib/theme-studio/capture.ts MAX_QA_SCREENSHOT_BYTES). */
export const MAX_QA_SCREENSHOT_BYTES = 512 * 1024;
/** The JPEG qualities a review screenshot is tried at, best first. */
export const QA_SCREENSHOT_QUALITIES = [55, 40, 28, 18];

/** How long a review screenshot waits for the page's photographs. */
export const PICTURE_WAIT_MS = 8_000;

/**
 * Runs IN THE PAGE, just before a design-review screenshot: wait until every
 * photograph the page shows has loaded, and return how many still have not.
 *
 * WHY (22 Nov 2026). The measuring probe scrolls the page so lazy pictures
 * start loading and waits six seconds for them; a picture still on its way
 * after that, or one whose first request failed and whose second succeeded
 * (the probe asks again and rightly does not call it broken), was left as an
 * empty box in the screenshot. On the first change to a live theme, with
 * nine new product photographs being resized for the first time, one story
 * picture was caught that way: the reviewer saw "a blank, unrendered
 * container", called it a platform fault and failed a design whose page
 * rendered correctly a moment later.
 *
 * So, for every picture that has a source and a box on the page and is not
 * loaded: one that failed is asked for once more, one still held back as
 * lazy is asked for now, and the page waits up to `ms` for them. A picture
 * that really is broken still fails its own check (the probe's
 * brokenImages); this only stops a slow one being photographed as missing.
 * Self-contained: Playwright sends this function's source to the browser.
 */
export async function waitForPictures(ms) {
  const missing = () =>
    [...document.images].filter((img) => {
      if (!(img.currentSrc || img.src)) return false;
      const box = img.getBoundingClientRect();
      if (!(box.width > 0 && box.height > 0)) return false;
      return !(img.complete && img.naturalWidth > 0);
    });
  for (const img of missing()) {
    if (img.complete) {
      // It failed. Setting the same address again asks for it again.
      const srcset = img.getAttribute("srcset");
      const src = img.getAttribute("src");
      if (srcset !== null) img.setAttribute("srcset", srcset);
      if (src !== null) img.setAttribute("src", src);
    } else if (img.loading === "lazy") {
      img.loading = "eager";
    }
  }
  const until = Date.now() + ms;
  while (missing().length > 0 && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 150));
  return missing().length;
}

export class CaptureError extends Error {
  /** `surface`: the preview page a status error came from, when known. */
  constructor(code, surface) {
    super(code);
    this.code = code;
    this.surface = surface;
  }
}

/** The preview page a reported error came from, or undefined. The web app
 * uses it only to tell an error that repeats from one that may not. */
export function errorSurface(error) {
  return error instanceof CaptureError && typeof error.surface === "string"
    ? error.surface
    : undefined;
}

/** A closed error code the web app accepts, from anything that was thrown. */
export function errorCode(error) {
  if (error instanceof CaptureError) return error.code;
  const message = String(error?.message ?? error);
  if (/timeout/i.test(message)) return "capture_timeout";
  if (/qa_probe_missing/i.test(message)) return "qa_probe_missing";
  if (/qa_measure_failed/i.test(message)) return "qa_measure_failed";
  if (/net::|ERR_/i.test(message)) return "capture_network";
  return "capture_browser_error";
}

const PHONE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

/** Take every shot a claim asks for; returns [{ slotId, base64 }]. */
export async function takeShots(browser, claim, { settleMs = 400 } = {}) {
  const images = [];
  for (const shot of claim.shots) {
    const context = await browser.newContext({
      viewport: shot.viewport,
      deviceScaleFactor: shot.deviceScaleFactor,
      isMobile: shot.mobile,
      hasTouch: shot.mobile,
      reducedMotion: "reduce",
      ...(shot.mobile ? { userAgent: PHONE_UA } : {}),
    });
    try {
      await context.addCookies([
        {
          name: claim.cookie.name,
          value: claim.cookie.value,
          url: claim.origin,
        },
      ]);
      const page = await context.newPage();
      const response = await page.goto(new URL(shot.path, claim.origin).href, {
        waitUntil: "load",
        timeout: 60_000,
      });
      const status = response ? response.status() : 0;
      // Every catalogue shot photographs the home page.
      if (status !== 200)
        throw new CaptureError(
          `preview_status_${status}`,
          shot.path === "/" ? "home" : undefined,
        );
      // Readiness below waits for the actual fonts/images. Analytics and
      // background requests must not add a 15-second network-idle wait.
      // Next's development badge is not part of the storefront (it never
      // renders in production), so a local capture hides it.
      await page.addStyleTag({
        content: "nextjs-portal{display:none!important}",
      });
      await page.evaluate(async () => {
        // Show every scroll-revealed section, load every image the first
        // screen shows, and wait for the theme's fonts.
        window.dispatchEvent(new Event("sm:reveal-all"));
        for (const img of document.querySelectorAll('img[loading="lazy"]')) {
          img.loading = "eager";
        }
        await document.fonts.ready;
        await Promise.all(
          [...document.images]
            .filter((img) => !img.complete)
            .map(
              (img) =>
                new Promise((resolve) => {
                  img.addEventListener("load", resolve, { once: true });
                  img.addEventListener("error", resolve, { once: true });
                  setTimeout(resolve, 8_000);
                }),
            ),
        );
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(settleMs);
      const bytes = await page.screenshot({ type: "jpeg", quality: 92 });
      images.push({ slotId: shot.slotId, base64: bytes.toString("base64") });
    } finally {
      await context.close();
    }
  }
  return images;
}

/** Track 5: measure and screenshot every preview page at every QA width. */
export async function takeQaScreenshots(
  browser,
  claim,
  { settleMs = 250, concurrency = MAX_QA_CONTEXTS } = {},
) {
  if (!claim.qa) return undefined;
  const qaStarted = Date.now();
  const measured = await mapCaptureWork(
    Object.entries(claim.qa.viewports),
    Math.min(concurrency, MAX_QA_CONTEXTS),
    async ([viewport, dimensions], index) => {
      const samples = [];
      const screenshots = [];
      const timings = [];
      const routes = [];
      const mobile = dimensions.width <= 768;
      const context = await browser.newContext({
        viewport: dimensions,
        deviceScaleFactor: 1,
        isMobile: mobile,
        hasTouch: mobile,
        reducedMotion: "reduce",
        ...(mobile ? { userAgent: PHONE_UA } : {}),
      });
      try {
        await context.addCookies([
          {
            name: claim.cookie.name,
            value: claim.cookie.value,
            url: claim.origin,
          },
        ]);
        for (const preview of claim.qa.pages) {
          const page = await context.newPage();
          const navigationStarted = Date.now();
          const response = await page.goto(
            new URL(preview.path, claim.origin).href,
            { waitUntil: "load", timeout: 60_000 },
          );
          const status = response ? response.status() : 0;
          const expected = preview.surface === "not_found" ? 404 : 200;
          if (status !== expected)
            throw new CaptureError(`preview_status_${status}`, preview.surface);
          const navigationMs = Date.now() - navigationStarted;
          // Initial server HTML from the first viewport, reused on this claim
          // only. A redirect or an oversized page keeps the fresh-fetch path.
          if (
            claim.qa.phase !== "layout" &&
            index === 0 &&
            response.text &&
            response.url?.() === new URL(preview.path, claim.origin).href
          ) {
            try {
              const html = await response.text();
              if (Buffer.byteLength(html) <= 1024 * 1024) {
                const headers = await response.allHeaders();
                const route = {
                  path: preview.path,
                  surface: preview.surface,
                  status,
                  html,
                  robots: String(headers["x-robots-tag"] ?? ""),
                };
                if (Buffer.byteLength(JSON.stringify(route)) <= 1024 * 1024)
                  routes.push(route);
              }
            } catch {
              // Optional reuse cannot fail browser measurement. Acceptance
              // fetches the route afresh when this transport body is absent.
            }
          }
          const probeStarted = Date.now();
          // The probe waits for fonts and images itself. Network-idle can add
          // 15 seconds to each of thirty pages because of unrelated traffic.
          await page.addStyleTag({
            content: "nextjs-portal{display:none!important}",
          });
          await page.waitForTimeout(settleMs);
          // load/networkidle do not guarantee React's effect has installed the
          // probe (especially on a cold streamed 404). Wait for that condition.
          await page
            .waitForFunction(
              () => typeof window.__smThemeStudioMeasure === "function",
              undefined,
              { timeout: 20_000 },
            )
            .catch(() => {
              throw new CaptureError("qa_probe_missing");
            });
          const result = await page.evaluate(async () => {
            let timer;
            try {
              return await Promise.race([
                window.__smThemeStudioMeasure(),
                new Promise((_, reject) => {
                  // 60s: the home page also opens and audits five chrome
                  // states (studio-acceptance-states.ts), up to ~25s when
                  // every one times out.
                  timer = setTimeout(
                    () => reject(new Error("qa_measure_timeout")),
                    60_000,
                  );
                }),
              ]);
            } catch (error) {
              throw new Error(
                /timeout/i.test(String(error))
                  ? "qa_measure_timeout"
                  : "qa_measure_failed",
              );
            } finally {
              clearTimeout(timer);
            }
          });
          samples.push({ ...result, viewport, surface: preview.surface });
          const probeMs = Date.now() - probeStarted;
          const screenshotStarted = Date.now();
          if (claim.qa.phase !== "layout") {
            // ★ The design review judges this picture, so every photograph
            //   on the page must be in it (waitForPictures). Best effort: a
            //   page that cannot be asked is photographed as it is.
            await page
              .evaluate(waitForPictures, PICTURE_WAIT_MS)
              .catch(() => {});
            // Capture the measured layout unchanged. CSS zoom reflows the page
            // and made vision review a different composition from the probe.
            // ★ A long page full of photographs can pass the limit at the
            //   first quality (the "Volt" theme's home page did, once every
            //   photograph was waited for). The reviewer judges layout and
            //   composition, which a lower JPEG quality still shows, so the
            //   page is photographed again, smaller, before giving up.
            let bytes = null;
            for (const quality of QA_SCREENSHOT_QUALITIES) {
              bytes = await page.screenshot({
                type: "jpeg",
                quality,
                fullPage: true,
              });
              if (bytes.byteLength <= MAX_QA_SCREENSHOT_BYTES) break;
            }
            if (bytes.byteLength > MAX_QA_SCREENSHOT_BYTES) {
              throw new CaptureError("qa_screenshot_too_large");
            }
            screenshots.push({
              key: `${viewport}:${preview.surface}`,
              viewport,
              surface: preview.surface,
              path: preview.path,
              base64: bytes.toString("base64"),
            });
          }
          timings.push({
            viewport,
            surface: preview.surface,
            navigationMs,
            probeMs,
            screenshotMs: Date.now() - screenshotStarted,
          });
          await page.close?.();
        }
      } finally {
        await context.close();
      }
      return { samples, screenshots, timings, routes };
    },
  );
  return {
    buildId: claim.qa.buildId,
    packageDigest: claim.qa.packageDigest,
    evidence: {
      userAgent: PHONE_UA,
      samples: measured.flatMap((value) => value.samples),
    },
    screenshots: measured.flatMap((value) => value.screenshots),
    routes: measured.flatMap((value) => value.routes),
    timing: {
      qaMs: Date.now() - qaStarted,
      samples: measured.flatMap((value) => value.timings),
    },
  };
}

/** Bounded browser work; preserve plan order and drain in-flight contexts
 * before returning an error. Never leave asynchronous work on a reused browser. */
export async function mapCaptureWork(items, concurrency, work) {
  const output = new Array(items.length);
  let next = 0;
  let failure;
  const lanes = Array.from(
    {
      length: Math.min(items.length, Math.max(1, Math.floor(concurrency) || 1)),
    },
    async () => {
      while (!failure && next < items.length) {
        const index = next++;
        try {
          output[index] = await work(items[index], index);
        } catch (error) {
          failure = error || new Error("capture_work_failed");
        }
      }
    },
  );
  await Promise.all(lanes);
  if (failure) throw failure;
  return output;
}

/**
 * Drain captures until none are queued, the budget is spent or `maxCaptures`
 * are done. Returns what happened, for the job's log.
 */
export async function runCaptureJob({
  appOrigin,
  cronSecret,
  launch,
  fetchImpl = fetch,
  log = console,
  maxCaptures = 5,
  budgetMs = DEFAULT_BUDGET_MS,
  now = () => Date.now(),
}) {
  const started = now();
  // Browser time left for a capture claimed now, after reserving the finish.
  const captureTimeLeft = () =>
    budgetMs - (now() - started) - FINISH_TIMEOUT_MS;
  const headers = {
    authorization: `Bearer ${cronSecret}`,
    "content-type": "application/json",
  };
  const results = [];
  let browser = null;
  // A finish left a design review queued; the claim said nothing is left.
  let reviewWaiting = false;
  let drained = false;
  try {
    while (
      results.length < maxCaptures &&
      captureTimeLeft() >= MIN_CAPTURE_MS
    ) {
      const response = await fetchImpl(
        new URL("/api/internal/theme-studio/captures/claim", appOrigin),
        { method: "POST", headers, signal: AbortSignal.timeout(60_000) },
      );
      if (response.status === 204) {
        drained = true;
        break;
      }
      if (!response.ok) {
        throw new Error(`claim failed with HTTP ${response.status}`);
      }
      const claim = await response.json();
      let body;
      let timer;
      let expired = false;
      try {
        // Leave the whole finish timeout for server acceptance before the
        // 10-minute lease/job expires. A hung page/evaluate must not hold a
        // theme forever.
        const remainingMs = Math.min(CAPTURE_WINDOW_MS, captureTimeLeft());
        if (remainingMs <= 0) throw new CaptureError("capture_timeout");
        body = await Promise.race([
          (async () => {
            const browserStarted = Date.now();
            if (!browser) {
              const launched = await launch();
              if (expired) {
                await launched.close().catch(() => {});
                throw new CaptureError("capture_timeout");
              }
              browser = launched;
            }
            const activeBrowser = browser;
            const catalogStarted = Date.now();
            const images = await takeShots(activeBrowser, claim);
            const catalogMs = Date.now() - catalogStarted;
            const qa = claim.qa
              ? await takeQaScreenshots(activeBrowser, claim)
              : undefined;
            if (qa)
              qa.timing = {
                ...qa.timing,
                browserMs: Date.now() - browserStarted,
                catalogMs,
              };
            return {
              leaseToken: claim.leaseToken,
              images,
              ...(qa ? { qa } : {}),
            };
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              expired = true;
              reject(new CaptureError("capture_timeout"));
            }, remainingMs);
          }),
        ]);
      } catch (error) {
        const surface = errorSurface(error);
        body = {
          leaseToken: claim.leaseToken,
          error: errorCode(error),
          ...(surface ? { failedSurface: surface } : {}),
        };
        log.warn?.(`capture ${claim.captureId}: ${body.error}`);
        // Do not reuse a crashed or timed-out Chromium for the retry.
        await browser?.close().catch(() => {});
        browser = null;
      } finally {
        clearTimeout(timer);
      }
      const finished = await fetchImpl(
        new URL(
          `/api/internal/theme-studio/captures/${claim.captureId}`,
          appOrigin,
        ),
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(FINISH_TIMEOUT_MS),
        },
      );
      // 409 means the lease was lost (expired or re-claimed): this capture is
      // no longer ours and nothing went wrong on the server, so carry on with
      // the queue. Any other failure stops the execution for monitoring.
      if (!finished.ok && finished.status !== 409)
        throw new Error(`finish failed with HTTP ${finished.status}`);
      const outcome = await finished.json().catch(() => ({}));
      results.push({
        captureId: claim.captureId,
        http: finished.status,
        ...outcome,
      });
      if (outcome.designReview === "waiting") reviewWaiting = true;
      log.info?.(
        `capture ${claim.captureId}: ${outcome.status ?? finished.status}`,
      );
    }
  } finally {
    await browser?.close();
  }
  // Stopped by its limit or its budget, captures may be left: the review
  // route starts the job again when one is waiting.
  if (reviewWaiting || (!drained && results.length > 0)) {
    await wakeReviews({
      appOrigin,
      headers,
      fetchImpl,
      log,
      timeLeftMs: budgetMs - (now() - started) - SHUTDOWN_MARGIN_MS,
    });
  }
  return results;
}

/**
 * Wake the design-review route and wait for its answer, bounded by the
 * route's own limit and the job's budget. Its paid work runs inside that
 * request on the web service, never here. Never throws: a review it could
 * not wake is left to the minute schedule. Answers the HTTP status, or null.
 */
export async function wakeReviews({
  appOrigin,
  headers,
  fetchImpl = fetch,
  log = console,
  timeLeftMs,
}) {
  const timeoutMs = Math.min(WAKE_TIMEOUT_MS, timeLeftMs);
  if (!(timeoutMs >= MIN_WAKE_MS)) {
    log.info?.("design review wake skipped: too little time left");
    return null;
  }
  try {
    const response = await fetchImpl(
      new URL("/api/internal/theme-studio/qa", appOrigin),
      { method: "POST", headers, signal: AbortSignal.timeout(timeoutMs) },
    );
    log.info?.(`design review wake: HTTP ${response.status}`);
    return response.status;
  } catch (error) {
    log.warn?.(`design review wake failed: ${errorCode(error)}`);
    return null;
  }
}

async function main() {
  const appOrigin = process.env.APP_ORIGIN;
  const cronSecret = process.env.CRON_SECRET;
  if (!appOrigin || !cronSecret) {
    console.error("APP_ORIGIN and CRON_SECRET are required.");
    process.exit(2);
  }
  const { chromium } = await import("playwright-core");
  const launch = () =>
    chromium.launch({
      ...(process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH }
        : {}),
      ...(process.env.CAPTURE_CHROME_CHANNEL
        ? { channel: process.env.CAPTURE_CHROME_CHANNEL }
        : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  const results = await runCaptureJob({ appOrigin, cronSecret, launch });
  console.log(JSON.stringify({ captures: results }));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
