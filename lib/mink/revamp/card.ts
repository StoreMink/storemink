import "server-only";

// ---------------------------------------------------------------------------
// The revamp's one review card: a private storefront personalisation draft
// that carries the whole stored plan (docs/mink-storefront-revamp.md). The
// runner calls this last, after every photo is drawn and every check ran, so
// the merchant is only ever shown a plan that is finished.
//
// ★ THE PLAN IS BOUND BY ITS DIGEST. Apply re-reads `plan_json` and compares
//   it with `plan_digest` (the same canonical-JSON digest the Builder
//   proposals use), so a stored plan edited between the card and the click
//   is refused rather than applied.
// ★ FREE IS DECIDED HERE, NOT BY THE CALLER'S ARITHMETIC. A free revamp, and a
//   paid one whose bill came to nothing, both become a free draft: asking the
//   charge function for zero credits would be a charge that is not one.
// ---------------------------------------------------------------------------

import { getMinkConfig } from "../config";
import { createMinkDraftProposal } from "../drafts";
import { MinkToolInputError } from "../errors";
import { imageCreditHeadroom } from "../image-credits";
import { digestMinkStorefrontValue } from "../storefront-code-contract";
import { REVAMP_LIMITS, type RevampStoredPlan } from "./contract";
import {
  RevampOutOfCreditsError,
  RevampStepError,
  type RevampStepContext,
} from "./ports";

export const REVAMP_CARD_TITLE = "Your redesigned storefront";
export const REVAMP_CARD_DESTINATION_LABEL = "Whole storefront";
export const REVAMP_CARD_DESTINATION_PATH = "/dashboard/builder";
/** The draft field's own ceiling (draft-types.ts, explanation). */
export const REVAMP_CARD_EXPLANATION_MAX = 1_000;

const FALLBACK_EXPLANATION =
  "Mink AI redesigned your storefront. Review every page before you apply it.";

export async function createRevampCard(
  ctx: RevampStepContext,
  input: { plan: RevampStoredPlan; free: boolean },
): Promise<{ draftId: string; credits: number }> {
  const total = paidTotal(input.plan);
  const free = input.free || total === 0;
  let artifact: Awaited<ReturnType<typeof createMinkDraftProposal>>;
  try {
    artifact = await createMinkDraftProposal({
      actor: ctx.actor,
      kind: "storefront_personalization",
      title: REVAMP_CARD_TITLE,
      destinationType: "storefront",
      // ★ No destination id, as for every personalisation draft: the table's
      //   storefront_personalization target CHECK requires it to be NULL
      //   (the whole storefront is the destination), and a store id here
      //   made every card insert fail, so no revamp could ever finish.
      destinationLabel: REVAMP_CARD_DESTINATION_LABEL,
      destinationPath: REVAMP_CARD_DESTINATION_PATH,
      content: {
        plan_json: JSON.stringify(input.plan),
        plan_digest: digestMinkStorefrontValue(input.plan),
        explanation: clipExplanation(input.plan.explanation),
      },
      ...(free ? { free: true } : { expectedCredits: total }),
      // ★ THE REVAMP'S OWN ID IS THE DRAFT'S ID, so a card step that runs
      //   twice (the finish failed, or the lease was lost after the card was
      //   made) finds the draft it already made and charges nothing again.
      //   Each refinement is its own revamp, so it still gets its own draft.
      draftId: ctx.revampId,
    });
  } catch (error) {
    // ★ A TOOL-INPUT ERROR IS A VERDICT, NOT A BLIP. Running the same draft
    //   again gives the same answer (no credits, no drafting, no run), so it
    //   ends the job rather than being retried until the attempts run out.
    //   The merchant-facing sentence comes from the closed code; the detail is
    //   for the logs and never names a number of credits.
    if (error instanceof MinkToolInputError) {
      // ★ A balance too small for the card is its own closed code, so the
      //   merchant reads that they ran out of credits and what to do about
      //   it, not "something went wrong".
      if (/enough mink credits/i.test(error.message)) {
        throw new RevampOutOfCreditsError("insufficient credits");
      }
      throw new RevampStepError(
        "internal",
        `card refused: ${error.message.slice(0, 200)}`,
        false,
      );
    }
    throw error;
  }
  if (artifact.type !== "proposal" || typeof artifact.draftId !== "string") {
    throw new RevampStepError("internal", "card draft has no id", false);
  }
  return {
    draftId: artifact.draftId,
    credits: free ? 0 : artifact.chargedCredits,
  };
}

/**
 * What the requester's store can still pay a card from right now, or null on
 * an unmetered plan. ★ The very read the start tool takes the budget from
 * (image-credits.ts, the plan cycle's allowance then top-ups), so the runner's
 * check before the photos and the start cannot disagree about what is left.
 */
export async function readRevampCreditBalance(
  ctx: RevampStepContext,
): Promise<number | null> {
  const headroom = await imageCreditHeadroom(
    ctx.actor,
    getMinkConfig().chargeCredits,
  );
  return headroom.remaining;
}

/**
 * What a paid revamp costs: the plan's own total, capped at the revamp
 * ceiling. ★ A malformed total is refused, never read as zero: zero means
 * free here, and a plan whose bill cannot be read must not be given away.
 */
function paidTotal(plan: RevampStoredPlan): number {
  const total = plan.credits?.total;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
    throw new RevampStepError("internal", "invalid credit total", false);
  }
  return Math.min(total, REVAMP_LIMITS.maxCredits);
}

/**
 * The explanation the card shows, within the draft field's limit. Normalised
 * the way the draft validator normalises it, so the clip is measured on the
 * text that is actually stored, and never split inside a surrogate pair.
 */
export function clipExplanation(value: unknown): string {
  const text = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (!text) return FALLBACK_EXPLANATION;
  if (text.length <= REVAMP_CARD_EXPLANATION_MAX) return text;
  let clipped = text.slice(0, REVAMP_CARD_EXPLANATION_MAX);
  const last = clipped.charCodeAt(clipped.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) clipped = clipped.slice(0, -1);
  return clipped.trimEnd();
}
