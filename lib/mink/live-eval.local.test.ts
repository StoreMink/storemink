import { appendFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import corpus from "../../evals/mink/read-alpha.json";
import {
  scoreMinkCase,
  summarizeMinkEval,
} from "../../scripts/mink-eval-core.mjs";
import { getBrandSoulForStore } from "@/lib/ai/brand-voice";
import { getMinkConfig, type MinkConfig } from "./config";
import { estimateMinkCost } from "./cost";
import { runMinkAgent } from "./orchestrator";
import {
  deleteMinkConversation,
  failMinkRun,
  startMinkRun,
} from "./persistence";
import { selectMinkThinkingLevel } from "./thinking";
import { applyMinkToolRoute, routeMinkTools } from "./tool-routing";
import { minkReadToolRegistry } from "./tools/read-tools";
import type { MinkActorContext, MinkRunResult, MinkUsage } from "./types";
import { createVertexMinkSession } from "./vertex-client";

// ---------------------------------------------------------------------------
// ★ OPT-IN, PAID, AND AGAINST A LOCAL DATABASE ONLY. Runs the live eval corpus
// (evals/mink/read-alpha.json) three ways and compares them:
//
//   baseline  every permitted tool, main model (Mink before routing)
//   routed    tool routing on, main model
//   lite      tool routing on, light routes on the lite model
//
// It calls Vertex for real (GCP_PROJECT_ID, ADC) and executes the real tools
// against the database the environment names, so it refuses anything but the
// local cluster. Each run is recorded in ONE throwaway conversation and closed
// as cancelled, so no eval turn ever becomes conversation history, proposal
// credits are refunded by the ordinary failed-run path, and the conversation
// is deleted at the end. Cases that would generate an image are skipped
// (each is a paid image and a bucket write).
//
//   set -a; source .env; source .env.local; set +a
//   MINK_LIVE_EVAL=1 MINK_LIVE_EVAL_OUT=/path/report.json \
//     npx vitest run lib/mink/live-eval.local.test.ts --coverage=false
//
// Optional: MINK_LIVE_EVAL_STORE / MINK_LIVE_EVAL_ADMIN (a local superadmin),
// MINK_LIVE_EVAL_CASES (comma-separated ids), MINK_LIVE_EVAL_MODES,
// MINK_LIVE_EVAL_CONCURRENCY (default 6), MINK_LIVE_EVAL_JUDGE=0 to skip the
// answer comparison, MINK_LIVE_EVAL_STALL_MS (default 25000) and
// MINK_LIVE_EVAL_ATTEMPTS (default 6). Each finished run is appended to
// `<out>.progress.jsonl` as it lands, so a long run can be watched and an
// interrupted one still leaves its results.
//
// ★★ A STALL IS RETRIED AND COUNTED, NEVER SCORED AS AN ANSWER. Measured on
// 2026-10-19 (storemink-staging, global): 11 of 38 main-model runs never got a
// first answer from the provider (no step, no tool, no tokens) and died at the
// 180 s run deadline, while 0 of 18 lite runs did. A bare probe the same hour
// (one-word prompt, no tools) stalled 3 of 5 sequential and 4 of 6 concurrent
// gemini-3.7-flash calls and 0 of 11 lite ones, so it is the provider, not
// the request or the concurrency (3.7 Flash answers only at `global`; every
// regional endpoint returns 404). Scored as failures, stalls swamp the
// comparison this exists for. So a run that hears nothing from the provider
// for MINK_LIVE_EVAL_STALL_MS is abandoned and asked again (a healthy step
// answers in 2 to 8 s), and so is one the provider refuses for capacity (429
// RESOURCE_EXHAUSTED or 503: the project's own quota is 10M input tokens a
// minute, so these come from Google's shared pool). The report counts both per
// model on their own line.
//
// ★ A LITE-MODE RUN WHOSE ROUTE IS NOT LIGHT IS THE ROUTED CONFIGURATION, so
// it is not run twice: the routed outcome is reused for it in the lite
// summary (`copiedFrom`), and only light routes reach the lite model.
// ---------------------------------------------------------------------------

const LIVE = process.env.MINK_LIVE_EVAL === "1";
const MODES = ["baseline", "routed", "lite"] as const;
type Mode = (typeof MODES)[number];

interface CaseDef {
  id: string;
  category: string;
  prompt: string;
  expectedTools?: string[];
  allowedTools?: string[];
  forbiddenTools?: string[];
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

interface Outcome {
  id: string;
  mode: Mode;
  model: string;
  route: string;
  light: boolean;
  declared: number;
  restarted: boolean;
  score: ReturnType<typeof scoreMinkCase>;
  usage: MinkUsage | null;
  abandonedUsage: MinkUsage | null;
  costMicrousd: number | null;
  steps: number;
  latencyMs: number;
  answer: string;
  error: string | null;
  /** Attempts abandoned because the provider never answered, and on what. */
  stalledModels: string[];
  /** Attempts the provider refused for capacity (429 or 503), and on what. */
  unavailableModels: string[];
  /** Set when this outcome is another mode's run reused (same configuration). */
  copiedFrom?: Mode;
}

describe.skipIf(!LIVE)("★ Mink live routing eval", () => {
  it(
    "runs the corpus three ways and writes the report",
    async () => {
      if (process.env.DB_HOST !== "127.0.0.1" || process.env.DB_PORT !== "5544")
        throw new Error("The live eval runs only against the local database.");
      const config = getMinkConfig();
      expect(config.projectId).toBeTruthy();
      const storeId =
        process.env.MINK_LIVE_EVAL_STORE ??
        "48baf654-8e5e-40dc-a2a8-2d3e287ecb33";
      const adminId =
        process.env.MINK_LIVE_EVAL_ADMIN ?? "fgHU7yC1ZBg6oIBlxpb6AmYeoG92";
      const brandVoice = (await getBrandSoulForStore(storeId))
        .slice(0, 6_000)
        .trim();
      const actor: MinkActorContext = {
        storeId,
        adminId,
        email: null,
        roleSlug: "superadmin",
        permissions: {},
        isSuperadmin: true,
        effectivePlan: "pro",
        locationIds: null,
        analyticsTimeZone: "Asia/Kolkata",
        currency: "INR",
        defaultLowStockThreshold: 5,
        currentPath: "/dashboard",
        selectedResource: null,
        draftingEnabled: true,
        brandVoice,
        requestId: crypto.randomUUID(),
      };

      const only = process.env.MINK_LIVE_EVAL_CASES?.split(",").map((id) =>
        id.trim(),
      );
      const modes = (process.env.MINK_LIVE_EVAL_MODES?.split(",") ??
        MODES) as Mode[];
      const cases = (corpus.cases as CaseDef[]).filter(
        (entry) =>
          (!only || only.includes(entry.id)) &&
          !(entry.allowedTools ?? []).includes("generate_storefront_image") &&
          !(entry.forbiddenTools ?? []).includes("generate_storefront_image"),
      );

      // One throwaway conversation; every run is closed as cancelled so none
      // becomes another case's history - which is also why a case's route is
      // known before it runs (no history ever reaches the router).
      let conversationId: string | undefined;
      const goesLite = (entry: CaseDef) => {
        const route = routeMinkTools({
          message: entry.prompt,
          currentPath: actor.currentPath,
          selectedResource: actor.selectedResource,
        });
        return (
          route.light &&
          applyMinkToolRoute(minkReadToolRegistry.declarationsFor(actor), route)
            .narrowed
        );
      };
      const reuseRouted = modes.includes("routed");
      const jobs = cases.flatMap((entry) =>
        modes
          .filter((mode) => mode !== "lite" || !reuseRouted || goesLite(entry))
          .map((mode) => ({ entry, mode })),
      );
      const outcomes: Outcome[] = [];
      const concurrency = Number(process.env.MINK_LIVE_EVAL_CONCURRENCY ?? 6);
      // The production run deadline: a provider call can stall for minutes
      // (measured: 3 to 13 minutes on the main model while a sibling call
      // answered in 5 s), and the stream route gives up at this point.
      const timeoutMs = Number(
        process.env.MINK_LIVE_EVAL_TIMEOUT_MS ?? config.runTimeoutMs,
      );
      const stallMs = Number(process.env.MINK_LIVE_EVAL_STALL_MS ?? 25_000);
      const maxAttempts = Math.max(
        1,
        Number(process.env.MINK_LIVE_EVAL_ATTEMPTS ?? 6),
      );
      const out = process.env.MINK_LIVE_EVAL_OUT;
      const progressFile = out ? `${out}.progress.jsonl` : null;
      if (progressFile) writeFileSync(progressFile, "");

      const attemptOne = async (
        entry: CaseDef,
        mode: Mode,
      ): Promise<Outcome> => {
        const runConfig: MinkConfig = {
          ...config,
          toolRouting: mode !== "baseline",
          liteRouting: mode === "lite",
          // ★ The eval measures each configured model: a fallback answering
          // for a stalled one would score the wrong model, and the session's
          // own stall deadlines would hide the stalls this harness counts.
          // Stalls are detected and retried here instead (`stallMs`).
          fallbackModel: null,
          firstChunkTimeoutMs: 120_000,
          streamIdleTimeoutMs: 120_000,
        };
        const runActor: MinkActorContext = {
          ...actor,
          requestId: crypto.randomUUID(),
        };
        const permitted = minkReadToolRegistry.declarationsFor(runActor);
        const thinkingLevel = selectMinkThinkingLevel(entry.prompt, permitted);
        const started = await startMinkRun({
          actor: runActor,
          conversationId,
          message: entry.prompt,
          model: runConfig.model,
          thinkingLevel,
        });
        conversationId ??= started.conversationId;
        const route = runConfig.toolRouting
          ? routeMinkTools({
              message: entry.prompt,
              currentPath: runActor.currentPath,
              selectedResource: runActor.selectedResource,
              history: started.history,
            })
          : null;
        const routed = applyMinkToolRoute(permitted, route);
        const initialModel =
          runConfig.liteRouting && route?.light && routed.narrowed
            ? runConfig.liteModel
            : runConfig.model;
        const abort = new AbortController();
        let timedOut = false;
        let stalled = false;
        const timer = setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, timeoutMs);
        // Any event or step counts as the provider answering; silence for
        // `stallMs` is a stall, abandoned here and asked again by `runOne`.
        let lastActivity = Date.now();
        const watchdog = setInterval(() => {
          if (Date.now() - lastActivity < stallMs) return;
          stalled = true;
          abort.abort();
        }, 1_000);
        const session = createVertexMinkSession(
          runConfig,
          { ...runActor, runId: started.runId },
          routed.declarations,
          {
            history: started.history,
            abortSignal: abort.signal,
            thinkingLevel,
            model: initialModel,
            route: routed.narrowed ? route : null,
            ...(routed.narrowed ? { allDeclarations: permitted } : {}),
          },
        );
        const events: SseEvent[] = [];
        let progress = {
          steps: 0,
          toolCalls: 0,
          retryCount: 0,
          usage: emptyUsage(),
        };
        const startedAt = Date.now();
        let result: MinkRunResult | null = null;
        let error: string | null = null;
        try {
          result = await runMinkAgent({
            actor: { ...runActor, runId: started.runId },
            message: entry.prompt,
            config: runConfig,
            registry: minkReadToolRegistry,
            session,
            onProgress(next) {
              lastActivity = Date.now();
              progress = next;
            },
            onEvent(event) {
              lastActivity = Date.now();
              if (event.type === "tool_call")
                events.push({
                  event: "tool",
                  data: { state: "running", name: event.call.name },
                });
              if (event.type === "tool_result")
                events.push({
                  event: "tool",
                  data: {
                    state: event.ok ? "completed" : "failed",
                    name: event.name,
                    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
                  },
                });
            },
          });
          events.push({
            event: "message",
            data: { role: "assistant", text: result.text },
          });
        } catch (caught) {
          error = stalled
            ? "provider_stall"
            : timedOut
              ? "run_timeout"
              : caught && typeof caught === "object" && "code" in caught
                ? String((caught as { code: unknown }).code)
                : "mink_failed";
          events.push({ event: "error", data: { code: error } });
        } finally {
          clearTimeout(timer);
          clearInterval(watchdog);
        }
        const latencyMs = Date.now() - startedAt;
        const usage = result?.usage ?? progress.usage;
        await failMinkRun({
          actor: runActor,
          started,
          status: "cancelled",
          errorCode: "live_eval",
          latencyMs,
          model: result?.model ?? session.model ?? initialModel,
          pricingLocation: runConfig.location,
          progress: result
            ? {
                steps: result.steps,
                toolCalls: result.toolCalls,
                retryCount: result.retryCount,
                usage: result.usage,
              }
            : progress,
          usageStatus: "reported",
        }).catch(() => undefined);
        const totalCost = (model: string, spent: MinkUsage | null) =>
          spent
            ? estimateMinkCost({
                model,
                location: runConfig.location,
                usage: spent,
              }).estimatedCostMicrousd
            : 0;
        const answerModel = result?.model ?? session.model ?? initialModel;
        const cost =
          (totalCost(answerModel, usage) ?? 0) +
          (result?.restart
            ? (totalCost(result.restart.abandonedModel, result.restart.usage) ??
              0)
            : 0);
        return {
          id: entry.id,
          mode,
          model: answerModel,
          route: route ? `${route.mode}:${route.groups.join("+")}` : "off",
          light: Boolean(route?.light && routed.narrowed),
          declared: routed.declarations.length,
          restarted: Boolean(result?.restart),
          score: scoreMinkCase(entry, events, latencyMs),
          usage,
          abandonedUsage: result?.restart?.usage ?? null,
          costMicrousd: cost,
          steps: result?.steps ?? progress.steps,
          latencyMs,
          answer: result?.text ?? "",
          error,
          stalledModels: [],
          unavailableModels: [],
        };
      };

      const runOne = async (entry: CaseDef, mode: Mode): Promise<Outcome> => {
        const stalledModels: string[] = [];
        const unavailableModels: string[] = [];
        for (let attempt = 1; ; attempt += 1) {
          const outcome = await attemptOne(entry, mode);
          // A stall or a capacity refusal says nothing about the answer, so
          // both are asked again; everything else is the run's real result.
          const capacity =
            outcome.error === "provider_stall" ||
            outcome.error === "provider_unavailable";
          if (!capacity || attempt >= maxAttempts) {
            const final = { ...outcome, stalledModels, unavailableModels };
            if (progressFile)
              appendFileSync(
                progressFile,
                `${JSON.stringify({
                  id: final.id,
                  mode: final.mode,
                  model: final.model,
                  route: final.route,
                  light: final.light,
                  passed: final.score.passed,
                  error: final.error,
                  latencyMs: final.latencyMs,
                  stalledModels,
                  unavailableModels,
                })}\n`,
              );
            return final;
          }
          (outcome.error === "provider_stall"
            ? stalledModels
            : unavailableModels
          ).push(outcome.model);
        }
      };

      // The first job creates the conversation the rest reuse.
      if (jobs.length) outcomes.push(await runOne(jobs[0].entry, jobs[0].mode));
      let next = 1;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (next < jobs.length) {
            const job = jobs[next++];
            outcomes.push(await runOne(job.entry, job.mode));
          }
        }),
      );

      // Stalls are counted from the real runs only, before any reuse below.
      const stallsByModelFrom = [...outcomes];
      // A lite-mode case whose route is not light ran as `routed`; reuse it.
      if (modes.includes("lite") && reuseRouted)
        for (const entry of cases) {
          if (goesLite(entry)) continue;
          const routed = outcomes.find(
            (outcome) => outcome.id === entry.id && outcome.mode === "routed",
          );
          if (routed)
            outcomes.push({ ...routed, mode: "lite", copiedFrom: "routed" });
        }

      const judgements =
        process.env.MINK_LIVE_EVAL_JUDGE === "0"
          ? []
          : await judgeAnswers(config, cases, outcomes, concurrency);

      // Stalls per model across every attempt, the reliability half of the
      // comparison: attempts = finished runs on that model + stalls on it.
      const stallsByModel: Record<
        string,
        { attempts: number; stalls: number; unavailable: number }
      > = {};
      const tally = (model: string) =>
        (stallsByModel[model] ??= { attempts: 0, stalls: 0, unavailable: 0 });
      for (const outcome of stallsByModelFrom) {
        for (const model of outcome.stalledModels) {
          tally(model).attempts += 1;
          tally(model).stalls += 1;
        }
        for (const model of outcome.unavailableModels) {
          tally(model).attempts += 1;
          tally(model).unavailable += 1;
        }
        tally(outcome.model).attempts += 1;
        // The last attempt of a run that never got an answer failed too.
        if (outcome.error === "provider_stall")
          tally(outcome.model).stalls += 1;
        if (outcome.error === "provider_unavailable")
          tally(outcome.model).unavailable += 1;
      }

      const report = {
        ranAt: new Date().toISOString(),
        storeId,
        model: config.model,
        liteModel: config.liteModel,
        cases: cases.length,
        modes: Object.fromEntries(
          modes.map((mode) => {
            const runs = outcomes.filter((outcome) => outcome.mode === mode);
            return [mode, summarizeMode(runs)];
          }),
        ),
        stallsByModel,
        judgements,
        outcomes: outcomes
          .sort(
            (a, b) => a.id.localeCompare(b.id) || a.mode.localeCompare(b.mode),
          )
          .map(({ score, ...rest }) => ({
            ...rest,
            passed: score.passed,
            calledTools: score.calledTools,
            missingTools: score.missingTools,
            unexpectedTools: score.unexpectedTools,
            forbiddenTools: score.forbiddenTools,
            unexpectedToolErrors: score.unexpectedToolErrors,
          })),
      };
      if (out) writeFileSync(out, JSON.stringify(report, null, 2));

      if (conversationId)
        await deleteMinkConversation(actor, conversationId).catch(
          () => undefined,
        );
      // Every job ran once; reused lite rows are additions, not runs.
      expect(stallsByModelFrom.length).toBe(jobs.length);
    },
    4 * 60 * 60 * 1_000,
  );
});

function emptyUsage(): MinkUsage {
  return {
    promptTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    basePromptTokens: 0,
  };
}

function summarizeMode(runs: Outcome[]) {
  const summary = summarizeMinkEval(runs.map((run) => run.score));
  const sum = (pick: (run: Outcome) => number) =>
    runs.reduce((total, run) => total + pick(run), 0);
  const firstStep = runs
    .map((run) => run.usage?.basePromptTokens ?? 0)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  // Latency of the attempt that answered; time lost to stalls is reported
  // apart, so a stall-prone model's number is not hidden inside its median.
  const latencies = runs
    .filter((run) => !run.error)
    .map((run) => run.latencyMs)
    .sort((a, b) => a - b);
  const percentile = (share: number) =>
    latencies[
      Math.min(latencies.length - 1, Math.floor(latencies.length * share))
    ] ?? 0;
  return {
    ...summary,
    errors: runs.filter((run) => run.error).length,
    timeouts: runs.filter((run) => run.error === "run_timeout").length,
    unansweredAfterStalls: runs.filter((run) => run.error === "provider_stall")
      .length,
    stalledAttempts: sum((run) => run.stalledModels.length),
    unavailableAttempts: sum((run) => run.unavailableModels.length),
    runsWithStall: runs.filter((run) => run.stalledModels.length > 0).length,
    p50LatencyMs: percentile(0.5),
    p90LatencyMs: percentile(0.9),
    restarts: runs.filter((run) => run.restarted).length,
    liteRuns: runs.filter((run) => run.model.includes("lite")).length,
    reusedFromRouted: runs.filter((run) => run.copiedFrom === "routed").length,
    promptTokens: sum((run) => run.usage?.promptTokens ?? 0),
    abandonedPromptTokens: sum((run) => run.abandonedUsage?.promptTokens ?? 0),
    outputTokens: sum(
      (run) => (run.usage?.outputTokens ?? 0) + (run.usage?.thoughtTokens ?? 0),
    ),
    medianFirstStepPromptTokens:
      firstStep[Math.floor(firstStep.length / 2)] ?? 0,
    costUsd: Math.round(sum((run) => run.costMicrousd ?? 0)) / 1_000_000,
    meanLatencyMs: Math.round(sum((run) => run.latencyMs) / (runs.length || 1)),
  };
}

/**
 * The main model compares each routed and lite answer with the baseline one.
 * It sees the question, both answers and the tools each called - not the tool
 * output - so it judges agreement, grounding and fitness, not ground truth.
 * A routed run whose route fell back to every tool is the same configuration
 * as the baseline, so its verdicts are the judge's own noise floor.
 *
 * Six at a time, and every call has its own 25 s deadline and six tries:
 * the judge runs on the main model, whose stalls this file measures.
 */
async function judgeAnswers(
  config: MinkConfig,
  cases: CaseDef[],
  outcomes: Outcome[],
  concurrency: number,
) {
  const { GoogleGenAI, ThinkingLevel } = await import("@google/genai");
  const ai = new GoogleGenAI({
    enterprise: true,
    project: config.projectId ?? undefined,
    location: config.location,
    apiVersion: "v1",
  });
  type Verdict = {
    id: string;
    mode: Mode;
    route: string;
    verdict: string;
    acceptable: boolean;
    reason: string;
  };
  const tasks: Array<{
    id: string;
    mode: Mode;
    route: string;
    prompt: string;
  }> = [];
  const verdicts: Verdict[] = [];
  for (const entry of cases) {
    const baseline = outcomes.find(
      (outcome) => outcome.id === entry.id && outcome.mode === "baseline",
    );
    if (!baseline) continue;
    for (const mode of ["routed", "lite"] as const) {
      const other = outcomes.find(
        (outcome) => outcome.id === entry.id && outcome.mode === mode,
      );
      if (!other) continue;
      // Identical tool path and model: nothing for a judge to compare.
      if (mode === "lite" && !other.light) continue;
      if (baseline.error) {
        // No reference answer to compare against.
        verdicts.push({
          id: entry.id,
          mode,
          route: other.route,
          verdict: "reference_failed",
          acceptable: false,
          reason: baseline.error,
        });
        continue;
      }
      tasks.push({
        id: entry.id,
        mode,
        route: other.route,
        prompt: [
          "Two runs of a store-operations assistant answered the same merchant message, each grounded in the same store data through tools.",
          `Merchant message: ${JSON.stringify(entry.prompt)}`,
          `Answer A (reference) called: ${baseline.score.calledTools.join(", ") || "no tools"}.`,
          `Answer A: ${JSON.stringify(baseline.answer)}`,
          `Answer B called: ${other.score.calledTools.join(", ") || "no tools"}${other.error ? ` and failed with ${other.error}` : ""}.`,
          `Answer B: ${JSON.stringify(other.answer)}`,
          "Judge answer B against answer A: does it answer what was asked, agree with A's figures and facts (or disagree only where it read more data), avoid inventing facts, refuse what should be refused, and read as plainly? Wording differences do not matter.",
        ].join("\n"),
      });
    }
  }

  const judgeOne = async (prompt: string) => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 25_000);
      try {
        const response = await ai.models.generateContent({
          model: config.model,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: {
              type: "object",
              properties: {
                verdict: {
                  type: "string",
                  enum: ["b_better", "same", "b_worse"],
                },
                acceptable: { type: "boolean" },
                reason: { type: "string" },
              },
              required: ["verdict", "acceptable", "reason"],
            },
            maxOutputTokens: 2_048,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            abortSignal: abort.signal,
          },
        });
        const parsed = JSON.parse(response.text ?? "{}") as {
          verdict?: string;
          acceptable?: boolean;
          reason?: string;
        };
        if (parsed.verdict)
          return {
            verdict: parsed.verdict,
            acceptable: parsed.acceptable === true,
            reason: (parsed.reason ?? "").slice(0, 300),
          };
      } catch {
        // A stall or a failure: ask again.
      } finally {
        clearTimeout(timer);
      }
    }
    return { verdict: "judge_failed", acceptable: false, reason: "" };
  };

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (next < tasks.length) {
        const task = tasks[next++];
        verdicts.push({
          id: task.id,
          mode: task.mode,
          route: task.route,
          ...(await judgeOne(task.prompt)),
        });
      }
    }),
  );
  return verdicts.sort(
    (a, b) => a.id.localeCompare(b.id) || a.mode.localeCompare(b.mode),
  );
}
