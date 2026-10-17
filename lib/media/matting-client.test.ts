import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import {
  MattingError,
  mattingConfigured,
  mattingUrl,
  requestProductMask,
} from "./matting-client";

/** An environment with only the matting URL (and the NODE_ENV Node types require). */
function env(url?: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    ...(url === undefined ? {} : { IMAGE_MATTING_URL: url }),
  };
}

const PHOTO = Buffer.from("photo-bytes");
const REMOTE = env("https://matting.example.run.app/");
const LOCAL = env("http://localhost:8080");

function maskResponse(headers: Record<string, string> = {}) {
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: {
      "x-matting-width": "400",
      "x-matting-height": "300",
      "x-matting-verdict": "ok",
      "x-matting-coverage": "0.25",
      ...headers,
    },
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return error instanceof MattingError ? error.code : null;
}

describe("mattingUrl", () => {
  it("accepts https anywhere and plain http only on this machine", () => {
    expect(mattingUrl(REMOTE)).toBe("https://matting.example.run.app");
    expect(mattingUrl(LOCAL)).toBe("http://localhost:8080");
    expect(mattingUrl(env("http://127.0.0.1:9"))).toBe("http://127.0.0.1:9");
    expect(mattingUrl(env("http://matting.example"))).toBeNull();
    expect(mattingUrl(env("not a url"))).toBeNull();
    expect(mattingUrl(env())).toBeNull();
    expect(mattingConfigured(env())).toBe(false);
    expect(mattingConfigured(REMOTE)).toBe(true);
  });
});

describe("requestProductMask", () => {
  it("sends the photo with an identity token minted for the service URL", async () => {
    const tokenSource = vi.fn(async () => "id-token");
    const fetchImpl = vi.fn<typeof fetch>(async () => maskResponse());
    const result = await requestProductMask(PHOTO, {
      env: REMOTE,
      tokenSource,
      fetchImpl,
    });
    expect(tokenSource).toHaveBeenCalledWith("https://matting.example.run.app");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://matting.example.run.app/v1/matte?output=mask");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer id-token",
    );
    expect(result).toMatchObject({
      width: 400,
      height: 300,
      verdict: "ok",
      coverage: 0.25,
    });
    expect([...result.mask]).toEqual([1, 2, 3]);
  });

  it("sends no token to a service on this machine", async () => {
    const tokenSource = vi.fn(async () => "id-token");
    const fetchImpl = vi.fn<typeof fetch>(async () => maskResponse());
    await requestProductMask(PHOTO, { env: LOCAL, tokenSource, fetchImpl });
    expect(tokenSource).not.toHaveBeenCalled();
    const init = fetchImpl.mock.calls[0][1];
    expect(
      (init?.headers as Record<string, string>).authorization,
    ).toBeUndefined();
  });

  it("reads the service's verdict, and treats anything unknown as ok", async () => {
    for (const [header, verdict] of [
      ["empty", "empty"],
      ["full", "full"],
      ["???", "ok"],
    ] as const) {
      const result = await requestProductMask(PHOTO, {
        env: LOCAL,
        fetchImpl: async () => maskResponse({ "x-matting-verdict": header }),
      });
      expect(result.verdict).toBe(verdict);
    }
  });

  it("is not configured without a URL", async () => {
    expect(await codeOf(requestProductMask(PHOTO, { env: env() }))).toBe(
      "not_configured",
    );
  });

  it("is unavailable when no identity token can be had", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(
      await codeOf(
        requestProductMask(PHOTO, {
          env: REMOTE,
          tokenSource: async () => {
            throw new Error("no credentials");
          },
          fetchImpl,
        }),
      ),
    ).toBe("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps the service's refusals to what the merchant can do about them", async () => {
    const answer = (status: number, error?: string) => async () =>
      new Response(JSON.stringify(error ? { error } : {}), { status });
    expect(
      await codeOf(
        requestProductMask(PHOTO, { env: LOCAL, fetchImpl: answer(429) }),
      ),
    ).toBe("busy");
    expect(
      await codeOf(
        requestProductMask(PHOTO, { env: LOCAL, fetchImpl: answer(503) }),
      ),
    ).toBe("busy");
    expect(
      await codeOf(
        requestProductMask(PHOTO, {
          env: LOCAL,
          fetchImpl: answer(413, "too_large"),
        }),
      ),
    ).toBe("too_large");
    expect(
      await codeOf(
        requestProductMask(PHOTO, {
          env: LOCAL,
          fetchImpl: answer(400, "too_many_pixels"),
        }),
      ),
    ).toBe("too_large");
    expect(
      await codeOf(
        requestProductMask(PHOTO, {
          env: LOCAL,
          fetchImpl: answer(415, "unsupported_type"),
        }),
      ),
    ).toBe("unreadable");
    expect(
      await codeOf(
        requestProductMask(PHOTO, { env: LOCAL, fetchImpl: answer(500) }),
      ),
    ).toBe("unavailable");
  });

  it("is unavailable when the request fails or the answer is malformed", async () => {
    expect(
      await codeOf(
        requestProductMask(PHOTO, {
          env: LOCAL,
          fetchImpl: async () => {
            throw new Error("network");
          },
        }),
      ),
    ).toBe("unavailable");
    expect(
      await codeOf(
        requestProductMask(PHOTO, {
          env: LOCAL,
          fetchImpl: async () => maskResponse({ "x-matting-width": "0" }),
        }),
      ),
    ).toBe("unavailable");
  });
});
