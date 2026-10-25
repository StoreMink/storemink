import { describe, expect, it } from "vitest";
import * as scorecard from "./scorecard";
import {
  REJECTION_CONDITIONS,
  SCORECARD_DIMENSIONS,
  SERIOUS_SCORE_LIMITS,
  scorecardClearsBar,
  scorecardWarnings,
  seriousScorecardFindings,
  type Scores,
} from "./scorecard";

const fives = (): Scores =>
  Object.fromEntries(SCORECARD_DIMENSIONS.map((d) => [d.key, 5])) as Scores;

describe("the design review's scorecard", () => {
  it("keeps the eight rows the review is built from, without the old database columns", () => {
    expect(SCORECARD_DIMENSIONS.map((d) => d.key)).toEqual([
      "artDirection",
      "distinctness",
      "commerceClarity",
      "typography",
      "imagery",
      "responsiveComposition",
      "detailQuality",
      "brandAdaptability",
    ]);
    for (const row of SCORECARD_DIMENSIONS) {
      expect(Object.keys(row).sort()).toEqual(["key", "label", "question"]);
    }
  });

  it("carries no second-reviewer remnants (section 2 of the plan)", () => {
    for (const gone of [
      "REVIEWER_ROLES",
      "REJECT_NOTE_MIN",
      "REVIEW_NOTE_MAX",
      "scorecardAverage",
    ])
      expect(scorecard).not.toHaveProperty(gone);
    expect(scorecard).toHaveProperty("scorecardClearsBar");
  });

  it("marks exactly the owner's serious rejections serious (decision 2: copied blocks)", () => {
    expect(
      REJECTION_CONDITIONS.filter((c) => c.serious).map((c) => c.key),
    ).toEqual([
      "copied",
      "unfinished_surface",
      "placeholder_copy",
      "inaccessible_copy",
      "unsupported_claim",
    ]);
    expect(
      REJECTION_CONDITIONS.filter((c) => !c.serious).map((c) => c.key),
    ).toEqual(["palette_only", "generic_surface", "needs_custom_code"]);
    // generic_surface was split: the unfinished half is its own condition.
    const generic = REJECTION_CONDITIONS.find(
      (c) => c.key === "generic_surface",
    )!;
    expect(generic.label).not.toMatch(/unfinished/);
  });

  it("decision 3: below 3 on shopping clarity, phone layout and brand fit; 2 or below on typography and detail quality", () => {
    expect(SERIOUS_SCORE_LIMITS).toEqual({
      commerceClarity: 2,
      responsiveComposition: 2,
      brandAdaptability: 2,
      typography: 2,
      detailQuality: 2,
    });
    for (const row of SCORECARD_DIMENSIONS) {
      for (const score of [1, 2, 3, 4, 5]) {
        const scores = { ...fives(), [row.key]: score };
        const serious = seriousScorecardFindings(scores, []);
        const limit = SERIOUS_SCORE_LIMITS[row.key];
        expect(serious.length > 0).toBe(limit !== undefined && score <= limit);
      }
    }
  });

  it("everything under the bar that is not serious is a warning, never both", () => {
    const scores = {
      ...fives(),
      artDirection: 3,
      commerceClarity: 2,
      typography: 3,
    };
    expect(seriousScorecardFindings(scores, ["generic_surface"])).toEqual([
      { code: "very_low_score", row: "commerceClarity", score: 2 },
    ]);
    expect(scorecardWarnings(scores, ["generic_surface"])).toEqual([
      { code: "generic_surface" },
      { code: "low_score", row: "artDirection", score: 3 },
      { code: "low_score", row: "typography", score: 3 },
    ]);
    // Every row at 4 is still under the 34 total: a warning.
    const fours = Object.fromEntries(
      SCORECARD_DIMENSIONS.map((d) => [d.key, 4]),
    ) as Scores;
    expect(scorecardWarnings(fours, [])).toEqual([
      { code: "low_total", score: 32 },
    ]);
    expect(scorecardClearsBar(fours, [])).toBe(false);
    expect(scorecardWarnings(fives(), [])).toEqual([]);
    expect(seriousScorecardFindings(fives(), [])).toEqual([]);
    expect(scorecardClearsBar(fives(), [])).toBe(true);
  });
});
