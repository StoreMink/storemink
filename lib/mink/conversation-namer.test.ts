import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Request = {
  model: string;
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  config: {
    systemInstruction: string;
    maxOutputTokens: number;
    thinkingConfig: { thinkingLevel: string };
    abortSignal: AbortSignal;
  };
};

const h = vi.hoisted(() => ({
  clients: [] as Array<{ project: string; location: string }>,
  /** What each call does, in order; the last one repeats. */
  plan: [] as Array<(request: unknown) => Promise<unknown>>,
  requests: [] as unknown[],
  rename: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  FinishReason: { STOP: "STOP", MAX_TOKENS: "MAX_TOKENS" },
  ThinkingLevel: { LOW: "LOW", HIGH: "HIGH" },
  GoogleGenAI: class {
    models: { generateContent: (request: unknown) => Promise<unknown> };
    constructor(options: { project: string; location: string }) {
      h.clients.push({ project: options.project, location: options.location });
      this.models = {
        generateContent: (request) => {
          h.requests.push(request);
          const step = h.plan.length > 1 ? h.plan.shift()! : h.plan[0];
          return step(request);
        },
      };
    }
  },
}));
vi.mock("./persistence", () => ({ renameMinkConversation: h.rename }));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: h.logInfo,
  logWarn: h.logWarn,
  logError: vi.fn(),
}));

import {
  generateMinkConversationTitle,
  nameMinkConversation,
} from "./conversation-namer";
import { addSavedMinkMediaReference } from "./media-attachment";

const config = {
  projectId: "project-1",
  location: "global",
  liteModel: "gemini-3.5-flash-lite",
};
const actor = { storeId: "store-1", adminId: "admin-1", requestId: "req-1" };
const CHAT = "11111111-1111-4111-8111-111111111111";

function reply(text: string, finishReason = "STOP") {
  return async () => ({
    text,
    candidates: [{ finishReason }],
    usageMetadata: {
      promptTokenCount: 180,
      candidatesTokenCount: 6,
      thoughtsTokenCount: 40,
    },
  });
}
const status = (code: number) => async () => {
  throw Object.assign(new Error(`status ${code}`), { status: code });
};
/** Never answers: the provider is silent. */
const silent = () => new Promise<never>(() => {});

function name(message = "How many orders did I get today?") {
  return nameMinkConversation({
    config,
    actor,
    conversationId: CHAT,
    provisionalTitle: "How many orders did I get today?",
    message,
  });
}

beforeEach(() => {
  h.plan = [reply("Today's order count")];
  h.requests = [];
  h.rename.mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("★★ nameMinkConversation", () => {
  it("asks the lite model, with low thinking, for a title of the merchant's words and saves it over the provisional one", async () => {
    await expect(name()).resolves.toBe("Today's order count");

    const request = h.requests[0] as Request;
    expect(request.model).toBe("gemini-3.5-flash-lite");
    expect(request.config.thinkingConfig.thinkingLevel).toBe("LOW");
    expect(request.config.systemInstruction).toContain("title");
    expect(request.config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(request.contents[0].parts[0].text).toContain(
      "How many orders did I get today?",
    );
    expect(h.clients.at(-1)).toEqual({
      project: "project-1",
      location: "global",
    });
    // Compare-and-set: only while the chat still has its first title.
    expect(h.rename).toHaveBeenCalledWith({
      actor,
      conversationId: CHAT,
      from: "How many orders did I get today?",
      to: "Today's order count",
    });
  });

  it("★ logs without the title or the message, which quote the merchant", async () => {
    await name();
    expect(h.logInfo).toHaveBeenCalledWith(
      "mink.title: named",
      expect.objectContaining({ storeId: "store-1", attempts: 1 }),
    );
    const logged = JSON.stringify(h.logInfo.mock.calls);
    expect(logged).not.toContain("Today's order count");
    expect(logged).not.toContain("How many orders");
  });

  it("keeps the provisional title, with no write, when the chat was deleted or renamed meanwhile", async () => {
    h.rename.mockResolvedValueOnce(false);
    await expect(name()).resolves.toBeNull();
  });

  it("writes nothing when the model's title is the one the chat already has", async () => {
    h.plan = [reply("Order count")];
    await expect(
      nameMinkConversation({
        config,
        actor,
        conversationId: CHAT,
        provisionalTitle: "Order count",
        message: "Order count",
      }),
    ).resolves.toBe("Order count");
    expect(h.rename).not.toHaveBeenCalled();
  });

  it("never throws, even when the save fails", async () => {
    h.rename.mockRejectedValueOnce(new Error("database down"));
    await expect(name()).resolves.toBeNull();
    expect(h.logWarn).toHaveBeenCalledWith(
      "mink.title: kept provisional",
      expect.objectContaining({ outcome: "failed" }),
    );
  });
});

describe("generateMinkConversationTitle", () => {
  it("does not ask a model to name a message of only attachments", async () => {
    const message = addSavedMinkMediaReference("", {
      url: "https://storage.googleapis.com/bucket/stores/s/media/a.webp",
      filename: "a.webp",
    }).trim();
    await expect(
      generateMinkConversationTitle({ config, message }),
    ).resolves.toMatchObject({ title: null, outcome: "skipped", attempts: 0 });
    expect(h.requests).toHaveLength(0);
  });

  it("does nothing without a Vertex project", async () => {
    await expect(
      generateMinkConversationTitle({
        config: { ...config, projectId: null },
        message: "Hi",
      }),
    ).resolves.toMatchObject({ outcome: "skipped" });
    expect(h.requests).toHaveLength(0);
  });

  it("★ drops a reply that is an answer rather than a title", async () => {
    h.plan = [
      reply(
        "You got twelve orders today, which is three more than yesterday afternoon",
      ),
    ];
    await expect(
      generateMinkConversationTitle({ config, message: "Orders today?" }),
    ).resolves.toMatchObject({
      title: null,
      outcome: "unusable",
      reason: "not_a_title",
    });
  });

  it("drops a reply the output limit cut off, however it reads", async () => {
    h.plan = [reply("Today's order", "MAX_TOKENS")];
    await expect(
      generateMinkConversationTitle({ config, message: "Orders today?" }),
    ).resolves.toMatchObject({
      title: null,
      outcome: "unusable",
      reason: "MAX_TOKENS",
    });
  });

  it('★ asks again when the reply opens with the model\'s reasoning, rather than titling the chat "thought"', async () => {
    h.plan = [
      reply("thought\nThe merchant asks about orders.\nDaily order count"),
      reply("Daily order count"),
    ];
    await expect(
      generateMinkConversationTitle({ config, message: "Orders today?" }),
    ).resolves.toMatchObject({ title: "Daily order count", attempts: 2 });
  });

  it("keeps the provisional title when both replies leak their reasoning", async () => {
    h.plan = [reply("thought\nworking it out")];
    await expect(
      generateMinkConversationTitle({ config, message: "Orders today?" }),
    ).resolves.toMatchObject({
      title: null,
      outcome: "failed",
      attempts: 2,
      reason: "leaked_reasoning",
    });
  });

  it("asks once more when the provider was busy", async () => {
    h.plan = [status(429), reply("Today's order count")];
    await expect(
      generateMinkConversationTitle({ config, message: "Orders today?" }),
    ).resolves.toMatchObject({ title: "Today's order count", attempts: 2 });
  });

  it("does not ask again after a refusal", async () => {
    h.plan = [status(400)];
    await expect(
      generateMinkConversationTitle({ config, message: "Orders today?" }),
    ).resolves.toMatchObject({
      title: null,
      outcome: "failed",
      attempts: 1,
      reason: "status_400",
    });
  });

  it("★ gives a silent provider eight seconds, abandons it, and asks once more", async () => {
    vi.useFakeTimers();
    h.plan = [silent, reply("Today's order count")];
    const pending = generateMinkConversationTitle({
      config,
      message: "Orders today?",
    });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1 + 500);
    await expect(pending).resolves.toMatchObject({
      title: "Today's order count",
      attempts: 2,
    });
    // The abandoned request was told to stop.
    expect((h.requests[0] as Request).config.abortSignal.aborted).toBe(true);
  });

  it("gives up after two silent attempts", async () => {
    vi.useFakeTimers();
    h.plan = [silent];
    const pending = generateMinkConversationTitle({
      config,
      message: "Orders today?",
    });
    await vi.advanceTimersByTimeAsync(16_500);
    await expect(pending).resolves.toMatchObject({
      title: null,
      outcome: "failed",
      attempts: 2,
      reason: "stall",
    });
  });
});
