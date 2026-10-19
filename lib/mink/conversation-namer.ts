import "server-only";

// ---------------------------------------------------------------------------
// ★★ A NEW CHAT IS NAMED BY A MODEL, THE WAY CHATGPT, CLAUDE AND SIDEKICK
// NAME ONE. The stream route starts this the moment a run creates a chat, in
// parallel with the answer, and sends the title as a `title` event; the chat
// says "New chat" until it lands. The rules for the words are in
// conversation-title.ts (pure); this file is the model call and the save.
//
// ★ NEVER IN THE ANSWER'S WAY: one small call to the lite model with low
// thinking (about a second, measured on storemink-staging), its own deadline,
// one retry when the provider was busy, and every failure kept quiet. A chat
// that cannot be named keeps its provisional title, a short excerpt of the
// merchant's words, and the answer is never delayed or refused for it.
//
// ★ STOREMINK'S COST, NOT THE MERCHANT'S: no Mink credits, no usage-ledger
// row. A title is a few hundred tokens on the cheapest model; the log line
// carries the token counts so the spend stays visible.
// ---------------------------------------------------------------------------

import { FinishReason, GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { MinkConfig } from "./config";
import {
  MINK_TITLE_INSTRUCTION,
  minkTitleInput,
  minkTitlePrompt,
  normalizeMinkConversationTitle,
} from "./conversation-title";
import { renameMinkConversation } from "./persistence";
import { isRetryableProviderError, MinkStallError } from "./retry";
import type { MinkActorContext } from "./types";
import { logInfo, logWarn } from "@/lib/observability/logger";

/** One attempt never takes longer than this. */
const TITLE_ATTEMPT_MS = 8_000;
/** A busy or silent first attempt is asked once more, after this pause. */
const TITLE_RETRY_DELAY_MS = 500;
/** Room for low thinking as well as the few words of a title. */
const TITLE_MAX_OUTPUT_TOKENS = 512;

type TitleConfig = Pick<MinkConfig, "projectId" | "location" | "liteModel">;

export type MinkTitleOutcome =
  | "named"
  // No words to name it by (attachments only), or Vertex is not configured.
  | "skipped"
  // The model answered with something that is not a title.
  | "unusable"
  | "failed";

export interface MinkGeneratedTitle {
  title: string | null;
  outcome: MinkTitleOutcome;
  attempts: number;
  /** Content-free: the reason a failed call gave up, for the log line. */
  reason?: string;
  usage?: { promptTokens: number; outputTokens: number; thoughtTokens: number };
}

// One client per project and location for the life of the process: each
// keeps its own cached access token.
const clients = new Map<string, GoogleGenAI>();
function clientFor(project: string, location: string): GoogleGenAI {
  const key = `${project}:${location}`;
  let client = clients.get(key);
  if (!client) {
    client = new GoogleGenAI({
      enterprise: true,
      project,
      location,
      apiVersion: "v1",
      // The retry below is ours, so the SDK makes exactly one attempt.
      httpOptions: { retryOptions: { attempts: 1 } },
    });
    clients.set(key, client);
  }
  return client;
}

/** The title a model gives the chat that starts with `message`. Never throws. */
export async function generateMinkConversationTitle(input: {
  config: TitleConfig;
  message: string;
}): Promise<MinkGeneratedTitle> {
  const titleInput = minkTitleInput(input.message);
  // A message that is only attachments keeps its "Photo" or "Document" name:
  // the model would only be guessing at files it cannot see.
  if (!titleInput.words || !input.config.projectId)
    return { title: null, outcome: "skipped", attempts: 0 };
  const ai = clientFor(input.config.projectId, input.config.location);
  const prompt = minkTitlePrompt(titleInput);

  let attempts = 0;
  let lastError: unknown = null;
  while (attempts < 2) {
    if (attempts > 0) await delay(TITLE_RETRY_DELAY_MS);
    attempts += 1;
    try {
      const response = await withDeadline(TITLE_ATTEMPT_MS, (abortSignal) =>
        ai.models.generateContent({
          model: input.config.liteModel,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: {
            systemInstruction: MINK_TITLE_INSTRUCTION,
            maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
            temperature: 0.2,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            abortSignal,
          },
        }),
      );
      const usage = {
        promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        thoughtTokens: response.usageMetadata?.thoughtsTokenCount ?? 0,
      };
      // A reply cut off or blocked is not a title, however it reads.
      const finished =
        response.candidates?.[0]?.finishReason === FinishReason.STOP;
      const title = finished
        ? normalizeMinkConversationTitle(response.text)
        : null;
      return title
        ? { title, outcome: "named", attempts, usage }
        : {
            title: null,
            outcome: "unusable",
            attempts,
            reason: finished
              ? "not_a_title"
              : String(
                  response.candidates?.[0]?.finishReason ?? "no_candidate",
                ),
            usage,
          };
    } catch (error) {
      lastError = error;
      if (!isRetryableProviderError(error)) break;
    }
  }
  return {
    title: null,
    outcome: "failed",
    attempts,
    reason: failureReason(lastError),
  };
}

/**
 * Names the chat a run has just created and saves the title. Resolves with
 * the title now on the chat, or null when it keeps its provisional one.
 * Never throws: naming is never a reason for a run to fail.
 */
export async function nameMinkConversation(input: {
  config: TitleConfig;
  actor: Pick<MinkActorContext, "storeId" | "adminId" | "requestId">;
  conversationId: string;
  provisionalTitle: string;
  message: string;
}): Promise<string | null> {
  const startedAt = Date.now();
  const context = {
    requestId: input.actor.requestId,
    storeId: input.actor.storeId,
    model: input.config.liteModel,
  };
  try {
    const generated = await generateMinkConversationTitle({
      config: input.config,
      message: input.message,
    });
    const tokens = generated.usage ?? {};
    if (!generated.title) {
      if (generated.outcome !== "skipped")
        logWarn("mink.title: kept provisional", {
          ...context,
          outcome: generated.outcome,
          reason: generated.reason,
          attempts: generated.attempts,
          ms: Date.now() - startedAt,
          ...tokens,
        });
      return null;
    }
    if (generated.title !== input.provisionalTitle) {
      const renamed = await renameMinkConversation({
        actor: input.actor,
        conversationId: input.conversationId,
        from: input.provisionalTitle,
        to: generated.title,
      });
      // Deleted, or renamed some other way, while the model was writing.
      if (!renamed) return null;
    }
    // Content-free, like every Mink log line: a title quotes the merchant.
    logInfo("mink.title: named", {
      ...context,
      attempts: generated.attempts,
      ms: Date.now() - startedAt,
      ...tokens,
    });
    return generated.title;
  } catch (error) {
    logWarn("mink.title: kept provisional", {
      ...context,
      outcome: "failed",
      reason: failureReason(error),
      ms: Date.now() - startedAt,
    });
    return null;
  }
}

/**
 * Runs `work` with its own abort signal, and gives up at the deadline even if
 * the SDK does not stop when told to.
 */
async function withDeadline<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new MinkStallError("first_chunk", ms));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failureReason(error: unknown): string {
  if (error instanceof MinkStallError) return "stall";
  const status =
    error && typeof error === "object"
      ? (error as { status?: unknown }).status
      : undefined;
  if (typeof status === "number") return `status_${status}`;
  return error instanceof Error ? error.name : "unknown";
}
