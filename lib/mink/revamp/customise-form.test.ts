import { describe, expect, it } from "vitest";
import { routeMinkTools, toolsForRoute } from "@/lib/mink/tool-routing";
import {
  CUSTOMISE_FORM_LIMITS,
  customiseFormProblem,
  customiseStorefrontMessage,
  EMPTY_CUSTOMISE_ANSWERS,
} from "./customise-form";

const FULL = {
  business: "Cold-pressed mustard oil for families who cook at home",
  look: "Warm and earthy, like a village kitchen",
  facts: "Pressed in our own mill in Faridkot\nSold since 1998",
  avoid: "Bright pink",
};

describe("customiseFormProblem", () => {
  it("needs what the store sells", () => {
    expect(customiseFormProblem(EMPTY_CUSTOMISE_ANSWERS)).toBe(
      "Tell Mink AI what you sell and who buys it.",
    );
    expect(
      customiseFormProblem({ ...EMPTY_CUSTOMISE_ANSWERS, business: "   " }),
    ).not.toBeNull();
    expect(customiseFormProblem(FULL)).toBeNull();
  });

  it("the other answers are optional", () => {
    expect(
      customiseFormProblem({
        ...EMPTY_CUSTOMISE_ANSWERS,
        business: FULL.business,
      }),
    ).toBeNull();
  });
});

describe("customiseStorefrontMessage", () => {
  it("★ carries every answer and asks Mink AI to start without questions", () => {
    const message = customiseStorefrontMessage(FULL);
    expect(message).toContain(
      "Please start the redesign now without asking me more questions.",
    );
    expect(message).toContain(
      "What I sell and who buys it: Cold-pressed mustard oil for families who cook at home",
    );
    expect(message).toContain(
      "The look and feel I want: Warm and earthy, like a village kitchen",
    );
    expect(message).toContain(
      "Facts about my business:\nPressed in our own mill in Faridkot\nSold since 1998",
    );
    expect(message).toContain("Please avoid: Bright pink");
    // The one question the revamp rule would still ask is answered.
    expect(message).toContain("keep my product categories as they are");
  });

  it("leaves out empty optional answers", () => {
    const message = customiseStorefrontMessage({
      ...EMPTY_CUSTOMISE_ANSWERS,
      business: FULL.business,
    });
    expect(message).not.toMatch(/look and feel|Facts about|Please avoid/);
  });

  it("tidies spacing and never goes over an answer's limit", () => {
    const message = customiseStorefrontMessage({
      ...EMPTY_CUSTOMISE_ANSWERS,
      business: `  ${"a".repeat(CUSTOMISE_FORM_LIMITS.business + 50)}  `,
      facts: "One\r\n\r\n\r\n\r\nTwo   three",
    });
    const business = message
      .split("\n")
      .find((line) => line.startsWith("What I sell"))!;
    expect(business).toBe(
      `What I sell and who buys it: ${"a".repeat(CUSTOMISE_FORM_LIMITS.business)}`,
    );
    expect(message).toContain("Facts about my business:\nOne\n\nTwo three");
  });

  it("★★ reaches the redesign tools, so the chat can start the redesign", () => {
    const route = routeMinkTools({ message: customiseStorefrontMessage(FULL) });
    expect(route.groups).toContain("revamp");
    expect(route.wantsChange).toBe(true);
    const names = toolsForRoute(route);
    expect(names?.has("get_storefront_revamp_context")).toBe(true);
    expect(names?.has("start_storefront_revamp")).toBe(true);
  });

  it("has no long dash", () => {
    expect(customiseStorefrontMessage(FULL)).not.toMatch(/[–—]/);
  });
});
