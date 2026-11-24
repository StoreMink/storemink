import {
  GATE_LABELS,
  gateBlocks,
  type GateId,
  type GateResult,
} from "./acceptance-gates";
import { isSeriousFinding } from "./finding-severity";

// Migration 0145 constrains version/run/capture/QA iterations to 0..3, so
// three automatic repairs (iterations 0 -> 1 -> 2 -> 3) is the ceiling the
// database allows. Raising this further needs a migration first.
export const MAX_AUTOMATIC_QA_REPAIRS = 3;

/**
 * What the design review concluded, classified by its caller (visual-qa.ts):
 * `pass`; `taste`, a design it would still improve (a low score, verdict
 * "revise", palette_only, generic_surface, needs_custom_code); or `serious`,
 * a defect that stops Publish (copy it cannot read, an invented claim, an
 * unfinished shop, product or cart view, copied work, a photo with a hard
 * problem, a very low score on shopping clarity, the phone layout or brand
 * fit). `null` means no review ran, which is never a pass.
 */
export interface AutomaticQaReview {
  outcome: "pass" | "taste" | "serious";
}

export type AutomaticQaDecision = "pass" | "revise" | "attention" | "blocked";

/** A layout check measures the browser stage alone. */
const LAYOUT_GATE_IDS: readonly GateId[] = [
  "browser.coverage",
  "browser.overflow",
  "browser.clipped_text",
  "browser.tap_targets",
  "browser.image_crops",
  "browser.accessibility",
  "browser.media",
  "browser.performance",
  "browser.header_menu",
];

/** Gates whose failure is a broken runtime, which no theme revision can
 * repair. */
const RUNTIME_GATES: ReadonlySet<string> = new Set([
  "demo.materialize",
  "browser.coverage",
  "assets.integrity",
]);
/** routes.render findings of the same kind. A missing noindex is no longer
 * one: it is a warning in StoreMink's own markup (finding-severity.ts). */
const RUNTIME_RENDER_CODES: ReadonlySet<string> = new Set([
  "fetch",
  "unthemed",
  "token",
]);
/** Findings that say a check could not finish: a page timing out, the time
 * budget spent, a skipped check, an unmeasured value. Not a theme defect a
 * paid revision can be trusted to fix, nor a blip a recapture would clear. */
const UNCHECKED_CODES: ReadonlySet<string> = new Set([
  "budget",
  "timeout",
  "skipped",
  "unmeasured",
]);

const REVIEW_OUTCOMES: ReadonlySet<string> = new Set([
  "pass",
  "taste",
  "serious",
]);

/** The review's outcome, or null for no review: anything that is not a
 * recognised outcome (a stale caller's yes or no included) counts as none. */
function reviewOutcome(review: unknown): AutomaticQaReview["outcome"] | null {
  if (!review || typeof review !== "object") return null;
  const outcome = (review as { outcome?: unknown }).outcome;
  return typeof outcome === "string" && REVIEW_OUTCOMES.has(outcome)
    ? (outcome as AutomaticQaReview["outcome"])
    : null;
}

/**
 * The next step after a check run and its design review ("Fix it, then
 * allow Publish", owner, 24 Oct 2026):
 *
 * - `blocked`: the security gate failed; not something to iterate on.
 * - `attention`: nothing a paid revision can be trusted to fix (a missing
 *   gate, a check that could not finish, a broken runtime, no design review
 *   at all), or a serious problem still left at the repair ceiling.
 * - `revise`: a serious finding (from the gates or the review), or a design
 *   the review would still improve, while repairs remain.
 * - `pass`: no serious finding is left and the review passed; or only taste
 *   is left once the repairs are used up, which becomes warnings.
 *
 * ★ A MODEL CANNOT OVERRULE DETERMINISTIC GATES OR REPAIR A BROKEN RUNTIME.
 * The gates decide through gateBlocks, the same rule as acceptanceOutcome,
 * so a stored "passed" run and this decision always agree.
 *
 * ★ AT THE REPAIR CEILING THIS NEVER ASKS FOR A REVISION, so a re-check,
 * which starts there (the re-check contract), can never buy a paid restyle.
 *
 * ★ The layout check is the gates-only preflight before photos and no design
 * review runs there, so `review` is ignored in the layout phase. In the
 * final phase a missing review (null) is never a pass.
 */
export function automaticQaDecision(
  gates: readonly GateResult[],
  review: AutomaticQaReview | null,
  iteration: number,
  phase: "layout" | "final" = "final",
): AutomaticQaDecision {
  const requiredIds =
    phase === "layout"
      ? LAYOUT_GATE_IDS
      : (Object.keys(GATE_LABELS) as GateId[]);
  if (requiredIds.some((id) => !gates.some((g) => g.id === id)))
    return "attention";
  const failed = gates.filter(gateBlocks);
  if (failed.some((g) => g.id === "package.security")) return "blocked";
  const serious = (g: GateResult) => g.findings.filter(isSeriousFinding);
  if (
    failed.some(
      (g) =>
        g.status === "skipped" ||
        serious(g).some((f) => UNCHECKED_CODES.has(f.code)),
    )
  )
    return "attention";
  if (
    failed.some(
      (g) =>
        RUNTIME_GATES.has(g.id) ||
        (g.id === "routes.render" &&
          serious(g).some((f) => RUNTIME_RENDER_CODES.has(f.code))),
    )
  )
    return "attention";
  const atCeiling = iteration >= MAX_AUTOMATIC_QA_REPAIRS;
  if (failed.length) return atCeiling ? "attention" : "revise";
  if (phase === "layout") return "pass";
  switch (reviewOutcome(review)) {
    case "pass":
      return "pass";
    case "taste":
      return atCeiling ? "pass" : "revise";
    case "serious":
      return atCeiling ? "attention" : "revise";
    default:
      // No review ran: never a pass, and no revision can supply one.
      return "attention";
  }
}

/** Why a theme was stopped for attention, which decides what the operator is
 * told to do (plan section 4, status rows 12 and 14). */
export type AutomaticQaAttention = "unfinished" | "runtime" | "serious";

/** browser.coverage findings that are a real fault in the storefront (a
 * menu, search, cart, account or sign-in that would not open or close); its
 * other findings say a page or a state was never measured. */
const COVERAGE_FAULT_CODES: ReadonlySet<string> = new Set([
  "state_unopened",
  "state_stuck",
]);

/**
 * Why automaticQaDecision answered `attention` for these inputs, or null
 * when it answered anything else:
 *
 * - `unfinished`: a check could not finish (a missing or skipped check, a
 *   page that was not measured or timed out, the time budget spent, a
 *   failure that names nothing, or no design review at all). Check again.
 * - `runtime`: StoreMink's preview did not work (the demo store, a page that
 *   could not be fetched or themed, a stored picture, a menu that would not
 *   open or close). No theme change can fix it.
 * - `serious`: a serious finding of the gates or the review is left at the
 *   repair ceiling. A change to the theme can fix it.
 *
 * Words only: the decision itself is automaticQaDecision's.
 */
export function automaticQaAttention(
  gates: readonly GateResult[],
  review: AutomaticQaReview | null,
  iteration: number,
  phase: "layout" | "final" = "final",
): AutomaticQaAttention | null {
  if (automaticQaDecision(gates, review, iteration, phase) !== "attention")
    return null;
  const requiredIds =
    phase === "layout"
      ? LAYOUT_GATE_IDS
      : (Object.keys(GATE_LABELS) as GateId[]);
  if (requiredIds.some((id) => !gates.some((g) => g.id === id)))
    return "unfinished";
  const failed = gates.filter(gateBlocks);
  const serious = (g: GateResult) => g.findings.filter(isSeriousFinding);
  if (
    failed.some(
      (g) =>
        g.status === "skipped" ||
        serious(g).length === 0 ||
        serious(g).some((f) => UNCHECKED_CODES.has(f.code)) ||
        (g.id === "browser.coverage" &&
          serious(g).some((f) => !COVERAGE_FAULT_CODES.has(f.code))),
    )
  )
    return "unfinished";
  if (
    failed.some(
      (g) =>
        RUNTIME_GATES.has(g.id) ||
        (g.id === "routes.render" &&
          serious(g).some((f) => RUNTIME_RENDER_CODES.has(f.code))),
    )
  )
    return "runtime";
  if (failed.length) return "serious";
  // The gates passed: the review stopped it, or none ran.
  return reviewOutcome(review) === "serious" ? "serious" : "unfinished";
}

/** One line per gate that stops the run, with its serious findings, for the
 * QA report and the revision brief. Warnings are left out: they never drive
 * a paid revision. */
export function automaticAcceptanceFailures(
  gates: readonly GateResult[],
): string[] {
  return gates.filter(gateBlocks).map(
    (g) =>
      `${g.label}: ${
        g.findings
          .filter(isSeriousFinding)
          .slice(0, 5)
          .map((f) => `${f.where ? `${f.where}: ` : ""}${f.message}`)
          .join("; ") || "not passed"
      }`,
  );
}
