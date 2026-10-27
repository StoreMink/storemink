import "server-only";

// ---------------------------------------------------------------------------
// The storefront revamp's planning call: ONE structured Gemini request that
// designs the whole storefront, and the repair request that fixes what the
// strict compiler found (docs/mink-storefront-revamp.md, section 5).
//
// ★ THE THEME STUDIO CLIENT, NOT A SECOND ONE. The request goes through
//   lib/theme-studio/gemini-vertex.ts with the shared provider capacity, so
//   its retries, 429 backoff, refusal handling and per-model admission are
//   the ones already run in production. Every shop's plans and repairs
//   queue together on the planner's own scope of that capacity
//   (REVAMP_PLANNER_CAPACITY_SCOPE), apart from the photo checks.
//
// ★ HIGH THINKING AND NO OUTPUT CAP. A whole site is one long answer; a
//   ceiling on a HIGH-thinking call only ever truncates the reasoning
//   (the Theme Studio "full capacity" finding). The six-minute cap on the
//   call is the bound instead, counted from when the shared capacity admits
//   it (L2-B), and no call is sent once the deadline drains the step.
//
// ★ OUTCOMES ARE CLASSIFIED FOR THE RUNNER. A refusal is final; a busy or
//   slow provider is worth retrying later (transient); a configuration or
//   permission fault is not; an unreadable answer returns `raw: null` so the
//   runner spends a repair on it; a lost lease or a cancelled job rethrows
//   the abort, so nothing is recorded for a run nobody owns; a call the
//   deadline's drain never sent is a `RevampDrainedError`, so the runner
//   hands the step over at once.
//
// ★ FAKE MODE MAKES NO CALL (MINK_REVAMP_PROVIDER=fake, provider.ts): the
//   offline plan comes back at zero cost.
//
// ★ THE SEED AND THE MEMORY (robustness audit section 5): the redesign's id
//   seeds the prompt's option order and the fake planner, and a full
//   redesign carries the runner's summary of this store's own earlier
//   redesigns (`<earlier_designs>`); a refinement never does.
// ---------------------------------------------------------------------------

import { estimateCostMicroUsd } from "@/lib/theme-studio/cost";
import {
  createVertexModelClient,
  getVertexConfig,
} from "@/lib/theme-studio/gemini-vertex";
import { resolveThemeStudioModel } from "@/lib/theme-studio/models";
import type {
  ProviderUsage,
  StructuredRequest,
  StructuredResult,
  ThemeStudioModelClient,
} from "@/lib/theme-studio/provider";
import type { ProviderCapacity } from "@/lib/theme-studio/provider-capacity";
import { sharedProviderCapacity } from "@/lib/theme-studio/provider-capacity-store";
import { sleepUnlessAborted } from "@/lib/theme-studio/rate-limit-backoff";
import { fakeRevampSiteOutput } from "./fake-plan";
import {
  RevampDrainedError,
  ZERO_REVAMP_USAGE,
  type RevampModelCall,
  type RevampStepContext,
  type RevampUsage,
} from "./ports";
import { revampProvider } from "./provider";
import {
  REVAMP_SITE_SCHEMA,
  revampRepairContent,
  revampSiteContent,
  revampSiteSystem,
  type RevampSiteInput,
} from "./site-schema";
import { RevampStepError } from "./step-error";

/** The model that designs a revamp (the Theme Studio registry's key). */
export const REVAMP_PLANNER_MODEL_KEY = "gemini-3.8-flash" as const;

/**
 * ★★ THE PLANNER QUEUES ON ITS OWN PERMITS (owner's decision, 2026-10-23).
 * Its model is the photo reviewer's, and a plan or repair holds its permit
 * for 97 to 244 s (staging, 2026-10-23) while that model's permits sat at
 * one in 73 to 87% of samples, so one planning call could hold the only
 * permit every shop's photo checks were waiting for. The scope gives the
 * planning and repair calls a capacity row of their own on the same model
 * (providerCapacityKey): their own permits, pause and recovery.
 */
export const REVAMP_PLANNER_CAPACITY_SCOPE = "revamp-planner";

/**
 * The longest one planning or repair call may take once the shared provider
 * capacity admits it.
 * ★★ COUNTED FROM THE ADMISSION, NOT FROM THE REQUEST (L2-B). The planner
 *   used to share its model's permits with every revamp's and theme build's
 *   photo reviews, and a 429 anywhere dropped them to one, so with four shops
 *   at once (the live run, 2026-10-22) a call waited minutes for its turn and
 *   was then cut off half written: six minutes from the request, queue
 *   included, failed a plan on two shops and a repair on every claim of a
 *   third. Written, a call takes about two minutes (a plan 118 s alone and
 *   two to three under load, a repair about 140 s), so six minutes of
 *   writing is twice the slowest seen. The wait itself is bounded by the
 *   run: no call is sent once its deadline drains the step, and the hard
 *   stop ends the wait. Its own scope (REVAMP_PLANNER_CAPACITY_SCOPE) now
 *   keeps the photo checks out of that queue, and other shops' plans are
 *   what remains in it.
 */
export const REVAMP_PLANNER_TIMEOUT_MS = 6 * 60_000;

export interface RevampPlannerOptions {
  /** A model client; null means none is configured. Omitted: Vertex. */
  client?: ThemeStudioModelClient | null;
}

/**
 * The Vertex client, built the way the Theme Studio worker builds it, on the
 * planner's own capacity scope. Plans and their repairs both come here.
 */
function vertexClient(ctx: RevampStepContext): ThemeStudioModelClient | null {
  const vertex = getVertexConfig();
  if (!vertex) return null;
  const draining = ctx.draining;
  return createVertexModelClient(vertex, {
    capacity: (model) =>
      revampPlannerCapacity(
        sharedProviderCapacity(vertex.projectId, vertex.region, model, {
          scope: REVAMP_PLANNER_CAPACITY_SCOPE,
        }),
        { draining },
      ),
    ...drainingSleep(draining),
  });
}

/**
 * The shared capacity as the planner uses it (L2-B): the call's cap starts
 * when it is admitted, and an attempt admitted after the deadline began to
 * drain the step is never sent (jobs-4, the photos step's
 * `revampDrainingCapacity`): sending it would start a paid call the hard
 * stop may cut off. ★ The refusal is an abort, which the Vertex client
 *   reports as "cancelled"; the planner turns that into a hand-over.
 */
export function revampPlannerCapacity(
  capacity: ProviderCapacity,
  options: { draining?: AbortSignal; callMs?: number } = {},
): ProviderCapacity {
  const callMs = options.callMs ?? REVAMP_PLANNER_TIMEOUT_MS;
  // ★ One cap for the whole call: a 429 retry after the first admission
  //   spends what is left of it, never a fresh six minutes.
  let cap: AbortSignal | null = null;
  return {
    run: (operation, signal, runOptions) =>
      capacity.run(
        async (permit) => {
          if (options.draining?.aborted) throw notSentAtDeadline();
          const cut = (cap ??= AbortSignal.timeout(callMs));
          return operation({
            ...permit,
            signal: AbortSignal.any([permit.signal, cut]),
          });
        },
        signal,
        {
          admission:
            options.draining && runOptions?.admission
              ? AbortSignal.any([options.draining, runOptions.admission])
              : (options.draining ?? runOptions?.admission),
        },
      ),
  };
}

function notSentAtDeadline(): Error {
  const error = new Error(
    "Not sent: the redesign stopped starting paid calls at its deadline.",
  );
  // The name the Vertex client reads as an abort ("cancelled"), never as an
  // outage that may have billed.
  error.name = "AbortError";
  return error;
}

/**
 * The client's 429 wait, ending when the drain begins as well as when the
 * run stops: the attempt after it would not be sent, so waiting it out would
 * only hold back the hand-over.
 */
function drainingSleep(draining: AbortSignal | undefined): {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
} {
  if (!draining) return {};
  return {
    sleep: (ms, signal) =>
      sleepUnlessAborted(
        ms,
        signal ? AbortSignal.any([signal, draining]) : draining,
      ),
  };
}

function revampUsageOf(usage: ProviderUsage): RevampUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    thinkingTokens: usage.thinkingTokens,
    images: 0,
    reviews: 0,
    estimatedCostMicroUsd: estimateCostMicroUsd(
      REVAMP_PLANNER_MODEL_KEY,
      usage,
    ),
  };
}

const UNAVAILABLE =
  "The design model is busy or did not answer in time. Try again in a few minutes.";

async function callPlanner(
  ctx: RevampStepContext,
  text: string,
  input: RevampSiteInput,
  options: RevampPlannerOptions,
): Promise<RevampModelCall> {
  ctx.signal.throwIfAborted();
  if (revampProvider() === "fake") {
    return {
      raw: fakeRevampSiteOutput(input),
      usage: { ...ZERO_REVAMP_USAGE },
    };
  }
  const injected = options.client !== undefined;
  const client = injected ? options.client : vertexClient(ctx);
  if (!client) {
    throw new RevampStepError(
      "model_unavailable",
      "No design model is configured for storefront redesigns.",
      false,
    );
  }

  const model = resolveThemeStudioModel(REVAMP_PLANNER_MODEL_KEY);
  const request: StructuredRequest = {
    stage: "draft",
    modelKey: REVAMP_PLANNER_MODEL_KEY,
    providerModel: model.providerModel,
    system: revampSiteSystem(),
    content: [{ type: "text", text }],
    schema: REVAMP_SITE_SCHEMA,
    effort: "high",
  };
  // ★ The Vertex client's cap starts at its admission (vertexClient); a
  //   client handed in has no capacity to wait in, so its cap counts from
  //   the request, as it always did.
  const signal = injected
    ? AbortSignal.any([
        ctx.signal,
        AbortSignal.timeout(REVAMP_PLANNER_TIMEOUT_MS),
      ])
    : ctx.signal;

  let result: StructuredResult;
  try {
    result = await client.generate(request, signal);
  } catch (error) {
    ctx.signal.throwIfAborted();
    if (error instanceof RevampStepError) throw error;
    throw new RevampStepError("model_unavailable", UNAVAILABLE, true);
  }
  // ★ A lease lost or a job cancelled while the call ran: rethrow, whatever
  //   the provider said.
  ctx.signal.throwIfAborted();

  const usage = revampUsageOf(result.usage);
  switch (result.kind) {
    case "ok":
      return { raw: result.value, usage };
    case "truncated":
    case "invalid_json":
      return { raw: null, usage };
    case "refused":
      throw new RevampStepError(
        "model_refused",
        "The design model declined to redesign this storefront.",
        false,
      );
    case "error":
      // ★ A call the drain refused at its permit was never sent (jobs-4):
      //   the runner hands the step over at once, as at any deadline.
      if (result.code === "cancelled" && ctx.draining?.aborted) {
        throw new RevampDrainedError();
      }
      switch (result.code) {
        case "rate_limited":
        case "provider_unavailable":
        case "provider_timeout":
          throw new RevampStepError("model_unavailable", UNAVAILABLE, true);
        case "provider_auth":
        case "provider_rejected":
          throw new RevampStepError(
            "model_unavailable",
            "The design model refused the request; it needs a configuration fix.",
            false,
          );
        case "cancelled":
          // Not the job's own abort nor the drain's refusal (both checked
          // above): an injected client's six-minute cap. The Vertex client
          // reports its admission cap as provider_timeout.
          throw new RevampStepError("model_unavailable", UNAVAILABLE, true);
      }
  }
  throw new RevampStepError("model_unavailable", UNAVAILABLE, true);
}

/**
 * ★★ THE STORE'S SAVED BRAND VOICE GOES TO THE PLANNER (B17), from the
 * actor the runner rebuilt at this claim (actor.ts reads the saved guide
 * only), as fenced data the planner follows for tone. A voice the caller
 * already set is kept.
 */
function withBrandVoice<T extends RevampSiteInput>(
  ctx: RevampStepContext,
  input: T,
): T {
  if (input.brandVoice !== undefined) return input;
  return { ...input, brandVoice: ctx.actor?.brandVoice ?? null };
}

/**
 * ★★ THE REDESIGN'S OWN SEED AND MEMORY (robustness audit section 5). The
 *   redesign's id, from the step's context when the caller leaves it out,
 *   seeds the order the prompt lists each choice's options in and the fake
 *   planner's picks (`revampDesignSeed`), so a redo of the same store picks
 *   again. ★ A refinement never sees this store's earlier redesigns
 *   (`<earlier_designs>` asks for different choices, and a refinement keeps
 *   its parent's design except where the merchant asked), whoever passed
 *   them.
 */
function withRedesign<T extends RevampSiteInput>(
  ctx: RevampStepContext,
  input: T,
): T {
  const revampId = input.revampId || ctx.revampId || null;
  if (input.request.kind === "full") return { ...input, revampId };
  return { ...input, revampId, earlierDesigns: null };
}

/** The input as the planner sends it: the voice, the seed and the memory. */
function prepared<T extends RevampSiteInput>(
  ctx: RevampStepContext,
  input: T,
): T {
  return withRedesign(ctx, withBrandVoice(ctx, input));
}

/** Designs the whole storefront in one call. */
export function planRevampSite(
  ctx: RevampStepContext,
  input: RevampSiteInput,
  options: RevampPlannerOptions = {},
): Promise<RevampModelCall> {
  const ready = prepared(ctx, input);
  return callPlanner(ctx, revampSiteContent(ready), ready, options);
}

/** Asks for the whole plan again with every compiler issue listed. */
export function repairRevampSite(
  ctx: RevampStepContext,
  input: RevampSiteInput & { raw: unknown; issues: string[] },
  options: RevampPlannerOptions = {},
): Promise<RevampModelCall> {
  const ready = prepared(ctx, input);
  return callPlanner(ctx, revampRepairContent(ready), ready, options);
}
