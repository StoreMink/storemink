import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  headerBag: {
    get: (name: string) => (name === "x-forwarded-for" ? "203.0.113.10" : null),
  },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => h.headerBag),
}));
vi.mock("@/lib/rate-limit", () => ({
  clientIp: vi.fn(() => "203.0.113.10"),
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
// The real normalizer runs; only the write is replaced. The database client is
// replaced too, so nothing in this file can reach a database.
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async () => {
    throw new Error("no database in this test");
  }),
}));
vi.mock("@/lib/help/assistant-feedback", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/help/assistant-feedback")>();
  return { ...actual, saveHelpFeedback: vi.fn(async () => undefined) };
});

import { headers } from "next/headers";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { logError } from "@/lib/observability/logger";
import { saveHelpFeedback } from "@/lib/help/assistant-feedback";
import { rateHelpAnswer } from "./help-assistant-feedback-actions";

const CONVERSATION = "conv_12345678";
const MESSAGE = "msg_abcdefgh";

function input(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: CONVERSATION,
    messageKey: MESSAGE,
    rating: "up",
    language: "ta",
    question: "  How do I   process a POS sale?  ",
    answer: "Open Sell and take payment.",
    sources: [
      {
        title: "Process a sale",
        url: "/help/point-of-sale/process",
        category: "POS",
      },
      { title: "Elsewhere", url: "https://example.com/help" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(rateLimit).mockResolvedValue({ allowed: true });
  vi.mocked(saveHelpFeedback).mockResolvedValue(undefined);
});

describe("rateHelpAnswer", () => {
  it("saves the normalized rating and answers ok", async () => {
    expect(await rateHelpAnswer(input())).toEqual({ ok: true });
    expect(saveHelpFeedback).toHaveBeenCalledTimes(1);
    expect(saveHelpFeedback).toHaveBeenCalledWith({
      conversationId: CONVERSATION,
      messageKey: MESSAGE,
      rating: "up",
      language: "ta",
      question: "How do I process a POS sale?",
      answer: "Open Sell and take payment.",
      sources: [
        {
          title: "Process a sale",
          url: "/help/point-of-sale/process",
          category: "POS",
        },
      ],
    });
  });

  it("rate-limits by the caller's address, 60 an hour", async () => {
    await rateHelpAnswer(input());
    expect(headers).toHaveBeenCalledTimes(1);
    expect(clientIp).toHaveBeenCalledWith(h.headerBag);
    expect(rateLimit).toHaveBeenCalledWith("help:feedback:203.0.113.10", {
      max: 60,
      windowSeconds: 3600,
    });
  });

  it("refuses when the caller is over the limit, and saves nothing", async () => {
    vi.mocked(rateLimit).mockResolvedValueOnce({ allowed: false });
    expect(await rateHelpAnswer(input())).toEqual({
      ok: false,
      error: "Too many ratings for now. Please try again later.",
    });
    expect(saveHelpFeedback).not.toHaveBeenCalled();
  });

  it.each([
    ["no input", undefined],
    ["a string", "up"],
    ["a bad conversation id", input({ conversationId: "x" })],
    ["a bad message key", input({ messageKey: "has space 1" })],
    ["an unknown rating", input({ rating: "love" })],
    ["a rating with no question", input({ question: "   " })],
    ["a rating with no answer", input({ answer: "" })],
  ])("refuses %s without spending the limit or saving", async (_label, raw) => {
    expect(await rateHelpAnswer(raw)).toEqual({
      ok: false,
      error: "That rating couldn't be read.",
    });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(headers).not.toHaveBeenCalled();
    expect(saveHelpFeedback).not.toHaveBeenCalled();
  });

  it("clears a rating through the same limit and save", async () => {
    expect(
      await rateHelpAnswer(input({ rating: null, question: "", answer: "" })),
    ).toEqual({ ok: true });
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(saveHelpFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ rating: null, question: "", answer: "" }),
    );
  });

  it("answers with a plain error when the save throws, and logs it", async () => {
    const failure = new Error("connection reset");
    vi.mocked(saveHelpFeedback).mockRejectedValueOnce(failure);
    expect(await rateHelpAnswer(input())).toEqual({
      ok: false,
      error: "That rating couldn't be saved.",
    });
    expect(logError).toHaveBeenCalledWith("help.feedback.save_failed", failure);
  });

  it("logs a failed query by its database reason, never by its parameters", async () => {
    const failure = Object.assign(
      new Error(
        "Failed query: insert into help_assistant_feedback params: How do I process a POS sale?",
      ),
      { cause: { message: "duplicate key value violates unique constraint" } },
    );
    vi.mocked(saveHelpFeedback).mockRejectedValueOnce(failure);
    expect(await rateHelpAnswer(input())).toEqual({
      ok: false,
      error: "That rating couldn't be saved.",
    });
    expect(logError).toHaveBeenCalledTimes(1);
    const logged = vi.mocked(logError).mock.calls[0][1];
    expect(logged).toBe("duplicate key value violates unique constraint");
    expect(JSON.stringify(logged)).not.toContain("POS sale");
  });
});
