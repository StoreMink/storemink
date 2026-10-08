import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import {
  debugToken,
  exchangeEmbeddedSignupCode,
  graphRequest,
  isTokenError,
  registerPhoneNumber,
  subscribeAppToWaba,
} from "./graph";

function reply(status: number, body: unknown) {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("graphRequest — the three-way outcome", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const OLD = { ...process.env };

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env.WHATSAPP_APP_ID = "APP";
    process.env.WHATSAPP_APP_SECRET = "SECRET";
    process.env.WHATSAPP_GRAPH_VERSION = "v26.0";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...OLD };
  });

  it("returns data on 2xx", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
    const r = await subscribeAppToWaba("tok", "WABA");
    expect(r).toEqual({ ok: true, data: { success: true } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://graph.facebook.com/v26.0/WABA/subscribed_apps",
    );
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer tok",
    );
  });

  it("a 4xx with Meta's error object is REJECTED, carrying code and message", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(400, {
        error: {
          message: "Invalid OAuth access token",
          code: 190,
          error_subcode: 463,
        },
      }),
    );
    const r = await registerPhoneNumber("tok", "PN", "123456");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.outcome).toBe("rejected");
    expect(r.code).toBe(190);
    expect(r.subcode).toBe(463);
    expect(r.error).toContain("Invalid OAuth");
    expect(isTokenError(r)).toBe(true);
  });

  it("★ a 5xx is UNKNOWN, never a rejection — the request may have happened", async () => {
    fetchMock.mockResolvedValueOnce(reply(502, undefined));
    const r = await subscribeAppToWaba("tok", "WABA");
    expect(r).toMatchObject({ ok: false, outcome: "unknown" });
    expect(isTokenError(r)).toBe(false);
  });

  it("★ a thrown fetch is UNKNOWN too", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const r = await graphRequest({ path: "/x", token: "tok" });
    expect(r).toMatchObject({ ok: false, outcome: "unknown" });
  });

  it("a 2xx whose body carries an error object is still a rejection", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, { error: { message: "Unsupported", code: 100 } }),
    );
    const r = await graphRequest({ path: "/x", token: "tok" });
    expect(r).toMatchObject({ ok: false, outcome: "rejected", code: 100 });
  });

  it("exchangeEmbeddedSignupCode sends the app id and secret as query, never a bearer", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: "BIZ" }));
    const r = await exchangeEmbeddedSignupCode("the-code");
    expect(r).toEqual({ ok: true, data: { access_token: "BIZ" } });
    const [url, init] = fetchMock.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.pathname).toBe("/v26.0/oauth/access_token");
    expect(u.searchParams.get("client_id")).toBe("APP");
    expect(u.searchParams.get("client_secret")).toBe("SECRET");
    expect(u.searchParams.get("code")).toBe("the-code");
    expect(
      (init?.headers as Record<string, string> | undefined)?.authorization,
    ).toBeUndefined();
  });

  it("exchangeEmbeddedSignupCode refuses without calling Meta when unconfigured", async () => {
    delete process.env.WHATSAPP_APP_SECRET;
    const r = await exchangeEmbeddedSignupCode("c");
    expect(r).toMatchObject({ ok: false, outcome: "rejected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("debugToken uses the app access token (id|secret)", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { data: { is_valid: true } }));
    await debugToken("BIZ");
    const u = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(u.searchParams.get("input_token")).toBe("BIZ");
    expect(u.searchParams.get("access_token")).toBe("APP|SECRET");
  });
});
