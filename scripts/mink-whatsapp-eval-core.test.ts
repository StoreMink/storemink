// The WhatsApp eval grades the configured model alone, and its summary tells a
// stall, a busy refusal and a fallback answer apart. Driven through the real
// retry rule (callMinkWhatsAppModelWithRetry) over a fake model call.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import type { MinkConfig } from "@/lib/mink/config";
import {
  callMinkWhatsAppModelWithRetry,
  type MinkWhatsAppModelInput,
  type MinkWhatsAppModelResult,
} from "@/lib/whatsapp/mink-model";
import {
  evalModelOptions,
  noRetries,
  retrySplit,
  watchedCall,
} from "./mink-whatsapp-eval-core";

const config = {
  projectId: "proj",
  location: "global",
  model: "gemini-3.7-flash",
  fallbackModel: "gemini-3.5-flash",
  fallbackLocation: "asia-south1",
} as unknown as MinkConfig;

const input = {
  facts: {},
  message: "Is the almond shake in stock?",
  now: new Date("2026-10-24T06:00:00Z"),
  timeZone: "Asia/Kolkata",
} as unknown as MinkWhatsAppModelInput;

const answered = (model: string): MinkWhatsAppModelResult => ({
  parsed: { outcome: "answer", reply: "Yes.", reason: "facts" },
  finishReason: "STOP",
  model,
  inputTokens: 1,
  outputTokens: 1,
});

const status = (code: number) =>
  Object.assign(new Error(`status ${code}`), { status: code });

/** Never answers: rejects only when the attempt's own budget fires. */
const stallUntilAborted = (signal?: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });

describe("evalModelOptions", () => {
  it("★★ never asks the fallback: a busy configured model fails the case instead", async () => {
    const asked: string[] = [];
    const call = vi.fn(async (target: MinkConfig) => {
      asked.push(`${target.model}@${target.location}`);
      throw status(429);
    });
    const retries = noRetries();
    await expect(
      callMinkWhatsAppModelWithRetry(config, input, {
        ...evalModelOptions(retries, call),
        retryDelayMs: 0,
      }),
    ).rejects.toMatchObject({ status: 429 });
    // The main model twice, then nothing: the live options would have gone on
    // to gemini-3.5-flash@asia-south1.
    expect(asked).toEqual([
      "gemini-3.7-flash@global",
      "gemini-3.7-flash@global",
    ]);
    expect(retries).toEqual({ stalls: 0, busy: 2 });
  });

  it("keeps the live path's 30 s per attempt", () => {
    expect(evalModelOptions(noRetries()).timeoutMs).toBe(30_000);
    expect(evalModelOptions(noRetries()).fallback).toBeNull();
  });
});

describe("watchedCall", () => {
  it("★ counts a busy refusal that the retry then recovered", async () => {
    const retries = noRetries();
    const call = vi
      .fn()
      .mockRejectedValueOnce(status(503))
      .mockResolvedValueOnce(answered(config.model));
    const out = await callMinkWhatsAppModelWithRetry(config, input, {
      ...evalModelOptions(retries, call),
      retryDelayMs: 0,
    });
    expect(out).toMatchObject({ attempts: 2, model: "gemini-3.7-flash" });
    expect(retries).toEqual({ stalls: 0, busy: 1 });
  });

  it("★ counts a stall: the attempt's own budget ran out", async () => {
    const retries = noRetries();
    let calls = 0;
    const call = vi.fn(
      async (
        _c: MinkConfig,
        _i: MinkWhatsAppModelInput,
        signal?: AbortSignal,
      ) => (++calls === 1 ? stallUntilAborted(signal) : answered(config.model)),
    );
    const out = await callMinkWhatsAppModelWithRetry(config, input, {
      ...evalModelOptions(retries, call),
      timeoutMs: 20,
    });
    expect(out.attempts).toBe(2);
    expect(retries).toEqual({ stalls: 1, busy: 0 });
  });

  it("counts a refusal of the request as neither, and passes it on unchanged", async () => {
    const retries = noRetries();
    const refused = status(400);
    await expect(
      watchedCall(retries, async () => {
        throw refused;
      })(config, input, new AbortController().signal),
    ).rejects.toBe(refused);
    expect(retries).toEqual({ stalls: 0, busy: 0 });
  });
});

describe("retrySplit", () => {
  it("★★ splits the answers that needed another attempt into stalls, busy retries and fallback answers", () => {
    const split = retrySplit(
      [
        // First time: not counted.
        { attempts: 1, model: "gemini-3.7-flash", retries: noRetries() },
        // Offline, at the gate, or failed: not counted.
        { attempts: 0, model: null, retries: { stalls: 2, busy: 0 } },
        {
          attempts: 2,
          model: "gemini-3.7-flash",
          retries: { stalls: 1, busy: 0 },
        },
        {
          attempts: 2,
          model: "gemini-3.7-flash",
          retries: { stalls: 0, busy: 1 },
        },
        {
          attempts: 2,
          model: "gemini-3.7-flash",
          retries: { stalls: 0, busy: 1 },
        },
        {
          attempts: 3,
          model: "gemini-3.5-flash",
          retries: { stalls: 1, busy: 1 },
        },
      ],
      "gemini-3.7-flash",
    );
    expect(split).toEqual({ stalls: 1, busyRetries: 2, fallbackAnswers: 1 });
  });
});
