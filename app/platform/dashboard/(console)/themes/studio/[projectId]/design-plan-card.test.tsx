// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DesignPlan } from "@/lib/theme-studio/design-plan";
import type { DistinctnessReport } from "@/lib/theme-studio/fingerprint";
import { DesignPlanCard } from "./design-plan-card";

afterEach(cleanup);

const plan: DesignPlan = {
  version: 1,
  colours: {
    page: "#fbfaf7",
    surface: "#ffffff",
    ink: "#1f2a24",
    accent: "#2f5d50",
  },
  fontPairing: "editorial-fraunces",
  buttons: { shape: "pill", primary: "outline" },
  layout: {
    header: "centered",
    card: "quick_add",
    productDetail: "editorial",
    footer: "minimal",
    pageWidth: "narrow",
    gridColumnsDesktop: 3,
    cardHoverImage: true,
  },
  layoutSource: "catalogue",
  styling: ["Product names in the body face.", "Prices a size up."],
  setsApart: ["A pill outline button."],
};
const report = (
  publishFloor?: DistinctnessReport["publishFloor"],
): DistinctnessReport => ({
  version: 1,
  score: 0.6,
  threshold: 0.35,
  nearestThemeId: "vitrine",
  sharedAttributes: [],
  changedAxes: 5,
  status: "distinct",
  repairAttempted: false,
  ...(publishFloor ? { publishFloor } : {}),
});

describe("the design plan card", () => {
  it("shows what was decided: colours, fonts, buttons, layout and styling", () => {
    render(<DesignPlanCard plan={plan} distinctness={null} />);
    const card = screen.getByRole("region", { name: "Design plan" });
    expect(card).toHaveTextContent("Page #fbfaf7");
    expect(card).toHaveTextContent("Accent #2f5d50");
    expect(card).toHaveTextContent("Fraunces headings, Inter body");
    expect(card).toHaveTextContent("pill, outline");
    expect(card).toHaveTextContent(
      "centered header, quick add product card, editorial product page, minimal footer, narrow page width, 3 columns, second photo on hover.",
    );
    expect(card).toHaveTextContent(
      "The layout the catalogue uses least for this direction.",
    );
    expect(card).toHaveTextContent("Product names in the body face.");
    expect(card).toHaveTextContent("A pill outline button.");
    // Nothing was measured against the published themes: no claim that it was.
    expect(card).not.toHaveTextContent("Before any picture was drawn");
  });

  it("says where a layout read from screenshots came from, and shows none when none was decided", () => {
    render(
      <DesignPlanCard
        plan={{ ...plan, layoutSource: "reference" }}
        distinctness={null}
      />,
    );
    expect(screen.getByRole("region")).toHaveTextContent(
      "Read from the reference screenshots.",
    );
    cleanup();
    render(
      <DesignPlanCard
        plan={{ ...plan, layout: null, layoutSource: "none" }}
        distinctness={null}
      />,
    );
    expect(screen.getByRole("region")).not.toHaveTextContent("Layout");
  });

  it("★ says what the built design was measured against before any picture was drawn", () => {
    render(
      <DesignPlanCard
        plan={plan}
        distinctness={report({
          threshold: 0.5,
          nearestThemeId: "vitrine",
          nearestName: "Vitrine",
          score: 0.62,
        })}
      />,
    );
    expect(screen.getByRole("region")).toHaveTextContent(
      'The nearest is "Vitrine": this design is 62% different, and at least 50% is needed to publish.',
    );
  });
});
