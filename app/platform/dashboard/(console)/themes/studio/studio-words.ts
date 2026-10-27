import type { GateFinding } from "@/lib/theme-studio/acceptance-gates";
import { CHROME_STATE_LABELS } from "@/lib/theme-studio/chrome-states";
import {
  CONTRAST_AA_LINE,
  isPlatformFinding,
  isSeriousFinding,
} from "@/lib/theme-studio/finding-severity";
import type {
  ThemeStudioBuildTimeRange,
  ThemeStudioCheckScreenshots,
} from "@/lib/theme-studio/progress";
import type { ReviewFinding } from "@/lib/theme-studio/scorecard";
import type { StopKind } from "./studio-ui";

// ---------------------------------------------------------------------------
// The words of Theme Studio's screens: one file, keyed by finding code and
// stop code (wave TS-2, plan section 4; contract in
// revamp-handoff/scratchpad/progress/ts2-contract.md).
//
// ★ RULES FOR EVERY STRING HERE. Plain sentences a person can act on; a check
// name only as a heading; codes, the model, the creator and the build appear
// only in the Log tab and in Checks, Technical details (copyDetailsText). No
// em dash or en dash, including in stored text passed through (finding
// messages, stop reasons, model answers: `plainWords`). Never a number of
// Mink credits. A failed check always gets a sentence: an unknown code gets
// its kind's or its check's general sentence, never a bare code.
//
// ★ Client-safe and server-safe. Runtime imports only from the pure Theme
// Studio modules the screens already share (finding-severity.ts,
// chrome-states.ts); acceptance-gates.ts, progress.ts and scorecard.ts give
// only their types here (the first two are server code).
//
// ★ STOP SENTENCES LIVE HERE (moved from studio-ui.tsx, word for word).
// studio-ui.tsx keeps `stopText` and `STOP_CODES` for their importers and
// answers from this file.
// ---------------------------------------------------------------------------

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

/**
 * Stored words without a long dash (the product's dash rule): a range of
 * numbers reads "3 to 5", anything else a comma. studio-ui.tsx `plainText`
 * is the same rule; this copy keeps this file free of runtime imports from
 * the screen modules.
 */
export function plainWords(text: string): string {
  return text
    .replace(new RegExp(`(\\d)\\s*${EN_DASH}\\s*(\\d)`, "g"), "$1 to $2")
    .replace(new RegExp(`\\s*[${EN_DASH}${EM_DASH}]\\s*`, "g"), ", ");
}

// ------------------------------------------------------------------- designs

/** "Design 2". A design's number is its version number, everywhere (the
 * Design list, the Publish dialog, Activity, the chat, the "Describe a fix"
 * text): stable, because it is stored in events and chat messages that are
 * never rewritten. */
export function designLabel(versionNumber: number): string {
  return Number.isSafeInteger(versionNumber) && versionNumber > 0
    ? `Design ${versionNumber}`
    : "This design";
}

// --------------------------------------------------------------- time words

/** A duration in plain words: "50 s", "3 min 39 s", "26 min", "1 h 5 min".
 * Seconds are shown only under ten minutes. */
export function durationWords(milliseconds: number): string {
  const total =
    Number.isFinite(milliseconds) && milliseconds > 0
      ? Math.floor(milliseconds / 1000)
      : 0;
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 10)
    return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const INDIA = "Asia/Kolkata";

function indiaParts(at: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: INDIA,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** A time of day in India time, "10:05"; with the date ("1 Oct, 10:05")
 * when it is not the same day as `now`, and the year too when that differs. */
export function clockWords(iso: string, now: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "an unknown time";
  const when = indiaParts(at);
  const time = `${when.hour}:${when.minute}`;
  const today = new Date(now);
  if (!Number.isFinite(today.getTime())) {
    return `${when.day} ${when.month} ${when.year}, ${time}`;
  }
  const reference = indiaParts(today);
  if (
    when.year === reference.year &&
    when.month === reference.month &&
    when.day === reference.day
  )
    return time;
  return when.year === reference.year
    ? `${when.day} ${when.month}, ${time}`
    : `${when.day} ${when.month} ${when.year}, ${time}`;
}

/** "Usually 35 to 75 minutes." from the build-time range. */
export function buildTimeWords(range: ThemeStudioBuildTimeRange): string {
  return `Usually ${range.fromMinutes} to ${range.toMinutes} minutes.`;
}

// ------------------------------------------------------------- stop reasons

const RUN_STOP: Record<string, string> = {
  invalid_output:
    "The model's answer still failed its checks after its repair attempts.",
  model_refused: "The model declined this request for safety reasons.",
  model_declined: "The model declined to build this theme.",
  output_truncated: "The model ran out of room before it finished.",
  repair_not_supported:
    "Automatic repair stopped: what is left needs changes beyond the theme's supported settings. Read the findings before trying again.",
  rate_limited:
    "The model provider still refused this request after automatic retries. Your existing version is unchanged. Try again when the provider has room.",
  provider_auth: "StoreMink couldn't sign in to the model provider.",
  provider_rejected: "The model provider rejected the request.",
  provider_timeout: "The model provider took too long to answer.",
  provider_error: "The model provider failed after its retries.",
  provider_unavailable: "No model provider was available for this step.",
  run_timeout: "The step ran out of time.",
  generation_disabled: "Building was switched off before this step started.",
  model_disabled: "This model was switched off before this step started.",
  cancelled:
    "It was stopped. Pictures already drawn are kept: press Retry on this step to use them.",
  lease_expired: "The step stopped responding and ran out of attempts.",
  lease_renewal_failed:
    "The step lost its hold on the work on every attempt, so it stopped.",
  input_missing: "The step's brief could not be found.",
  worker_error: "The worker failed while running this step.",
  image_checkpoint_unavailable:
    "Picture recovery storage was unavailable. Try again to resume the saved pictures.",
  image_review_unavailable:
    "The picture check could not finish after automatic retries. The pictures are saved; try again to check them.",
  image_provider_unavailable: "The picture model was not available.",
  project_state_changed: "The theme changed while this step was working.",
  base_missing: "The version being changed could not be found.",
  base_changed:
    "The version being changed is not the one this step was asked for.",
  base_invalid: "The version being changed no longer passes its checks.",
  images_anchor_refused:
    "The picture model refused the style picture, so nothing else was drawn.",
  images_anchor_rejected:
    "The style picture failed its check on every attempt, so nothing else was drawn.",
  images_none: "No picture came back, so no version was made.",
  images_package_invalid:
    "The theme with the new pictures no longer passed its checks.",
  images_asset_conflict: "A drawn picture clashed with a stored file.",
  images_nothing_to_draw: "There was nothing left to draw.",
  auto_images_incomplete:
    "Some pictures still could not be drawn after the automatic fill rounds. Try again to draw them.",
  auto_qa_disabled:
    "The automatic checks were switched off before this step ran.",
  auto_revision_clarified:
    "An automatic fix asked a question instead of fixing, so it stopped. Describe the fix in the chat.",
};

const CAPTURE_STOP: Record<string, string> = {
  cancelled: "You stopped it.",
  capture_not_started:
    "The check never started, so it was stopped after 15 minutes. Check again.",
  lease_expired:
    "The capture stopped responding and ran out of attempts. Check again.",
  base_changed: "The version changed before the capture could finish.",
  base_invalid:
    "The version no longer passes its checks, so it could not be captured.",
  capture_not_ready:
    "The version still has pictures to finish, so it could not be captured.",
  preview_failed:
    "The preview store could not be built, so nothing could be captured.",
  project_state_changed: "The theme changed while the capture was working.",
  operator_removed:
    "The operator who started it is no longer a platform admin, so the preview could not be opened.",
  operator_not_superadmin:
    "The operator who started it is no longer a superadmin, so the preview could not be opened.",
  capture_job_outdated:
    "The capture job is older than this StoreMink build and has to be deployed again. This is a StoreMink problem, not the theme's.",
  capture_build_changed:
    "StoreMink was updated during every try of the capture. Check again.",
  capture_asset_conflict: "A captured picture clashed with a stored file.",
  capture_package_invalid:
    "The theme with the captured pictures no longer passed its checks.",
  capture_incomplete:
    "The capture did not return every picture it was asked for.",
  capture_too_large: "A captured picture was too large to keep.",
  capture_unusable: "A captured picture could not be used.",
  capture_timeout: "The capture took too long.",
  capture_network: "The capture could not reach the preview store.",
  capture_browser_error: "The browser failed during the capture.",
  capture_work_failed: "The capture job failed.",
  capture_failed: "The capture failed.",
  acceptance_route_fetch:
    "The preview store's pages could not be fetched on any try. Check again.",
  qa_report_invalid: "The page measurements could not be read.",
  qa_screenshots_invalid: "The screenshots from the checks could not be read.",
  qa_screenshot_unusable: "A screenshot from the checks could not be used.",
  qa_screenshot_too_large:
    "A screenshot from the checks was too large to keep.",
  qa_asset_conflict: "A screenshot from the checks clashed with a stored file.",
  qa_probe_missing: "The preview store's measuring script did not answer.",
  qa_measure_timeout: "Measuring a page took too long.",
  qa_measure_failed: "Measuring a page failed.",
};

const REVIEW_STOP: Record<string, string> = {
  cancelled: "You stopped it.",
  qa_lease_expired:
    "The design review stopped responding and ran out of attempts. Check again.",
  qa_input_missing:
    "The design review could not find its screenshots or the check it judges. Check again.",
  qa_image_input_missing:
    "The design review could not find a photo it had to look at. Check again.",
  qa_screenshot_unusable:
    "The design review could not use a screenshot from the checks. Check again.",
  qa_provider_failed:
    "The design review model failed after its retries. Check again later.",
  project_state_changed:
    "The theme changed while the design review was working.",
  automatic_acceptance_missing:
    "The design review found no finished check of the pages to go with it. Check again.",
  acceptance_build_unstable:
    "StoreMink was updated more often during these checks than they allow, so they could not finish on one build. Check this theme again.",
  acceptance_build_changed:
    "StoreMink was updated during the checks, so the pages are measured again on the new build.",
  acceptance_outcome_mismatch:
    "The page checks and their stored result did not agree, so neither was trusted. Check again.",
  acceptance_evidence_stale:
    "The page checks no longer match this design. Check again.",
  acceptance_security_failed:
    "The security check failed. Describe a fix in the chat.",
  quality_bar_not_met:
    "Serious problems are left after the automatic fixes. Read the findings and describe a fix.",
  checks_incomplete:
    "The checks could not finish, so the theme was not judged. A change to the theme will not help. Check again.",
  auto_qa_disabled:
    "The automatic checks were switched off before the design review ran.",
  image_check_required:
    "Some photos have not passed their picture check, or it found a problem it does not allow. Redraw them, or check the theme again.",
  image_provider_unavailable:
    "The picture model was not available for the fix the design review asked for.",
  repair_not_supported:
    "The fix the design review asked for has no theme setting or picture to change.",
  renderer_fix_required:
    "These findings need a fix in StoreMink's own storefront code. A theme change can't fix them.",
  qa_no_progress:
    "The automatic fixes stopped helping, so Theme Studio stopped them. Read the findings and describe a fix.",
};

const STOP_WORDS: Record<StopKind, Record<string, string>> = {
  run: RUN_STOP,
  capture: CAPTURE_STOP,
  review: REVIEW_STOP,
};

const STOP_FALLBACK: Record<StopKind, string> = {
  run: "This step stopped.",
  capture: "The capture stopped.",
  review: "The automatic checks stopped.",
};

/** A preview page that answered the capture job with the wrong status
 * (capture-job.mjs `preview_status_<n>`; the not-found sample expects 404,
 * every other page 200). */
const PREVIEW_STATUS = /^preview_status_(\d{1,3})$/;

/** Every stop code with its own sentence, by kind (for tests and
 * reviewers). Two more families are worded by pattern: a capture's
 * `preview_status_<n>` and a run's `images_anchor_<reason>`. */
export const STOP_REASON_CODES: Record<StopKind, readonly string[]> = {
  run: Object.keys(RUN_STOP),
  capture: Object.keys(CAPTURE_STOP),
  review: Object.keys(REVIEW_STOP),
};

/** Whether a stop code has its own sentence (or a family's), rather than
 * its kind's general one. */
export function isKnownStopCode(
  code: string | null | undefined,
  kind: StopKind,
): boolean {
  if (!code) return false;
  if (Object.hasOwn(STOP_WORDS[kind], code)) return true;
  if (kind === "capture" && PREVIEW_STATUS.test(code)) return true;
  return kind === "run" && code.startsWith("images_anchor_");
}

/** The sentence for a stop code of a run, a capture or the design review.
 * Every code StoreMink writes has its own; an unknown or missing one gets
 * its kind's general sentence (studio-ui.tsx stopText, kept for its
 * importers, answers from here). */
export function stopReasonWords(
  code: string | null | undefined,
  kind: StopKind,
): string {
  if (!code) return STOP_FALLBACK[kind];
  const own = Object.hasOwn(STOP_WORDS[kind], code)
    ? STOP_WORDS[kind][code]
    : undefined;
  if (own) return own;
  if (kind === "capture") {
    const status = PREVIEW_STATUS.exec(code);
    if (status)
      return `A preview page answered with status ${status[1]} instead of opening, so the checks could not measure it. Check again.`;
  }
  if (kind === "run" && code.startsWith("images_anchor_"))
    return "The style picture could not be drawn, so nothing else was.";
  return STOP_FALLBACK[kind];
}

/** Words that keep their capital at the start of a phrase. */
const PROPER_START = /^(?:StoreMink|Google|Gemini|Theme Studio)\b/;

/**
 * A sentence as a short phrase after a colon in the status words ("Couldn't
 * finish the checks: the capture took too long"): its first sentence, a
 * lower-case first letter unless it starts with a name, no full stop, at
 * most about 100 characters.
 */
export function reasonPhrase(sentence: string): string {
  const plain = plainWords(sentence).trim();
  const [first] = plain.split(/(?<=[.!?])\s+/);
  let phrase = (first ?? "").replace(/[.!?]+$/, "").trim();
  if (phrase.length > 100) {
    const cut = phrase.slice(0, 100);
    phrase = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 60)).trim()}...`;
  }
  if (!phrase) return "";
  return PROPER_START.test(phrase) || /^[A-Z]{2}/.test(phrase)
    ? phrase
    : phrase.charAt(0).toLowerCase() + phrase.slice(1);
}

/** A stop as a phrase for the status words. */
export function stopPhrase(
  code: string | null | undefined,
  kind: StopKind,
): string {
  return reasonPhrase(stopReasonWords(code, kind));
}

// ---------------------------------------------------------------- places

/** The check widths (acceptance-gates.ts THEME_STUDIO_QA_VIEWPORTS; a test
 * keeps the two equal, because that file is server code). */
export const STUDIO_VIEWPORT_WIDTHS: Readonly<Record<string, number>> = {
  phone360: 360,
  phone390: 390,
  tablet768: 768,
  laptop1024: 1024,
  desktop1440: 1440,
};

const SURFACE_WORDS: Readonly<Record<string, string>> = {
  home: "Home",
  shop: "Shop",
  product: "Product",
  cart: "Cart",
  content: "Content page",
  not_found: "Not-found page",
};

const CHROME_BY_LABEL = new Map<string, string>(
  Object.values(CHROME_STATE_LABELS).map((label) => [label, label]),
);

/** "Product at 390 px", or "Home at 360 px, menu drawer open", from a
 * browser finding's `where` ("phone390 · product · menu drawer"); a page
 * path as it is; null when there is nothing to say. */
export function placeWords(where: string | undefined | null): string | null {
  const text = typeof where === "string" ? where.trim() : "";
  if (!text) return null;
  const parts = text.split(" · ").map((part) => part.trim());
  const width = STUDIO_VIEWPORT_WIDTHS[parts[0]];
  if (width !== undefined) {
    const page = SURFACE_WORDS[parts[1] ?? ""] ?? "A page";
    const state = parts[2] && CHROME_BY_LABEL.get(parts[2]);
    return state
      ? `${page} at ${width} px, ${state} open`
      : `${page} at ${width} px`;
  }
  if (text.startsWith("/")) return `The page ${plainWords(text).slice(0, 120)}`;
  return null;
}

/** A picture slot's id as a place ("Picture: hero main"). */
export function slotPlace(slotId: string | null | undefined): string | null {
  if (!slotId) return null;
  const words = slotId
    .split(",")
    .map((id) => id.trim().replace(/[-_]+/g, " ").trim())
    .filter(Boolean);
  if (!words.length) return null;
  return words.length === 1
    ? `Picture: ${words[0]}`
    : `Pictures: ${words.slice(0, 6).join(", ")}${words.length > 6 ? " and more" : ""}`;
}

// --------------------------------------------------------- finding words

/** One finding in words, for the Checks tab and the Publish dialog. */
export interface StudioFindingWords {
  /** The check's plain name, for a heading ("Readable text", "Links").
   * Never a code. */
  heading: string;
  /** One plain sentence: what a shopper meets, with the measurement when
   * there is one ("The struck price on the product page is hard to read
   * (3.9 to 1, needs 4.5 to 1)"). */
  text: string;
  /** Where: the page and the screen width ("Product at 390 px"); null when
   * the finding has no place. */
  place: string | null;
  /** It stops Publish (finding-severity.ts isSeriousFinding for a check
   * finding; the review's serious list for a review finding). */
  serious: boolean;
  /** It is in StoreMink's own storefront code (finding-severity.ts
   * isPlatformFinding): "StoreMink has been told", no fix button. Changes
   * the words only, never `serious`. */
  storeMink: boolean;
}

/** The check names, as headings (acceptance-gates.ts gate ids). */
export const CHECK_HEADINGS: Readonly<Record<string, string>> = {
  "package.schema": "Theme file",
  "package.content": "Pages and sample content",
  "package.design": "Colours and readable text",
  "package.security": "Security",
  "assets.integrity": "Pictures",
  "assets.provenance": "Picture sources",
  "demo.materialize": "Demo store",
  "routes.render": "Pages open",
  "routes.links": "Links",
  "routes.markup": "Page markup",
  "browser.coverage": "Every page checked",
  "browser.overflow": "Fits the screen",
  "browser.clipped_text": "Cut-off text",
  "browser.tap_targets": "Button sizes on phones",
  "browser.image_crops": "Photo crops",
  "browser.accessibility": "Accessibility",
  "browser.media": "Pictures load",
  "browser.performance": "Speed",
};

/** What the check says when it has nothing more specific: a check failed,
 * so it always gets a sentence. */
const CHECK_GENERAL: Readonly<Record<string, string>> = {
  "package.schema": "The theme file no longer passes StoreMink's theme rules.",
  "package.content":
    "Something in the theme's pages, catalogue or sample products is not finished.",
  "package.design":
    "Something in the theme's colours, fonts or layout settings breaks a design rule.",
  "package.security":
    "The theme contains something that is not safe to publish.",
  "assets.integrity": "A picture in the theme is missing or broken.",
  "assets.provenance": "A picture in the theme cannot be published as it is.",
  "demo.materialize": "The demo store could not be built.",
  "routes.render": "A page did not open as it should.",
  "routes.links": "A link does not lead where it should.",
  "routes.markup": "A page's markup breaks a rule.",
  "browser.coverage":
    "Part of the checks could not run, so it does not count as passed.",
  "browser.overflow": "A page scrolls sideways on this screen.",
  "browser.clipped_text": "Some text is cut off.",
  "browser.tap_targets": "A button or link is too small to tap easily.",
  "browser.image_crops": "A photo is cropped very tightly.",
  "browser.accessibility": "Part of the page fails an accessibility rule.",
  "browser.media": "A picture did not load.",
  "browser.performance": "The page is slow to load.",
};

const UNKNOWN_CHECK = "A check found a problem it did not name.";

/** One sentence per finding code, by check (acceptance-gates.ts and
 * acceptance.ts write these codes). Codes measured with a number are worded
 * in `measuredText`. */
export const FINDING_TEXT: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "package.schema": {
    contract: "The theme file no longer passes StoreMink's theme rules.",
  },
  "package.content": {
    capability_gap:
      "The design needs something StoreMink's storefront cannot show yet.",
  },
  "package.security": {
    markup: "The theme contains a script or a page-level HTML tag.",
    handler:
      "The theme contains code that would run when a shopper clicks, taps or hovers.",
    scheme:
      "The theme contains a link that would run code or carry a hidden file.",
    external_asset:
      "A picture or media field points outside the theme's own files.",
    external_link: "A link leaves the storefront for another website.",
    css: "A design setting carries something other than a plain colour, size or font.",
    custom_code:
      "The theme contains a custom code section, which a generated theme may not have.",
    capability: "The theme claims a feature it never declared.",
  },
  "assets.integrity": {
    digest: "A picture has no fingerprint, so its file cannot be checked.",
    missing: "A picture's file is missing.",
    purpose: "A file that is not a storefront picture is used as one.",
    format: "A picture is stored in a format storefronts cannot show.",
    dimensions: "A picture's size does not match what the theme says it is.",
    wrong_format: "A picture is not in a web format storefronts can show.",
    preview_too_small: "The catalogue card picture is too short.",
    preview_over_budget:
      "The catalogue card picture is larger than its size budget.",
    preview_shape: "The catalogue card picture is not 4 by 3.",
    too_small: "A picture is narrower than storefronts allow.",
    over_budget: "A picture is larger than its size budget.",
    size: "A picture breaks a size rule.",
    below_target:
      "A picture is narrower than its slot, so it can look soft on large screens.",
    unused: "A file is part of the theme, but nothing shows it.",
  },
  "assets.provenance": {
    placeholder: "Some pictures are still placeholders.",
    alt: "A picture has no description.",
    source:
      "A picture comes from an old bundled theme, which a new theme may not use.",
    license: "A licensed or owned picture has no licence note.",
  },
  "demo.materialize": {
    materialize: "The demo store could not be built.",
  },
  "routes.render": {
    token: "The preview store could not be opened for the checks.",
    fetch: "The page could not be loaded during the checks.",
    budget: "The checks ran out of time before this page was read.",
    timeout: "The page did not answer in time.",
    status: "The page answered with an error instead of opening.",
    unthemed: "The page opened without the theme's design.",
    indexable: "The preview page is missing its noindex tag.",
  },
  "routes.links": {
    fetch: "A link could not be followed during the checks.",
    budget: "The checks ran out of time before this link was followed.",
    timeout: "A link's page did not answer in time.",
    broken: "A link leads to a page that does not exist.",
  },
  "routes.markup": {
    external_resource: "The page loads a file from another website.",
    img_alt: "A picture in the page's markup has no description.",
    lang: "A page does not say which language it is in.",
  },
  "browser.coverage": {
    missing: "This page was not measured at this width.",
    viewport: "This page was measured at the wrong width.",
    states_missing:
      "The menu, search, cart, account and sign-in panels were not opened and measured.",
    state_missing: "A header panel was not opened and measured.",
    state_unopened: "A header panel did not open when its button was pressed.",
    state_stuck: "A header panel did not close after it was measured.",
  },
  "browser.overflow": {
    horizontal_overflow:
      "The page is wider than the screen, so it scrolls sideways.",
  },
  "browser.clipped_text": {
    clipped_text: "Some text is cut off by its box.",
    unmeasured:
      "Text is cut off in many places and the list stopped there, so a larger cut may not have been measured.",
  },
  "browser.tap_targets": {
    small_target: "A button or link is too small to tap easily.",
  },
  "browser.image_crops": {
    extreme_crop: "A photo is cropped so tightly that most of it is hidden.",
  },
  "browser.media": {
    broken_image: "A picture did not load.",
  },
  "browser.performance": {
    lcp: "The main content is slow to show.",
    cls: "Content moves while the page loads.",
    unmeasured: "Loading speed was not measured on this page.",
  },
};

/** The codes every check may write: a check that did not run, and a value
 * that could not be measured. */
const ANY_CHECK_TEXT: Readonly<Record<string, string>> = {
  skipped: "This check could not run, so it does not count as passed.",
  unmeasured: "This could not be measured, so it does not count as passed.",
};

/** The theme validator's codes (lib/themes/validation.ts), "area.code",
 * worded by area, with the ones that matter most worded on their own. */
const VALIDATION_TEXT: Readonly<Record<string, string>> = {
  "design.contrast": "Some text in the theme's colours is hard to read.",
  "design.button_label_contrast":
    "Button labels are hard to read on their colour.",
  "design.scheme_contrast":
    "Buttons in one of the theme's colour schemes are hard to read.",
  "design.hero_contrast": "Text over the main banner is hard to read.",
  "design.promo_tile_contrast": "Text on a promotion tile is hard to read.",
  "design.palette": "A theme colour is missing or is not a valid colour.",
  "design.fonts": "A font setting does not point at a font StoreMink loads.",
  "pages.placeholder": "Some page text is unfinished placeholder copy.",
  "pages.duplicate_newsletter": "A page has more than one newsletter section.",
  "pages.duplicate_section": "A page repeats the same section twice.",
  "pages.image_alt": "A picture on a page has no description.",
  "pages.custom_code":
    "A page contains custom code, which a theme may not ship.",
  "catalog.name_placeholder": "The theme's name reads like placeholder copy.",
  "catalog.description_placeholder":
    "The theme's description reads like placeholder copy.",
  "brand.tagline_placeholder": "The store tagline reads like placeholder copy.",
  "brand.blurb_placeholder":
    "The store description reads like placeholder copy.",
  "sample.missing": "The theme has no sample products for its demo store.",
  "sample.products": "The theme has too few sample products.",
  "sample.categories": "The theme has too few sample categories.",
  "sample.product_price": "A sample product's price is wrong.",
  "sample.product_image":
    "Two sample products share one photo; each needs its own.",
  "links.category": "A link points at a category the demo store does not have.",
  "links.product": "A link points at a product the demo store does not have.",
};

const VALIDATION_AREA_TEXT: Readonly<Record<string, string>> = {
  catalog: "The theme's catalogue details are not finished.",
  pages: "A page of the theme is not finished.",
  homepage: "The home page is not finished.",
  sample: "The theme's sample products or categories are not finished.",
  links: "A link in the theme does not lead to a real page.",
  design: "A colour, font or layout setting breaks a design rule.",
  brand: "The store's own name, tagline or colour is not finished.",
};

/** Plain names for the selectors StoreMink's shared storefront code
 * renders (finding-severity.ts SHARED_STOREFRONT_CLASSES). */
const SHARED_TEXT_NAMES: readonly (readonly [RegExp, string])[] = [
  [/\.shop-card-off(?![\w-])/, "The discount label on product cards"],
  [/\.shop-card-base(?![\w-])/, "The struck price on product cards"],
  [/\.shop-card-badge(?![\w-])/, "The badge on product cards"],
  [/\.pdp-price-base(?![\w-])/, "The struck price on the product page"],
  [/\.pdp-variant-was(?![\w-])/, "The old price beside a product option"],
  [/\.pdp-category(?![\w-])/, "The category name on the product page"],
  [/\.sm-gallery-count(?![\w-])/, "The picture counter in the product gallery"],
  [/\.home-hero-badge(?![\w-])/, "The badge on the home page's main banner"],
  [/#header-profile-btn(?![\w-])/, "The account button in the header"],
  [/#profile-dropdown(?![\w-])/, "Text in the account menu"],
];

/** What a piece of text is, in words, from the selectors a finding names
 * and the panel it was measured in. */
function textName(
  selectors: readonly string[],
  where: string | undefined,
): string {
  for (const selector of selectors)
    for (const [pattern, name] of SHARED_TEXT_NAMES)
      if (pattern.test(selector)) return name;
  const state = (where ?? "")
    .split(" · ")
    .map((part) => part.trim())
    .find((part) => CHROME_BY_LABEL.has(part));
  return state ? `Text in the ${state}` : "Some text";
}

/** The AA line one measured piece of text was held to (finding-severity.ts:
 * the line the browser applied, never looser than large text's nor stricter
 * than normal text's). */
function aaLine(required: number): number {
  return Math.min(
    Math.max(required, CONTRAST_AA_LINE.largeText),
    CONTRAST_AA_LINE.normalText,
  );
}

/** A contrast ratio in words, rounded down so a failing ratio never reads
 * as passing ("4.4" for 4.47 beside a line of 4.5), with a second decimal
 * when one would read as the line itself ("4.52"). */
export function ratioWords(ratio: number, line: number): string {
  // A hair added before rounding down, so 4.52 is not read as 4.5199...
  const down = (places: number) =>
    Math.floor(ratio * 10 ** places + 1e-9) / 10 ** places;
  const one = down(1);
  if (one < line || one === 0) return String(one);
  return String(down(2));
}

function contrastText(finding: GateFinding): string {
  const measured = (finding.contrast ?? []).filter(
    (item) =>
      typeof item?.ratio === "number" &&
      Number.isFinite(item.ratio) &&
      typeof item.required === "number" &&
      Number.isFinite(item.required),
  );
  if (!measured.length)
    return `${textName(finding.targets ?? [], finding.where)} is too faint to read, and its contrast could not be measured.`;
  const worst = measured.reduce((low, item) =>
    item.ratio < low.ratio ? item : low,
  );
  const line = aaLine(worst.required);
  const name = textName(
    [worst.target, ...(finding.targets ?? [])].filter(
      (s): s is string => typeof s === "string",
    ),
    finding.where,
  );
  return `${name} is hard to read (${ratioWords(worst.ratio, line)} to 1, needs ${line} to 1).`;
}

const AXE_TEXT: Readonly<Record<string, string>> = {
  "image-alt": "A picture has no description for screen readers.",
  "svg-img-alt": "A drawing has no description for screen readers.",
  "button-name": "A button has no name a screen reader can say.",
  "input-button-name": "A button has no name a screen reader can say.",
  "link-name": "A link has no name a screen reader can say.",
  label: "A form field has no label.",
  "select-name": "A drop-down list has no label.",
  "document-title": "The page has no title.",
  "html-has-lang": "The page does not say which language it is in.",
  "html-lang-valid": "The page names a language that does not exist.",
  "heading-order": "Headings skip a level.",
  "meta-viewport": "The page stops people from zooming in.",
  "nested-interactive": "A control sits inside another control.",
  "scrollable-region-focusable":
    "A scrolling area cannot be reached with the keyboard.",
  "frame-title": "A frame has no title.",
  "target-size": "A button or link is too small to tap easily.",
  list: "A list is marked up wrongly.",
  listitem: "A list is marked up wrongly.",
  region: "Some content sits outside the page's main areas.",
  "duplicate-id":
    "Two parts of the page share one name, which confuses screen readers.",
  "duplicate-id-aria":
    "Two parts of the page share one name, which confuses screen readers.",
  "duplicate-id-active":
    "Two parts of the page share one name, which confuses screen readers.",
};

function accessibilityText(finding: GateFinding): string {
  const own =
    (Object.hasOwn(AXE_TEXT, finding.code) ? AXE_TEXT[finding.code] : null) ??
    (finding.code.startsWith("aria-")
      ? "Part of the page uses accessibility markup wrongly."
      : finding.code.startsWith("landmark-")
        ? "Some content sits outside the page's main areas."
        : CHECK_GENERAL["browser.accessibility"]);
  const nodes =
    typeof finding.nodes === "number" && Number.isFinite(finding.nodes)
      ? finding.nodes
      : null;
  return nodes && nodes > 1
    ? `${own.replace(/\.$/, "")} (${nodes} places).`
    : own;
}

const num = (match: RegExpExecArray | null, index = 1): number | null => {
  const value = match ? Number(match[index]) : NaN;
  return Number.isFinite(value) ? value : null;
};

/** The words for codes whose stored message carries the measurement. */
function measuredText(gateId: string, finding: GateFinding): string | null {
  const message = typeof finding.message === "string" ? finding.message : "";
  switch (`${gateId}:${finding.code}`) {
    case "browser.clipped_text:clipped_text": {
      const clip = finding.clipped;
      const px =
        clip && Number.isFinite(clip.x) && Number.isFinite(clip.y)
          ? Math.max(clip.x, clip.y)
          : null;
      return px !== null
        ? `Some text is cut off by ${Math.round(px)} px.`
        : null;
    }
    case "browser.overflow:horizontal_overflow": {
      const wider = num(/The page is (\d+)px wider/.exec(message));
      return wider !== null
        ? `The page is ${wider} px wider than the screen, so it scrolls sideways.`
        : null;
    }
    case "browser.tap_targets:small_target": {
      const size = /(\d+)\D(\d+)px interactive target/.exec(message);
      return size
        ? `A button or link is ${size[1]} by ${size[2]} px; the smallest easy size to tap is 24 by 24 px.`
        : null;
    }
    case "browser.image_crops:extreme_crop": {
      const kept = num(/Only (\d+)% of the source/.exec(message));
      return kept !== null
        ? `A photo is cropped so tightly that only ${kept}% of it shows.`
        : null;
    }
    case "browser.media:broken_image": {
      const count = num(/^(\d+) image/.exec(message));
      return count !== null
        ? count === 1
          ? "1 picture did not load."
          : `${count} pictures did not load.`
        : null;
    }
    case "browser.performance:lcp": {
      const ms = num(/LCP (\d+)ms/.exec(message));
      return ms !== null
        ? `The main content took ${(ms / 1000).toFixed(1)} s to show; the limit is 3 s.`
        : null;
    }
    case "browser.performance:cls": {
      const score = /CLS ([\d.]+)/.exec(message);
      return score
        ? `Content moves while the page loads (a score of ${score[1]}; the limit is under 0.1).`
        : null;
    }
    case "routes.render:status": {
      const got = /Returned (\d{3})/.exec(message);
      const want = /expected (\d{3})/.exec(message);
      return got && want
        ? `The page answered with status ${got[1]} instead of ${want[1]}.`
        : null;
    }
    case "routes.links:broken": {
      const got = /Returned (\d{3})/.exec(message);
      return got
        ? `A link leads to a page that answered with status ${got[1]}.`
        : null;
    }
    case "assets.provenance:placeholder": {
      const count = num(/^(\d+) (?:catalog image|artwork)/.exec(message));
      if (count === null) return null;
      return /catalog image/.test(message)
        ? `${count} catalogue picture${count === 1 ? " is" : "s are"} still waiting to be captured.`
        : `${count} picture${count === 1 ? " is" : "s are"} still a placeholder.`;
    }
    case "browser.coverage:state_missing": {
      const label = /^The (.+) was not measured\.$/.exec(message)?.[1];
      return label && CHROME_BY_LABEL.has(label)
        ? `The ${label} was not opened and measured.`
        : null;
    }
    case "browser.coverage:state_unopened":
    case "browser.coverage:state_stuck": {
      const label = (finding.where ?? "")
        .split(" · ")
        .map((part) => part.trim())
        .find((part) => CHROME_BY_LABEL.has(part));
      if (!label) return null;
      return finding.code === "state_unopened"
        ? `The ${label} did not open when its button was pressed.`
        : `The ${label} did not close after it was measured.`;
    }
  }
  return null;
}

function validationText(code: string, message: string): string | null {
  const [area] = code.split(".");
  if (code === "design.contrast" || code === "design.scheme_contrast") {
    const found = /\(([\d.]+):1, needs ([\d.]+):1\)/.exec(message);
    const ratio = num(found);
    const line = num(found, 2);
    if (ratio !== null && line !== null)
      return `${(Object.hasOwn(VALIDATION_TEXT, code) ? VALIDATION_TEXT[code] : "Some text is hard to read.").replace(/\.$/, "")} (${ratioWords(ratio, line)} to 1, needs ${line} to 1).`;
  }
  if (Object.hasOwn(VALIDATION_TEXT, code)) return VALIDATION_TEXT[code];
  return Object.hasOwn(VALIDATION_AREA_TEXT, area)
    ? VALIDATION_AREA_TEXT[area]
    : null;
}

const STOREMINK_TOLD =
  "This is in StoreMink's shared storefront code, not in this theme. StoreMink has been told.";

/** A finding of a check run, by its gate id and its code. */
export function findingWords(
  gateId: string,
  finding: GateFinding,
): StudioFindingWords {
  const code = typeof finding?.code === "string" ? finding.code : "";
  const isContrast =
    gateId === "browser.accessibility" &&
    (code === "color-contrast" || code === "contrast");
  const heading = isContrast
    ? "Readable text"
    : Object.hasOwn(CHECK_HEADINGS, gateId)
      ? CHECK_HEADINGS[gateId]
      : "Checks";
  const own = (table: Readonly<Record<string, string>> | undefined) =>
    table && Object.hasOwn(table, code) ? table[code] : null;
  const message = typeof finding?.message === "string" ? finding.message : "";
  let text: string | null;
  if (isContrast) text = contrastText(finding);
  else if (gateId === "browser.accessibility" && !own(ANY_CHECK_TEXT))
    text = accessibilityText(finding);
  else
    text =
      measuredText(gateId, finding) ??
      own(FINDING_TEXT[gateId]) ??
      ((gateId === "package.content" || gateId === "package.design") &&
      code.includes(".")
        ? validationText(code, message)
        : null) ??
      own(ANY_CHECK_TEXT) ??
      (Object.hasOwn(CHECK_GENERAL, gateId) ? CHECK_GENERAL[gateId] : null) ??
      UNKNOWN_CHECK;
  const storeMink = isPlatformFinding(gateId, finding);
  const placeFrom = gateId.startsWith("assets.")
    ? slotPlace(finding.where)
    : gateId.startsWith("package.") || gateId === "demo.materialize"
      ? null
      : placeWords(finding.where);
  return {
    heading,
    text: plainWords(storeMink ? `${text} ${STOREMINK_TOLD}` : text),
    place: placeFrom ? plainWords(placeFrom) : null,
    serious: isSeriousFinding(finding),
    storeMink,
  };
}

// ------------------------------------------------------- the design review

/** The review's rows in plain words, for "scored the phone layout 2 of 5". */
const REVIEW_ROW_WORDS: Readonly<Record<string, string>> = {
  artDirection: "the art direction",
  distinctness: "how distinct it looks",
  commerceClarity: "how clear shopping is",
  typography: "the typography",
  imagery: "the photos",
  responsiveComposition: "the phone layout",
  detailQuality: "the finish of the details",
  brandAdaptability: "how well a store's own logo, colours and products fit",
};

const REVIEW_TEXT: Readonly<Record<string, string>> = {
  copied:
    "The design looks copied from another company's theme, screenshots, words or pictures.",
  unfinished_surface:
    "A shop, product, cart or phone view looks unfinished: a blank or placeholder picture, an empty section, or missing products, prices or buttons.",
  placeholder_copy: "Placeholder words are visible in the demo store.",
  inaccessible_copy:
    "Some words are hard or impossible to read: over a photo, a gradient or another layer, cut off, or too small or faint.",
  unsupported_claim:
    "The design shows an award, rating, review count, press mention or other claim the brief does not support.",
  palette_only:
    "The design mostly changes the colours, fonts or section order of an existing StoreMink theme.",
  generic_surface:
    "Some shop, product, cart or phone views look generic, as if they could belong to any store.",
  needs_custom_code:
    "Parts of the design would need custom code to look as intended.",
  revise_requested: "The design review asked for small changes.",
  image_unchecked: "A photo has not passed its picture check yet.",
  image_hard_problem:
    "A photo has a problem the picture check does not allow, such as lettering, a logo or the wrong product.",
  image_redraw:
    "A photo was flagged for something small, such as its style, staging or crop.",
};

const REVIEW_PICTURE_CODES: ReadonlySet<string> = new Set([
  "image_unchecked",
  "image_hard_problem",
  "image_redraw",
]);

/** The review findings whose words this file has (scorecard.ts and
 * qa-image-issues.ts write them; a test reads both sources). */
export const REVIEW_FINDING_CODES: readonly string[] = [
  ...Object.keys(REVIEW_TEXT),
  "very_low_score",
  "low_score",
  "low_total",
];

/** A finding of the design review (scorecard.ts ReviewFinding: a rejection
 * code, `very_low_score` or `low_score` with its row and score,
 * `low_total`, `revise_requested`, `image_unchecked`, `image_hard_problem`,
 * `image_redraw` with its slot), and whether it came from the review's
 * serious list. */
export function reviewFindingWords(
  finding: ReviewFinding,
  serious: boolean,
): StudioFindingWords {
  const code = typeof finding?.code === "string" ? finding.code : "";
  const row =
    finding?.row && Object.hasOwn(REVIEW_ROW_WORDS, finding.row)
      ? REVIEW_ROW_WORDS[finding.row]
      : "one of its rows";
  const score =
    typeof finding?.score === "number" && Number.isFinite(finding.score)
      ? finding.score
      : null;
  let text: string;
  if (code === "very_low_score")
    text =
      score !== null
        ? `The design review scored ${row} ${score} of 5, too low for a store to work well.`
        : `The design review scored ${row} too low for a store to work well.`;
  else if (code === "low_score")
    text =
      score !== null
        ? `The design review scored ${row} ${score} of 5; it asks for 4.`
        : `The design review scored ${row} below 4 of 5.`;
  else if (code === "low_total")
    text =
      score !== null
        ? `The design review gave ${score} of 40 in all; it asks for 34.`
        : "The design review's total is below 34 of 40.";
  else
    text = Object.hasOwn(REVIEW_TEXT, code)
      ? REVIEW_TEXT[code]
      : "The design review found something it did not name.";
  return {
    heading: REVIEW_PICTURE_CODES.has(code) ? "Photos" : "Design review",
    text,
    place: slotPlace(finding?.slotId ?? null),
    serious,
    storeMink: false,
  };
}

// ------------------------------------------------------------ check coverage

const COVERAGE_PAGE_WORDS: Readonly<Record<string, string>> = {
  home: "home",
  shop: "shop",
  product: "the first product",
  cart: "the cart while empty",
  content: "the first content page",
  not_found: "the not-found page",
};

const PANEL_WORDS: Readonly<Record<string, string>> = {
  menu: "menu",
  search: "search",
  cart: "cart",
  account: "account",
  sign_in: "sign-in",
};

/** "a, b and c". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * What the checks really measured, in one plain paragraph, from the stored
 * coverage (never hard-coded): "Checked 6 sample pages (home, shop, the first
 * product, the cart while empty, the first content page and the not-found
 * page) at 5 widths (360, 390, 768, 1024 and 1440 px), and opened the menu,
 * search, cart, account and sign-in panels on the home page." A theme with no
 * product or content page is told so.
 */
export function checkCoverageWords(
  coverage: ThemeStudioCheckScreenshots["coverage"],
): string {
  const pages = coverage.pages.map((page) =>
    page === "cart" && !coverage.cartWasEmpty
      ? "the cart"
      : Object.hasOwn(COVERAGE_PAGE_WORDS, page)
        ? COVERAGE_PAGE_WORDS[page]
        : page.replace(/_/g, " "),
  );
  if (!pages.length) return "These checks stored no screenshots.";
  const widths = [...coverage.widths].sort((a, b) => a - b);
  const pageCount = `${pages.length} sample page${pages.length === 1 ? "" : "s"}`;
  const widthPart = widths.length
    ? ` at ${widths.length} width${widths.length === 1 ? "" : "s"} (${listWords(widths.map(String))} px)`
    : "";
  const panels = coverage.panels.map((panel) =>
    Object.hasOwn(PANEL_WORDS, panel) ? PANEL_WORDS[panel] : panel,
  );
  const panelPart = panels.length
    ? `, and opened the ${listWords(panels)} panel${panels.length === 1 ? "" : "s"} on the home page`
    : ", and opened no header panels";
  const missing = [
    !coverage.pages.includes("product") ? "no product page" : null,
    !coverage.pages.includes("content") ? "no content page" : null,
  ].filter((part): part is string => part !== null);
  const missingPart = missing.length
    ? ` This theme has ${listWords(missing)}, so none was checked.`
    : "";
  return `Checked ${pageCount} (${listWords(pages)})${widthPart}${panelPart}.${missingPart}`;
}

// ---------------------------------------------------------------- copying

/** What "Copy details" puts on the clipboard: the theme, what went wrong,
 * the check and code, the design and version, the build and the time. */
export interface StudioCopyDetails {
  themeName: string;
  themeId: string;
  /** The plain sentence the screen showed. */
  what: string;
  /** The gate id or the stop kind, when there is one. */
  check: string | null;
  code: string | null;
  versionNumber: number | null;
  build: string | null;
  /** ISO 8601. */
  at: string | null;
}

/** "25 Oct 2026, 10:05", India time. */
function fullClock(iso: string): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  const when = indiaParts(at);
  return `${when.day} ${when.month} ${when.year}, ${when.hour}:${when.minute}`;
}

/** Plain text for an engineer, one fact per line, no long dashes. The only
 * place besides the Log tab and Technical details where a code or a build
 * appears is this clipboard text. */
export function copyDetailsText(details: StudioCopyDetails): string {
  const line = (label: string, value: string | null | undefined) =>
    value && value.trim() ? `${label}: ${plainWords(value.trim())}` : null;
  const time = details.at ? fullClock(details.at) : null;
  return [
    line("Theme", `${details.themeName} (${details.themeId})`),
    line("What the screen said", details.what),
    line("Check", details.check),
    line("Code", details.code),
    details.versionNumber !== null
      ? line(
          "Design",
          `${designLabel(details.versionNumber)} (version ${details.versionNumber})`,
        )
      : null,
    line("Build", details.build),
    time ? line("Time", `${time} India time (${details.at})`) : null,
  ]
    .filter((value): value is string => value !== null)
    .join("\n");
}
