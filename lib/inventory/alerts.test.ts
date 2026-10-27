import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  deferred: [] as Promise<unknown>[],
  withService: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("next/server", () => ({
  after: (task: () => Promise<unknown>) => {
    h.deferred.push(task());
  },
}));
vi.mock("@/lib/db/client", () => ({ withService: h.withService }));
vi.mock("@/lib/observability/logger", () => ({ logError: h.logError }));
vi.mock("@/lib/notifications/record", () => ({ recordEvent: vi.fn() }));

import { reportStockChanges, stockAlertFor } from "./alerts";

// The whole value of the low-stock alert is that it fires ONCE per crossing.
// A merchant who gets "Only 3 left" on every subsequent sale stops reading
// them, which makes the out-of-stock alert worthless too.
describe("stockAlertFor", () => {
  const THRESHOLD = 5;

  it("alerts when stock crosses into the low band", () => {
    expect(stockAlertFor(6, 5, THRESHOLD)).toBe("low");
    expect(stockAlertFor(10, 2, THRESHOLD)).toBe("low");
  });

  it("stays quiet on every further sale inside the low band", () => {
    expect(stockAlertFor(5, 4, THRESHOLD)).toBeNull();
    expect(stockAlertFor(4, 3, THRESHOLD)).toBeNull();
    expect(stockAlertFor(2, 1, THRESHOLD)).toBeNull();
  });

  it("alerts when stock reaches zero", () => {
    expect(stockAlertFor(1, 0, THRESHOLD)).toBe("out");
    // Straight from healthy to empty (a bulk correction) is still one alert.
    expect(stockAlertFor(40, 0, THRESHOLD)).toBe("out");
  });

  it("stays quiet on an already-empty SKU", () => {
    expect(stockAlertFor(0, 0, THRESHOLD)).toBeNull();
    // Backorderable SKUs are filtered out before this point, but a negative
    // move on an empty one must not re-alert either.
    expect(stockAlertFor(0, -2, THRESHOLD)).toBeNull();
  });

  it("re-arms after a restock", () => {
    expect(stockAlertFor(0, 20, THRESHOLD)).toBeNull(); // restocking is not news
    expect(stockAlertFor(20, 5, THRESHOLD)).toBe("low"); // but the next dip is
  });

  it("treats a zero threshold as 'only tell me when it's gone'", () => {
    expect(stockAlertFor(3, 1, 0)).toBeNull();
    expect(stockAlertFor(1, 0, 0)).toBe("out");
  });
});

// ★ B22: the deferred check's failure is the only trace it leaves, so the log
// names the store and the database's reason, never "[object Object]" and
// never the failed query's parameters (an alert's are product names).
describe("reportStockChanges failure log", () => {
  it("logs the database's reason as the error and the store as the context", async () => {
    h.withService.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'Failed query: select settings from stores\nparams: "Secret Almond Shake"',
        ),
        { cause: new Error("connection terminated unexpectedly") },
      ),
    );
    reportStockChanges("store-1", [{ productId: "p1", delta: -1 }]);
    await Promise.all(h.deferred.splice(0));
    expect(h.logError).toHaveBeenCalledWith(
      "notifications: stock alert failed",
      "connection terminated unexpectedly",
      { storeId: "store-1" },
    );
    // An error is written out the way logError reports it.
    const logged = JSON.stringify(h.logError.mock.calls, (_k, v) =>
      v instanceof Error
        ? {
            message: v.message,
            cause: v.cause instanceof Error ? v.cause.message : v.cause,
          }
        : v,
    );
    expect(logged).not.toMatch(/Secret Almond Shake|\[object Object\]/);
  });

  it("logs any other error as itself, so its stack names the line that broke", async () => {
    const bug = new TypeError("Cannot read properties of undefined");
    h.withService.mockRejectedValueOnce(bug);
    reportStockChanges("store-1", [{ productId: "p1", delta: -1 }]);
    await Promise.all(h.deferred.splice(0));
    expect(h.logError).toHaveBeenCalledWith(
      "notifications: stock alert failed",
      bug,
      { storeId: "store-1" },
    );
  });
});
