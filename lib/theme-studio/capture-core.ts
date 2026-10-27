import { PLACEHOLDER_LICENSE_NOTE } from "./compiler";
import type { ThemePackageV2 } from "./contracts";
import {
  applySlotReplacements,
  describeSlots,
  slotByteLimit,
  slotTargetSize,
  type SlotImageRow,
} from "./slot-images-core";

// ---------------------------------------------------------------------------
// Track 3.6: the catalog card and screenshots, captured from the preview.
//
// Publication needs a catalog card and two screenshots, and the model cannot
// draw them: they are pictures of the storefront itself. So the capture job
// (scripts/theme-studio-capture-job.mjs) opens the version's private preview
// store in headless Chromium and photographs its home page, and the pictures
// are saved as a new version. This module is the pure half: what to shoot at
// what size, when shooting would be pointless, and how the pictures enter the
// package.
//
// ★ EACH SHOT IS RENDERED LARGER THAN ITS SLOT. The crop step refuses to
// upscale (slot-images.ts), and a catalog card is looked at on retina screens,
// so a shot is taken at 2× (3× on the phone) and cropped down.
//
// ★ NOT WHILE ART IS A PLACEHOLDER. A catalog card of solid-colour blocks
// would pass every check and sell nothing; the capture waits for real images.
// ---------------------------------------------------------------------------

export const CAPTURED_LICENSE_NOTE =
  "Captured by StoreMink Theme Studio from this theme's own preview store.";

/** Bounded retries for transient browser failures; capped by the DB constraint. */
export const AUTOMATIC_CAPTURE_MAX_ATTEMPTS = 5;

// ── Which reported errors are worth another try (owner, 24 Oct 2026) ─────
//
// Every try of a capture costs about two minutes of browser time, and up to
// 90 s more before the job starts again, so an error that will come back
// identically is failed at once instead of spending the remaining tries.
//   ★ DETERMINISTIC: the same every time. A screenshot over the 512 KB limit,
//     or a report or screenshot set the server refuses as invalid. Failed on
//     the first report.
//   ★ TRANSIENT: the weather. Timeouts, network errors, a deploy between the
//     claim and the finish, and a 429 or 5xx (Google's front end, or the web
//     service briefly unavailable). They keep every try even when they repeat.
//   ★ Anything else fails when the SAME code is reported on two tries in a
//     row, and is retried otherwise. ★ That includes one of our own preview
//     pages answering 404 or another 4xx: a preview answers 404 for a short
//     database outage too (the preview gate and the store lookup fail closed,
//     preview-access.ts and lib/store/resolve.ts, and the storefront layout
//     then answers not found), for example when one of the web's 5 pooled
//     connections does not come free within 5 s (lib/db/client.ts). So a 404
//     on one try is the weather; the same 404 on the next try is the page.
// The theme then reads "Couldn't finish the checks" with Check again.

export type CaptureErrorKind = "deterministic" | "transient" | "other";

/** Reported codes that keep every try, even when they repeat. */
export const TRANSIENT_CAPTURE_ERRORS: ReadonlySet<string> = new Set([
  "capture_timeout",
  "qa_measure_timeout",
  "capture_network",
  "acceptance_route_fetch",
  "capture_build_changed",
]);

/** Reported codes that come back identically on every try. */
export const DETERMINISTIC_CAPTURE_ERRORS: ReadonlySet<string> = new Set([
  "qa_screenshot_too_large",
  "qa_report_invalid",
  "qa_screenshots_invalid",
  "qa_screenshot_unusable",
  "capture_unusable",
  "capture_job_outdated",
]);

const PREVIEW_STATUS = /^preview_status_(\d{1,3})$/;

/**
 * How a code the capture job reported should be retried. A preview page's
 * status (`preview_status_<code>`) is transient for a 429 or 5xx and judged
 * by its repeats otherwise, whichever page it came from: a 404 or another
 * 4xx is what a preview answers while the database is briefly out of reach,
 * so it fails only when the next try reports it again.
 */
export function captureErrorKind(code: string): CaptureErrorKind {
  if (TRANSIENT_CAPTURE_ERRORS.has(code)) return "transient";
  if (DETERMINISTIC_CAPTURE_ERRORS.has(code)) return "deterministic";
  const status = PREVIEW_STATUS.exec(code);
  if (!status) return "other";
  const value = Number(status[1]);
  if (value === 429 || (value >= 500 && value <= 599)) return "transient";
  return "other";
}

/**
 * Whether a capture whose try just reported `code` goes back to the queue.
 * `previousCode` is the code the try before this one reported, when that try
 * was sent back (null when there was none, or it lapsed without a report).
 */
export function captureRetryDecision(input: {
  code: string;
  kind: CaptureErrorKind;
  attemptCount: number;
  maxAttempts: number;
  previousCode: string | null;
}): "requeue" | "fail" {
  if (input.attemptCount >= input.maxAttempts) return "fail";
  if (input.kind === "deterministic") return "fail";
  if (input.kind === "other" && input.previousCode === input.code)
    return "fail";
  return "requeue";
}

export interface CaptureShot {
  slotId: string;
  /** The storefront path photographed. */
  path: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  /** A phone: touch, mobile viewport and user agent. */
  mobile: boolean;
  alt: string;
  /** The crop the stored picture ends at, and its byte ceiling. */
  target: { width: number; height: number; aspect: number };
  byteLimit: number;
}

const CSS_WIDTH = { card: 1280, desktop: 1440, mobile: 390 } as const;

/** The pictures a capture takes for this version, in package order. */
export function captureShots(pkg: ThemePackageV2): CaptureShot[] {
  const name = pkg.definition.name;
  const viewportBySrc = new Map(
    pkg.definition.catalog.screenshots.map((shot) => [shot.src, shot.viewport]),
  );
  const shots: CaptureShot[] = [];
  for (const slot of describeSlots(pkg)) {
    if (!slot.catalogPreview && !slot.catalogScreenshot) continue;
    const target = slotTargetSize(slot);
    if (!target) continue;
    const kind = slot.catalogPreview
      ? "card"
      : viewportBySrc.get(slot.path) === "mobile"
        ? "mobile"
        : "desktop";
    const width = CSS_WIDTH[kind];
    shots.push({
      slotId: slot.id,
      path: "/",
      viewport: { width, height: Math.round(width / target.aspect) },
      deviceScaleFactor: kind === "mobile" ? 3 : 2,
      mobile: kind === "mobile",
      alt:
        kind === "card"
          ? `${name}: the storefront home page`
          : `${name} storefront on ${kind}`,
      target,
      byteLimit: slotByteLimit(slot),
    });
  }
  return shots;
}

/** Why a capture of this version would be pointless, in operator words. */
export function captureBlockers(
  pkg: ThemePackageV2,
  phase: "layout" | "final" = "final",
): string[] {
  const blockers: string[] = [];
  // Automatic acceptance measures the storefront before replacing its catalog
  // pictures. Those replacements must never change a shopper-facing image.
  const catalogPaths = new Set([
    pkg.definition.catalog.previewImage,
    ...pkg.definition.catalog.screenshots.map((shot) => shot.src),
  ]);
  const usesCatalogImage = (value: unknown): boolean => {
    if (typeof value === "string") return catalogPaths.has(value);
    if (!value || typeof value !== "object") return false;
    return Object.values(value).some(usesCatalogImage);
  };
  if (usesCatalogImage(pkg.definition.preset)) {
    blockers.push(
      "A storefront image uses a catalog screenshot slot. Revise the theme to give storefront artwork its own image slots before capturing it.",
    );
  }
  const missingCategories = (
    pkg.definition.preset.sampleData?.categories ?? []
  ).filter((category) => !category.image_url?.trim());
  if (missingCategories.length) {
    blockers.push(
      `${missingCategories.length} categories have no image slot. Revise the theme to add imagery for: ${missingCategories.map((category) => category.name).join(", ")}.`,
    );
  }
  const art = describeSlots(pkg).filter(
    (slot) =>
      !slot.catalogPreview &&
      !slot.catalogScreenshot &&
      slot.licenseNote === PLACEHOLDER_LICENSE_NOTE,
  );
  if (phase === "final" && art.length > 0) {
    blockers.push(
      `${art.length} image${art.length === 1 ? " is" : "s are"} still a placeholder. Draw or upload ${art.length === 1 ? "it" : "them"} first: the catalog pictures show the storefront as it is.`,
    );
  }
  if (phase === "final" && captureShots(pkg).length === 0) {
    blockers.push("This version has no catalog card or screenshot to capture.");
  }
  return blockers;
}

/**
 * The next version's package with the captured pictures in place, marked as
 * StoreMink's own capture (operator-owned, with a licence note) and with alt
 * text that no longer calls the screenshots placeholders.
 */
export function applyCapturedImages(
  pkg: ThemePackageV2,
  captured: readonly { slotId: string; row: SlotImageRow }[],
  versionNumber: number,
): { ok: true; value: ThemePackageV2 } | { ok: false; error: string } {
  if (captured.length === 0) {
    return { ok: false, error: "Nothing was captured." };
  }
  const alts = new Map(captureShots(pkg).map((s) => [s.slotId, s.alt]));
  return applySlotReplacements(
    pkg,
    captured.map(({ slotId, row }) => ({
      slotId,
      assetId: row.id,
      alt: alts.get(slotId) ?? `${pkg.definition.name} storefront`,
      source: "operator-owned",
      licenseNote: CAPTURED_LICENSE_NOTE,
    })),
    new Map(captured.map(({ row }) => [row.id, row])),
    versionNumber,
    `Catalog pictures captured from the preview: ${captured.map((c) => c.slotId).join(", ")}.`,
  );
}

/**
 * Whether an automatic capture is re-measuring evidence for a version an
 * earlier automatic capture already produced (a deploy made its acceptance
 * evidence stale). Such a version already carries its captured catalog
 * pictures, so the recapture re-measures it in place: no catalog shots, and
 * no new version left behind as a hidden `pending` orphan.
 */
export function isEvidenceRecapture(version: {
  origin: string;
  visibility: string;
  qaStatus: string;
  editDetail: unknown;
}): boolean {
  return (
    version.origin === "asset_edit" &&
    version.visibility === "internal" &&
    version.qaStatus === "pending" &&
    (version.editDetail as { kind?: unknown } | null)?.kind === "capture"
  );
}

// ── Re-checks (TS-1E, the capture half of the re-check contract) ─────────
//
// A re-check measures a version again on today's StoreMink build without
// redrawing anything: "Check again", or Publish after a code deploy. The
// capture table has no free-form detail column and its CHECK makes every
// automatic capture say `previous_status = 'generating'`, so the reason rides
// in the capture's idempotency key, the way a deploy re-capture already marks
// itself with `auto_recapture_` (visual-qa.ts). No migration.

/** Why a version is being measured again. */
export type ThemeStudioRecheckReason = "check_again" | "publish_recheck";
export const RECHECK_REASONS: readonly ThemeStudioRecheckReason[] = [
  "check_again",
  "publish_recheck",
];
/** Keys only the server writes. An operator's capture key may never start
 * with one, so a manual capture can never pass for a re-check. */
export const RECHECK_KEY_PREFIX = "recheck_";
export const DEPLOY_RECAPTURE_KEY_PREFIX = "auto_recapture_";
export const RESERVED_CAPTURE_KEY_PREFIXES = ["recheck_", "auto_"] as const;

const RECHECK_KEY =
  /^recheck_(check_again|publish_recheck)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `recheck_<reason>_<uuid>`: 56 or 60 characters, inside the 16 to 80 the
 * capture CHECK allows. */
export function recheckIdempotencyKey(
  reason: ThemeStudioRecheckReason,
  uuid: string,
): string {
  return `${RECHECK_KEY_PREFIX}${reason}_${uuid}`;
}

/** The re-check reason a capture key carries, or null for any other key. */
export function recheckReasonOf(
  idempotencyKey: string,
): ThemeStudioRecheckReason | null {
  if (typeof idempotencyKey !== "string") return null;
  const match = RECHECK_KEY.exec(idempotencyKey);
  return match ? (match[1] as ThemeStudioRecheckReason) : null;
}

/** A capture visual QA queued because a deploy outdated its evidence. */
export function isDeployRecaptureKey(idempotencyKey: string): boolean {
  return (
    typeof idempotencyKey === "string" &&
    idempotencyKey.startsWith(DEPLOY_RECAPTURE_KEY_PREFIX)
  );
}

/** Whether an operator-supplied capture key uses a server-only prefix. */
export function isReservedCaptureKey(idempotencyKey: string): boolean {
  return RESERVED_CAPTURE_KEY_PREFIXES.some((prefix) =>
    idempotencyKey.startsWith(prefix),
  );
}

/**
 * A version that passed its checks and that the operator can see: Ready to
 * publish, a publish waiting to retry, or one made current again. Only the
 * automatic design review marks a version `passed` (the 0144 guard allows
 * that mark once, from hidden and pending), and that review passes only over
 * a passing check run of the captured version, so such a version already
 * carries its catalogue pictures. The mark says the version passed ONCE; a
 * theme's state now comes from its newest check run and review, never from
 * this mark (re-check contract item 4).
 */
export function versionPassedChecks(version: {
  visibility: string;
  qaStatus: string;
}): boolean {
  return version.visibility === "operator" && version.qaStatus === "passed";
}

/**
 * Whether an automatic capture re-measures its version IN PLACE (the same
 * version, no catalogue shots, a complete new check run and a design review
 * bound to it) rather than making a new hidden version with fresh catalogue
 * pictures. In place when:
 *   - the version is one an earlier automatic capture produced and nobody
 *     has judged yet (`isEvidenceRecapture`), as before; or
 *   - the capture is a re-check, or a deploy re-capture, of a visible version
 *     that passed (`versionPassedChecks`).
 * Any other version, including every "Retry automatic QA" (an operator's key,
 * never a re-check key) and a re-check of a version that never passed, gets a
 * new hidden version, as the capture path makes today. The version row itself
 * is never written by an in-place re-measure.
 */
export function remeasuresInPlace(
  capture: { automatic: boolean; idempotencyKey: string },
  version: {
    origin: string;
    visibility: string;
    qaStatus: string;
    editDetail: unknown;
  },
): boolean {
  if (!capture.automatic) return false;
  if (isEvidenceRecapture(version)) return true;
  const remeasure =
    recheckReasonOf(capture.idempotencyKey) !== null ||
    isDeployRecaptureKey(capture.idempotencyKey);
  return remeasure && versionPassedChecks(version);
}
