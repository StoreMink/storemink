import type { MinkArtifact } from "./types";

/**
 * Suggested follow-up questions under the newest answer.
 *
 * ★ DETERMINISTIC, FROM THE CARDS THE RUN PRODUCED. Asking the model for
 * follow-ups would spend tokens on every turn and put a second free-text
 * field into the prompt contract; the cards already say what kind of answer
 * this was (a sales figure, a catalogue list, a Help citation, a proposal),
 * and the natural next question follows from that. Three at most, no
 * duplicates, and nothing for a clarification card, whose choices are the
 * follow-up.
 */
export const MINK_FOLLOW_UP_LIMIT = 3;

export function suggestMinkFollowUps(input: {
  text: string;
  artifacts?: MinkArtifact[];
}): string[] {
  const artifacts = input.artifacts ?? [];
  if (artifacts.some((artifact) => artifact.type === "clarification")) {
    return [];
  }
  const suggestions: string[] = [];
  const add = (prompt: string) => {
    if (!suggestions.includes(prompt)) suggestions.push(prompt);
  };

  for (const artifact of artifacts) {
    switch (artifact.type) {
      case "metrics":
        add("Compare this with the previous period");
        add("Which products drove this?");
        add("Break this down by location");
        break;
      case "catalog":
        add("Which of these are low on stock?");
        add("Which of these are not published yet?");
        break;
      case "records":
        if (artifact.recordType === "order") {
          add("Which of these still need action?");
          add("Show me the ones waiting longest");
        } else if (artifact.recordType === "product") {
          add("Which of these are low on stock?");
          add("Draft a description for one of these");
        } else if (artifact.recordType === "offer") {
          add("Which offer is being used most?");
          add("Draft a coupon email for one of these");
        } else if (artifact.recordType === "blog") {
          add("Draft a new post on a similar topic");
        } else if (artifact.recordType === "inventory") {
          add("Draft a stock adjustment for one of these");
        } else {
          add("Tell me more about one of these");
        }
        break;
      case "sources":
        add("Show me the exact steps");
        add("Where is this in my dashboard?");
        break;
      case "proposal":
        if (
          artifact.draftKind === "product_description" ||
          artifact.draftKind === "blog" ||
          artifact.draftKind === "coupon_email" ||
          artifact.draftKind === "customer_message" ||
          (artifact.draftKind as string) === "social_post"
        ) {
          add("Make it shorter");
          add("Make the tone more playful");
        } else {
          add("Explain exactly what this will change");
        }
        break;
      case "storefront_layout_proposal":
      case "storefront_design_proposal":
      case "storefront_code_proposal":
      case "builder_proposal":
        add("Explain exactly what this will change");
        add("Show me a different option");
        break;
      case "media_image_proposal":
        add("Try a different style");
        add("Put this on my homepage");
        break;
      case "storefront_personalization_proposal":
        add("Explain exactly what this will change");
        add("What should I check before publishing?");
        break;
      case "navigation":
      case "workflow":
      case "product_import":
      case "chart":
        break;
    }
    if (suggestions.length >= MINK_FOLLOW_UP_LIMIT) break;
  }

  if (suggestions.length === 0) {
    const text = input.text.toLowerCase();
    if (/\bstock\b/.test(text)) add("Which locations are affected?");
    if (/\border/.test(text)) add("Which orders need action today?");
    if (/\bsales?\b|\brevenue\b/.test(text)) {
      add("Compare this with the previous period");
    }
    add("What should I do next?");
  }
  return suggestions.slice(0, MINK_FOLLOW_UP_LIMIT);
}
