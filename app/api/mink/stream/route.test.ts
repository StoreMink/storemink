import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/mink/memories", () => ({
  loadMinkMemoryReference: vi.fn(async () => ""),
  listMinkMemories: vi.fn(async () => []),
}));

const holder = vi.hoisted(() => ({
  enabled: true,
  run: vi.fn(),
  actor: vi.fn(),
  rateAllowed: true,
  startRun: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
  startTool: vi.fn(),
  completeTool: vi.fn(),
  runTimeoutMs: 120_000,
  toolRouting: false,
  liteRouting: false,
  declarations: [] as Array<{ name: string }>,
  createSession: vi.fn(() => ({})),
}));

vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({
    enabled: holder.enabled,
    betaRequireInvite: true,
    projectId: "project-1",
    location: "global",
    model: "gemini-3.7-flash",
    maxSteps: 8,
    maxToolCalls: 16,
    maxParallelReadTools: 4,
    maxOutputTokens: 2_048,
    maxModelRetries: 1,
    // Explicit, not merely absent: with charging on, the route would reach the
    // affordability read and settlement, so a future default flip must show up
    // here as a decision rather than as a surprise database call in a test.
    chargeCredits: false,
    runTimeoutMs: holder.runTimeoutMs,
    toolRouting: holder.toolRouting,
    liteModel: "gemini-3.5-flash-lite",
    liteRouting: holder.liteRouting,
  })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/orchestrator", () => ({
  runMinkAgent: holder.run,
}));
vi.mock("@/lib/mink/persistence", () => ({
  startMinkRun: holder.startRun,
  completeMinkRun: holder.completeRun,
  failMinkRun: holder.failRun,
  startMinkToolCall: holder.startTool,
  completeMinkToolCall: holder.completeTool,
}));
vi.mock("@/lib/mink/tools/read-tools", () => ({
  minkReadToolRegistry: {
    declarationsFor: vi.fn(() => holder.declarations),
  },
}));
vi.mock("@/lib/mink/vertex-client", () => ({
  createVertexMinkSession: holder.createSession,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.rateAllowed })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { POST } from "./route";
import { listMinkMemories, loadMinkMemoryReference } from "@/lib/mink/memories";

beforeEach(() => {
  vi.clearAllMocks();
  holder.enabled = true;
  holder.rateAllowed = true;
  holder.runTimeoutMs = 120_000;
  holder.toolRouting = false;
  holder.liteRouting = false;
  holder.declarations = [];
  holder.actor.mockResolvedValue({
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
  });
  holder.startRun.mockResolvedValue({
    conversationId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    history: [],
  });
  // completeMinkRun hands back what proposals in this run already charged, so
  // settlement can FOLD the run's band against it rather than stacking.
  holder.completeRun.mockResolvedValue({ draftCredits: 0 });
  holder.failRun.mockResolvedValue(undefined);
  holder.startTool.mockResolvedValue(undefined);
  holder.completeTool.mockResolvedValue(undefined);
  holder.run.mockResolvedValue({
    text: "You have 12 published products.",
    model: "gemini-3.7-flash",
    steps: 2,
    toolCalls: 1,
    retryCount: 0,
    usage: {
      promptTokens: 100,
      outputTokens: 20,
      thoughtTokens: 10,
      totalTokens: 130,
    },
    artifacts: [],
  });
});

describe("POST /api/mink/stream", () => {
  it("is unreachable until explicitly enabled", async () => {
    holder.enabled = false;
    const response = await POST(request({ message: "Hello" }));

    expect(response.status).toBe(404);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request before charging or reading store data", async () => {
    const response = await POST(
      request({ message: "Hello" }, { origin: "https://attacker.example" }),
    );

    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("accepts the public dashboard origin behind an internal proxy host", async () => {
    const publicHost = "echos.staging.storemink.com";
    const response = await POST(
      request(
        { message: "Hello" },
        {
          origin: `https://${publicHost}`,
          "x-forwarded-host": publicHost,
          host: "internal-service:8080",
        },
      ),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(holder.actor).toHaveBeenCalledOnce();
  });

  it("accepts a same-origin local store host without proxy headers", async () => {
    const response = await POST(
      request(
        { message: "Hello" },
        {
          origin: "http://echos.localhost:3000",
          host: "echos.localhost:3000",
        },
      ),
    );
    await response.text();

    expect(response.status).toBe(200);
  });

  it("returns app-level SSE events and trims the user message", async () => {
    const response = await POST(request({ message: "  Show my catalog  " }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(holder.run).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Show my catalog" }),
    );
    expect(holder.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Show my catalog",
        conversationId: undefined,
      }),
    );
    expect(holder.completeRun).toHaveBeenCalledOnce();
    expect(body).toContain("event: status");
    expect(body).toContain("11111111-1111-4111-8111-111111111111");
    expect(body).toContain("event: message");
    expect(body).toContain("You have 12 published products.");
    expect(body).toContain("event: usage");
    expect(body).toContain("event: done");
  });

  it("offers a lasting instruction back as a memory, after the answer", async () => {
    const response = await POST(
      request({ message: "From now on, always keep answers short." }),
    );
    const body = await response.text();
    const events = body
      .split("\n\n")
      .filter((block) => block.startsWith("event: "))
      .map((block) => block.slice(7, block.indexOf("\n")));
    expect(events.indexOf("memory_suggestion")).toBeGreaterThan(
      events.indexOf("message"),
    );
    expect(events.indexOf("memory_suggestion")).toBeLessThan(
      events.indexOf("done"),
    );
    expect(body).toContain(
      'event: memory_suggestion\ndata: {"kind":"preference","content":"From now on, always keep answers short.","title":"From now on, always keep answers short"}',
    );
    // A plain question offers nothing and reads no memories.
    vi.mocked(listMinkMemories).mockClear();
    const quiet = await (
      await POST(request({ message: "What were sales yesterday?" }))
    ).text();
    expect(quiet).not.toContain("event: memory_suggestion");
    expect(listMinkMemories).not.toHaveBeenCalled();
  });

  it("withholds the offer when the memories are full or already hold it", async () => {
    const kept = Array.from({ length: 10 }, (_, i) => ({
      id: `m-${i}`,
      title: `t${i}`,
      content: `c${i}`,
      kind: "preference" as const,
      version: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      usable: true,
    }));
    vi.mocked(listMinkMemories).mockResolvedValueOnce(kept);
    const full = await (
      await POST(
        request({ message: "From now on, always keep answers short." }),
      )
    ).text();
    expect(full).not.toContain("event: memory_suggestion");
    vi.mocked(listMinkMemories).mockResolvedValueOnce([
      { ...kept[0]!, content: "From now on, always keep answers short." },
    ]);
    const held = await (
      await POST(
        request({ message: "From now on, always keep answers short." }),
      )
    ).text();
    expect(held).not.toContain("event: memory_suggestion");
    // A failed read costs the offer, never the answer that preceded it.
    vi.mocked(listMinkMemories).mockRejectedValueOnce(new Error("down"));
    const failed = await (
      await POST(
        request({ message: "From now on, always keep answers short." }),
      )
    ).text();
    expect(failed).toContain("event: message");
    expect(failed).toContain("event: done");
    expect(failed).not.toContain("event: memory_suggestion");
  });

  it("forwards streamed text as delta events before the finished message", async () => {
    holder.run.mockImplementation(
      async (input: {
        onEvent?: (event: Record<string, unknown>) => Promise<void> | void;
      }) => {
        await input.onEvent?.({ type: "text_delta", text: "You have " });
        await input.onEvent?.({ type: "text_reset" });
        await input.onEvent?.({ type: "text_delta", text: "12 products." });
        return {
          text: "12 products.",
          model: "gemini-3.7-flash",
          steps: 1,
          toolCalls: 0,
          retryCount: 0,
          usage: {
            promptTokens: 10,
            outputTokens: 2,
            thoughtTokens: 0,
            totalTokens: 12,
          },
          artifacts: [],
        };
      },
    );
    const response = await POST(request({ message: "How many products?" }));
    const body = await response.text();

    const events = body
      .split("\n\n")
      .filter((block) => block.startsWith("event: "))
      .map((block) => block.slice(7, block.indexOf("\n")));
    expect(events).toEqual([
      "status",
      "delta",
      "delta_reset",
      "delta",
      "message",
      "usage",
      "done",
    ]);
    expect(body).toContain('event: delta\ndata: {"text":"You have "}');
    // A delta writes no telemetry row: only tool events do.
    expect(holder.startTool).not.toHaveBeenCalled();
  });

  it("★ streams a voice turn's spoken block apart from the written answer, and keeps only the written", async () => {
    holder.actor.mockResolvedValue({
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
      answerMedium: "spoken",
      requestId: "request-1",
    });
    holder.run.mockImplementation(
      async (input: {
        onEvent?: (event: Record<string, unknown>) => Promise<void> | void;
      }) => {
        await input.onEvent?.({ type: "text_delta", text: "<spok" });
        await input.onEvent?.({
          type: "text_delta",
          text: "en>You have twelve orders today.</spo",
        });
        await input.onEvent?.({ type: "text_delta", text: "ken>\n\n**12" });
        await input.onEvent?.({ type: "text_delta", text: " orders** today." });
        return {
          text: "<spoken>You have twelve orders today.</spoken>\n\n**12 orders** today.",
          model: "gemini-3.7-flash",
          steps: 1,
          toolCalls: 0,
          retryCount: 0,
          usage: {
            promptTokens: 10,
            outputTokens: 2,
            thoughtTokens: 0,
            totalTokens: 12,
          },
          artifacts: [],
        };
      },
    );
    const response = await POST(
      request({
        message: "How many orders today?",
        context: { currentPath: "/dashboard", voice: true },
      }),
    );
    const body = await response.text();
    const events = body
      .split("\n\n")
      .filter((block) => block.startsWith("event: "))
      .map((block) => block.slice(7, block.indexOf("\n")));
    expect(events).toEqual([
      "status",
      "spoken",
      "spoken_end",
      "delta",
      "delta",
      "message",
      "usage",
      "done",
    ]);
    expect(body).toContain(
      'event: spoken\ndata: {"text":"You have twelve orders today."}',
    );
    expect(body).toContain('event: delta\ndata: {"text":"\\n\\n**12"}');
    expect(body).toContain(
      'event: message\ndata: {"role":"assistant","text":"**12 orders** today.","spoken":"You have twelve orders today."',
    );
    // The persisted answer (and so the history replay) never carries the block.
    expect(holder.completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ text: "**12 orders** today." }),
      }),
    );
    expect(holder.actor).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        pageContext: expect.objectContaining({ voice: true }),
      }),
    );
  });

  function streamingRun(fragments: string[], text: string) {
    holder.run.mockImplementation(
      async (input: {
        onEvent?: (event: Record<string, unknown>) => Promise<void> | void;
      }) => {
        for (const fragment of fragments)
          await input.onEvent?.({ type: "text_delta", text: fragment });
        return {
          text,
          model: "gemini-3.7-flash",
          steps: 1,
          toolCalls: 0,
          retryCount: 0,
          usage: {
            promptTokens: 10,
            outputTokens: 2,
            thoughtTokens: 0,
            totalTokens: 12,
          },
          artifacts: [],
        };
      },
    );
  }

  function streamed(body: string) {
    const out = { events: [] as string[], written: "", spoken: "" };
    for (const block of body.split("\n\n")) {
      if (!block.startsWith("event: ")) continue;
      const event = block.slice(7, block.indexOf("\n"));
      out.events.push(event);
      const data = JSON.parse(block.slice(block.indexOf("data: ") + 6));
      if (event === "delta") out.written += data.text;
      if (event === "spoken") out.spoken += data.text;
    }
    return out;
  }

  it("★ flushes the tail the splitter held, so the streamed text adds up to the message", async () => {
    // A reply that ends in "<" holds it back in case a tag follows; the run
    // ending is what settles it, and the stream must still carry it.
    streamingRun(["Stock is low <"], "Stock is low <");
    const body = await (
      await POST(request({ message: "How is stock?" }))
    ).text();
    const { events, written } = streamed(body);
    expect(written).toBe("Stock is low <");
    expect(events.indexOf("delta")).toBeLessThan(events.indexOf("message"));
    expect(events.lastIndexOf("delta")).toBeLessThan(events.indexOf("message"));
    expect(body).toContain(
      'event: message\ndata: {"role":"assistant","text":"Stock is low <"',
    );
  });

  it("★ ends a spoken block the output limit cut short, never saying the cut tag", async () => {
    streamingRun(
      ["<spoken>You have twelve ", "orders today.</spo"],
      "<spoken>You have twelve orders today.</spo",
    );
    const body = await (
      await POST(
        request({
          message: "How many orders today?",
          context: { currentPath: "/dashboard", voice: true },
        }),
      )
    ).text();
    const { events, spoken } = streamed(body);
    expect(spoken).toBe("You have twelve orders today.");
    expect(events.filter((event) => event === "spoken_end")).toHaveLength(1);
    expect(events.indexOf("spoken_end")).toBeLessThan(
      events.indexOf("message"),
    );
    expect(body).toContain(
      'event: message\ndata: {"role":"assistant","text":"You have twelve orders today.","spoken":"You have twelve orders today."',
    );
  });

  it("★ stores a spoken-only voice reply as its written answer", async () => {
    holder.run.mockResolvedValue({
      text: "<spoken>You have twelve orders today.</spoken>",
      model: "gemini-3.7-flash",
      steps: 1,
      toolCalls: 0,
      retryCount: 0,
      usage: {
        promptTokens: 10,
        outputTokens: 2,
        thoughtTokens: 0,
        totalTokens: 12,
      },
      artifacts: [],
    });
    const response = await POST(
      request({
        message: "How many orders today?",
        context: { currentPath: "/dashboard", voice: true },
      }),
    );
    const body = await response.text();
    expect(holder.completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          text: "You have twelve orders today.",
        }),
      }),
    );
    expect(holder.failRun).not.toHaveBeenCalled();
    expect(body).toContain(
      'event: message\ndata: {"role":"assistant","text":"You have twelve orders today.","spoken":"You have twelve orders today."',
    );
  });

  it("★ fails a reply with no words at all instead of storing an empty message", async () => {
    holder.run.mockResolvedValue({
      text: "<spoken> </spoken>",
      model: "gemini-3.7-flash",
      steps: 1,
      toolCalls: 0,
      retryCount: 0,
      usage: {
        promptTokens: 10,
        outputTokens: 2,
        thoughtTokens: 0,
        totalTokens: 12,
      },
      artifacts: [],
    });
    const response = await POST(
      request({
        message: "How many orders today?",
        context: { currentPath: "/dashboard", voice: true },
      }),
    );
    const body = await response.text();
    expect(holder.completeRun).not.toHaveBeenCalled();
    expect(holder.failRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "empty_model_response",
      }),
    );
    expect(body).toContain('"code":"empty_model_response"');
  });

  it("marks a written turn's message with no spoken text and no tag handling", async () => {
    const response = await POST(request({ message: "How many products?" }));
    const body = await response.text();
    expect(body).toContain(
      'event: message\ndata: {"role":"assistant","text":"You have 12 published products.","spoken":null',
    );
    expect(body).not.toContain("event: spoken");
  });

  it("uses high thinking only for an authorised storefront code request", async () => {
    holder.declarations = [{ name: "propose_storefront_custom_code" }];
    const response = await POST(
      request({
        message: "Redesign my homepage hero and generate custom code",
      }),
    );
    await response.text();

    expect(holder.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingLevel: "high" }),
    );
    expect(holder.createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      holder.declarations,
      expect.objectContaining({ thinkingLevel: "high" }),
    );

    holder.declarations = [];
    const readResponse = await POST(
      request({
        message: "Redesign my homepage hero and generate custom code",
      }),
    );
    await readResponse.text();
    expect(holder.startRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ thinkingLevel: "low" }),
    );
  });

  it("rejects invalid messages before opening a model session", async () => {
    const response = await POST(request({ message: "   " }));

    expect(response.status).toBe(400);
    expect(holder.run).not.toHaveBeenCalled();
    expect(holder.startRun).not.toHaveBeenCalled();
  });

  it("loads fresh approved context but never persists it as the user's message", async () => {
    vi.mocked(loadMinkMemoryReference).mockResolvedValueOnce(
      "Private approved preference",
    );
    const response = await POST(request({ message: "Hello" }));
    await response.text();
    expect(holder.createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        memoryReference: "Private approved preference",
      }),
    );
    expect(holder.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Hello" }),
    );
  });
  it("fails closed on a memory read error before reserving credits or calling Vertex", async () => {
    vi.mocked(loadMinkMemoryReference).mockRejectedValueOnce(
      new Error("Memory DB unavailable"),
    );
    const response = await POST(request({ message: "Hello" }));
    expect(response.status).toBe(503);
    expect(holder.startRun).not.toHaveBeenCalled();
    expect(holder.createSession).not.toHaveBeenCalled();
  });
  it("bounds the actual body even without a length header", async () => {
    const response = await POST(
      request({ message: "Hello", padding: "x".repeat(66_000) }),
    );
    expect(response.status).toBe(413);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("rate limits per actor before calling Vertex", async () => {
    holder.rateAllowed = false;
    const response = await POST(request({ message: "Hello" }));

    expect(response.status).toBe(429);
    expect(holder.run).not.toHaveBeenCalled();
  });

  it("continues only a well-formed conversation id", async () => {
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const response = await POST(
      request({ message: "And drafts?", conversationId }),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(holder.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId }),
    );

    const rejected = await POST(
      request({ message: "And drafts?", conversationId: "not-an-id" }),
    );
    expect(rejected.status).toBe(400);
  });

  it("records a failed run before returning a safe SSE error", async () => {
    holder.run.mockRejectedValueOnce(new Error("database details"));
    const response = await POST(request({ message: "Show my catalog" }));
    const body = await response.text();

    expect(holder.failRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "mink_failed" }),
    );
    expect(body).toContain("Mink AI couldn't complete that request.");
    expect(body).not.toContain("database details");
  });

  it("fails a hard-timeout run instead of recording it as user cancellation", async () => {
    holder.runTimeoutMs = 5;
    holder.run.mockImplementationOnce(
      () =>
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new DOMException("aborted", "AbortError")),
            10,
          ),
        ),
    );
    const response = await POST(request({ message: "Slow question" }));
    const body = await response.text();

    expect(holder.failRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "run_timeout" }),
    );
    expect(body).toContain("Mink AI took too long to finish");
  });
});

describe("★★ tool routing", () => {
  /** createVertexMinkSession's arguments, typed for these assertions. */
  function sessionCall(index: number) {
    return holder.createSession.mock.calls[index] as unknown as [
      unknown,
      unknown,
      Array<{ name: string }>,
      Record<string, unknown>,
    ];
  }
  const PERMITTED = [
    "get_store_profile",
    "get_sales_summary",
    "query_analytics",
    "search_help_centre",
    "generate_storefront_image",
    "propose_storefront_layout",
  ].map((name) => ({ name, description: name, parametersJsonSchema: {} }));

  beforeEach(() => {
    holder.declarations = PERMITTED;
    holder.toolRouting = true;
  });

  it("starts a sales question with the sales tools and the escape hatch", async () => {
    const response = await POST(
      request({ message: "How much did I sell today?" }),
    );
    await response.text();
    const [, , declarations, options] = sessionCall(0);
    expect(declarations.map((tool) => tool.name)).toEqual([
      "get_store_profile",
      "get_sales_summary",
      "query_analytics",
      "search_help_centre",
      "request_more_tools",
    ]);
    expect(options).toMatchObject({
      model: "gemini-3.7-flash",
      route: expect.objectContaining({ mode: "narrow" }),
      allDeclarations: PERMITTED,
    });
  });

  it("★ keeps the lite model off until it is switched on", async () => {
    await (
      await POST(request({ message: "How much did I sell today?" }))
    ).text();
    expect(sessionCall(0)[3]).toMatchObject({
      model: "gemini-3.7-flash",
    });
    holder.liteRouting = true;
    await (
      await POST(request({ message: "How much did I sell today?" }))
    ).text();
    expect(sessionCall(1)[3]).toMatchObject({
      model: "gemini-3.5-flash-lite",
    });
    // A change request is never light, switch or not.
    await (
      await POST(request({ message: "Create a banner for my homepage" }))
    ).text();
    expect(sessionCall(2)[3]).toMatchObject({
      model: "gemini-3.7-flash",
    });
  });

  it("sends every tool, unrouted, when routing is off or the message names no subject", async () => {
    holder.toolRouting = false;
    await (
      await POST(request({ message: "How much did I sell today?" }))
    ).text();
    expect(sessionCall(0)[2]).toBe(PERMITTED);
    expect(sessionCall(0)[3]).toMatchObject({
      route: null,
    });
    expect(sessionCall(0)[3]).not.toHaveProperty("allDeclarations");
    holder.toolRouting = true;
    await (
      await POST(request({ message: "Tell me something useful." }))
    ).text();
    expect(sessionCall(1)[2]).toBe(PERMITTED);
  });

  it("★ records the model that actually answered when a run fails", async () => {
    holder.liteRouting = true;
    holder.createSession.mockReturnValueOnce({ model: "gemini-3.7-flash" });
    holder.run.mockRejectedValueOnce(new Error("boom"));
    await (
      await POST(request({ message: "How much did I sell today?" }))
    ).text();
    expect(holder.failRun).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-3.7-flash" }),
    );
  });
});

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://acme.storemink.com/api/mink/stream", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
