// ---------------------------------------------------------------------------
// The design review's scorecard (docs/theme-acceptance.md §5), with no
// imports at all, so the operator screens (client components) and the server
// share one copy of the rows, the bar, the rejection conditions and which of
// them are serious.
//
// ★ "Fix it, then allow Publish" (owner, 23 and 24 Oct 2026). Theme Studio
// repairs what the review finds, up to three rounds. After that, only a
// SERIOUS finding stops Publish; everything else is taste, shown as a warning
// the operator may publish past. Serious: copy that cannot be read, invented
// claims, unfinished commerce views, placeholder copy, a copied design
// (decision 2) and the very low scores of decision 3.
// ---------------------------------------------------------------------------

/** The eight rows of the scorecard, scored 1 to 5, in the words of
 * docs/theme-acceptance.md §5 (change them together). `key` is the name the
 * reviewer answers with. */
export const SCORECARD_DIMENSIONS = [
  {
    key: "artDirection",
    label: "Art direction",
    question:
      "A coherent and intentional point of view, not a collection of fashionable effects.",
  },
  {
    key: "distinctness",
    label: "Distinctness",
    question:
      "Homepage, shop, product, cart, header and footer cannot be mistaken for another StoreMink theme with new colours.",
  },
  {
    key: "commerceClarity",
    label: "Commerce clarity",
    question:
      "Discovery, price, variant, stock, add-to-cart, cart and checkout matter more than decoration.",
  },
  {
    key: "typography",
    label: "Typography",
    question:
      "Clear hierarchy, readable measures, suitable weights and graceful long-content behaviour.",
  },
  {
    key: "imagery",
    label: "Imagery",
    question:
      "Consistent crop language, useful focal points, licensed sources and no obvious stock-photo collage.",
  },
  {
    key: "responsiveComposition",
    label: "Responsive composition",
    question:
      "Mobile is deliberately composed rather than a collapsed desktop design.",
  },
  {
    key: "detailQuality",
    label: "Detail quality",
    question:
      "Spacing, icons, borders, motion, empty states and error states feel finished.",
  },
  {
    key: "brandAdaptability",
    label: "Brand adaptability",
    question:
      "A merchant logo, primary colour and real catalogue can replace the seed without destroying the design.",
  },
] as const;
export type ScorecardKey = (typeof SCORECARD_DIMENSIONS)[number]["key"];
export type Scores = Record<ScorecardKey, number>;

/** The conditions the reviewer may name. Naming any one makes a clean pass
 * impossible, whatever the scores say. `serious` ones still stop Publish
 * after the repair rounds; the others are taste and become warnings. The
 * labels are the reviewer's instructions (VISUAL_QA_SYSTEM_PROMPT). */
export const REJECTION_CONDITIONS = [
  {
    key: "palette_only",
    serious: false,
    label:
      "An existing StoreMink theme with only palette, font, radius or section order changes",
  },
  {
    key: "copied",
    serious: true,
    label: "Copies another company's theme, screenshots, copy or assets",
  },
  {
    key: "generic_surface",
    serious: false,
    label:
      "Shop, product, cart or mobile views are finished but generic: they could belong to any store",
  },
  {
    key: "unfinished_surface",
    serious: true,
    label:
      "A shop, product, cart or mobile view is unfinished: placeholder or blank artwork, a headed section with nothing under it, or missing products, prices or buttons",
  },
  {
    key: "needs_custom_code",
    serious: false,
    label: "Needs custom code to render its core advertised design",
  },
  {
    key: "placeholder_copy",
    serious: true,
    label: "Placeholder copy is visible in the demo",
  },
  {
    key: "inaccessible_copy",
    serious: true,
    label:
      "Copy a shopper cannot read is visible in the demo: over a photograph, a gradient or an overlapping layer, clipped or cut off, or too small or too faint",
  },
  {
    key: "unsupported_claim",
    serious: true,
    label:
      "Shows an award, certification, endorsement, rating, review count, press mention or clinical result that the original brief does not support",
  },
] as const;
export type RejectionCondition = (typeof REJECTION_CONDITIONS)[number]["key"];

/** Every row must reach this… */
export const MIN_ROW_SCORE = 4;
/** …and the eight rows must total this: an average of 4.2 over eight rows
 * is 33.6, and scores are whole numbers. */
export const MIN_TOTAL_SCORE = 34;

/**
 * Decision 3 (owner, 24 Oct 2026): after the repair rounds a score stops
 * Publish only on these rows, and only at or below this score. Below 3 of 5
 * on shopping clarity, the phone layout and how well a merchant's own logo,
 * colours and products fit; 2 or below on typography and detail quality, the
 * two rows where reviewers have scored down copy they could not read. Scores
 * are whole numbers, so all five read "2 or below". Every other low score is
 * taste: a warning.
 */
export const SERIOUS_SCORE_LIMITS: Readonly<
  Partial<Record<ScorecardKey, number>>
> = {
  commerceClarity: 2,
  responsiveComposition: 2,
  brandAdaptability: 2,
  typography: 2,
  detailQuality: 2,
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Does this set of scores clear the bar for a clean pass, with no warnings? */
export function scorecardClearsBar(
  scores: Scores,
  rejections: readonly RejectionCondition[],
): boolean {
  const values = SCORECARD_DIMENSIONS.map((d) => scores[d.key]);
  const total = values.reduce((sum, value) => sum + value, 0);
  return (
    rejections.length === 0 &&
    Math.min(...values) >= MIN_ROW_SCORE &&
    total >= MIN_TOTAL_SCORE
  );
}

/**
 * One thing the design review found. `code` is a rejection key, or one of
 * `very_low_score` and `low_score` (with `row` and `score`), `low_total`
 * (with `score`), `revise_requested`, and `image_unchecked`,
 * `image_hard_problem` and `image_redraw` (with `slotId`). Stable: the
 * operator screens key their words on it. A final check with no review at
 * all carries none: the policy is told `null`, which never passes.
 */
export interface ReviewFinding {
  code: string;
  row?: ScorecardKey;
  score?: number;
  slotId?: string;
}

/** What the review found, split by what it does to Publish. */
export interface ReviewSeverity {
  /** "serious" stops Publish once the repairs are used up; "taste" is shown
   * as warnings; "pass" is a clean pass. */
  outcome: "pass" | "taste" | "serious";
  serious: ReviewFinding[];
  warnings: ReviewFinding[];
}

/** The serious findings on a scorecard: its serious rejections and its very
 * low scores. */
export function seriousScorecardFindings(
  scores: Scores,
  rejections: readonly RejectionCondition[],
): ReviewFinding[] {
  return [
    ...REJECTION_CONDITIONS.filter(
      (c) => c.serious && rejections.includes(c.key),
    ).map((c) => ({ code: c.key })),
    ...SCORECARD_DIMENSIONS.flatMap((d) => {
      const limit = SERIOUS_SCORE_LIMITS[d.key];
      return limit !== undefined && scores[d.key] <= limit
        ? [{ code: "very_low_score", row: d.key, score: scores[d.key] }]
        : [];
    }),
  ];
}

/** Taste on a scorecard: the other rejections, every row under the bar that
 * is not already serious, and a total under the bar. */
export function scorecardWarnings(
  scores: Scores,
  rejections: readonly RejectionCondition[],
): ReviewFinding[] {
  const total = SCORECARD_DIMENSIONS.reduce((s, d) => s + scores[d.key], 0);
  const rows = SCORECARD_DIMENSIONS.flatMap((d) => {
    const limit = SERIOUS_SCORE_LIMITS[d.key];
    const score = scores[d.key];
    if (score >= MIN_ROW_SCORE) return [];
    if (limit !== undefined && score <= limit) return [];
    return [{ code: "low_score", row: d.key, score }];
  });
  return [
    ...REJECTION_CONDITIONS.filter(
      (c) => !c.serious && rejections.includes(c.key),
    ).map((c) => ({ code: c.key })),
    ...rows,
    ...(total < MIN_TOTAL_SCORE &&
    SCORECARD_DIMENSIONS.every((d) => scores[d.key] >= MIN_ROW_SCORE)
      ? [{ code: "low_total", score: total }]
      : []),
  ];
}
