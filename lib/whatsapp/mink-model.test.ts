// ---------------------------------------------------------------------------
// The retry rule in front of the one model call: a second attempt only after
// a stall, never after a refusal, and never more than once.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import type { MinkConfig } from "@/lib/mink/config";
import {
  MINK_WHATSAPP_MODEL_ATTEMPTS,
  MinkWhatsAppModelStalled,
  callMinkWhatsAppModelWithRetry,
  isModelStall,
  type MinkWhatsAppModelInput,
  type MinkWhatsAppModelResult,
} from "./mink-model";

const config = { projectId: "p", location: "global", model: "m" } as MinkConfig;
const input = {
  facts: {
    store: { name: "Echoss", url: null, email: null },
    hours: null,
    orders: [],
    products: [],
    delivery: null,
    offers: [],
    policies: [],
    recent: [],
  },
  message: "hi",
  now: new Date("2026-10-14T06:30:00Z"),
  timeZone: "Asia/Kolkata",
} satisfies MinkWhatsAppModelInput;

const answered: MinkWhatsAppModelResult = {
  parsed: { outcome: "answer", reply: "ok", reason: "" },
  finishReason: "STOP",
  model: "m",
  inputTokens: 1,
  outputTokens: 1,
};

/** A call that never answers: it rejects only when its budget fires, the way
 *  the SDK does, wrapping the abort in a plain Error as seen live. */
const stall = () =>
  vi.fn(
    (_c: MinkConfig, _i: MinkWhatsAppModelInput, signal?: AbortSignal) =>
      new Promise<MinkWhatsAppModelResult>((_, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new Error("This operation was aborted")),
        );
      }),
  );

describe("callMinkWhatsAppModelWithRetry", () => {
  it("the default is two attempts", () => {
    expect(MINK_WHATSAPP_MODEL_ATTEMPTS).toBe(2);
  });

  it("★ a stall is followed by exactly one more attempt, and the answer says so", async () => {
    const call = stall();
    call.mockImplementationOnce(call.getMockImplementation()!);
    call.mockImplementationOnce(async () => answered);
    const result = await callMinkWhatsAppModelWithRetry(config, input, {
      timeoutMs: 20,
      call,
    });
    expect(result).toMatchObject({ ...answered, attempts: 2 });
    expect(call).toHaveBeenCalledTimes(2);
    // Each attempt gets its own, unexpired budget.
    const signals = call.mock.calls.map((c) => c[2]);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("★ two stalls end as a stall, never a third call", async () => {
    const call = stall();
    await expect(
      callMinkWhatsAppModelWithRetry(config, input, { timeoutMs: 20, call }),
    ).rejects.toMatchObject({
      name: "MinkWhatsAppModelStalled",
      attempts: 2,
    });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("★ a refusal is final: thrown as it came, after one call", async () => {
    const refused = Object.assign(new Error("permission denied"), {
      status: 403,
    });
    const call = vi.fn(async () => {
      throw refused;
    });
    await expect(
      callMinkWhatsAppModelWithRetry(config, input, { timeoutMs: 20, call }),
    ).rejects.toBe(refused);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("a single-attempt budget stalls once and stops", async () => {
    const call = stall();
    await expect(
      callMinkWhatsAppModelWithRetry(config, input, {
        timeoutMs: 20,
        attempts: 1,
        call,
      }),
    ).rejects.toBeInstanceOf(MinkWhatsAppModelStalled);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("an answer on the first attempt reports one attempt", async () => {
    const call = vi.fn(async () => answered);
    expect(
      await callMinkWhatsAppModelWithRetry(config, input, { call }),
    ).toMatchObject({ attempts: 1 });
  });
});

describe("isModelStall", () => {
  it("reads the signal first, then the abort names, and nothing else", () => {
    const fired = AbortSignal.abort();
    const live = new AbortController().signal;
    expect(isModelStall(new Error("This operation was aborted"), fired)).toBe(
      true,
    );
    expect(
      isModelStall(
        Object.assign(new Error("x"), { name: "TimeoutError" }),
        live,
      ),
    ).toBe(true);
    expect(
      isModelStall(Object.assign(new Error("x"), { name: "AbortError" }), live),
    ).toBe(true);
    expect(isModelStall(new Error("permission denied"), live)).toBe(false);
    expect(isModelStall("not an error", live)).toBe(false);
  });
});
