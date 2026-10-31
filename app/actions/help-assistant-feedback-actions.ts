"use server";

// A Help Centre visitor's thumbs up or down on one Mink AI answer. Public by
// design (Help visitors are anonymous), so the input is bounded by
// normalizeHelpFeedback, the caller is rate-limited by address, and the only
// thing it can do is record, change or clear a rating on the answer it names.

import { headers } from "next/headers";
import {
  normalizeHelpFeedback,
  saveHelpFeedback,
} from "@/lib/help/assistant-feedback";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { logError } from "@/lib/observability/logger";
import { loggableError } from "@/lib/db/errors";

export type RateHelpAnswerResult = { ok: true } | { ok: false; error: string };

export async function rateHelpAnswer(
  input: unknown,
): Promise<RateHelpAnswerResult> {
  const parsed = normalizeHelpFeedback(input);
  if (!parsed.ok) return parsed;

  const { allowed } = await rateLimit(
    `help:feedback:${clientIp(await headers())}`,
    { max: 60, windowSeconds: 3600 },
  );
  if (!allowed) {
    return {
      ok: false,
      error: "Too many ratings for now. Please try again later.",
    };
  }

  try {
    await saveHelpFeedback(parsed.value);
    return { ok: true };
  } catch (error) {
    // loggableError: a failed query's own message carries its params, which
    // here are the visitor's question and Mink AI's answer.
    logError("help.feedback.save_failed", loggableError(error));
    return { ok: false, error: "That rating couldn't be saved." };
  }
}
