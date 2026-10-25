import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  actor: vi.fn(),
  config: vi.fn(),
  reserve: vi.fn(),
  validate: vi.fn(),
  extract: vi.fn(),
  log: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@/lib/mink/actor-context", () => ({ getMinkActorContext: h.actor }));
vi.mock("@/lib/mink/config", () => ({ getMinkConfig: h.config }));
vi.mock("@/lib/mink/input-limits", () => ({ reserveMinkInput: h.reserve }));
vi.mock("@/lib/mink/input-validation", async (original) => ({
  ...(await original<object>()),
  validateMinkInput: h.validate,
}));
vi.mock("@/lib/mink/input-provider", () => ({ extractMinkInput: h.extract }));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: h.log,
  logError: h.logError,
}));
import { GET, POST } from "./route";
import { MinkRequestError } from "@/lib/mink/errors";
const url = "https://echos.dev.storemink.com/api/mink/input";
const payload = {
  name: "private.png",
  data: "YQ==",
  confirmed: true,
  requestKey: "11111111-1111-4111-8111-111111111111",
};
const req = (body: unknown = payload, headers = {}) =>
  new Request(url, {
    method: "POST",
    headers: {
      origin: new URL(url).origin,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MINK_MULTIMODAL_ENABLED", "true");
  h.config.mockReturnValue({ enabled: true, model: "model" });
  h.actor.mockResolvedValue({ storeId: "echos", adminId: "owner" });
  h.validate.mockResolvedValue({ kind: "image" });
  h.extract.mockResolvedValue({
    text: "Reviewed source",
    usage: { promptTokenCount: 42 },
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("multimodal endpoint authority", () => {
  it("requires the global gate before provider work", async () => {
    h.config.mockReturnValue({ enabled: false });
    expect((await POST(req())).status).toBe(404);
    expect(h.extract).not.toHaveBeenCalled();
    expect(await (await GET()).json()).toEqual({ enabled: false });
  });
  it("does not require a separate multimodal feature switch", async () => {
    vi.stubEnv("MINK_MULTIMODAL_ENABLED", "false");
    expect((await POST(req())).status).toBe(200);
    expect(await (await GET()).json()).toEqual({ enabled: true });
  });
  it("rejects foreign origins before auth", async () => {
    expect(
      (await POST(req(payload, { origin: "https://evil.example" }))).status,
    ).toBe(403);
    expect(h.actor).not.toHaveBeenCalled();
  });
  it("honours auth/invite denial", async () => {
    h.actor.mockRejectedValue(new MinkRequestError("denied", "Denied", 403));
    expect((await POST(req())).status).toBe(403);
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it("requires consent and forbids forged ownership", async () => {
    for (const extra of [{ confirmed: false }, { storeId: "other" }])
      expect((await POST(req({ ...payload, ...extra }))).status).toBe(400);
    expect(h.extract).not.toHaveBeenCalled();
  });
  it("uses trusted identities, private caching and content-free logs", async () => {
    const response = await POST(req());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(h.reserve).toHaveBeenCalledWith(
      { storeId: "echos", adminId: "owner" },
      payload.requestKey,
    );
    expect(JSON.stringify(h.log.mock.calls)).not.toMatch(
      /private.png|YQ==|Reviewed source/,
    );
  });
  it("fails closed on quota database outage before decoding/provider", async () => {
    h.reserve.mockRejectedValue(new Error("private database values"));
    const response = await POST(req());
    expect(response.status).toBe(503);
    expect(h.validate).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("private database");
  });
  it("enforces actual bytes with absent/forged content length", async () => {
    expect(
      (
        await POST(
          req(
            { ...payload, data: "x".repeat(7_100_001) },
            { "content-length": "1" },
          ),
        )
      ).status,
    ).toBe(413);
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it("does not expose provider errors", async () => {
    h.extract.mockRejectedValue(new Error("secret attachment data"));
    const response = await POST(req());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret attachment");
    expect(allLogs()).not.toContain("secret attachment");
  });
});

/** Every logger call, as one string: what may never carry content. An error
 *  is written out the way logError reports it, its message and its cause's. */
const allLogs = () =>
  JSON.stringify([...h.log.mock.calls, ...h.logError.mock.calls], (_k, v) =>
    v instanceof Error
      ? {
          message: v.message,
          cause: v.cause instanceof Error ? v.cause.message : v.cause,
        }
      : v,
  );
/** What input-provider throws when no model could read it. */
const readerUnavailable = () =>
  Object.assign(
    new Error("The attachment reader did not answer.", {
      cause: new Error("secret attachment data"),
    }),
    {
      name: "MinkReaderUnavailableError",
      attempts: 3,
      model: "gemini-3.5-flash",
      location: "asia-south1",
      status: 503,
    },
  );

describe("★★ the reader's failures are visible (B12)", () => {
  it("a reader that could not answer is logged as an error, with content-free facts", async () => {
    h.extract.mockRejectedValue(readerUnavailable());
    const response = await POST(req());
    expect(response.status).toBe(503);
    expect(h.logError).toHaveBeenCalledWith(
      "mink.input.failed",
      "no model could read the attachment (HTTP 503)",
      expect.objectContaining({
        requestId: expect.any(String),
        providerAttempted: true,
        attempts: 3,
        model: "gemini-3.5-flash",
        location: "asia-south1",
        status: 503,
      }),
    );
    expect(allLogs()).not.toMatch(/secret attachment|private\.png|YQ==/);
  });

  it("a database or other fault is an error too, named by its kind only", async () => {
    h.reserve.mockRejectedValue(new Error("private database values"));
    expect((await POST(req())).status).toBe(503);
    expect(h.logError).toHaveBeenCalledWith(
      "mink.input.failed",
      "Error",
      expect.objectContaining({ providerAttempted: false }),
    );
    expect(allLogs()).not.toContain("private database");
  });

  it("a verdict on the input stays information", async () => {
    h.extract.mockRejectedValue(
      new MinkRequestError("input_unreadable", "No readable result.", 422),
    );
    expect((await POST(req())).status).toBe(422);
    expect(h.logError).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(
      "mink.input.failed",
      expect.objectContaining({ code: "input_unreadable" }),
    );
  });

  it("a merchant who went away is not an error", async () => {
    const controller = new AbortController();
    h.extract.mockImplementation(async () => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const request = new Request(url, {
      method: "POST",
      headers: {
        origin: new URL(url).origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    await POST(request);
    expect(h.logError).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(
      "mink.input.failed",
      expect.objectContaining({ cancelled: true }),
    );
  });

  it("the completed log names the model that read it", async () => {
    h.extract.mockResolvedValue({
      text: "Reviewed source",
      usage: { promptTokenCount: 42 },
      model: "gemini-3.5-flash",
      location: "asia-south1",
      attempts: 3,
    });
    expect((await POST(req())).status).toBe(200);
    expect(h.log).toHaveBeenCalledWith(
      "mink.input.completed",
      expect.objectContaining({
        model: "gemini-3.5-flash",
        location: "asia-south1",
        attempts: 3,
      }),
    );
  });

  it("★ every attempt shares the route's one deadline", async () => {
    const before = Date.now();
    await POST(req());
    const [, , signal, , options] = h.extract.mock.calls[0];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(options.deadlineAt).toBeGreaterThanOrEqual(before + 45_000);
    expect(options.deadlineAt).toBeLessThanOrEqual(Date.now() + 45_000);
  });
});
