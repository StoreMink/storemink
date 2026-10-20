import "server-only";

import {
  type GoogleGenAI,
  ThinkingLevel,
  type Chat,
  type Content,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import type { MinkConfig } from "./config";
import { MinkAgentError } from "./errors";
import type {
  MinkActorContext,
  MinkModelSession,
  MinkModelTurn,
  MinkStreamOptions,
  MinkToolCall,
  MinkToolDeclaration,
  MinkUsage,
} from "./types";
import type { MinkStoredMessage } from "./persistence";
import {
  abortError,
  leakedReasoningAt,
  MinkLeakedReasoningError,
  MinkRetryError,
  MinkStallError,
  sameMinkTarget,
  withMinkFailover,
  type MinkProviderTarget,
} from "./retry";
import {
  markMinkModelAnswered,
  markMinkModelUnavailable,
  minkModelLooksAvailable,
} from "./provider-health";
import { renderMinkSystemInstruction } from "./system-prompt";
import type { MinkThinkingLevel } from "./thinking";
import type { MinkToolRoute } from "./tool-routing";
import { minkVertexClient } from "./vertex-clients";
import { logError, logWarn } from "@/lib/observability/logger";

/** A voice turn's first chunk never waits longer than this: the merchant is listening. */
const VOICE_FIRST_CHUNK_MAX_MS = 12_000;
/** A HIGH-thinking turn reasons before it writes anything, so its first chunk waits this much longer. */
const HIGH_THINKING_FIRST_CHUNK_FACTOR = 4;

export function createVertexMinkSession(
  config: MinkConfig,
  actor: MinkActorContext,
  declarations: MinkToolDeclaration[],
  options: {
    history: MinkStoredMessage[];
    abortSignal?: AbortSignal;
    thinkingLevel?: MinkThinkingLevel;
    memoryReference?: string;
    /** The merchant's current screen, as a separate untrusted part (page-context.ts). */
    screenReference?: string;
    /** The model the run starts on (the lite model for a light route). */
    model?: string;
    /** The route `declarations` were narrowed by; selects the prompt rules. */
    route?: Pick<MinkToolRoute, "mode" | "groups"> | null;
    /**
     * Every permitted declaration. Present only for a narrowed run, and what
     * `restartWithAllTools` widens to.
     */
    allDeclarations?: MinkToolDeclaration[];
  },
): MinkModelSession {
  const project = config.projectId;
  if (!project) {
    throw new MinkAgentError(
      "vertex_not_configured",
      "Mink AI requires GCP_PROJECT_ID for Vertex AI.",
    );
  }

  // One client per project and Vertex location for the life of the process
  // (vertex-clients.ts), made when first needed: the fallback usually lives
  // in another region, and most runs never touch it. Shared across runs, so
  // a run does not fetch a fresh access token of its own.
  const clientFor = (location: string): GoogleGenAI =>
    minkVertexClient(project, location);

  const chatConfig = (
    tools: MinkToolDeclaration[],
    route: Pick<MinkToolRoute, "mode" | "groups"> | null,
  ): GenerateContentConfig => {
    const functionDeclarations: FunctionDeclaration[] = tools.map(
      (declaration) => ({
        name: declaration.name,
        description: declaration.description,
        parametersJsonSchema: declaration.parametersJsonSchema,
      }),
    );
    return {
      systemInstruction: renderMinkSystemInstruction(actor, tools, route),
      maxOutputTokens: config.maxOutputTokens,
      thinkingConfig: {
        thinkingLevel:
          options.thinkingLevel === "high"
            ? ThinkingLevel.HIGH
            : ThinkingLevel.LOW,
      },
      ...(functionDeclarations.length
        ? { tools: [{ functionDeclarations }] }
        : {}),
    };
  };

  // ★ THE DEADLINES ARE PER ATTEMPT, NOT PER RUN. The run's own 180 s limit
  // still holds everything; these only decide when one silent attempt is
  // abandoned and asked again (see `attempt`).
  const configuredFirstChunkMs =
    config.firstChunkTimeoutMs > 0 ? config.firstChunkTimeoutMs : 20_000;
  const firstChunkMs =
    options.thinkingLevel === "high"
      ? configuredFirstChunkMs * HIGH_THINKING_FIRST_CHUNK_FACTOR
      : actor.answerMedium === "spoken"
        ? Math.min(configuredFirstChunkMs, VOICE_FIRST_CHUNK_MAX_MS)
        : configuredFirstChunkMs;
  const idleMs =
    config.streamIdleTimeoutMs > 0 ? config.streamIdleTimeoutMs : 20_000;
  /** A first-chunk stall under a deadline shorter than a written chat's. */
  const shortenedStall = (error: unknown) =>
    error instanceof MinkStallError &&
    error.phase === "first_chunk" &&
    error.waitedMs < configuredFirstChunkMs;

  const fallbackTarget: MinkProviderTarget | null = config.fallbackModel
    ? {
        model: config.fallbackModel,
        location: config.fallbackLocation || config.location,
      }
    : null;
  let fallbackUsable = fallbackTarget !== null;
  let tools = declarations;
  let route = options.route ?? null;
  let currentConfig = chatConfig(tools, route);
  // The main model for this session: the lite model until a restart widens it.
  let primary: MinkProviderTarget = {
    model: options.model ?? config.model,
    location: config.location,
  };
  const fallbackFor = (main: MinkProviderTarget) =>
    fallbackUsable && fallbackTarget && !sameMinkTarget(fallbackTarget, main)
      ? fallbackTarget
      : null;
  // ★ A model this instance has just watched fail is not tried first: the
  // run starts on the fallback and pays nothing for the main model's window.
  // ★★ A VOICE TURN STARTS ON THE FALLBACK (owner's decision, 2026-10-20):
  // 3.5 Flash in Mumbai answered a spoken question in about half the time
  // 3.7 Flash at global took (config.voiceStartsOnFallback). The main model
  // is its failover, by the same rules, and a fallback this instance has just
  // watched fail is not where a voice turn starts either.
  const startingFallback = fallbackFor(primary);
  const voiceFirst =
    actor.answerMedium === "spoken" && config.voiceStartsOnFallback === true;
  let current: MinkProviderTarget =
    startingFallback &&
    minkModelLooksAvailable(startingFallback) &&
    (voiceFirst || !minkModelLooksAvailable(primary))
      ? startingFallback
      : primary;
  const openChat = (target: MinkProviderTarget, history: Content[]): Chat =>
    // The SDK clones the history it is given, so neither a restart nor a
    // failover ever shares turns with the chat it replaces.
    clientFor(target.location).chats.create({
      model: target.model,
      history,
      config: currentConfig,
    });
  let chat = openChat(current, toVertexHistory(options.history));
  let widened = false;

  return {
    get model() {
      return current.model;
    },
    get location() {
      return current.location;
    },
    /**
     * ★ ONE WIDENING PER RUN, AND ALWAYS ONTO THE MAIN MODEL. A run that
     * asked for more tools has shown its route was wrong, and a lite model
     * that guessed wrong is not the one to trust with the rest. The new chat
     * sees the stored conversation only; the orchestrator re-sends the
     * merchant's message. ★ Unless the main model has already failed in this
     * run: then the widened chat opens on the fallback that took over.
     */
    restartWithAllTools() {
      if (widened || !options.allDeclarations) return false;
      widened = true;
      const onFallback =
        fallbackTarget !== null && sameMinkTarget(current, fallbackTarget);
      primary = { model: config.model, location: config.location };
      tools = options.allDeclarations;
      route = null;
      currentConfig = chatConfig(tools, route);
      const fallback = fallbackFor(primary);
      current = onFallback && fallback ? fallback : primary;
      chat = openChat(current, toVertexHistory(options.history));
      return true;
    },
    async sendUserMessage(message, stream) {
      // Reference parts come BEFORE the message and never inside the system
      // instruction: memories first (durable), then the screen (this turn).
      const references = [options.memoryReference, options.screenReference]
        .filter((text): text is string => Boolean(text))
        .map((text) => ({ text }));
      return send(
        references.length ? [...references, { text: message }] : message,
        stream,
      );
    },
    async sendToolResponses(responses, stream) {
      const parts: Part[] = responses.map((result) => ({
        functionResponse: {
          ...(result.id ? { id: result.id } : {}),
          name: result.name,
          response: result.response,
        },
      }));
      return send(parts, stream);
    },
  };

  /**
   * One model turn, STREAMED, failing over between the main model and the
   * fallback (`withMinkFailover`).
   *
   * ★★ EVERY TURN STREAMS, not only the one that turns out to be the answer:
   * nothing knows a turn is final until it arrives without a function call,
   * and the merchant used to watch "Thinking…" for the whole of a long
   * answer because the text was only released once the SDK had buffered all
   * of it. The orchestrator discards fragments of a turn that ends in a tool
   * call, so what the merchant sees is exactly the text the run returns.
   *
   * ★ A RETRY IS SAFE WITH NO HISTORY REPAIR: the SDK's `sendMessageStream`
   * records the user turn and the model output only after the LAST chunk
   * (`processStreamResponse`), so a stream that fails half way leaves the
   * chat history exactly as it was. Every retry opens a NEW chat from that
   * history, on whichever model is next: the old chat may still be waiting on
   * a request that ignored its abort, and the SDK queues a chat's sends
   * behind the previous one, so reusing it could wait for ever. A model
   * switch mid-run is safe too: 3.5 Flash at asia-south1 answered a tool
   * result whose call (with its thought signature) 3.7 Flash had made
   * (probed on storemink-staging, 2026-10-19). Fragments already delivered
   * are withdrawn through `onReset` before the next attempt streams.
   */
  async function send(
    message: string | Part[],
    stream?: MinkStreamOptions,
  ): Promise<MinkModelTurn> {
    let delivered = 0;
    try {
      const result = await withMinkFailover({
        primary,
        fallback: fallbackFor(primary),
        start: current,
        maxRetries: config.maxModelRetries,
        signal: options.abortSignal,
        attempt: async (target, retryCount) => {
          if (retryCount > 0 || !sameMinkTarget(target, current)) {
            chat = openChat(target, chat.getHistory(true));
            current = target;
          }
          if (delivered > 0) {
            delivered = 0;
            stream?.onReset?.();
          }
          return attempt(message, (text) => {
            delivered += text.length;
            stream?.onDelta?.(text);
          });
        },
        onFailure: ({ target, error, kind, retryCount }) => {
          const onFallback =
            fallbackTarget !== null && sameMinkTarget(target, fallbackTarget);
          const context = {
            requestId: actor.requestId,
            storeId: actor.storeId,
            model: target.model,
            location: target.location,
            retry: retryCount,
            status: providerStatus(error) ?? undefined,
            stall: error instanceof MinkStallError ? error.phase : undefined,
            leakedReasoning:
              error instanceof MinkLeakedReasoningError ? true : undefined,
          };
          if (kind === "history") {
            // The main model would not read the fallback's turns: neither
            // model is down, so neither is marked.
            logWarn("mink.model: history refused", context);
          } else if (kind === "retryable") {
            // ★ A STALL ONLY THE VOICE DEADLINE CALLED is not evidence the
            //   model is down: voice waits at most 12 s for a first chunk,
            //   where a written chat waits 20, and marking the model would
            //   send every run on this instance to the fallback for a minute.
            if (!shortenedStall(error)) markMinkModelUnavailable(target);
            logWarn("mink.model: attempt failed", context);
          } else if (onFallback) {
            // A fallback that refuses outright is a configuration fault
            // (wrong id, not enabled at that location): say so loudly, and
            // stop offering it for the rest of this session. ★ Remembered on
            // the instance too, because voice turns START on the fallback:
            // without it every voice turn would pay this refusal first.
            fallbackUsable = false;
            markMinkModelUnavailable(target);
            logError("mink.model: fallback refused", error, context);
          }
        },
      });
      fallbackUsable = fallbackUsable && result.fallbackUsable;
      current = result.target;
      markMinkModelAnswered(result.target);
      return { ...result.value, retryCount: result.retryCount };
    } catch (error) {
      if (!(error instanceof MinkRetryError)) throw error;
      const status = providerStatus(error.originalError);
      const credentialFailure = isCredentialProviderError(error.originalError);
      const code =
        credentialFailure || status === 401 || status === 403
          ? "provider_auth_failed"
          : status !== null && status >= 400 && status < 500 && status !== 429
            ? "provider_request_rejected"
            : "provider_unavailable";
      throw new MinkAgentError(
        code,
        code === "provider_unavailable"
          ? "Mink AI's model is temporarily unavailable. Try again shortly."
          : code === "provider_auth_failed"
            ? process.env.NODE_ENV === "production"
              ? "Mink AI cannot authenticate with Google Cloud. Ask StoreMink support to check the deployment service account."
              : "Your local Google Cloud login has expired. Run `gcloud auth application-default login`, then restart StoreMink."
            : "Mink AI couldn't use its configured model.",
        error.retryCount,
      );
    }
  }

  /**
   * One provider attempt with a watchdog: no first chunk within
   * `firstChunkMs`, or a gap of `idleMs` once streaming, abandons it as a
   * `MinkStallError` (retried like a 503).
   *
   * ★ IT STOPS WAITING EVEN IF THE SDK DOES NOT. The attempt's own abort
   * signal (linked to the run's) cancels the request, and every await here
   * also races the watchdog, so the attempt ends at its deadline whether or
   * not the provider's stream honours the abort. A request left behind that
   * way can only settle on a chat nothing uses any more.
   */
  async function attempt(
    message: string | Part[],
    onDelta: (text: string) => void,
  ): Promise<MinkModelTurn> {
    const run = options.abortSignal;
    if (run?.aborted) throw abortError(run);
    const controller = new AbortController();
    let stopWaiting: (error: Error) => void = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      stopWaiting = reject;
    });
    // Nothing may be left to reject unobserved once the attempt has settled.
    interrupted.catch(() => {});
    const onRunAbort = () => {
      controller.abort(run?.reason);
      stopWaiting(abortError(run));
    };
    run?.addEventListener("abort", onRunAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = (ms: number, phase: MinkStallError["phase"]) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const stall = new MinkStallError(phase, ms);
        controller.abort(stall);
        stopWaiting(stall);
      }, ms);
    };
    watch(firstChunkMs, "first_chunk");
    try {
      const opening = chat.sendMessageStream({
        message,
        config: { ...currentConfig, abortSignal: controller.signal },
      });
      opening.catch(() => {});
      const chunks = await Promise.race([opening, interrupted]);
      return await consumeMinkStream(
        watched(chunks, interrupted, () => watch(idleMs, "idle")),
        onDelta,
      );
    } finally {
      clearTimeout(timer);
      run?.removeEventListener("abort", onRunAbort);
    }
  }
}

/**
 * The provider's stream, each chunk raced against the attempt's watchdog,
 * with `onChunk` called as each one arrives (to re-arm the idle deadline).
 */
async function* watched<T>(
  source: AsyncIterable<T>,
  interrupted: Promise<never>,
  onChunk: () => void,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let finished = false;
  try {
    for (;;) {
      const pending = iterator.next();
      pending.catch(() => {});
      const next = await Promise.race([pending, interrupted]);
      if (next.done) {
        finished = true;
        return;
      }
      onChunk();
      yield next.value;
    }
  } finally {
    // An abandoned stream is asked to stop, never waited on.
    if (!finished) void iterator.return?.()?.catch(() => {});
  }
}

function isCredentialProviderError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && !seen.has(current); depth++) {
    seen.add(current);
    if (current instanceof Error) {
      if (/invalid_(?:grant|rapt)|reauth|credential/i.test(current.message))
        return true;
      current = current.cause;
    } else if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (
        typeof value.message === "string" &&
        /invalid_(?:grant|rapt)|reauth|credential/i.test(value.message)
      )
        return true;
      current = value.cause;
    } else {
      break;
    }
  }
  return false;
}

function providerStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function toVertexHistory(history: MinkStoredMessage[]): Content[] {
  return history.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.text }],
  }));
}

/**
 * Fold a chunk stream into one finished turn, releasing visible text as it
 * arrives.
 *
 * ★ ONLY NON-THOUGHT TEXT PARTS are forwarded and collected, which is the
 * rule `toTurn` applied to a buffered response: reading `response.text` on a
 * function-call turn makes the SDK warn about non-text parts, and a thought
 * part is reasoning the merchant must never see. Function calls are gathered
 * from every chunk because the provider may split a call across chunks from
 * its text. Usage is cumulative on the provider's side, so the LAST chunk
 * that carries it wins.
 *
 * Exported for the unit test; it takes any async iterable of responses.
 */
export async function consumeMinkStream(
  chunks: AsyncIterable<GenerateContentResponse>,
  onDelta?: (text: string) => void,
): Promise<MinkModelTurn> {
  let text = "";
  // ★ The opening is held back until it cannot be leaked reasoning
  //   (`leakedReasoningAt`): a reply whose first line is just "thought" is
  //   thrown away and asked again before a word of it reaches the merchant.
  //   Almost every answer is released on its first character.
  let released = false;
  const functionCalls: MinkToolCall[] = [];
  let usage: MinkUsage = {
    promptTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    basePromptTokens: 0,
  };
  for await (const chunk of chunks) {
    const parts = chunk.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.thought) continue;
      if (typeof part.text === "string" && part.text.length > 0) {
        text += part.text;
        if (released) {
          onDelta?.(part.text);
        } else {
          const leaked = leakedReasoningAt(text);
          if (leaked === true) throw new MinkLeakedReasoningError();
          if (leaked === false) {
            released = true;
            onDelta?.(text);
          }
        }
      }
      const call = part.functionCall;
      if (call?.name) {
        functionCalls.push({
          id: call.id,
          name: call.name,
          args: call.args ?? {},
        });
      }
    }
    if (chunk.usageMetadata) usage = toUsage(chunk);
  }
  // A whole reply short enough to stay undecided ("th") is an answer.
  if (!released && text) onDelta?.(text);
  return { text: text.trim(), functionCalls, usage, retryCount: 0 };
}

function toUsage(response: GenerateContentResponse): MinkUsage {
  const usage = response.usageMetadata;
  return {
    promptTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    thoughtTokens: usage?.thoughtsTokenCount ?? 0,
    totalTokens: usage?.totalTokenCount ?? 0,
    // A SUBSET of promptTokenCount — the provider documents that count as
    // already including cached content. Absent means "the provider said
    // nothing", which is read as zero cached rather than as an error: an
    // unreported cache must cost us an accounting discount, never a run.
    cachedTokens: usage?.cachedContentTokenCount ?? 0,
    // THIS turn's own prompt size. Every turn reports one; the orchestrator
    // keeps the FIRST, which is the initial prompt each later turn re-sent.
    basePromptTokens: usage?.promptTokenCount ?? 0,
  };
}
