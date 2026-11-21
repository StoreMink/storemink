import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/logger", () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import {
  ELEVENLABS_IMAGE_API,
  elevenLabsPrompt,
  requestElevenLabsImage,
} from "./image-elevenlabs";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const KEY = "test-key";

type Call = { url: string; init?: RequestInit };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fake ElevenLabs: answers are taken in order, one per request. */
function fakeFetch(
  answers: Array<(call: Call) => Response | Promise<Response>>,
) {
  const calls: Call[] = [];
  const impl = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), init };
      calls.push(call);
      const next = answers.shift();
      if (!next) throw new Error(`unexpected request ${call.url}`);
      return next(call);
    },
  );
  return { calls, fetch: impl as unknown as typeof fetch };
}

const noSleep = async (_ms: number, signal: AbortSignal) => {
  if (signal.aborted) throw new Error("aborted");
};

const input = {
  prompt: "A ceramic mug on linen",
  aspectRatio: "4:5",
  images: [{ mediaType: "image/webp", base64: "AAAA" }],
};

function options(fetchImpl: typeof fetch, extra: object = {}) {
  return {
    apiKey: KEY,
    model: "gemini-3.1-flash-image" as const,
    fetch: fetchImpl,
    sleep: noSleep,
    random: () => 0.5,
    ...extra,
  };
}

const completed = () =>
  json(200, {
    status: "completed",
    content_url: "https://cdn.example.test/out.png?sig=1",
    content_mime_type: "image/png",
  });

const file = () => new Response(PNG, { status: 200 });

describe("requestElevenLabsImage", () => {
  it("creates, polls and downloads the picture", async () => {
    const { calls, fetch } = fakeFetch([
      () => json(200, { id: "gen_1", status: "pending" }),
      () => json(200, { status: "generating" }),
      completed,
      file,
    ]);
    const result = await requestElevenLabsImage(
      input,
      new AbortController().signal,
      options(fetch),
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.mediaType).toBe("image/png");
    expect(Array.from(result.bytes)).toEqual(Array.from(PNG));
    expect(result.timing?.providerAttempts).toBe(1);

    const create = calls[0];
    expect(create.url).toBe(ELEVENLABS_IMAGE_API);
    const body = JSON.parse(String(create.init?.body));
    expect(body).toMatchObject({
      model_id: "gemini-3.1-flash-image",
      aspect_ratio: "4:5",
      resolution: "2K",
      images: [
        {
          type: "inline_base64",
          content_base64: "AAAA",
          mime_type: "image/webp",
        },
      ],
    });
    expect(calls[1].url).toBe(`${ELEVENLABS_IMAGE_API}/gen_1`);
  });

  it("never sends the key to the signed download address", async () => {
    const { calls, fetch } = fakeFetch([
      () => json(200, { id: "gen_1" }),
      completed,
      file,
    ]);
    await requestElevenLabsImage(
      input,
      new AbortController().signal,
      options(fetch),
    );
    const download = calls[2];
    expect(download.url).toContain("cdn.example.test");
    expect(JSON.stringify(download.init ?? {})).not.toContain(KEY);
    expect(JSON.stringify(calls[0].init?.headers)).toContain(KEY);
  });

  it("waits out a 429 on create and asks again", async () => {
    const sleep = vi.fn(noSleep);
    const { calls, fetch } = fakeFetch([
      () => json(429, { detail: { code: "rate_limit_exceeded" } }),
      () => json(200, { id: "gen_2" }),
      completed,
      file,
    ]);
    const result = await requestElevenLabsImage(
      input,
      new AbortController().signal,
      options(fetch, { sleep }),
    );
    expect(result.kind).toBe("ok");
    expect(result.timing?.providerAttempts).toBe(2);
    expect(calls.filter((c) => c.url === ELEVENLABS_IMAGE_API)).toHaveLength(2);
  });

  it("reports rate_limited after the retries run out", async () => {
    const { fetch } = fakeFetch(
      Array.from(
        { length: 9 },
        () => () =>
          json(429, { detail: { code: "concurrent_limit_exceeded" } }),
      ),
    );
    const result = await requestElevenLabsImage(
      input,
      new AbortController().signal,
      options(fetch),
    );
    expect(result).toMatchObject({ kind: "error", code: "rate_limited" });
  });

  it("reads a moderated generation as a refusal with its reason", async () => {
    const { fetch } = fakeFetch([
      () => json(200, { id: "gen_3" }),
      () =>
        json(200, {
          status: "failed",
          failure_reason: "moderated",
          error_message: "Blocked by policy",
        }),
    ]);
    const result = await requestElevenLabsImage(
      input,
      new AbortController().signal,
      options(fetch),
    );
    expect(result).toMatchObject({
      kind: "refused",
      reason: "Blocked by policy",
    });
  });

  it("maps a refused key, a bad request and a server error", async () => {
    for (const [status, code] of [
      [401, "provider_auth"],
      [402, "provider_rejected"],
      [422, "provider_rejected"],
      [503, "provider_unavailable"],
    ] as const) {
      const { fetch } = fakeFetch([() => json(status, { detail: {} })]);
      const result = await requestElevenLabsImage(
        input,
        new AbortController().signal,
        options(fetch),
      );
      expect(result).toMatchObject({ kind: "error", code });
    }
  });

  it("sends nothing once the drain has fired", async () => {
    const drain = new AbortController();
    drain.abort();
    const { calls, fetch } = fakeFetch([]);
    const result = await requestElevenLabsImage(
      input,
      new AbortController().signal,
      options(fetch, { draining: drain.signal }),
    );
    expect(result).toMatchObject({ kind: "error", code: "cancelled" });
    expect(result.timing?.providerAttempts).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("marks a job the stop cut off after it was created", async () => {
    const stop = new AbortController();
    const { fetch } = fakeFetch([
      () => {
        return json(200, { id: "gen_4" });
      },
    ]);
    const sleep = async (_ms: number, signal: AbortSignal) => {
      stop.abort();
      if (signal.aborted) throw new Error("aborted");
    };
    const result = await requestElevenLabsImage(
      input,
      stop.signal,
      options(fetch, { sleep, markStoppedInFlight: true }),
    ).catch((error) => {
      throw error;
    });
    expect(result).toMatchObject({ kind: "error", code: "cancelled" });
    expect(result.timing?.stoppedInFlight).toBe(true);
  });
});

describe("elevenLabsPrompt", () => {
  it("names each reference by its place in the list", () => {
    expect(
      elevenLabsPrompt("Base", [{ role: "anchor" }, { role: "product" }]),
    ).toContain(
      "Image 1 is the reference labelled ANCHOR. Image 2 is the reference labelled PRODUCT.",
    );
    expect(elevenLabsPrompt("Base", [])).toBe("Base");
  });
});
