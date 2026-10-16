import { describe, expect, it } from "vitest";
import { suggestMinkFollowUps, MINK_FOLLOW_UP_LIMIT } from "./follow-ups";
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
