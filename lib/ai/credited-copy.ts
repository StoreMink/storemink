import "server-only";

import { AI_UNAVAILABLE_MESSAGE, withoutNothingChargedClaim } from "./gemini";
import { consumeAiQuota, refundAiQuota } from "./quota";

// ---------------------------------------------------------------------------
// One Generate with AI request on a Mink credit: product descriptions and SEO,
// brand voice and coupon emails. The four actions each took a credit, asked
// the model and gave the credit back in their own try/finally, and each
// returned callGemini's message, which says nothing was charged, whether or
// not the refund had been written (robustness review of B1). They now share
// this one path.
//
// ★ A separate module from quota.ts on purpose: the actions' tests mock
//   quota.ts, and this file reaches it through the mocked exports, so the
//   tests still see exactly which take was refunded.
// ---------------------------------------------------------------------------

/** A generation that did not deliver: what the merchant is told. */
export interface AiCopyFailure {
  error: string;
}

/**
 * Takes the credit (the rates first, `consumeAiQuota`), runs `write`, and
 * gives the credit back on every way out that does not deliver the copy: a
 * failure `write` returns, or a throw (re-thrown after the refund).
 *
 * ★ WHAT THE MERCHANT IS TOLD MATCHES WHAT HAPPENED. Every message callGemini
 *   returns says nothing was charged; when the refund could not be written
 *   (refundAiQuota answered "failed", and logged it for an operator to grant
 *   back), the message loses that claim.
 */
export async function withAiCredit<T extends object>(
  scope: { storeId: string; actorId: string },
  write: () => Promise<T | AiCopyFailure>,
): Promise<T | AiCopyFailure> {
  const quota = await consumeAiQuota(scope.storeId, {
    actorId: scope.actorId,
  });
  if (!quota.allowed) {
    return { error: quota.error ?? AI_UNAVAILABLE_MESSAGE };
  }
  let outcome: T | AiCopyFailure;
  try {
    outcome = await write();
  } catch (error) {
    await refundAiQuota(scope.storeId, quota.taken);
    throw error;
  }
  if (!isFailure(outcome)) return outcome;
  const refund = await refundAiQuota(scope.storeId, quota.taken);
  return {
    error:
      refund === "failed"
        ? withoutNothingChargedClaim(outcome.error)
        : outcome.error,
  };
}

function isFailure(value: object): value is AiCopyFailure {
  return typeof (value as { error?: unknown }).error === "string";
}
