import { describe, it, expect, vi } from "vitest";
import { sendEmailBatch, type BatchSender } from "./send-batch";
import { logError, logWarn } from "@/lib/observability/logger";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

/**
 * A Resend stand-in where `badKeys` name the messages that genuinely can't be
 * sent. batch.send fails if ANY of them is in the request — which is what the
 * real API does, and the reason this module exists.
 */
function fakeResend(badKeys: string[] = [], opts: { down?: boolean } = {}) {
  const individualCalls: string[] = [];
  const resend = {
    batch: {
      send: async (messages: unknown) => {
        const list = messages as { __key: string }[];
        if (opts.down) return { error: { message: "service unavailable" } };
        const bad = list.find((m) => badKeys.includes(m.__key));
        return bad
          ? { error: { message: `Invalid recipient: ${bad.__key}` } }
          : {};
      },
    },
    emails: {
      send: async (message: unknown) => {
        const key = (message as { __key: string }).__key;
        individualCalls.push(key);
        if (opts.down) return { error: { message: "service unavailable" } };
        return badKeys.includes(key)
          ? { error: { message: `Invalid recipient: ${key}` } }
          : {};
      },
    },
  };
  return { resend: resend as unknown as BatchSender, individualCalls };
}

const msgs = (...keys: string[]) =>
  keys.map((k) => ({ key: k, message: { __key: k } }));

describe("sendEmailBatch", () => {
  it("sends everything in one call when nothing is wrong", async () => {
    const { resend, individualCalls } = fakeResend();
    const out = await sendEmailBatch(resend, msgs("a", "b", "c"));

    expect(out.sent).toEqual(["a", "b", "c"]);
    expect(out.failed).toEqual([]);
    expect(individualCalls).toEqual([]); // no per-message fallback needed
  });

  // THE POINT OF THIS MODULE. Resend rejects the whole batch over one bad
  // address; reading that as "all 100 failed" silently cost 99 people their
  // email — permanently, in the campaign worker, which has no retry.
  it("blames only the bad message, not the batch it travelled in", async () => {
    const { resend, individualCalls } = fakeResend(["b"]);
    const out = await sendEmailBatch(resend, msgs("a", "b", "c"));

    expect(out.sent).toEqual(["a", "c"]);
    expect(out.failed).toEqual([{ key: "b", error: "Invalid recipient: b" }]);
    expect(individualCalls).toEqual(["a", "b", "c"]);
  });

  it("reports each bad message's own error, not a shared one", async () => {
    const { resend } = fakeResend(["a", "c"]);
    const out = await sendEmailBatch(resend, msgs("a", "b", "c"));

    expect(out.sent).toEqual(["b"]);
    expect(out.failed.map((f) => f.error)).toEqual([
      "Invalid recipient: a",
      "Invalid recipient: c",
    ]);
  });

  it("doesn't re-send a lone message — it can't be poisoning anyone", async () => {
    const { resend, individualCalls } = fakeResend(["a"]);
    const out = await sendEmailBatch(resend, msgs("a"));

    expect(out.sent).toEqual([]);
    expect(out.failed).toHaveLength(1);
    expect(individualCalls).toEqual([]);
  });

  it("stops probing during an outage instead of hammering the API", async () => {
    const { resend, individualCalls } = fakeResend([], { down: true });
    const out = await sendEmailBatch(
      resend,
      msgs("a", "b", "c", "d", "e", "f", "g", "h"),
    );

    // Three consecutive failures is an outage, not a poison pill.
    expect(individualCalls).toEqual(["a", "b", "c"]);
    // Everything is still reported failed, so the caller's retry path applies.
    expect(out.sent).toEqual([]);
    expect(out.failed).toHaveLength(8);
  });

  it("survives the transport throwing on both paths", async () => {
    const boom = {
      batch: {
        send: async () => {
          throw new Error("socket hang up");
        },
      },
      emails: {
        send: async () => {
          throw new Error("socket hang up");
        },
      },
    } as unknown as BatchSender;

    const out = await sendEmailBatch(boom, msgs("a", "b"));
    expect(out.sent).toEqual([]);
    expect(out.failed.map((f) => f.error)).toEqual([
      "socket hang up",
      "socket hang up",
    ]);
  });

  it("does nothing for an empty list", async () => {
    const { resend } = fakeResend();
    expect(await sendEmailBatch(resend, [])).toEqual({ sent: [], failed: [] });
  });
});

// ★ B22: the outage log named "[object Object]"; it now carries the
// provider's reason as the error and the count as the context.
describe("sendEmailBatch outage log", () => {
  it("logs the provider's reason and how far it got", async () => {
    const { resend } = fakeResend([], { down: true });
    await sendEmailBatch(resend, msgs("a", "b", "c", "d", "e"));
    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      "email: individual sends failing in a row, stopping",
      "service unavailable",
      { after: 3 },
    );
  });

  it("masks an address the provider quotes", async () => {
    const refusal = {
      error: {
        message:
          "You can only send testing emails to your own email address (owner@shop.in).",
      },
    };
    const resend = {
      batch: { send: async () => refusal },
      emails: { send: async () => refusal },
    } as unknown as BatchSender;
    await sendEmailBatch(resend, msgs("a", "b", "c", "d"));
    const [, reason] = vi.mocked(logError).mock.calls[0];
    expect(reason).toBe(
      "You can only send testing emails to your own email address ([address]).",
    );
  });

  // ★ The first line too: the batch refusal is logged before any message is
  //   retried, and it is the same provider text.
  it("masks an address in the batch refusal it retries after", async () => {
    vi.mocked(logWarn).mockClear();
    const refusal = {
      error: {
        message:
          "You can only send testing emails to your own email address (owner@shop.in).",
      },
    };
    const resend = {
      batch: { send: async () => refusal },
      emails: { send: async () => ({}) },
    } as unknown as BatchSender;
    await sendEmailBatch(resend, msgs("a", "b"));
    expect(vi.mocked(logWarn)).toHaveBeenCalledWith(
      "email: batch send failed, retrying individually",
      {
        count: 2,
        error:
          "You can only send testing emails to your own email address ([address]).",
      },
    );
    expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toContain(
      "owner@shop.in",
    );
  });
});
