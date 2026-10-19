import { describe, expect, it, vi } from "vitest";
import type { MinkConfig } from "./config";
import { runMinkAgent } from "./orchestrator";
import type {
  MinkActorContext,
  MinkModelSession,
  MinkModelTurn,
  MinkUsage,
} from "./types";
import { MinkToolRegistry } from "./tools/registry";

const ZERO_USAGE: MinkUsage = {
  promptTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  basePromptTokens: 0,
};

const ACTOR: MinkActorContext = {
  storeId: "store-1",
  adminId: "admin-1",
  email: "owner@example.com",
  roleSlug: "superadmin",
  permissions: {},
  isSuperadmin: true,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request-1",
};

function config(overrides: Partial<MinkConfig> = {}): MinkConfig {
  return {
    enabled: true,
    betaRequireInvite: true,
    // Off, matching production: the orchestrator must behave identically
    // whether or not a run is billed.
    chargeCredits: false,
    projectId: "project-1",
    location: "global",
    model: "gemini-3.7-flash",
    imageModel: "gemini-3.1-flash-image",
    imageLocation: "global",
    maxSteps: 8,
    maxToolCalls: 16,
    maxParallelReadTools: 4,
    maxOutputTokens: 2_048,
    maxModelRetries: 1,
    runTimeoutMs: 120_000,
    toolRouting: true,
    liteModel: "gemini-3.5-flash-lite",
    liteRouting: false,
    ...overrides,
  };
}

function turn(overrides: Partial<MinkModelTurn> = {}): MinkModelTurn {
  return {
    text: "",
    functionCalls: [],
    usage: ZERO_USAGE,
    retryCount: 0,
    ...overrides,
  };
}

function registry() {
  return new MinkToolRegistry([
    {
      declaration: {
        name: "get_store_profile",
        description: "Read store.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      permission: { section: "dashboard", action: "view" },
      timeoutMs: 5_000,
      execute: vi.fn(async (actor) => ({ storeId: actor.storeId })),
    },
  ]);
}

describe("runMinkAgent", () => {
  it("executes model-selected reads, returns results, and accumulates usage", async () => {
    const sendToolResponses = vi.fn(async () =>
      turn({
        text: "Your store is ready.",
        usage: {
          promptTokens: 20,
          outputTokens: 5,
          thoughtTokens: 2,
          totalTokens: 27,
          cachedTokens: 12,
          basePromptTokens: 0,
        },
      }),
    );
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [
            { id: "call-1", name: "get_store_profile", args: {} },
          ],
          usage: {
            promptTokens: 10,
            outputTokens: 3,
            thoughtTokens: 1,
            totalTokens: 14,
            cachedTokens: 7,
            basePromptTokens: 0,
          },
        }),
      ),
      sendToolResponses,
    };
    const onEvent = vi.fn();

    const result = await runMinkAgent({
      actor: ACTOR,
      message: "How is my store?",
      config: config(),
      registry: registry(),
      session,
      onEvent,
    });

    expect(sendToolResponses).toHaveBeenCalledWith(
      [
        {
          id: "call-1",
          name: "get_store_profile",
          response: { output: { storeId: "store-1" } },
        },
      ],
      expect.objectContaining({
        onDelta: expect.any(Function),
        onReset: expect.any(Function),
      }),
    );
    expect(result).toEqual({
      text: "Your store is ready.",
      model: "gemini-3.7-flash",
      steps: 2,
      toolCalls: 1,
      retryCount: 0,
      usage: {
        promptTokens: 30,
        outputTokens: 8,
        thoughtTokens: 3,
        totalTokens: 41,
        // 7 + 12. Each step re-sends the same deterministic system+tools
        // prefix, so the run-level cached figure has to be the SUM across
        // steps — that total is what the cost estimate prices against.
        cachedTokens: 19,
        basePromptTokens: 0,
      },
      artifacts: [],
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "tool_call",
      sequence: 1,
      call: { id: "call-1", name: "get_store_profile", args: {} },
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "tool_result",
      sequence: 1,
      name: "get_store_profile",
      ok: true,
    });
  });

  it("accumulates retry telemetry and reports progress without changing tool execution", async () => {
    const onProgress = vi.fn();
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [{ name: "get_store_profile", args: {} }],
          retryCount: 1,
        }),
      ),
      sendToolResponses: vi.fn(async () =>
        turn({ text: "Ready.", retryCount: 1 }),
      ),
    };

    const result = await runMinkAgent({
      actor: ACTOR,
      message: "Check my store.",
      config: config(),
      registry: registry(),
      session,
      onProgress,
    });

    expect(result.retryCount).toBe(2);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ steps: 2, toolCalls: 1, retryCount: 2 }),
    );
  });

  it("keeps an unknown first prompt unknown when a later turn reports usage", async () => {
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({ functionCalls: [{ name: "get_store_profile", args: {} }] }),
      ),
      sendToolResponses: vi.fn(async () =>
        turn({
          text: "Ready.",
          usage: {
            promptTokens: 20_000,
            outputTokens: 10,
            thoughtTokens: 0,
            totalTokens: 20_010,
            cachedTokens: 0,
            basePromptTokens: 20_000,
          },
        }),
      ),
    };

    const result = await runMinkAgent({
      actor: ACTOR,
      message: "Check my store.",
      config: config(),
      registry: registry(),
      session,
    });

    expect(result.usage.basePromptTokens).toBe(0);
    expect(result.usage.promptTokens).toBe(20_000);
  });

  it("stops before exceeding the reasoning-step cap", async () => {
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [{ name: "get_store_profile", args: {} }],
        }),
      ),
      sendToolResponses: vi.fn(),
    };

    await expect(
      runMinkAgent({
        actor: ACTOR,
        message: "Keep reading forever.",
        config: config({ maxSteps: 1 }),
        registry: registry(),
        session,
      }),
    ).rejects.toMatchObject({ code: "step_limit_reached" });
    expect(session.sendToolResponses).not.toHaveBeenCalled();
  });

  it("finishes the observed offer-banner trace when its proposal is selected on the last turn", async () => {
    // Production, 2026-09-20: eleven completed tool rounds made these fifteen
    // successful calls. The image was ready, and a twelfth model turn returned
    // another function call, but the old top-of-loop guard rejected it before
    // even recording its name. Supply the expected final layout proposal here
    // to pin the completion path that was previously impossible at the cap.
    const toolTurns = [
      ["list_current_offers", "get_storefront_page_context"],
      ["get_storefront_section_context", "list_storefront_media"],
      ["search_help_centre"],
      ["search_help_centre"],
      ["list_storefront_pages"],
      ["search_help_centre"],
      ["search_help_centre"],
      ["search_products", "search_products"],
      ["get_catalog_summary"],
      ["search_products", "search_products"],
      ["generate_storefront_image"],
      ["propose_storefront_layout"],
    ];
    const names = [...new Set(toolTurns.flat())];
    const traceRegistry = new MinkToolRegistry(
      names.map((name) => ({
        declaration: {
          name,
          description: name,
          parametersJsonSchema: { type: "object", properties: {} },
        },
        permission: { section: "dashboard", action: "view" },
        timeoutMs: 5_000,
        ...(name === "propose_storefront_layout"
          ? {
              stepLimitCompletionText: "The layout proposal is ready.",
              artifact: () =>
                ({
                  type: "storefront_layout_proposal",
                  title: "Home",
                }) as never,
            }
          : {}),
        execute: vi.fn(async () => ({ ok: true })),
      })),
    );
    let nextTurn = 0;
    const modelTurn = () =>
      turn({
        functionCalls: toolTurns[nextTurn++].map((name, index) => ({
          id: `turn-${nextTurn}-call-${index + 1}`,
          name,
          args: { sequence: nextTurn, index },
        })),
      });
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () => modelTurn()),
      // There must be no thirteenth, prose-only model call after the final
      // proposal: deterministic completion is the bounded cost of this fix.
      sendToolResponses: vi.fn(async () => modelTurn()),
    };
    const onEvent = vi.fn();

    const result = await runMinkAgent({
      actor: ACTOR,
      message:
        "Create the banner on the homepage carousel for this buy 1 get 1 offer.",
      config: config({ maxSteps: 12, maxToolCalls: 16 }),
      registry: traceRegistry,
      session,
      onEvent,
    });

    expect(result).toMatchObject({
      text: "The layout proposal is ready.",
      steps: 12,
      toolCalls: 16,
      artifacts: [{ type: "storefront_layout_proposal" }],
    });
    expect(session.sendToolResponses).toHaveBeenCalledTimes(11);
    expect(onEvent).toHaveBeenCalledWith({
      type: "tool_call",
      sequence: 16,
      call: expect.objectContaining({ name: "propose_storefront_layout" }),
    });
  });

  it("does not spend the last-turn escape hatch on a read", async () => {
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [{ name: "get_store_profile", args: {} }],
        }),
      ),
      sendToolResponses: vi.fn(),
    };

    await expect(
      runMinkAgent({
        actor: ACTOR,
        message: "Keep reading forever.",
        config: config({ maxSteps: 1 }),
        registry: registry(),
        session,
      }),
    ).rejects.toMatchObject({ code: "step_limit_reached" });
    expect(session.sendToolResponses).not.toHaveBeenCalled();
  });

  it("does not claim last-turn success when a marked finalizer produces no review artifact", async () => {
    const finalizerRegistry = new MinkToolRegistry([
      {
        declaration: {
          name: "propose_storefront_layout",
          description: "Propose a layout.",
          parametersJsonSchema: { type: "object", properties: {} },
        },
        permission: { section: "dashboard", action: "view" },
        timeoutMs: 5_000,
        stepLimitCompletionText: "The layout proposal is ready.",
        execute: vi.fn(async () => ({ ok: true })),
      },
    ]);
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [{ name: "propose_storefront_layout", args: {} }],
        }),
      ),
      sendToolResponses: vi.fn(),
    };

    await expect(
      runMinkAgent({
        actor: ACTOR,
        message: "Create the banner.",
        config: config({ maxSteps: 1 }),
        registry: finalizerRegistry,
        session,
      }),
    ).rejects.toMatchObject({ code: "step_limit_reached" });
    expect(session.sendToolResponses).not.toHaveBeenCalled();
  });

  it("finishes a bounded compound workflow that needs more than eight model turns", async () => {
    let completedToolTurns = 0;
    const anotherRead = () =>
      turn({
        functionCalls: [{ name: "get_store_profile", args: {} }],
      });
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () => anotherRead()),
      sendToolResponses: vi.fn(async () => {
        completedToolTurns += 1;
        return completedToolTurns < 8
          ? anotherRead()
          : turn({ text: "The image and homepage proposal are ready." });
      }),
    };

    const result = await runMinkAgent({
      actor: ACTOR,
      message: "Create an image and prepare my homepage carousel.",
      config: config({ maxSteps: 12 }),
      registry: registry(),
      session,
    });

    expect(result).toMatchObject({ steps: 9, toolCalls: 8 });
    expect(result.text).toContain("homepage proposal");
  });

  it("rejects an empty final answer", async () => {
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () => turn()),
      sendToolResponses: vi.fn(),
    };

    await expect(
      runMinkAgent({
        actor: ACTOR,
        message: "Hello",
        config: config(),
        registry: registry(),
        session,
      }),
    ).rejects.toMatchObject({ code: "empty_model_response" });
  });
});

// ---------------------------------------------------------------------------
// ★★ A REPEATED PURE READ COSTS NO TOOL BUDGET.
//
// Observed on a live run that failed at the step limit: 15 tool calls, every
// one SUCCEEDED, and 8 of them repeated 4 reads the model had already made — so
// it never reached the tools that would have finished the job. The runtime
// prompt already asks it not to repeat a successful read; the memo makes that
// true whether or not the model complies.
// ---------------------------------------------------------------------------
describe("repeated tool calls", () => {
  function memoRegistry(repeatSafe: boolean, execute = vi.fn()) {
    return new MinkToolRegistry([
      {
        declaration: {
          name: "search_products",
          description: "Find products.",
          parametersJsonSchema: { type: "object", properties: {} },
        },
        permission: { section: "products", action: "view" },
        timeoutMs: 5_000,
        repeatSafe,
        artifact: () => ({ type: "records", title: "Products" }) as never,
        execute,
      },
    ]);
  }

  /** Two turns each asking for the same read, then a final answer. */
  function twiceThenAnswer(
    args: [Record<string, unknown>, Record<string, unknown>],
  ) {
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [{ id: "c1", name: "search_products", args: args[0] }],
        }),
      ),
      sendToolResponses: vi
        .fn()
        .mockResolvedValueOnce(
          turn({
            functionCalls: [
              { id: "c2", name: "search_products", args: args[1] },
            ],
          }),
        )
        .mockResolvedValueOnce(turn({ text: "Done." })),
    };
    return session;
  }

  it("serves an identical repeat from the memo and does not re-execute it", async () => {
    const execute = vi.fn(async () => ({ items: [] }));
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: memoRegistry(true, execute),
      session: twiceThenAnswer([{ q: "chair" }, { q: "chair" }]),
    });

    expect(execute).toHaveBeenCalledTimes(1);
    // The budget only counts what actually ran — the point of the whole fix.
    expect(result.toolCalls).toBe(1);
  });

  it("★ key order does not make two identical calls look different", async () => {
    const execute = vi.fn(async () => ({ items: [] }));
    await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: memoRegistry(true, execute),
      session: twiceThenAnswer([
        { q: "chair", limit: 5 },
        { limit: 5, q: "chair" },
      ]),
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("★ a DIFFERENT argument is a different call and still runs", async () => {
    const execute = vi.fn(async () => ({ items: [] }));
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: memoRegistry(true, execute),
      session: twiceThenAnswer([{ q: "chair" }, { q: "lamp" }]),
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toBe(2);
  });

  // ⚠ Opt-in, and it must stay opt-in: the tools that are NOT marked are the
  // ones that queue a workflow, create a proposal, or spend money on an image.
  it("★★ never de-duplicates a tool that is not marked repeat-safe", async () => {
    const execute = vi.fn(async () => ({ items: [] }));
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: memoRegistry(false, execute),
      session: twiceThenAnswer([{ q: "chair" }, { q: "chair" }]),
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toBe(2);
  });

  // ⚠ A failure is often transient; replaying it would deny the model its one
  // legitimate retry.
  it("★ does not remember a failed read", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ items: [] });
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: memoRegistry(true, execute),
      session: twiceThenAnswer([{ q: "chair" }, { q: "chair" }]),
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toBe(2);
  });

  // ⚠ The card is already on screen from the first call; pushing it again
  // renders a duplicate.
  it("★ a repeat adds no second artifact", async () => {
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: memoRegistry(
        true,
        vi.fn(async () => ({ items: [] })),
      ),
      session: twiceThenAnswer([{ q: "chair" }, { q: "chair" }]),
    });

    expect(result.artifacts).toHaveLength(1);
  });

  // ★★ EVERY EMITTED SEQUENCE INSERTS A `mink_tool_calls` ROW UNDER A UNIQUE
  // (run, sequence), so a re-used number is not a cosmetic numbering slip — it
  // is a rejected insert that kills the run. When the memo stopped counting
  // repeats against `toolCalls`, that same variable was still the base for the
  // sequence, so a turn holding a hit advanced numbering by less than it
  // emitted and the NEXT turn collided. Observed in production at sequence 5,
  // reported to the merchant as "Mink AI couldn't complete that request."
  it("★★ numbers every call it emits, so a memo hit cannot re-use a sequence", async () => {
    const onEvent = vi.fn();
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [
            { id: "c1", name: "search_products", args: { q: "a" } },
          ],
        }),
      ),
      sendToolResponses: vi
        .fn()
        // Two calls, one of them a repeat of the first turn's read.
        .mockResolvedValueOnce(
          turn({
            functionCalls: [
              { id: "c2", name: "search_products", args: { q: "a" } },
              { id: "c3", name: "search_products", args: { q: "b" } },
            ],
          }),
        )
        .mockResolvedValueOnce(
          turn({
            functionCalls: [
              { id: "c4", name: "search_products", args: { q: "c" } },
            ],
          }),
        )
        .mockResolvedValueOnce(turn({ text: "Done." })),
    };

    const result = await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: memoRegistry(
        true,
        vi.fn(async () => ({ items: [] })),
      ),
      session,
      onEvent,
    });

    const sequences = onEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "tool_call")
      .map((event) => event.sequence);
    expect(sequences).toEqual([1, 2, 3, 4]);
    expect(new Set(sequences).size).toBe(sequences.length);
    // And the budget still ignores the repeat — the two counters are separate,
    // not merely renamed.
    expect(result.toolCalls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// ★★ WHAT A RUN PRODUCED, NOT WHAT IT READ.
//
// Reported on a live "create the banner on the homepage carousel for this buy
// 1 get 1 offer": the answer carried the page's whole section list, the media
// library, two individual section cards AND the proposal. Every read tool emits
// a card, so an action run stacks its own research in front of the one thing
// the merchant asked for.
// ---------------------------------------------------------------------------
describe("artifacts a run returns", () => {
  function artifactRegistry(artifact: (result: unknown) => unknown) {
    return new MinkToolRegistry([
      {
        declaration: {
          name: "get_storefront_page_context",
          description: "Read a page.",
          parametersJsonSchema: { type: "object", properties: {} },
        },
        permission: { section: "builder", action: "view" },
        timeoutMs: 5_000,
        artifact: artifact as never,
        execute: vi.fn(async () => ({ ok: true })),
      },
      {
        declaration: {
          name: "propose_storefront_layout",
          description: "Propose a layout.",
          parametersJsonSchema: { type: "object", properties: {} },
        },
        permission: { section: "builder", action: "manage" },
        timeoutMs: 5_000,
        artifact: () =>
          ({ type: "storefront_layout_proposal", title: "Home" }) as never,
        execute: vi.fn(async () => ({ ok: true })),
      },
    ]);
  }

  const session = (names: string[]): MinkModelSession => ({
    sendUserMessage: vi.fn(async () =>
      turn({
        functionCalls: names.map((name, i) => ({
          id: `c${i}`,
          name,
          args: {},
        })),
      }),
    ),
    sendToolResponses: vi.fn(async () => turn({ text: "Done." })),
  });

  it("★★ drops the reads that fed a proposal", async () => {
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "create the banner",
      config: config(),
      registry: artifactRegistry(
        () => ({ type: "records", title: "Page" }) as never,
      ),
      session: session([
        "get_storefront_page_context",
        "propose_storefront_layout",
      ]),
    });

    expect(result.artifacts.map((a) => a.type)).toEqual([
      "storefront_layout_proposal",
    ]);
  });

  it("★★ a read-heavy run cannot crowd the proposal out of its own answer", async () => {
    const reads = Array.from(
      { length: 8 },
      () => "get_storefront_page_context",
    );
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "create the banner",
      config: config({ maxParallelReadTools: 12 }),
      registry: artifactRegistry(
        () => ({ type: "records", title: "Page" }) as never,
      ),
      // Eight reads would have filled the old flat cap of six before the
      // proposal was ever made.
      session: session([...reads, "propose_storefront_layout"]),
    });

    expect(result.artifacts.map((a) => a.type)).toEqual([
      "storefront_layout_proposal",
    ]);
  });

  it("★ but a read IS the answer when nothing was produced", async () => {
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "what is on my home page",
      config: config(),
      registry: artifactRegistry(
        () => ({ type: "records", title: "Page" }) as never,
      ),
      session: session(["get_storefront_page_context"]),
    });

    expect(result.artifacts.map((a) => a.type)).toEqual(["records"]);
  });
});

describe("★★ streamed answers", () => {
  it("forwards each visible fragment as it arrives and keeps the finished text", async () => {
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async (_message, options) => {
        options?.onDelta?.("Your ");
        options?.onDelta?.("store is ready.");
        return turn({ text: "Your store is ready." });
      }),
      sendToolResponses: vi.fn(),
    };
    const onEvent = vi.fn();

    const result = await runMinkAgent({
      actor: ACTOR,
      message: "How is my store?",
      config: config(),
      registry: registry(),
      session,
      onEvent,
    });

    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "text_delta", text: "Your " },
      { type: "text_delta", text: "store is ready." },
    ]);
    expect(result.text).toBe("Your store is ready.");
  });

  it("withdraws fragments of a turn that ends in a tool call, so working-out is never the answer", async () => {
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async (_message, options) => {
        options?.onDelta?.("Let me check.");
        return turn({
          functionCalls: [
            { id: "call-1", name: "get_store_profile", args: {} },
          ],
        });
      }),
      sendToolResponses: vi.fn(async (_responses, options) => {
        options?.onDelta?.("All good.");
        return turn({ text: "All good." });
      }),
    };
    const onEvent = vi.fn();

    const result = await runMinkAgent({
      actor: ACTOR,
      message: "How is my store?",
      config: config(),
      registry: registry(),
      session,
      onEvent,
    });

    const types = onEvent.mock.calls.map(([event]) => event.type);
    expect(types).toEqual([
      "text_delta",
      "text_reset",
      "tool_call",
      "tool_result",
      "text_delta",
    ]);
    expect(types.indexOf("text_reset")).toBeLessThan(
      types.indexOf("tool_call"),
    );
    expect(result.text).toBe("All good.");
  });

  it("relays a provider retry's reset so the client discards the first attempt's text", async () => {
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async (_message, options) => {
        options?.onDelta?.("Half an ans");
        options?.onReset?.();
        options?.onDelta?.("A whole answer.");
        return turn({ text: "A whole answer.", retryCount: 1 });
      }),
      sendToolResponses: vi.fn(),
    };
    const onEvent = vi.fn();

    await runMinkAgent({
      actor: ACTOR,
      message: "Hi",
      config: config(),
      registry: registry(),
      session,
      onEvent,
    });

    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "text_delta", text: "Half an ans" },
      { type: "text_reset" },
      { type: "text_delta", text: "A whole answer." },
    ]);
  });
});

describe("★★ request_more_tools", () => {
  const USAGE = (prompt: number): MinkUsage => ({
    promptTokens: prompt,
    outputTokens: 5,
    thoughtTokens: 0,
    totalTokens: prompt + 5,
    cachedTokens: 0,
    basePromptTokens: prompt,
  });

  function toolsRegistry(execute = vi.fn(async () => ({ ok: true }))) {
    const tool = (name: string, flags: Record<string, boolean> = {}) => ({
      declaration: {
        name,
        description: name,
        parametersJsonSchema: { type: "object", properties: {} },
      },
      permission: { section: "dashboard", action: "view" } as const,
      timeoutMs: 5_000,
      ...flags,
      execute,
    });
    return {
      execute,
      registry: new MinkToolRegistry([
        tool("search_products", { repeatSafe: true }),
        tool("open_dashboard_page", { restartSafe: true }),
        tool("propose_social_posts"),
      ]),
    };
  }

  /** A session that widens once, on the main model. */
  function widening(turns: {
    narrow: MinkModelTurn[];
    widened: MinkModelTurn[];
  }) {
    let model = "gemini-3.5-flash-lite";
    let queue = [...turns.narrow];
    const restartWithAllTools = vi.fn(() => {
      if (model !== "gemini-3.5-flash-lite") return false;
      model = "gemini-3.7-flash";
      queue = [...turns.widened];
      return true;
    });
    const next = async () => {
      const value = queue.shift();
      if (!value) throw new Error("no turn left");
      return value;
    };
    const session: MinkModelSession = {
      get model() {
        return model;
      },
      restartWithAllTools,
      sendUserMessage: vi.fn(next),
      sendToolResponses: vi.fn(next),
    };
    return { session, restartWithAllTools };
  }

  it("starts again with every tool on the main model, metering only the new attempt", async () => {
    const { registry: tools, execute } = toolsRegistry();
    const { session, restartWithAllTools } = widening({
      narrow: [
        turn({
          functionCalls: [{ id: "a", name: "search_products", args: {} }],
          usage: USAGE(1_000),
        }),
        turn({
          functionCalls: [
            {
              id: "b",
              name: "request_more_tools",
              args: { reason: "Needs the social post tool." },
            },
          ],
          usage: USAGE(1_200),
        }),
      ],
      widened: [
        turn({
          functionCalls: [{ id: "c", name: "propose_social_posts", args: {} }],
          usage: USAGE(9_000),
        }),
        turn({ text: "Your posts are ready.", usage: USAGE(9_400) }),
      ],
    });
    const onEvent = vi.fn();

    const result = await runMinkAgent({
      actor: ACTOR,
      message: "Write instagram posts for the sale",
      config: config(),
      registry: tools,
      session,
      onEvent,
    });

    expect(restartWithAllTools).toHaveBeenCalledOnce();
    // The merchant's message is asked again on the widened chat.
    expect(session.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("Your posts are ready.");
    expect(result.model).toBe("gemini-3.7-flash");
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toBe(1);
    // ★ The miss is reported apart, never in what the merchant is metered on.
    expect(result.usage.promptTokens).toBe(18_400);
    expect(result.usage.basePromptTokens).toBe(9_000);
    expect(result.restart).toEqual({
      abandonedModel: "gemini-3.5-flash-lite",
      usage: expect.objectContaining({ promptTokens: 2_200 }),
      steps: 2,
      toolCalls: 1,
    });
    expect(
      onEvent.mock.calls.map(([event]) => event.type).filter(Boolean),
    ).toContain("tools_restarted");
    // The escape hatch itself is never recorded as a tool call.
    expect(
      onEvent.mock.calls.some(
        ([event]) =>
          event.type === "tool_call" &&
          event.call.name === "request_more_tools",
      ),
    ).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("★ drops calls made beside the request instead of running them", async () => {
    const { registry: tools, execute } = toolsRegistry();
    const { session } = widening({
      narrow: [
        turn({
          functionCalls: [
            { id: "a", name: "propose_social_posts", args: {} },
            { id: "b", name: "request_more_tools", args: { reason: "x" } },
          ],
        }),
      ],
      widened: [turn({ text: "Done." })],
    });
    await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: tools,
      session,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("★ a restart-safe navigation does not block the restart", async () => {
    const { registry: tools } = toolsRegistry();
    const { session, restartWithAllTools } = widening({
      narrow: [
        turn({
          functionCalls: [{ id: "a", name: "open_dashboard_page", args: {} }],
        }),
        turn({
          functionCalls: [
            { id: "b", name: "request_more_tools", args: { reason: "x" } },
          ],
        }),
      ],
      widened: [turn({ text: "Done." })],
    });
    await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: tools,
      session,
    });
    expect(restartWithAllTools).toHaveBeenCalledOnce();
  });

  it("★★ refuses once something has been prepared, so nothing happens twice", async () => {
    const { registry: tools, execute } = toolsRegistry();
    const { session, restartWithAllTools } = widening({
      narrow: [
        turn({
          functionCalls: [{ id: "a", name: "propose_social_posts", args: {} }],
        }),
        turn({
          functionCalls: [
            { id: "b", name: "request_more_tools", args: { reason: "x" } },
          ],
        }),
        turn({ text: "Your posts are ready; ask me for the rest." }),
      ],
      widened: [],
    });

    const result = await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: tools,
      session,
    });

    expect(restartWithAllTools).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(result.restart).toBeUndefined();
    expect(result.model).toBe("gemini-3.5-flash-lite");
    expect(session.sendToolResponses).toHaveBeenLastCalledWith(
      [
        {
          id: "b",
          name: "request_more_tools",
          response: {
            error: expect.objectContaining({
              code: "more_tools_unavailable",
              message: expect.stringContaining("already prepared or queued"),
            }),
          },
        },
      ],
      expect.anything(),
    );
  });

  it("answers the request in place when the session cannot widen", async () => {
    const { registry: tools } = toolsRegistry();
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [
            { id: "b", name: "request_more_tools", args: { reason: "x" } },
          ],
        }),
      ),
      sendToolResponses: vi.fn(async () => turn({ text: "I can't do that." })),
    };
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: tools,
      session,
    });
    expect(result.text).toBe("I can't do that.");
    expect(result.model).toBe("gemini-3.7-flash");
    expect(session.sendToolResponses).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          response: {
            error: expect.objectContaining({
              message: expect.stringContaining("already declared"),
            }),
          },
        }),
      ],
      expect.anything(),
    );
  });

  it("★ forgets the abandoned attempt's reads, so the new attempt reads afresh", async () => {
    const { registry: tools, execute } = toolsRegistry();
    const { session } = widening({
      narrow: [
        turn({
          functionCalls: [{ id: "a", name: "search_products", args: {} }],
        }),
        turn({
          functionCalls: [
            { id: "b", name: "request_more_tools", args: { reason: "x" } },
          ],
        }),
      ],
      widened: [
        turn({
          functionCalls: [{ id: "c", name: "search_products", args: {} }],
        }),
        turn({ text: "Done." }),
      ],
    });
    await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: tools,
      session,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    const last = (
      session.sendToolResponses as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)?.[0];
    expect(last[0].response.output).not.toHaveProperty(
      "alreadyRequestedInThisRun",
    );
  });
});
