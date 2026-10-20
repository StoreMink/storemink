import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  create: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@google/genai", () => ({
  ThinkingLevel: { HIGH: "HIGH", LOW: "LOW" },
  GoogleGenAI: class {
    chats = { create: h.create };
  },
}));
import { createVertexMinkSession } from "./vertex-client";
import type { MinkConfig } from "./config";
import {
  applyMinkToolRoute,
  REQUEST_MORE_TOOLS,
  routeMinkTools,
} from "./tool-routing";
import type { MinkActorContext, MinkToolDeclaration } from "./types";

const actor: MinkActorContext = {
  storeId: "store",
  adminId: "owner",
  email: null,
  effectivePlan: "pro",
  roleSlug: "superadmin",
  permissions: {},
  isSuperadmin: true,
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request",
};
const config = {
  projectId: "project",
  model: "gemini-3.7-flash",
  location: "global",
  maxOutputTokens: 100,
  maxModelRetries: 0,
} as MinkConfig;

const declaration = (name: string): MinkToolDeclaration => ({
  name,
  description: `${name} description`,
  parametersJsonSchema: { type: "object", properties: {} },
});
const PERMITTED = [
  "get_store_profile",
  "get_sales_summary",
  "query_analytics",
  "search_help_centre",
  "generate_storefront_image",
  "propose_storefront_layout",
].map(declaration);

beforeEach(() => {
  h.create.mockImplementation(() => ({
    sendMessageStream: async (params: unknown) => {
      h.send(params);
      return (async function* () {
        yield { candidates: [{ content: { parts: [{ text: "Hi" }] } }] };
      })();
    },
  }));
});

describe("a routed Vertex session", () => {
  const route = routeMinkTools({ message: "How much did I sell today?" });
  const routed = applyMinkToolRoute(PERMITTED, route);

  it("starts on the given model with the narrowed tools and their rules only", () => {
    const session = createVertexMinkSession(
      config,
      actor,
      routed.declarations,
      {
        history: [],
        model: "gemini-3.5-flash-lite",
        route,
        allDeclarations: PERMITTED,
      },
    );
    const created = h.create.mock.calls[0][0];
    expect(created.model).toBe("gemini-3.5-flash-lite");
    expect(session.model).toBe("gemini-3.5-flash-lite");
    const names = created.config.tools[0].functionDeclarations.map(
      (tool: { name: string }) => tool.name,
    );
    expect(names).toContain("get_sales_summary");
    expect(names).toContain(REQUEST_MORE_TOOLS);
    expect(names).not.toContain("generate_storefront_image");
    // ★ The image generator's 5,500-character rule stays out with its tool.
    const instruction: string = created.config.systemInstruction;
    expect(instruction).not.toContain("You may create one AI IMAGE");
    expect(instruction).toContain("call request_more_tools once");
    expect(instruction).toContain("Use query_analytics when the merchant");
    expect(instruction).not.toContain("[[when:");
  });

  it("★★ widens once, onto the main model, with every tool and every rule", async () => {
    const session = createVertexMinkSession(
      config,
      actor,
      routed.declarations,
      {
        history: [{ role: "user", text: "earlier" }],
        model: "gemini-3.5-flash-lite",
        route,
        allDeclarations: PERMITTED,
      },
    );
    await session.sendUserMessage("first try");
    expect(session.restartWithAllTools?.()).toBe(true);
    expect(session.model).toBe("gemini-3.7-flash");
    const widened = h.create.mock.calls[1][0];
    expect(widened.model).toBe("gemini-3.7-flash");
    // The stored conversation only, never the abandoned attempt.
    expect(widened.history).toEqual([
      { role: "user", parts: [{ text: "earlier" }] },
    ]);
    const names = widened.config.tools[0].functionDeclarations.map(
      (tool: { name: string }) => tool.name,
    );
    expect(names).toEqual(PERMITTED.map((tool) => tool.name));
    expect(widened.config.systemInstruction).toContain(
      "You may create one AI IMAGE",
    );
    expect(widened.config.systemInstruction).not.toContain(
      "call request_more_tools once",
    );
    // Sending now goes to the widened chat.
    await session.sendUserMessage("again");
    expect(h.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: "again" }),
    );
    expect(h.create).toHaveBeenCalledTimes(2);
    // Once only.
    expect(session.restartWithAllTools?.()).toBe(false);
  });

  it("cannot widen a session that was never narrowed", () => {
    const session = createVertexMinkSession(config, actor, PERMITTED, {
      history: [],
    });
    expect(session.model).toBe("gemini-3.7-flash");
    expect(session.restartWithAllTools?.()).toBe(false);
    expect(h.create).toHaveBeenCalledTimes(1);
  });
});
