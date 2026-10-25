import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  origin: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/request-url", () => ({ getRequestOrigin: holder.origin }));
vi.mock("@/lib/observability/logger", () => ({
  logWarn: holder.warn,
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

import { PLATFORM_URL } from "@/lib/store/host";
import { kickRevampRunner } from "./trigger";

const REVAMP_ID = "11111111-1111-4111-8111-111111111111";
const fetchMock = vi.fn();

describe("kickRevampRunner", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
    holder.origin.mockResolvedValue("https://echos.storemink.com");
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it("posts the revamp id to the run route of THIS request's origin", async () => {
    await kickRevampRunner(REVAMP_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://echos.storemink.com/api/internal/mink/revamps/run",
    );
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer cron-secret");
    expect(JSON.parse(init.body)).toEqual({ revampId: REVAMP_ID });
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the platform origin with no request scope", async () => {
    holder.origin.mockResolvedValue(null);
    await kickRevampRunner(REVAMP_ID);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${PLATFORM_URL}/api/internal/mink/revamps/run`,
    );
  });

  it("does nothing without CRON_SECRET, and says why", async () => {
    delete process.env.CRON_SECRET;
    await kickRevampRunner(REVAMP_ID);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(holder.warn).toHaveBeenCalledWith(
      expect.stringContaining("CRON_SECRET"),
      { revampId: REVAMP_ID },
    );
  });

  it("never sends a malformed id", async () => {
    await kickRevampRunner("not-a-uuid");
    await kickRevampRunner("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("★ treats the five-second delivery bound as a kick that landed", async () => {
    const timeout = new Error("The operation timed out.");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeout);
    await expect(kickRevampRunner(REVAMP_ID)).resolves.toBeUndefined();
    expect(holder.warn).not.toHaveBeenCalled();
  });

  it("logs a refused kick without throwing", async () => {
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 503 }));
    await expect(kickRevampRunner(REVAMP_ID)).resolves.toBeUndefined();
    expect(holder.warn).toHaveBeenCalledWith(
      "Mink revamp runner kick failed",
      expect.objectContaining({ revampId: REVAMP_ID, status: 503 }),
    );
  });

  it("★ reads a busy runner (429) as a kick that will be retried, not a failure (jobs-1)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"outcome":"busy"}', { status: 429 }),
    );
    await expect(kickRevampRunner(REVAMP_ID)).resolves.toBeUndefined();
    expect(holder.warn).not.toHaveBeenCalled();
  });

  it("logs a network failure without throwing", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(kickRevampRunner(REVAMP_ID)).resolves.toBeUndefined();
    expect(holder.warn).toHaveBeenCalledWith(
      "Mink revamp runner kick failed",
      expect.objectContaining({ revampId: REVAMP_ID, error: "fetch failed" }),
    );
  });

  it("still kicks when reading the request origin throws", async () => {
    holder.origin.mockRejectedValueOnce(new Error("headers unavailable"));
    await kickRevampRunner(REVAMP_ID);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${PLATFORM_URL}/api/internal/mink/revamps/run`,
    );
  });
});
