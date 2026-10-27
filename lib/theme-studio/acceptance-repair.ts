import {
  designLabel,
  findingWords,
  plainWords,
  reviewFindingWords,
} from "@/app/platform/dashboard/(console)/themes/studio/studio-words";
import type { ThemeStudioAcceptanceRunView } from "./acceptance";
import { gateBlocks, type GateId } from "./acceptance-gates";
import { THEME_STUDIO_LIMITS } from "./contracts";
import { isPlatformFinding, isSeriousFinding } from "./finding-severity";
import type { ReviewSeverity } from "./scorecard";

// ---------------------------------------------------------------------------
// "Describe a fix" (wave TS-2, plan section 4, "Fix it" by kind).
//
// ★ DRAFT ONLY: the operator reads it in the chat before sending it. The
// theme page puts it in the composer (StudioPageApi.putInChat) and never
// sends it: every change is a full creative pass that may restyle a design
// the operator liked, so it is never a one-click paid revision.
//
// ★ SERIOUS FINDINGS ONLY, NEVER WARNINGS, and only those a change to the
// theme can fix (THEME_FIX_CHECKS, plus the design review's serious findings
// that are not about a photo). A picture is redrawn (Redraw), StoreMink's own
// storefront code is ours to fix ("StoreMink has been told"), and a check
// that could not run is checked again: none of those reaches the draft.
//
// ★ WORDS. The design is named the way every screen names it (designLabel,
// "Design 3"), and the draft carries no run id: the Checks tab's own words
// (studio-words.ts) plus, for the model, a short detail from the finding as
// it was measured. No em dash or en dash (plainWords).
// ---------------------------------------------------------------------------

/** The checks whose serious findings a change to the theme can fix: its
 * settings, pages, words and links, and its security (`package.security`,
 * which the draft left out until TS-2). acceptance-repair.test.ts classifies
 * every check id, so a new check is never left out silently. */
export const THEME_FIX_CHECKS: readonly GateId[] = [
  "package.schema",
  "package.content",
  "package.design",
  "package.security",
  "routes.links",
  "routes.markup",
  "browser.overflow",
  "browser.clipped_text",
  "browser.tap_targets",
  "browser.image_crops",
  "browser.accessibility",
];

const THEME_FIX: ReadonlySet<string> = new Set(THEME_FIX_CHECKS);

/** Design-review findings about a photo: it is redrawn, or it waits for its
 * picture check. A change to the theme cannot clear them. */
export const PHOTO_REVIEW_CODES: readonly string[] = [
  "image_unchecked",
  "image_hard_problem",
  "image_redraw",
];

const PHOTO_REVIEW: ReadonlySet<string> = new Set(PHOTO_REVIEW_CODES);

/** At most this many kinds of problem, places per kind and characters of a
 * measured detail: the draft is a short summary, not a report. */
const MAX_KINDS = 12;
const MAX_PLACES = 4;
const MAX_DETAIL = 240;

/** The design the draft is about. */
export interface DescribeFixVersion {
  id: string;
  packageDigest: string | null;
  versionNumber: number;
}

export interface DescribeFixInput {
  /** The design's newest check run, or null when it has none. A run of
   * another design, or of other pictures or files, is not read. */
  run: ThemeStudioAcceptanceRunView | null;
  version: DescribeFixVersion;
  /** The design's newest final design review, as it split what it found
   * (acceptance.ts readReviewSeverity); null when there is none. */
  review: ReviewSeverity | null;
  /** What the design review wrote when it recorded no codes (a review from
   * before severity-v1): used only when nothing else is serious. */
  notes?: readonly string[];
}

interface Kind {
  line: string;
  /** Every distinct place it was found, in the order found. */
  places: string[];
  detail: string | null;
}

function clip(text: string, max: number): string {
  const plain = plainWords(text).replace(/\s+/g, " ").trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40)).trim()}...`;
}

function bullet(kind: Kind): string {
  const parts = [kind.line];
  if (kind.places.length)
    parts.push(
      `Where: ${kind.places.slice(0, MAX_PLACES).join("; ")}${kind.places.length > MAX_PLACES ? "; and more" : ""}.`,
    );
  if (kind.detail) parts.push(`Measured: ${kind.detail}`);
  return `- ${parts.join(" ")}`;
}

/**
 * The text "Describe a fix" puts in the chat for the operator to read and
 * send, or null when nothing serious in this design is a change to the
 * theme. Built from serious findings only, grouped by kind, in the Checks
 * tab's words, with the design named "Design N" and no run id.
 */
export function describeFixDraft(input: DescribeFixInput): string | null {
  const { run, version, review } = input;
  const kinds = new Map<string, Kind>();
  const add = (
    key: string,
    line: string,
    place: string | null,
    detail: string | null,
  ) => {
    let kind = kinds.get(key);
    if (!kind) {
      kind = { line, places: [], detail };
      kinds.set(key, kind);
    }
    if (place && !kind.places.includes(place)) kind.places.push(place);
  };

  const sameDesign =
    run !== null &&
    run.versionId === version.id &&
    version.packageDigest !== null &&
    run.packageDigest === version.packageDigest;
  if (sameDesign) {
    for (const gate of run.gates) {
      if (!gate.required || !THEME_FIX.has(gate.id) || !gateBlocks(gate))
        continue;
      for (const finding of gate.findings) {
        if (!isSeriousFinding(finding)) continue;
        if (isPlatformFinding(gate.id, finding)) continue;
        const words = findingWords(gate.id, finding);
        const raw =
          typeof finding.message === "string" && finding.message.trim()
            ? clip(
                gate.id.startsWith("package.") && finding.where
                  ? `${finding.message} (${finding.where})`
                  : finding.message,
                MAX_DETAIL,
              )
            : null;
        add(
          `checks|${gate.id}|${finding.code}|${words.text}`,
          `${words.heading}: ${words.text}`,
          words.place,
          raw,
        );
      }
    }
  }

  for (const finding of review?.serious ?? []) {
    if (PHOTO_REVIEW.has(finding.code)) continue;
    const words = reviewFindingWords(finding, true);
    add(
      `review|${finding.code}|${words.text}`,
      `${words.heading}: ${words.text}`,
      words.place,
      null,
    );
  }

  if (kinds.size === 0) {
    for (const note of input.notes ?? []) {
      const text = typeof note === "string" ? clip(note, MAX_DETAIL) : "";
      if (text) add(`note|${text}`, `Design review: ${text}`, null, null);
    }
  }
  if (kinds.size === 0) return null;

  const listed = [...kinds.values()].slice(0, MAX_KINDS);
  const more = kinds.size - listed.length;
  const design = designLabel(version.versionNumber);
  const text = [
    `Please fix what the checks found in ${design}. Keep what works in its design, words and pictures, and change only what these problems need. Don't hide content or switch off a check to make it pass. If a problem needs a change to StoreMink's own storefront code that the theme can't make, say so.`,
    "",
    "Must fix:",
    ...listed.map(bullet),
    ...(more > 0
      ? [`- And ${more} more kind${more === 1 ? "" : "s"} of problem.`]
      : []),
  ].join("\n");
  return plainWords(text).slice(0, THEME_STUDIO_LIMITS.promptChars - 2000);
}

/**
 * Today's draft from one check run (kept for its importers): a failed or
 * security-blocked run of this exact design on today's StoreMink build, in
 * the same words as `describeFixDraft`. Null for anything else.
 */
export function acceptanceRepairDraft(
  run: ThemeStudioAcceptanceRunView,
  version: DescribeFixVersion,
): string | null {
  if (
    !run.currentBuild ||
    run.versionId !== version.id ||
    run.packageDigest !== version.packageDigest ||
    (run.status !== "failed" && run.status !== "blocked")
  )
    return null;
  return describeFixDraft({ run, version, review: null });
}
