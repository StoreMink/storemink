import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/orders/pending-payments", () => ({
  confirmYoungPendingOrders: vi.fn(),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

import { GET, POST } from "./route";
import { confirmYoungPendingOrders } from "@/lib/orders/pending-payments";

const call = (handler: typeof GET, secret?: string) =>
  handler(
    new Request("https://storemink.com/api/cron/confirm-payments", {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "secret";
  vi.mocked(confirmYoungPendingOrders).mockResolvedValue({
    considered: 2,
    paid: 1,
    errors: 0,
  });
});
afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("confirm-payments cron", () => {
  it("refuses without the cron secret, with a wrong one, and when none is set", async () => {
    expect((await call(GET)).status).toBe(401);
    expect((await call(GET, "nope")).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await call(GET, "secret")).status).toBe(401);
    expect(confirmYoungPendingOrders).not.toHaveBeenCalled();
  });

  it("runs the confirming pass and reports what it found", async () => {
    const res = await call(GET, "secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      considered: 2,
      paid: 1,
      errors: 0,
    });
    expect((await call(POST, "secret")).status).toBe(200);
  });

  it("answers 503 when the pass had errors, so the scheduler retries", async () => {
    vi.mocked(confirmYoungPendingOrders).mockResolvedValue({
      considered: 3,
      paid: 0,
      errors: 1,
    });
    const res = await call(GET, "secret");
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });
});
