import { describe, expect, it } from "vitest";
import {
  MINK_REVAMP_REFINE_PROMPTS,
  suggestMinkFollowUps,
  MINK_FOLLOW_UP_LIMIT,
} from "./follow-ups";
import type { MinkArtifact } from "./types";

const metrics: MinkArtifact = {
  type: "metrics",
  title: "Sales",
  metrics: [],
  filters: [],
};

describe("suggestMinkFollowUps", () => {
  it("follows the card the run produced, three at most and never repeated", () => {
    const prompts = suggestMinkFollowUps({
      text: "Sales are up.",
      artifacts: [metrics, metrics],
    });
    expect(prompts).toEqual([
      "Compare this with the previous period",
      "Which products drove this?",
      "Break this down by location",
    ]);
    expect(prompts.length).toBeLessThanOrEqual(MINK_FOLLOW_UP_LIMIT);
  });

  it("asks for a tone change on a text draft and an explanation on a structured one", () => {
    const draft = (draftKind: string) =>
      ({
        type: "proposal",
        draftId: "d",
        draftKind,
        title: "t",
        destinationLabel: "l",
        destinationPath: "/dashboard",
        before: [],
        after: [],
        content: {},
        status: "draft",
        currentVersion: 0,
        expectedCredits: 1,
        chargedCredits: 1,
        creditSource: "plan",
      }) as unknown as MinkArtifact;
    expect(
      suggestMinkFollowUps({ text: "", artifacts: [draft("blog")] }),
    ).toEqual(["Make it shorter", "Make the tone more playful"]);
    expect(
      suggestMinkFollowUps({ text: "", artifacts: [draft("coupon_create")] }),
    ).toEqual(["Explain exactly what this will change"]);
  });

  const revamp = (status: string) =>
    ({
      type: "storefront_revamp",
      revampId: "00000000-0000-4000-8000-000000000001",
      kind: "full",
      status,
    }) as unknown as MinkArtifact;

  it("offers a finished revamp's refinements, phrased as the merchant would ask", () => {
    expect(
      suggestMinkFollowUps({
        text: "Your redesign is ready.",
        artifacts: [revamp("ready")],
      }),
    ).toEqual([...MINK_REVAMP_REFINE_PROMPTS]);
    expect(MINK_REVAMP_REFINE_PROMPTS).toEqual([
      "Make the colours warmer",
      "Redo the opening photo",
      "Add my products",
    ]);
  });

  it.each(["queued", "running"])(
    "★★ suggests nothing under a redesign that is still being made (%s), which nothing can refine yet (chat-8)",
    (status) => {
      // Tapped during the build, "Make the colours warmer" was routed to the
      // Builder's own design change, which then collided with the redesign.
      expect(
        suggestMinkFollowUps({
          text: "The redesign has started and the card shows its progress.",
          artifacts: [revamp(status)],
        }),
      ).toEqual([]);
    },
  );

  it("stays silent when the run is asking a question, and falls back to the answer's words", () => {
    expect(
      suggestMinkFollowUps({
        text: "Which location?",
        artifacts: [
          {
            type: "clarification",
            title: "t",
            question: "Which?",
            choices: [{ label: "A", prompt: "A" }],
          },
        ],
      }),
    ).toEqual([]);
    expect(
      suggestMinkFollowUps({ text: "Two SKUs are low on stock." }),
    ).toEqual(["Which locations are affected?", "What should I do next?"]);
    expect(suggestMinkFollowUps({ text: "Hello" })).toEqual([
      "What should I do next?",
    ]);
  });
});
