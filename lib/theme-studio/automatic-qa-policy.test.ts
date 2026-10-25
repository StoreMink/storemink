import { describe, expect, it } from "vitest";
import {
  MAX_AUTOMATIC_QA_REPAIRS,
  automaticQaAttention,
  automaticQaDecision,
  automaticAcceptanceFailures,
  type AutomaticQaReview,
} from "./automatic-qa-policy";
import {
  acceptanceOutcome,
  gate,
  GATE_LABELS,
  type GateFinding,
  type GateId,
  type GateResult,
} from "./acceptance-gates";

const PASS: AutomaticQaReview = { outcome: "pass" };
const TASTE: AutomaticQaReview = { outcome: "taste" };
const SERIOUS: AutomaticQaReview = { outcome: "serious" };
const REVIEWS = [PASS, TASTE, SERIOUS, null] as const;

const passing = () =>
  (Object.keys(GATE_LABELS) as GateId[]).map((id) =>
    gate(id, [], { required: id !== "browser.performance" }),
  );
const withGate = (gates: GateResult[], replacement: GateResult) =>
  gates.map((g) => (g.id === replacement.id ? replacement : g));
const failing = (
  id: GateId,
  code = "quality",
  extra: Partial<GateFinding> = {},
) =>
  withGate(
    passing(),
    gate(id, [
      { code, where: "phone360 · home", message: "Fix this", ...extra },
    ]),
  );

describe("automatic completion policy", () => {
  it("sends a check that could not finish to attention, never a paid revision", () => {
    for (const id of ["routes.render", "routes.links"] as const) {
      for (const code of ["budget", "timeout"]) {
        expect(automaticQaDecision(failing(id, code), PASS, 0)).toBe(
          "attention",
        );
      }
    }
    expect(
      automaticQaDecision(
        withGate(passing(), gate("routes.links", [], { status: "skipped" })),
        PASS,
        0,
      ),
    ).toBe("attention");
    expect(
      automaticQaDecision(
        withGate(
          passing(),
          gate("browser.performance", [{ code: "unmeasured", message: "x" }], {
            required: true,
          }),
        ),
        PASS,
        0,
      ),
    ).toBe("attention");
    // An ordinary broken link at the first iteration is still repaired.
    expect(
      automaticQaDecision(failing("routes.links", "broken"), PASS, 0),
    ).toBe("revise");
  });

  it("requires every acceptance gate and a design review", () => {
    expect(automaticQaDecision(passing(), PASS, 0)).toBe("pass");
    expect(automaticQaDecision(passing(), TASTE, 0)).toBe("revise");
    expect(automaticQaDecision(passing(), SERIOUS, 0)).toBe("revise");
    expect(automaticQaDecision([], PASS, 0)).toBe("attention");
    expect(automaticQaDecision(passing().slice(1), PASS, 0)).toBe("attention");
  });

  it("never passes without a review, and no revision can supply one", () => {
    for (
      let iteration = 0;
      iteration <= MAX_AUTOMATIC_QA_REPAIRS;
      iteration++
    ) {
      expect(automaticQaDecision(passing(), null, iteration)).toBe("attention");
    }
    // A caller still passing today's yes or no counts as no review.
    for (const stale of [true, false, {}, { outcome: "great" }, "pass"]) {
      expect(
        automaticQaDecision(
          passing(),
          stale as unknown as AutomaticQaReview,
          0,
        ),
        JSON.stringify(stale),
      ).toBe("attention");
    }
    // With serious gate failures the gates are repaired first, as today.
    expect(automaticQaDecision(failing("browser.overflow"), null, 0)).toBe(
      "revise",
    );
  });

  it("repairs serious findings even when the review passes, and stops after the bounded budget", () => {
    expect(automaticQaDecision(failing("browser.accessibility"), PASS, 0)).toBe(
      "revise",
    );
    expect(automaticQaDecision(failing("package.design"), PASS, 1)).toBe(
      "revise",
    );
    // Three repairs: iterations 0, 1 and 2 still revise; 3 is the last check.
    expect(automaticQaDecision(failing("browser.accessibility"), PASS, 2)).toBe(
      "revise",
    );
    expect(automaticQaDecision(failing("browser.accessibility"), PASS, 3)).toBe(
      "attention",
    );
    expect(automaticQaDecision(passing(), PASS, 3)).toBe("pass");
    expect(
      automaticAcceptanceFailures(failing("browser.accessibility"))[0],
    ).toContain("phone360 · home: Fix this");
  });

  it("turns taste into warnings once the repairs are used up, and keeps a serious review a problem", () => {
    expect(automaticQaDecision(passing(), TASTE, 2)).toBe("revise");
    expect(automaticQaDecision(passing(), TASTE, 3)).toBe("pass");
    expect(automaticQaDecision(passing(), SERIOUS, 2)).toBe("revise");
    expect(automaticQaDecision(passing(), SERIOUS, 3)).toBe("attention");
  });

  it("never asks for a revision at the repair ceiling, whatever the gates and the review (the re-check contract)", () => {
    const gateSets = [
      passing(),
      failing("browser.overflow", "horizontal_overflow"),
      failing("browser.tap_targets", "small_target"),
      failing("routes.render", "indexable"),
      failing("package.security", "markup"),
      failing("routes.render", "timeout"),
      passing().slice(1),
    ];
    for (const iteration of [MAX_AUTOMATIC_QA_REPAIRS, 4]) {
      for (const gates of gateSets) {
        for (const review of REVIEWS) {
          for (const phase of ["layout", "final"] as const) {
            expect(
              automaticQaDecision(gates, review, iteration, phase),
            ).not.toBe("revise");
          }
        }
      }
    }
  });

  it("lets no review overrule a serious gate", () => {
    for (const review of REVIEWS) {
      for (let iteration = 0; iteration <= 4; iteration++) {
        expect(
          automaticQaDecision(failing("browser.overflow"), review, iteration),
        ).not.toBe("pass");
      }
    }
  });

  it("blocks security and stops unrepairable runtime faults without requesting paid redesigns", () => {
    for (const review of REVIEWS) {
      expect(automaticQaDecision(failing("package.security"), review, 0)).toBe(
        "blocked",
      );
    }
    for (const code of ["fetch", "unthemed", "token"]) {
      expect(automaticQaDecision(failing("routes.render", code), PASS, 0)).toBe(
        "attention",
      );
    }
    expect(automaticQaDecision(failing("browser.coverage"), PASS, 0)).toBe(
      "attention",
    );
    expect(automaticQaDecision(failing("demo.materialize"), PASS, 0)).toBe(
      "attention",
    );
    expect(
      automaticQaDecision(failing("assets.integrity", "missing"), PASS, 0),
    ).toBe("attention");
  });

  it("lets warnings through without a paid revision or a stop", () => {
    const warnings: [GateId, string, Partial<GateFinding>?][] = [
      ["browser.tap_targets", "small_target"],
      ["browser.image_crops", "extreme_crop"],
      ["browser.clipped_text", "clipped_text", { clipped: { x: 2, y: 0 } }],
      // A missing noindex used to end at attention; it is StoreMink's
      // markup, a warning plus an alert.
      ["routes.render", "indexable"],
      ["routes.markup", "lang"],
      ["routes.markup", "img_alt"],
      ["assets.integrity", "unused"],
      ["assets.integrity", "over_budget"],
      ["assets.integrity", "below_target"],
    ];
    for (const [id, code, extra] of warnings) {
      const gates = failing(id, code, extra);
      expect(automaticQaDecision(gates, PASS, 0), `${id} ${code}`).toBe("pass");
      expect(automaticQaDecision(gates, TASTE, 3), `${id} ${code}`).toBe(
        "pass",
      );
      expect(automaticAcceptanceFailures(gates), `${id} ${code}`).toEqual([]);
    }
  });

  it("agrees with the stored acceptance outcome, so a pass is never a mismatch", () => {
    const gateSets = [
      passing(),
      failing("browser.overflow"),
      failing("browser.tap_targets", "small_target"),
      failing("routes.render", "indexable"),
      failing("browser.accessibility", "region", { impact: "moderate" }),
      failing("browser.accessibility", "region", { impact: null }),
      failing("browser.clipped_text", "clipped_text", {
        clipped: { x: 9, y: 0 },
      }),
      withGate(passing(), gate("routes.markup", [], { status: "skipped" })),
    ];
    for (const gates of gateSets) {
      expect(automaticQaDecision(gates, PASS, 0) === "pass").toBe(
        acceptanceOutcome(gates) === "pass",
      );
    }
  });

  it("requires all browser gates for the layout check, which no review joins", () => {
    const layout = passing().filter((g) => g.id.startsWith("browser."));
    expect(automaticQaDecision(layout, PASS, 0, "layout")).toBe("pass");
    // No review runs at layout: none is needed and none is consulted.
    expect(automaticQaDecision(layout, null, 0, "layout")).toBe("pass");
    expect(automaticQaDecision(layout, SERIOUS, 0, "layout")).toBe("pass");
    expect(automaticQaDecision(layout, PASS, 0, "final")).toBe("attention");
    expect(automaticQaDecision(layout.slice(1), PASS, 0, "layout")).toBe(
      "attention",
    );
    const crop = layout.map((g) =>
      g.id === "browser.image_crops"
        ? gate(g.id, [{ code: "extreme_crop", message: "24% retained" }])
        : g,
    );
    // A tight crop is a warning: the layout passes and photos follow.
    expect(automaticQaDecision(crop, null, 3, "layout")).toBe("pass");
    const overflow = layout.map((g) =>
      g.id === "browser.overflow"
        ? gate(g.id, [{ code: "horizontal_overflow", message: "40px wider" }])
        : g,
    );
    expect(automaticQaDecision(overflow, null, 0, "layout")).toBe("revise");
    expect(automaticQaDecision(overflow, null, 3, "layout")).toBe("attention");
  });

  it("keeps performance advisory, and serious once a deployment requires it", () => {
    const advisory = withGate(
      passing(),
      gate("browser.performance", [{ code: "slow", message: "Slow" }], {
        required: false,
      }),
    );
    expect(automaticQaDecision(advisory, PASS, 0)).toBe("pass");
    const required = withGate(
      passing(),
      gate(
        "browser.performance",
        [{ code: "lcp", message: "LCP 4216ms", severity: "serious" }],
        { required: true },
      ),
    );
    expect(automaticQaDecision(required, PASS, 0)).toBe("revise");
  });

  it("lists only the serious findings of the gates that stop the run", () => {
    const gates = withGate(
      passing(),
      gate("routes.markup", [
        { code: "lang", message: "The page has no language.", where: "/" },
        {
          code: "external_resource",
          message: "Loads https://cdn.example/x.js from another origin.",
          where: "/",
        },
      ]),
    );
    expect(automaticAcceptanceFailures(gates)).toEqual([
      "Rendered markup: /: Loads https://cdn.example/x.js from another origin.",
    ]);
    expect(
      automaticAcceptanceFailures(
        withGate(passing(), gate("routes.links", [], { status: "skipped" })),
      ),
    ).toEqual(["Navigation links: not passed"]);
    expect(automaticAcceptanceFailures(passing())).toEqual([]);
  });

  it("says why it stopped for attention: a check that could not finish, a broken preview, or a serious finding left", () => {
    const ceiling = MAX_AUTOMATIC_QA_REPAIRS;
    // Could not finish: a page timed out, was never measured, or a check
    // was skipped; a missing gate; no design review at all.
    for (const gates of [
      failing("browser.coverage", "timeout"),
      failing("browser.coverage", "missing"),
      failing("routes.render", "budget"),
      withGate(passing(), gate("routes.links", [], { status: "skipped" })),
      passing().filter((g) => g.id !== "browser.media"),
    ]) {
      for (const iteration of [0, ceiling]) {
        expect(automaticQaDecision(gates, PASS, iteration)).toBe("attention");
        expect(automaticQaAttention(gates, PASS, iteration)).toBe("unfinished");
      }
    }
    expect(automaticQaAttention(passing(), null, ceiling)).toBe("unfinished");
    // StoreMink's preview did not work.
    for (const gates of [
      failing("demo.materialize", "seed_failed"),
      failing("routes.render", "unthemed"),
      failing("assets.integrity", "missing"),
      failing("browser.coverage", "state_stuck"),
    ]) {
      expect(automaticQaAttention(gates, PASS, ceiling)).toBe("runtime");
    }
    // A serious finding left at the ceiling: a theme change can fix it.
    expect(
      automaticQaAttention(
        failing("browser.overflow", "horizontal_overflow"),
        PASS,
        ceiling,
      ),
    ).toBe("serious");
    expect(automaticQaAttention(passing(), SERIOUS, ceiling)).toBe("serious");
    // Not attention at all: nothing to explain.
    expect(
      automaticQaAttention(
        failing("browser.overflow", "horizontal_overflow"),
        PASS,
        0,
      ),
    ).toBeNull();
    expect(automaticQaAttention(passing(), PASS, 0)).toBeNull();
    expect(automaticQaAttention(passing(), TASTE, ceiling)).toBeNull();
    expect(
      automaticQaAttention(failing("package.security", "script"), PASS, 0),
    ).toBeNull();
  });
});
