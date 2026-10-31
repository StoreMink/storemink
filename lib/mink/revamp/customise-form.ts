// ---------------------------------------------------------------------------
// The Storefront page's "Customise storefront" form (owner, 31 Oct 2026): what
// it asks the merchant, how long each answer may be, and the ONE chat message
// it hands to Mink AI, which then starts the redesign.
//
// Pure and client-safe: the dialog validates and builds the message with it,
// and its tests pin that the message reaches the redesign tools.
//
// ★ A SHORTCUT INTO THE CHAT, NEVER A SECOND WAY TO START A REDESIGN. The
// message goes through an ordinary Mink run, so the actor, permissions,
// credits, the one-redesign-at-a-time rule and the review card are the chat's
// own, and Mink AI still writes the brief from the merchant's words. The
// prompt's revamp rule starts without asking once the merchant has said
// enough; the message says so, and keeps the categories as they are, the one
// question that rule would otherwise still ask.
// ---------------------------------------------------------------------------

export interface CustomiseStorefrontAnswers {
  /** What the store sells and who buys it. Required. */
  business: string;
  /** The look and feeling the merchant wants. */
  look: string;
  /** True statements to use: where they are, how things are made. */
  facts: string;
  /** Anything the redesign must not do. */
  avoid: string;
}

/**
 * The most each answer may hold, within what the redesign's brief takes
 * (start_storefront_revamp: business 600, look 400, avoid 300, 15 facts of
 * 200), so nothing the merchant writes is cut off later.
 */
export const CUSTOMISE_FORM_LIMITS = {
  business: 600,
  look: 400,
  facts: 1500,
  avoid: 300,
} as const satisfies Record<keyof CustomiseStorefrontAnswers, number>;

export const EMPTY_CUSTOMISE_ANSWERS: CustomiseStorefrontAnswers = {
  business: "",
  look: "",
  facts: "",
  avoid: "",
};

/** One answer as the message carries it: tidy spacing, never over its limit. */
function clean(value: string, max: number): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max)
    .trim();
}

/** Why the form cannot be sent yet, or null when it can. */
export function customiseFormProblem(
  answers: CustomiseStorefrontAnswers,
): string | null {
  if (clean(answers.business, CUSTOMISE_FORM_LIMITS.business).length < 3) {
    return "Tell Mink AI what you sell and who buys it.";
  }
  return null;
}

/** A labelled answer: on the same line, or under its label when it has lines. */
function answerLine(label: string, value: string): string {
  return value.includes("\n") ? `${label}:\n${value}` : `${label}: ${value}`;
}

/** The chat message the form sends. Empty optional answers are left out. */
export function customiseStorefrontMessage(
  answers: CustomiseStorefrontAnswers,
): string {
  const business = clean(answers.business, CUSTOMISE_FORM_LIMITS.business);
  const look = clean(answers.look, CUSTOMISE_FORM_LIMITS.look);
  const facts = clean(answers.facts, CUSTOMISE_FORM_LIMITS.facts);
  const avoid = clean(answers.avoid, CUSTOMISE_FORM_LIMITS.avoid);

  const lines = [
    "Customise my storefront for my business, using my answers from the Customise storefront form. Please start the redesign now without asking me more questions.",
    "",
    answerLine("What I sell and who buys it", business),
  ];
  if (look) lines.push(answerLine("The look and feel I want", look));
  if (facts) lines.push(answerLine("Facts about my business", facts));
  if (avoid) lines.push(answerLine("Please avoid", avoid));
  lines.push(
    "",
    "Use the products already in my store, and keep my product categories as they are.",
  );
  return lines.join("\n");
}
