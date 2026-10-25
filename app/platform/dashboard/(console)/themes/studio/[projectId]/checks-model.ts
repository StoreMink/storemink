import type { ThemeStudioAcceptanceRunView } from "@/lib/theme-studio/acceptance";
import {
  gateBlocks,
  type GateFinding,
  type GateResult,
} from "@/lib/theme-studio/acceptance-gates";
import {
  isPlatformFinding,
  isSeriousFinding,
} from "@/lib/theme-studio/finding-severity";
import type {
  ReviewFinding,
  ReviewSeverity,
} from "@/lib/theme-studio/scorecard";
import {
  CHECK_HEADINGS,
  findingWords,
  reviewFindingWords,
} from "../studio-words";

// ---------------------------------------------------------------------------
// What the Checks tab lists (wave TS-2, builder 2C; plan section 4, "Theme
// page, ready to publish" and "needs a fix"): Must fix before publishing,
// Warnings (you can still publish) and Passed, for one design's newest check
// run and its newest design review.
//
// ★ COUNTED BY KIND, THE WAY THE STATUS WORDS COUNT. A kind is keyed exactly
// as progress.ts counts it (`checks|<check>|<code>`; a serious review
// finding per row or photo, a review warning per code), so "Needs a fix (2
// problems)" or "Ready to publish, 2 warnings" in the header and the lists
// here agree. A warning is a finding of a check that does not stop Publish
// (acceptance-gates.ts acceptanceWarnings, what the Publish dialog lists);
// a minor finding inside a check that stops Publish waits in Technical
// details until that check is fixed.
//
// ★ NEVER JUDGED AGAIN. Severity is read as it was measured
// (finding-severity.ts isSeriousFinding; a finding with none is serious), a
// check stops Publish exactly when acceptance-gates.ts gateBlocks says so,
// and the design review's own split decides its findings.
//
// ★ SERVER ONLY BY USE: acceptance-gates.ts is server code. The tab computes
// this on the server and hands plain data to its client parts.
// ---------------------------------------------------------------------------

/** Check findings a picture redraw can clear: a named slot's picture is
 * missing, too small or in the wrong format, or still a placeholder. The
 * same list as progress.ts PICTURE_FINDINGS, which decides when the status
 * words offer Redraw (checks-model.test.ts reads that source and fails if
 * the two differ). */
export const PICTURE_FINDINGS: Readonly<Record<string, readonly string[]>> = {
  "assets.integrity": [
    "missing",
    "too_small",
    "wrong_format",
    "format",
    "size",
  ],
  "assets.provenance": ["placeholder"],
};

/** Design-review findings a redraw clears: progress.ts PICTURE_REVIEW_CODES,
 * plus `image_redraw`, the warning for a photo with a small problem. */
export const PICTURE_REVIEW_CODES: readonly string[] = [
  "image_unchecked",
  "image_hard_problem",
  "image_redraw",
];

/** One sentence of a kind, and the places it was found. */
export interface StudioCheckLine {
  text: string;
  places: string[];
}

/** One kind of problem or warning, as the Checks tab shows it. */
export interface StudioCheckItem {
  /** `checks|<check>|<code>`, or the design review's, as the status counts
   * them. */
  key: string;
  source: "checks" | "review";
  /** The check that found it; null for the design review. Technical details
   * and Copy details only. */
  check: string | null;
  /** The finding's code: Technical details and Copy details only. */
  code: string;
  /** The check's plain name ("Readable text"). */
  heading: string;
  /** Its distinct sentences in the order found, each with its places. */
  lines: StudioCheckLine[];
  /** How many findings of this kind. */
  count: number;
  /** In StoreMink's own storefront code: "StoreMink has been told", Copy
   * details, never a fix button. */
  storeMink: boolean;
  /** A picture redraw clears it. */
  picture: boolean;
  /** The picture slots it names (a picture check's `where`, the review's
   * `slotId`). */
  slotIds: string[];
  /** The first finding as it was measured, for Copy details only: never
   * shown on the main view. */
  measured: string | null;
}

/** A check that passed, or holds only warnings. */
export interface StudioPassedCheck {
  id: string;
  heading: string;
  withWarnings: boolean;
}

export interface StudioChecksModel {
  mustFix: StudioCheckItem[];
  warnings: StudioCheckItem[];
  passed: StudioPassedCheck[];
}

function headingOf(gateId: string, fallback: string): string {
  return Object.hasOwn(CHECK_HEADINGS, gateId)
    ? CHECK_HEADINGS[gateId]
    : fallback;
}

interface Found {
  text: string;
  place: string | null;
  slotId: string | null;
  measured: string | null;
  storeMink: boolean;
}

/** Kinds in the order first found. */
class Kinds {
  private readonly byKey = new Map<string, StudioCheckItem>();
  readonly list: StudioCheckItem[] = [];

  add(
    item: Pick<
      StudioCheckItem,
      "key" | "source" | "check" | "code" | "heading" | "picture"
    >,
    found: Found,
  ): void {
    let entry = this.byKey.get(item.key);
    if (!entry) {
      entry = {
        ...item,
        lines: [],
        count: 0,
        storeMink: found.storeMink,
        slotIds: [],
        measured: found.measured,
      };
      this.byKey.set(item.key, entry);
      this.list.push(entry);
    } else {
      // StoreMink's own only when every finding of the kind is.
      entry.storeMink = entry.storeMink && found.storeMink;
    }
    entry.count += 1;
    let line = entry.lines.find((l) => l.text === found.text);
    if (!line) {
      line = { text: found.text, places: [] };
      entry.lines.push(line);
    }
    if (found.place && !line.places.includes(found.place))
      line.places.push(found.place);
    if (found.slotId && !entry.slotIds.includes(found.slotId))
      entry.slotIds.push(found.slotId);
  }
}

function addCheckFinding(
  into: Kinds,
  gate: GateResult,
  finding: GateFinding,
): void {
  const words = findingWords(gate.id, finding);
  into.add(
    {
      key: `checks|${gate.id}|${finding.code}`,
      source: "checks",
      check: gate.id,
      code: finding.code,
      heading: words.heading,
      picture: (PICTURE_FINDINGS[gate.id] ?? []).includes(finding.code),
    },
    {
      text: words.text,
      place: words.place,
      slotId:
        gate.id.startsWith("assets.") && typeof finding.where === "string"
          ? finding.where
          : null,
      measured:
        typeof finding.message === "string" && finding.message
          ? `${finding.where ? `${finding.where}: ` : ""}${finding.message}`
          : null,
      storeMink: isPlatformFinding(gate.id, finding),
    },
  );
}

function addReviewFinding(
  into: Kinds,
  finding: ReviewFinding,
  serious: boolean,
): void {
  const words = reviewFindingWords(finding, serious);
  into.add(
    {
      // progress.ts: a serious finding per row or photo, a warning per code.
      key: serious
        ? `review|${finding.code}|${finding.row ?? finding.slotId ?? ""}`
        : `review|${finding.code}`,
      source: "review",
      check: null,
      code: finding.code,
      heading: words.heading,
      picture: PICTURE_REVIEW_CODES.includes(finding.code),
    },
    {
      text: words.text,
      place: words.place,
      slotId: typeof finding.slotId === "string" ? finding.slotId : null,
      measured: null,
      storeMink: false,
    },
  );
}

/**
 * Must fix, Warnings and Passed for one design: its newest check run (null
 * when it has none) and its newest final design review's split (null when
 * there is none, it is still running, or it recorded none).
 */
export function studioChecksModel(input: {
  run: ThemeStudioAcceptanceRunView | null;
  review: ReviewSeverity | null;
}): StudioChecksModel {
  const mustFix = new Kinds();
  const warnings = new Kinds();
  const passed: StudioPassedCheck[] = [];
  for (const gate of input.run?.gates ?? []) {
    const findings = Array.isArray(gate.findings) ? gate.findings : [];
    if (gateBlocks(gate)) {
      const serious = findings.filter(isSeriousFinding);
      if (!serious.length) {
        // A required check that was not passed and says nothing serious (no
        // findings, or a state this code does not know): never a pass.
        mustFix.add(
          {
            key: `checks|${gate.id}|`,
            source: "checks",
            check: gate.id,
            code: gate.status,
            heading: headingOf(gate.id, gate.label),
            picture: false,
          },
          {
            text: findingWords(gate.id, { code: "", message: "" }).text,
            place: null,
            slotId: null,
            measured: null,
            storeMink: false,
          },
        );
      }
      for (const finding of serious) addCheckFinding(mustFix, gate, finding);
      continue;
    }
    for (const finding of findings) addCheckFinding(warnings, gate, finding);
    if (gate.status !== "skipped")
      passed.push({
        id: gate.id,
        heading: headingOf(gate.id, gate.label),
        withWarnings: findings.length > 0,
      });
  }
  for (const finding of input.review?.serious ?? [])
    addReviewFinding(mustFix, finding, true);
  for (const finding of input.review?.warnings ?? [])
    addReviewFinding(warnings, finding, false);
  return { mustFix: mustFix.list, warnings: warnings.list, passed };
}

/** The picture slots a Redraw of these items draws again: the slots they
 * name that can be redrawn, in the order found. */
export function redrawSlotIds(
  items: readonly StudioCheckItem[],
  redrawable: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const item of items)
    if (item.picture)
      for (const slot of item.slotIds)
        if (redrawable.has(slot) && !out.includes(slot)) out.push(slot);
  return out;
}

/** Whether these items include pictures that are still placeholders: Draw
 * missing pictures draws every one. */
export function hasPlaceholderItem(items: readonly StudioCheckItem[]): boolean {
  return items.some(
    (item) =>
      item.source === "checks" &&
      item.check === "assets.provenance" &&
      item.code === "placeholder",
  );
}
