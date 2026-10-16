import { describe, expect, it, vi } from "vitest";
vi.mock("@google/genai", () => ({
  ThinkingLevel: { HIGH: "HIGH", LOW: "LOW" },
  GoogleGenAI: class {},
}));
import { consumeMinkStream } from "./vertex-client";
import type { GenerateContentResponse } from "@google/genai";

async function* chunks(items: unknown[]) {
  for (const item of items) yield item as GenerateContentResponse;
}

describe("consumeMinkStream", () => {
  it("releases visible text in order, skips thoughts and gathers function calls from every chunk", async () => {
    const seen: string[] = [];
    const turn = await consumeMinkStream(
      chunks([
        {
          candidates: [
            { content: { parts: [{ text: "Let me ", thought: false }] } },
          ],
        },
        {
          candidates: [
            { content: { parts: [{ text: "secret plan", thought: true }] } },
          ],
        },
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: "check." },
                  {
                    functionCall: {
                      id: "c1",
                      name: "get_store_profile",
                      args: { a: 1 },
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 1,
            totalTokenCount: 6,
          },
        },
        {
          candidates: [
            { content: { parts: [{ functionCall: { name: "list_orders" } }] } },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 2,
            totalTokenCount: 16,
            cachedContentTokenCount: 3,
          },
        },
      ]),
      (text) => seen.push(text),
    );

    expect(seen).toEqual(["Let me ", "check."]);
    expect(turn.text).toBe("Let me check.");
    expect(turn.functionCalls).toEqual([
      { id: "c1", name: "get_store_profile", args: { a: 1 } },
      { id: undefined, name: "list_orders", args: {} },
    ]);
    // ★ Usage is cumulative on the provider side: the last report wins.
    expect(turn.usage).toEqual({
      promptTokens: 10,
      outputTokens: 4,
      thoughtTokens: 2,
      totalTokens: 16,
      cachedTokens: 3,
      basePromptTokens: 10,
    });
  });

  it("returns an empty turn, not a throw, for a stream with no visible parts", async () => {
    const turn = await consumeMinkStream(chunks([{ candidates: [] }]));
    expect(turn).toEqual({
      text: "",
      functionCalls: [],
      usage: {
        promptTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        basePromptTokens: 0,
      },
      retryCount: 0,
    });
  });
});
