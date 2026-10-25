import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MinkRequestError,
  MinkToolInputError,
  MinkToolTimeoutError,
} from "../errors";
import type { MinkActorContext } from "../types";

const h = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: h.logError,
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import {
  MinkToolRegistry,
  TOOL_COMMIT_GRACE_MS,
  type MinkTool,
  type MinkToolContext,
} from "./registry";

const logError = h.logError;

function actor(overrides: Partial<MinkActorContext> = {}): MinkActorContext {
  return {
    storeId: "store-1",
    adminId: "admin-1",
    email: "owner@example.com",
    roleSlug: "member",
    permissions: {},
    isSuperadmin: false,
    effectivePlan: "pro",
    locationIds: null,
    analyticsTimeZone: "Asia/Kolkata",
    currency: "INR",
    defaultLowStockThreshold: 5,
    requestId: "request-1",
    ...overrides,
  };
}

function tool(overrides: Partial<MinkTool> = {}): MinkTool {
  return {
    declaration: {
      name: "read_products",
      description: "Read products.",
      parametersJsonSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    permission: { section: "products", action: "view" },
    timeoutMs: 5_000,
    execute: vi.fn(async (ctx) => ({ storeIdUsed: ctx.storeId })),
    ...overrides,
  };
}

describe("MinkToolRegistry", () => {
  it("only declares tools allowed by trusted actor permissions", () => {
    const registry = new MinkToolRegistry([tool()]);

    expect(registry.declarationsFor(actor())).toEqual([]);
    expect(
      registry.declarationsFor(
        actor({ permissions: { products: ["manage"] } }),
      ),
    ).toHaveLength(1);
  });

  it("rechecks permissions when a hidden tool name is submitted directly", async () => {
    const execute = vi.fn(async () => ({ secret: "should not run" }));
    const registry = new MinkToolRegistry([tool({ execute })]);

    const response = await registry.execute(actor(), {
      id: "call-1",
      name: "read_products",
      args: { storeId: "other-store" },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(response).toEqual({
      id: "call-1",
      name: "read_products",
      response: {
        error: {
          code: "permission_denied",
          message: "The current admin is not allowed to use this tool.",
        },
      },
    });
  });

  it("passes the server actor unchanged and converts input errors safely", async () => {
    const execute = vi.fn(async (ctx: MinkActorContext) => {
      expect(ctx.storeId).toBe("store-1");
      throw new MinkToolInputError("query is invalid.");
    });
    const registry = new MinkToolRegistry([tool({ execute })]);
    const trustedActor = actor({ permissions: { products: ["view"] } });

    const response = await registry.execute(trustedActor, {
      name: "read_products",
      args: { storeId: "other-store" },
    });

    expect(execute).toHaveBeenCalledWith(
      trustedActor,
      { storeId: "other-store" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(response.response).toEqual({
      error: { code: "invalid_tool_input", message: "query is invalid." },
    });
  });

  it("rejects duplicate names so one tool cannot shadow another", () => {
    expect(() => new MinkToolRegistry([tool(), tool()])).toThrow(
      "Duplicate Mink tool: read_products",
    );
  });

  it("bounds a stalled read and returns a safe tool error", async () => {
    const registry = new MinkToolRegistry([
      tool({
        timeoutMs: 1,
        execute: vi.fn(() => new Promise<Record<string, unknown>>(() => {})),
      }),
    ]);

    await expect(
      registry.execute(actor({ permissions: { products: ["view"] } }), {
        name: "read_products",
        args: {},
      }),
    ).resolves.toMatchObject({
      response: {
        error: {
          code: "tool_timeout",
        },
      },
    });
  });
});

describe("per-actor declarations", () => {
  it("narrows the declaration to what this actor can satisfy", () => {
    const registry = new MinkToolRegistry([
      tool({
        declarationFor: (a) => ({
          name: "read_products",
          description: "Read products.",
          parametersJsonSchema: {
            type: "object",
            properties: {},
            required: a.isSuperadmin ? ["cover"] : [],
            additionalProperties: false,
          },
        }),
      }),
    ]);
    const limited = registry.declarationsFor(
      actor({ permissions: { products: ["view"] } }),
    );
    expect(
      (limited[0].parametersJsonSchema as { required: string[] }).required,
    ).toEqual([]);
    const full = registry.declarationsFor(actor({ isSuperadmin: true }));
    expect(
      (full[0].parametersJsonSchema as { required: string[] }).required,
    ).toEqual(["cover"]);
  });

  it("falls back to the static declaration when a tool defines none", () => {
    const registry = new MinkToolRegistry([tool()]);
    expect(
      registry
        .declarationsFor(actor({ permissions: { products: ["view"] } }))
        .map((d) => d.name),
    ).toEqual(["read_products"]);
  });

  // The registry is keyed on `declaration.name`, so a variant that renamed the
  // tool would be routable to the model and unroutable on the way back.
  it("is still executable under its registered name", async () => {
    const registry = new MinkToolRegistry([
      tool({
        declarationFor: () => ({
          name: "read_products",
          description: "Narrowed.",
          parametersJsonSchema: { type: "object", properties: {} },
        }),
      }),
    ]);
    const a = actor({ permissions: { products: ["view"] } });
    const [declared] = registry.declarationsFor(a);
    const result = await registry.execute(a, { name: declared.name, args: {} });
    expect(result.response.output).toEqual({ storeIdUsed: "store-1" });
  });
});

// ★★ A `MinkRequestError` CARRIES AN AUTHOR-WRITTEN, MERCHANT-SAFE SENTENCE —
//    the same text the HTTP routes return — and the catch-all replaced every
//    one with "could not finish right now". That is the difference between
//    the model rephrasing actionable advice and it retrying the same failing
//    input until the run's tool budget is gone.
describe("what the model is sent", () => {
  it("★★ sends a tool's narrowed output to the model, while its card still gets the whole output", async () => {
    const card = {
      type: "metric",
      title: "A card",
      value: "47 credits",
    } as never;
    const registry = new MinkToolRegistry([
      tool({
        execute: vi.fn(async () => ({ card, summary: { pages: 2 } })),
        artifact: (output) => output.card as never,
        modelOutput: (output) => ({ summary: output.summary }),
      }),
    ]);
    const response = await registry.execute(
      actor({ permissions: { products: ["view"] } }),
      { id: "call-1", name: "read_products", args: {} },
    );
    expect(response.response).toEqual({ output: { summary: { pages: 2 } } });
    expect(response.artifact).toBe(card);
  });

  it("sends the whole output when a tool names no narrowing", async () => {
    const registry = new MinkToolRegistry([tool()]);
    const response = await registry.execute(
      actor({ permissions: { products: ["view"] } }),
      { id: "call-1", name: "read_products", args: {} },
    );
    expect(response.response).toEqual({
      output: { storeIdUsed: "store-1" },
    });
  });
});

describe("tool failure messages", () => {
  it("forwards a MinkRequestError's own message", async () => {
    const registry = new MinkToolRegistry([
      tool({
        execute: vi.fn(async () => {
          throw new MinkRequestError(
            "image_preparation_source_failed",
            "Choose another image and try again.",
            422,
          );
        }),
      }),
    ]);
    const result = await registry.execute(
      actor({ permissions: { products: ["view"] } }),
      { name: "read_products", args: {} },
    );
    expect(result.response.error).toMatchObject({
      code: "tool_failed",
      message: "Choose another image and try again.",
    });
  });

  // Anything else still gets the generic text, so no database or stack
  // detail can reach the model context.
  it("keeps an unrecognised error generic", async () => {
    const registry = new MinkToolRegistry([
      tool({
        execute: vi.fn(async () => {
          throw new Error('relation "orders" does not exist');
        }),
      }),
    ]);
    const result = await registry.execute(
      actor({ permissions: { products: ["view"] } }),
      { name: "read_products", args: {} },
    );
    expect(result.response.error).toMatchObject({
      message: "The Mink AI tool could not finish right now.",
    });
  });
});

// ★★ B6 (2026-10-23): the registry raced a tool against a timer and walked
//    away when the timer won, leaving the tool running, so an image could be
//    saved and charged after the chat said the tool took too long.
describe("★★ a tool's deadline stops its work (B6)", () => {
  const viewer = () => actor({ permissions: { products: ["view"] } });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives the tool a signal that fires at its timeout, and its deadline", async () => {
    let seen: MinkToolContext | undefined;
    const registry = new MinkToolRegistry([
      tool({
        timeoutMs: 10_000,
        execute: vi.fn(
          (_actor, _args, context?: MinkToolContext) =>
            new Promise<Record<string, unknown>>((_, reject) => {
              seen = context;
              // Like a provider call: it stops when the signal fires.
              context!.signal.addEventListener("abort", () =>
                reject(new Error("This operation was aborted")),
              );
            }),
        ),
      }),
    ]);
    const started = Date.now();
    const pending = registry.execute(viewer(), {
      name: "read_products",
      args: {},
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(seen?.signal.aborted).toBe(false);
    expect(seen?.deadlineAt).toBe(started + 10_000);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(seen?.signal.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({
      response: { error: { code: "tool_timeout" } },
    });
  });

  it("★★ refuses a write once the time is up, without running it", async () => {
    const write = vi.fn(async () => "saved");
    let refusal: unknown;
    const registry = new MinkToolRegistry([
      tool({
        timeoutMs: 1_000,
        execute: vi.fn(async (_actor, _args, context?: MinkToolContext) => {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          refusal = await context!.commit(write).catch((error) => error);
          return { ok: true };
        }),
      }),
    ]);
    const pending = registry.execute(viewer(), {
      name: "read_products",
      args: {},
    });
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(pending).resolves.toMatchObject({
      response: { error: { code: "tool_timeout" } },
    });
    expect(write).not.toHaveBeenCalled();
    expect(refusal).toBeInstanceOf(MinkToolTimeoutError);
  });

  it("★★ a write under way at the deadline holds it, and its result is the answer", async () => {
    // The merchant is charged exactly when the chat shows the card.
    const registry = new MinkToolRegistry([
      tool({
        timeoutMs: 1_000,
        execute: vi.fn(async (_actor, _args, context?: MinkToolContext) => {
          await new Promise((resolve) => setTimeout(resolve, 900));
          const saved = await context!.commit(
            () =>
              new Promise<string>((resolve) =>
                setTimeout(() => resolve("draft-1"), 3_000),
              ),
          );
          return { saved };
        }),
      }),
    ]);
    const pending = registry.execute(viewer(), {
      name: "read_products",
      args: {},
    });
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(pending).resolves.toMatchObject({
      response: { output: { saved: "draft-1" } },
    });
  });

  it("★ a write that finished just before the deadline still gets its answer shown", async () => {
    // Charged at 900 ms; the tool then needs a moment to build its answer.
    const registry = new MinkToolRegistry([
      tool({
        timeoutMs: 1_000,
        execute: vi.fn(async (_actor, _args, context?: MinkToolContext) => {
          const saved = await context!.commit(
            () =>
              new Promise<string>((resolve) =>
                setTimeout(() => resolve("draft-1"), 900),
              ),
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { saved };
        }),
      }),
    ]);
    const pending = registry.execute(viewer(), {
      name: "read_products",
      args: {},
    });
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(pending).resolves.toMatchObject({
      response: { output: { saved: "draft-1" } },
    });
  });

  // ★★ A minute: the image tool's charged write is a few transactions, and
  //    since B27 each may wait 5 s for a connection and 30 s on a lock.
  it("★ the grace covers a write's bounded worst case, not only a quick one", () => {
    expect(TOOL_COMMIT_GRACE_MS).toBeGreaterThanOrEqual(45_000);
  });

  it("★ a write that outlives the grace is logged, so the charge can be given back", async () => {
    const registry = new MinkToolRegistry([
      tool({
        timeoutMs: 1_000,
        execute: vi.fn(async (_actor, _args, context?: MinkToolContext) => {
          await context!.commit(() => new Promise<never>(() => {}));
          return { ok: true };
        }),
      }),
    ]);
    const pending = registry.execute(viewer(), {
      name: "read_products",
      args: {},
    });
    await vi.advanceTimersByTimeAsync(1_000 + TOOL_COMMIT_GRACE_MS + 100);
    await expect(pending).resolves.toMatchObject({
      response: { error: { code: "tool_timeout" } },
    });
    expect(logError).toHaveBeenCalledWith(
      "mink.tool: write outlived its grace",
      undefined,
      expect.objectContaining({
        tool: "read_products",
        graceMs: TOOL_COMMIT_GRACE_MS,
      }),
    );
  });

  it("logs nothing when the time runs out with no write under way", async () => {
    const registry = new MinkToolRegistry([
      tool({
        timeoutMs: 1_000,
        execute: vi.fn(() => new Promise<never>(() => {})),
      }),
    ]);
    const pending = registry.execute(viewer(), {
      name: "read_products",
      args: {},
    });
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(pending).resolves.toMatchObject({
      response: { error: { code: "tool_timeout" } },
    });
    expect(logError.mock.calls.map(([message]) => message)).not.toContain(
      "mink.tool: write outlived its grace",
    );
  });

  it("★ holds for the grace only, then reports the timeout regardless", async () => {
    const registry = new MinkToolRegistry([
      tool({
        timeoutMs: 1_000,
        execute: vi.fn(async (_actor, _args, context?: MinkToolContext) => {
          await context!.commit(() => new Promise<never>(() => {}));
          return { ok: true };
        }),
      }),
    ]);
    const pending = registry.execute(viewer(), {
      name: "read_products",
      args: {},
    });
    await vi.advanceTimersByTimeAsync(1_000 + TOOL_COMMIT_GRACE_MS - 100);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({
      response: { error: { code: "tool_timeout" } },
    });
  });

  it("★ the run's stop fires the tool's signal", async () => {
    const run = new AbortController();
    let seen: MinkToolContext | undefined;
    const registry = new MinkToolRegistry([
      tool({
        timeoutMs: 60_000,
        execute: vi.fn(
          (_actor, _args, context?: MinkToolContext) =>
            new Promise<Record<string, unknown>>(() => {
              seen = context;
            }),
        ),
      }),
    ]);
    const pending = registry.execute(
      viewer(),
      { name: "read_products", args: {} },
      { signal: run.signal },
    );
    await vi.advanceTimersByTimeAsync(10);
    run.abort();
    await expect(pending).resolves.toMatchObject({
      response: { error: { code: "tool_timeout" } },
    });
    expect(seen?.signal.aborted).toBe(true);
  });

  it("★ does not start a tool for a run that has already stopped", async () => {
    const run = new AbortController();
    run.abort();
    const execute = vi.fn(async () => ({ ok: true }));
    const registry = new MinkToolRegistry([tool({ execute })]);
    await expect(
      registry.execute(
        viewer(),
        { name: "read_products", args: {} },
        { signal: run.signal },
      ),
    ).resolves.toMatchObject({
      response: { error: { code: "tool_timeout" } },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
