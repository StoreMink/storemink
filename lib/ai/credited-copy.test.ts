import { beforeEach, describe, expect, it, vi } from "vitest";

// withAiCredit: the one path every Generate with AI action takes a credit
// through. What is refunded, when, and what the merchant is told.

const TAKE = vi.hoisted(() => ({
  source: "credit" as const,
  takeId: "66666666-6666-4666-8666-666666666666",
}));
vi.mock("./quota", () => ({
  consumeAiQuota: vi.fn(async () => ({ allowed: true, taken: TAKE })),
  refundAiQuota: vi.fn(async () => "refunded"),
}));

import { withAiCredit } from "./credited-copy";
import { consumeAiQuota, refundAiQuota } from "./quota";
import {
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AI_UNUSABLE_MESSAGE,
} from "./gemini";

const SCOPE = { storeId: "store-1", actorId: "admin-1" };

beforeEach(() => {
  vi.mocked(consumeAiQuota).mockImplementation(async () => ({
    allowed: true,
    taken: TAKE,
  }));
  vi.mocked(refundAiQuota).mockImplementation(async () => "refunded");
});

describe("withAiCredit", () => {
  it("takes the credit for the store and the admin, and keeps it when the copy is delivered", async () => {
    const write = vi.fn(async () => ({ description: "Crunchy." }));
    await expect(withAiCredit(SCOPE, write)).resolves.toEqual({
      description: "Crunchy.",
    });
    expect(consumeAiQuota).toHaveBeenCalledWith("store-1", {
      actorId: "admin-1",
    });
    expect(refundAiQuota).not.toHaveBeenCalled();
  });

  it("never writes, and refunds nothing, when the take was refused", async () => {
    vi.mocked(consumeAiQuota).mockResolvedValueOnce({
      allowed: false,
      error: "Slow down.",
    });
    const write = vi.fn(async () => ({ description: "x" }));
    await expect(withAiCredit(SCOPE, write)).resolves.toEqual({
      error: "Slow down.",
    });
    expect(write).not.toHaveBeenCalled();
    expect(refundAiQuota).not.toHaveBeenCalled();
  });

  it.each([AI_BUSY_MESSAGE, AI_UNAVAILABLE_MESSAGE, AI_UNUSABLE_MESSAGE])(
    "gives the take back for a failure and keeps the message when it was: %s",
    async (message) => {
      const result = await withAiCredit(SCOPE, async () => ({
        error: message,
      }));
      expect(refundAiQuota).toHaveBeenCalledWith("store-1", TAKE);
      expect(result).toEqual({ error: message });
    },
  );

  it("keeps the message when there was nothing to give back", async () => {
    vi.mocked(refundAiQuota).mockResolvedValueOnce("none");
    await expect(
      withAiCredit(SCOPE, async () => ({ error: AI_BUSY_MESSAGE })),
    ).resolves.toEqual({ error: AI_BUSY_MESSAGE });
  });

  // ★★ The merchant is never told nothing was charged while the credit stays
  //    spent.
  it.each([
    [AI_BUSY_MESSAGE, "AI is busy right now. Try again in a minute."],
    [AI_UNAVAILABLE_MESSAGE, "AI isn't available right now."],
    [AI_UNUSABLE_MESSAGE, "AI couldn't finish writing this. Try again."],
  ])(
    "drops the nothing-charged claim when the refund failed: %s",
    async (message, honest) => {
      vi.mocked(refundAiQuota).mockResolvedValueOnce("failed");
      await expect(
        withAiCredit(SCOPE, async () => ({ error: message })),
      ).resolves.toEqual({ error: honest });
    },
  );

  it("gives the take back for a throw, then throws it on", async () => {
    await expect(
      withAiCredit(SCOPE, async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");
    expect(refundAiQuota).toHaveBeenCalledTimes(1);
    expect(refundAiQuota).toHaveBeenCalledWith("store-1", TAKE);
  });
});
