import {
  ApiError,
  HarmBlockThreshold,
  HarmCategory,
  Modality,
  ProminentPeople,
  ThinkingLevel,
  type GenerateContentConfig,
  type GenerateContentResponse,
} from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { logInfo, logWarn } from "@/lib/observability/logger";
import { estimateImageCostMicroUsd } from "./cost";
import { createFakeImageClient, FAKE_IMAGE_LONG_EDGE } from "./image-fake";
import {
  IMAGE_SAMPLING_PARAMETERS,
  getThemeStudioImageConfig,
  themeStudioImageSize,
} from "./image-models";
import {
  assertThemeImageRequest,
  type ThemeImageRequest,
} from "./image-provider";
import {
  createVertexImageClient,
  imageDimensions,
  minimumLongEdgePx,
  parseThemeImageResponse,
  themeImageAnswerParts,
  themeImageConfig,
  themeImageParts,
} from "./image-vertex";

// The client's log lines, off the console and readable by the tests.
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const REQUEST: ThemeImageRequest = {
  purpose: "product",
  briefId: "product-mug",
  aspectRatio: "4:5",
  prompt: "A stoneware mug.",
  references: [{ role: "anchor", mediaType: "image/webp", base64: "QUJD" }],
};

const CONFIG = {
  projectId: "p",
  location: "global",
  modelKey: "gemini-nano-banana-2.1" as const,
  providerModel: "gemini-nano-banana-2.1",
};

/** The owner's rollback (THEME_STUDIO_IMAGE_MODEL=gemini-3-pro-image). */
const PRO_CONFIG = {
  projectId: "p",
  location: "global",
  modelKey: "gemini-3-pro-image" as const,
  providerModel: "gemini-3-pro-image",
};

/** The photos the homepage opens with in these tests: worker.ts names them
 * from the run's package (image-models.ts homepageOpeningPhotoIds). Every
 * photo of a slot the homepage does not open with is 2K. */
const HOMEPAGE_SLIDES: ReadonlySet<string> = new Set([
  "hero-21:9",
  "hero-16:9",
  "hero-4:5",
  "content-21:9",
  "hero-1",
]);

/** Theme Studio's request options (worker.ts imageClientFor). */
const OPTIONS = {
  imageSize: (request: ThemeImageRequest) =>
    themeStudioImageSize(request, HOMEPAGE_SLIDES),
  thinkingLevel: ThinkingLevel.HIGH,
};

/** The same at one size for every request: the log tests' 2K pictures. */
const OPTIONS_2K = { ...OPTIONS, imageSize: "2K" as const };

/** What the 2.1 client sends for a request, read through the send seam. */
async function sentFor(
  request: ThemeImageRequest,
  options: Partial<
    Pick<
      Parameters<typeof createVertexImageClient>[1],
      "imageSize" | "thinkingLevel"
    >
  > = {},
  config: typeof CONFIG | typeof PRO_CONFIG = CONFIG,
): Promise<GenerateContentConfig> {
  let sent: GenerateContentConfig | null = null;
  const client = createVertexImageClient(
    { ...config, projectId: `sent-${request.briefId}-${config.modelKey}` },
    {
      ...OPTIONS,
      ...options,
      send: async (_request, _signal, config) => {
        sent = config;
        return okResponse;
      },
    },
  );
  expect((await client.generateImage(request, signal())).kind).toBe("ok");
  if (!sent) throw new Error("nothing was sent");
  return sent;
}

const IMAGE = Buffer.from("fake-jpeg").toString("base64");

function response(parts: object): GenerateContentResponse {
  return parts as unknown as GenerateContentResponse;
}
const okResponse = response({
  candidates: [
    {
      finishReason: "STOP",
      content: {
        parts: [
          { text: "Here is the image." },
          { inlineData: { mimeType: "image/jpeg", data: IMAGE } },
        ],
      },
    },
  ],
  usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 1690 },
});

function status(code: number) {
  return Object.assign(new Error(`HTTP ${code}`), { status: code });
}

const signal = () => new AbortController().signal;

describe("the image model registry", () => {
  it("★★ is off without a project, and defaults to Nano Banana 2.1 on the global endpoint (owner, 25 Oct 2026)", () => {
    expect(getThemeStudioImageConfig({})).toBeNull();
    expect(getThemeStudioImageConfig({ GCP_PROJECT_ID: "p" })).toEqual(CONFIG);
    // The value cloudbuild.yaml sets by default is the same model.
    expect(
      getThemeStudioImageConfig({
        GCP_PROJECT_ID: "p",
        THEME_STUDIO_IMAGE_MODEL: "gemini-nano-banana-2.1",
      }),
    ).toEqual(CONFIG);
  });

  it("★★ an override may pin a version of 2.1, or roll back to the Pro family, and nothing else", () => {
    expect(
      getThemeStudioImageConfig({
        GCP_PROJECT_ID: "p",
        THEME_STUDIO_IMAGE_MODEL: "gemini-nano-banana-2.1-001",
      }),
    ).toEqual({ ...CONFIG, providerModel: "gemini-nano-banana-2.1-001" });
    // The owner's rollback: the Pro family, a published version included.
    expect(
      getThemeStudioImageConfig({
        GCP_PROJECT_ID: "p",
        THEME_STUDIO_IMAGE_MODEL: "gemini-3-pro-image",
      }),
    ).toEqual(PRO_CONFIG);
    expect(
      getThemeStudioImageConfig({
        GCP_PROJECT_ID: "p",
        THEME_STUDIO_IMAGE_MODEL: "gemini-3-pro-image-001",
      }),
    ).toEqual({ ...PRO_CONFIG, providerModel: "gemini-3-pro-image-001" });
    // Any other model, cheaper or not, is a different model, never a version.
    for (const other of [
      "gemini-3.1-flash-image",
      "gemini-3-pro-image-lite",
      "gemini-3-pro-image-preview",
      "gemini-nano-banana-2.1-lite",
      "gemini-nano-banana-2",
      "gemini-nano-banana-2.10",
      "gemini-3.1-flash-lite-image",
      "gemini-3.8-flash",
    ]) {
      expect(() =>
        getThemeStudioImageConfig({
          GCP_PROJECT_ID: "p",
          THEME_STUDIO_IMAGE_MODEL: other,
        }),
      ).toThrow(/model family/);
    }
  });
});

const SETTINGS = {
  model: "gemini-nano-banana-2.1",
  imageSize: "2K",
  thinkingLevel: ThinkingLevel.HIGH,
} as const;

describe("the fixed provider configuration", () => {
  it("pins every safety value to Mink's verified call", () => {
    const config = themeImageConfig(REQUEST, SETTINGS);
    expect(config.responseModalities).toEqual([Modality.TEXT, Modality.IMAGE]);
    expect(config.candidateCount).toBe(1);
    expect(config.safetySettings).toHaveLength(4);
    for (const setting of config.safetySettings ?? []) {
      expect(setting.threshold).toBe(HarmBlockThreshold.BLOCK_LOW_AND_ABOVE);
    }
    expect(config.imageConfig).toEqual({
      aspectRatio: "4:5",
      imageSize: "2K",
      personGeneration: "ALLOW_NONE",
      prominentPeople: ProminentPeople.BLOCK_PROMINENT_PEOPLE,
      outputMimeType: "image/jpeg",
      outputCompressionQuality: 95,
    });
  });

  it("★★ a request to 2.1 is exactly the verified one: the caller's size and thinking level, and no sampling parameter", () => {
    expect(themeImageConfig(REQUEST, SETTINGS)).toEqual({
      responseModalities: [Modality.TEXT, Modality.IMAGE],
      candidateCount: 1,
      safetySettings: [
        HarmCategory.HARM_CATEGORY_HARASSMENT,
        HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      ].map((category) => ({
        category,
        threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
      })),
      imageConfig: {
        aspectRatio: "4:5",
        imageSize: "2K",
        personGeneration: "ALLOW_NONE",
        prominentPeople: ProminentPeople.BLOCK_PROMINENT_PEOPLE,
        outputMimeType: "image/jpeg",
        outputCompressionQuality: 95,
      },
      thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
    });
    const hero = themeImageConfig(
      { ...REQUEST, purpose: "hero", aspectRatio: "21:9", references: [] },
      { ...SETTINGS, imageSize: "4K", thinkingLevel: ThinkingLevel.MEDIUM },
    );
    expect(hero.imageConfig?.imageSize).toBe("4K");
    expect(hero.thinkingConfig).toEqual({
      thinkingLevel: ThinkingLevel.MEDIUM,
    });
    // A legacy "512" or "0.5K" is asked of 2.1 as "1K".
    for (const legacy of ["512", "0.5K"] as const) {
      expect(
        themeImageConfig(REQUEST, { ...SETTINGS, imageSize: legacy })
          .imageConfig?.imageSize,
      ).toBe("1K");
    }
    for (const parameter of IMAGE_SAMPLING_PARAMETERS) {
      expect(themeImageConfig(REQUEST, SETTINGS)).not.toHaveProperty(parameter);
    }
  });

  it("★★ the owner's Pro rollback is sent the caller's size and no thinking config, the rest unchanged", () => {
    const pro = themeImageConfig(REQUEST, {
      ...SETTINGS,
      model: "gemini-3-pro-image",
    });
    expect(pro).not.toHaveProperty("thinkingConfig");
    expect(pro.imageConfig?.imageSize).toBe("2K");
    const { thinkingConfig, ...withoutThinking } = themeImageConfig(
      REQUEST,
      SETTINGS,
    );
    expect(thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.HIGH });
    expect(pro).toEqual(withoutThinking);
  });

  it("sends the prompt, then each reference after a label naming its role", () => {
    expect(themeImageParts(REQUEST)).toEqual([
      { text: "A stoneware mug." },
      { text: "ANCHOR:" },
      { inlineData: { mimeType: "image/webp", data: "QUJD" } },
    ]);
  });
});

describe("reading a response", () => {
  it("returns the inline image and the usage", () => {
    const result = parseThemeImageResponse(okResponse);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(Buffer.from(result.bytes).toString()).toBe("fake-jpeg");
    expect(result.mediaType).toBe("image/jpeg");
    expect(result.usage).toEqual({
      inputTokens: 900,
      outputTokens: 1690,
      thinkingTokens: 0,
    });
    // ★ The client names the model that answered, so cost.ts prices it there.
    expect(
      parseThemeImageResponse(okResponse, "gemini-nano-banana-2.1").usage,
    ).toEqual({
      inputTokens: 900,
      outputTokens: 1690,
      thinkingTokens: 0,
      model: "gemini-nano-banana-2.1",
    });
  });

  it("★★ a Nano Banana 2.1 answer at HIGH thinking: keeps the final picture, never its draft, and counts the thinking", () => {
    // The shape of every 2.1 answer on storemink-staging (25 Oct 2026): thought
    // text, a thought draft, thought text, then the final picture; at HIGH,
    // the usage counts thinking apart from the picture's 1,680 tokens.
    const draft = Buffer.from("draft-1K").toString("base64");
    const final = Buffer.from("final-2400x1792").toString("base64");
    const answer = response({
      modelVersion: "gemini-nano-banana-2.1",
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { text: "Composing the still life", thought: true },
              {
                thought: true,
                inlineData: { mimeType: "image/jpeg", data: draft },
              },
              { text: "Refining the light", thought: true },
              {
                thoughtSignature: "sig",
                inlineData: { mimeType: "image/jpeg", data: final },
              },
              { text: "Here is the photograph." },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 83,
        candidatesTokenCount: 1698,
        totalTokenCount: 3130,
        thoughtsTokenCount: 1349,
        candidatesTokensDetails: [
          { modality: "IMAGE", tokenCount: 1680 },
          { modality: "TEXT", tokenCount: 18 },
        ],
      },
    });
    const result = parseThemeImageResponse(answer, "gemini-nano-banana-2.1");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(Buffer.from(result.bytes).toString()).toBe("final-2400x1792");
    expect(result.usage).toEqual({
      inputTokens: 83,
      outputTokens: 1698,
      thinkingTokens: 1349,
      model: "gemini-nano-banana-2.1",
    });
  });

  it("★★ a Nano Banana 2.1 answer with no draft, and one at MINIMAL thinking with a draft and no thinking counted", () => {
    const final = Buffer.from("final-only").toString("base64");
    const noDraft = parseThemeImageResponse(
      response({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [{ inlineData: { mimeType: "image/jpeg", data: final } }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 77, candidatesTokenCount: 1680 },
      }),
      "gemini-nano-banana-2.1",
    );
    expect(noDraft.kind).toBe("ok");
    if (noDraft.kind !== "ok") return;
    expect(Buffer.from(noDraft.bytes).toString()).toBe("final-only");

    // MINIMAL: the draft, then the picture; the usage reported no thoughts.
    const minimal = parseThemeImageResponse(
      response({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                {
                  thought: true,
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: Buffer.from("draft").toString("base64"),
                  },
                },
                { inlineData: { mimeType: "image/jpeg", data: final } },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 77, candidatesTokenCount: 1680 },
      }),
      "gemini-nano-banana-2.1",
    );
    expect(minimal.kind).toBe("ok");
    if (minimal.kind !== "ok") return;
    expect(Buffer.from(minimal.bytes).toString()).toBe("final-only");
    expect(minimal.usage).toEqual({
      inputTokens: 77,
      outputTokens: 1680,
      thinkingTokens: 0,
      model: "gemini-nano-banana-2.1",
    });
  });

  it("keeps the final image, never the 1K thought draft gemini-3-pro-image sends first", () => {
    // The shape measured on storemink-staging (2026-10-23) for a 21:9 2K
    // request: thought text, a 1584x672 thought image, thought text, then the
    // 3168x1344 final image carrying a thought signature.
    const draft = Buffer.from("draft-1584x672").toString("base64");
    const final = Buffer.from("final-3168x1344").toString("base64");
    const draftFirst = parseThemeImageResponse(
      response({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                { text: "Planning the shot", thought: true },
                {
                  thought: true,
                  inlineData: { mimeType: "image/jpeg", data: draft },
                },
                { text: "Checking it", thought: true },
                {
                  thoughtSignature: "sig",
                  inlineData: { mimeType: "image/jpeg", data: final },
                },
              ],
            },
          },
        ],
      }),
    );
    expect(draftFirst.kind).toBe("ok");
    if (draftFirst.kind !== "ok") return;
    expect(Buffer.from(draftFirst.bytes).toString()).toBe("final-3168x1344");

    // Two plain image parts (a default render, then the size asked for): the
    // last is the final picture.
    const twoFinals = parseThemeImageResponse(
      response({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                { inlineData: { mimeType: "image/jpeg", data: draft } },
                { inlineData: { mimeType: "image/jpeg", data: final } },
              ],
            },
          },
        ],
      }),
    );
    expect(twoFinals.kind).toBe("ok");
    if (twoFinals.kind !== "ok") return;
    expect(Buffer.from(twoFinals.bytes).toString()).toBe("final-3168x1344");
  });

  it("an answer holding only a thought draft has no image to keep", () => {
    const draftOnly = (finishReason: string) =>
      parseThemeImageResponse(
        response({
          candidates: [
            {
              finishReason,
              content: {
                parts: [
                  {
                    thought: true,
                    inlineData: { mimeType: "image/jpeg", data: IMAGE },
                  },
                ],
              },
            },
          ],
        }),
      );
    expect(draftOnly("IMAGE_SAFETY")).toMatchObject({
      kind: "refused",
      reason: "IMAGE_SAFETY",
    });
    expect(draftOnly("STOP")).toMatchObject({
      kind: "error",
      code: "provider_unavailable",
    });
  });

  it("a blocked prompt or a named stop without an image is a refusal with its reason", () => {
    expect(
      parseThemeImageResponse(
        response({ promptFeedback: { blockReason: "SAFETY" } }),
      ),
    ).toMatchObject({ kind: "refused", reason: "SAFETY" });
    expect(
      parseThemeImageResponse(
        response({
          candidates: [
            { finishReason: "IMAGE_SAFETY", content: { parts: [] } },
          ],
        }),
      ),
    ).toMatchObject({ kind: "refused", reason: "IMAGE_SAFETY" });
  });

  it("no image and no reason is a failure, never an empty success", () => {
    expect(
      parseThemeImageResponse(
        response({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "hi" }] } },
          ],
        }),
      ),
    ).toMatchObject({ kind: "error", code: "provider_unavailable" });
  });

  it("refuses an image type the pipeline cannot open", () => {
    expect(
      parseThemeImageResponse(
        response({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [{ inlineData: { mimeType: "image/gif", data: IMAGE } }],
              },
            },
          ],
        }),
      ),
    ).toMatchObject({ kind: "error", code: "provider_rejected" });
  });
});

describe("the Vertex client", () => {
  it("retains local cooldown and 429 retries when the database pause fails", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(status(429))
      .mockResolvedValueOnce(okResponse);
    const sleep = vi.fn(async () => true);
    const client = createVertexImageClient(
      { ...CONFIG, projectId: "failed-db-pause" },
      {
        ...OPTIONS,
        send,
        sleep,
        random: () => 0,
        capacity: {
          run: (operation, signal) =>
            operation({
              signal,
              succeeded() {},
              async rateLimited() {
                throw new Error("DB timeout");
              },
            }),
        },
      },
    );
    expect(await client.generateImage(REQUEST, signal())).toMatchObject({
      kind: "ok",
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });
  it("waits out a rate limit, which bills nothing, then returns the image", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(status(429))
      .mockResolvedValueOnce(okResponse);
    const sleep = vi.fn(async () => true);
    const client = createVertexImageClient(CONFIG, {
      ...OPTIONS,
      send,
      sleep,
      random: () => 0,
    });
    const result = await client.generateImage(REQUEST, signal());
    expect(result.kind).toBe("ok");
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7_500, expect.anything());
  });

  it("★★ a refusal holds the others back, and waits itself, at most 15 s, then queues again through the shared capacity", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(status(429))
      .mockRejectedValueOnce(status(429))
      .mockRejectedValueOnce(status(429))
      .mockResolvedValueOnce(okResponse);
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<boolean>>(
      async () => true,
    );
    const paused: number[] = [];
    let admissions = 0;
    const client = createVertexImageClient(
      { ...CONFIG, projectId: "paced-retries" },
      {
        ...OPTIONS,
        send,
        sleep,
        // The top of each backoff step: 15, 30 and 60 s before the ceiling.
        random: () => 1,
        capacity: {
          run: (operation, signal) => {
            admissions++;
            return operation({
              signal,
              succeeded() {},
              async rateLimited(delayMs) {
                paused.push(delayMs);
              },
            });
          },
        },
      },
    );
    const result = await client.generateImage(REQUEST, signal());
    expect(result.kind).toBe("ok");
    expect(paused).toEqual([15_000, 15_000, 15_000]);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([
      15_000, 15_000, 15_000,
    ]);
    // Every retry went back to the capacity (the start pacer) for its turn.
    expect(admissions).toBe(4);
    expect(result.timing?.providerAttempts).toBe(4);
  });

  it("gives up after five retries of a refusal, never more", async () => {
    const send = vi.fn().mockRejectedValue(status(429));
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<boolean>>(
      async () => true,
    );
    const client = createVertexImageClient(
      { ...CONFIG, projectId: "bounded-retries" },
      { ...OPTIONS, send, sleep, random: () => 1 },
    );
    expect(await client.generateImage(REQUEST, signal())).toMatchObject({
      kind: "error",
      code: "rate_limited",
    });
    expect(send).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledTimes(5);
    for (const [ms] of sleep.mock.calls) expect(ms).toBeLessThanOrEqual(15_000);
  });

  it("never retries a failure that may have billed", async () => {
    for (const code of [500, 503, 400]) {
      const send = vi.fn().mockRejectedValue(status(code));
      const client = createVertexImageClient(CONFIG, { ...OPTIONS, send });
      const result = await client.generateImage(REQUEST, signal());
      expect(result.kind).toBe("error");
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
  it("coordinates provider cooldowns across themes instead of sending new slots into a 429 storm", async () => {
    const release: (() => void)[] = [];
    const retried = new Set<string>();
    const client = createVertexImageClient(
      { ...CONFIG, projectId: "cooldown-fairness" },
      {
        ...OPTIONS,
        random: () => 0,
        send: async (request) => {
          if (request.briefId !== "healthy" && !retried.has(request.briefId)) {
            retried.add(request.briefId);
            throw status(429);
          }
          return okResponse;
        },
        sleep: () =>
          new Promise<boolean>((resolve) => release.push(() => resolve(true))),
      },
    );
    const waiting = [0, 1, 2].map((i) =>
      client.generateImage({ ...REQUEST, briefId: `waiting-${i}` }, signal()),
    );
    try {
      await vi.waitFor(() => expect(release).toHaveLength(3));
      let healthyDone = false;
      const healthy = client
        .generateImage({ ...REQUEST, briefId: "healthy" }, signal())
        .then((result) => {
          healthyDone = result.kind === "ok";
          return result;
        });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(healthyDone).toBe(false);
      release.forEach((resolve) => resolve());
      await vi.waitFor(() => expect(healthyDone).toBe(true));
      await healthy;
    } finally {
      release.forEach((resolve) => resolve());
      await Promise.all(waiting);
    }
  });

  it("reports a cancelled run as cancelled", async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const client = createVertexImageClient(CONFIG, { ...OPTIONS, send });
    expect(
      await client.generateImage(REQUEST, controller.signal),
    ).toMatchObject({ kind: "error", code: "cancelled" });
  });

  it("★★ sends each request the size and thinking its caller states: 2K, a wide homepage hero 4K, HIGH, and never a sampling parameter", async () => {
    const cases: [Partial<ThemeImageRequest>, string][] = [
      [{}, "2K"],
      [{ purpose: "hero", aspectRatio: "21:9", references: [] }, "4K"],
      [{ purpose: "hero", aspectRatio: "16:9", references: [] }, "4K"],
      // A narrower hero is a homepage feature scene, not a slide.
      [{ purpose: "hero", aspectRatio: "4:5", references: [] }, "2K"],
      // ★ A wide hero the homepage does not open with (a story or promo
      // page's banner) is 2K.
      [
        {
          purpose: "hero",
          aspectRatio: "21:9",
          references: [],
          briefId: "story-page-hero",
        },
        "2K",
      ],
      [{ purpose: "anchor", aspectRatio: "4:3", references: [] }, "2K"],
      [{ purpose: "category", aspectRatio: "1:1" }, "2K"],
      [{ purpose: "content", aspectRatio: "16:9" }, "2K"],
      [{ purpose: "content", aspectRatio: "21:9" }, "2K"],
    ];
    for (const [change, size] of cases) {
      const request = {
        ...REQUEST,
        briefId: `${change.purpose ?? "product"}-${change.aspectRatio ?? "4:5"}`,
        ...change,
      } as ThemeImageRequest;
      const sent = await sentFor(request);
      expect(sent.imageConfig?.imageSize, request.briefId).toBe(size);
      expect(sent.imageConfig?.aspectRatio).toBe(request.aspectRatio);
      expect(sent.thinkingConfig).toEqual({
        thinkingLevel: ThinkingLevel.HIGH,
      });
      for (const parameter of IMAGE_SAMPLING_PARAMETERS) {
        expect(sent).not.toHaveProperty(parameter);
      }
      expect(sent).not.toHaveProperty("abortSignal");
    }
  });

  it("★★ a caller may state one size for every request: the redesign's 2K at MEDIUM", async () => {
    const sent = await sentFor(
      { ...REQUEST, purpose: "hero", aspectRatio: "21:9", references: [] },
      { imageSize: "2K", thinkingLevel: ThinkingLevel.MEDIUM },
    );
    expect(sent.imageConfig?.imageSize).toBe("2K");
    expect(sent.thinkingConfig).toEqual({
      thinkingLevel: ThinkingLevel.MEDIUM,
    });
  });

  it("★★ the owner's Pro rollback is sent the same sizes and no thinking config", async () => {
    const hero = await sentFor(
      {
        ...REQUEST,
        purpose: "hero",
        aspectRatio: "21:9",
        references: [],
        briefId: "hero-21:9",
      },
      {},
      PRO_CONFIG,
    );
    expect(hero.imageConfig?.imageSize).toBe("4K");
    expect(hero).not.toHaveProperty("thinkingConfig");
    const product = await sentFor(REQUEST, {}, PRO_CONFIG);
    expect(product.imageConfig?.imageSize).toBe("2K");
    expect(product).not.toHaveProperty("thinkingConfig");
  });

  it("★ a request with no size, or none of 2.1's thinking, is refused before anything is sent", async () => {
    const send = vi.fn();
    const noSize = createVertexImageClient(CONFIG, {
      ...OPTIONS,
      imageSize: undefined as never,
      send,
    });
    await expect(noSize.generateImage(REQUEST, signal())).rejects.toThrow(
      /must state its size/,
    );
    const noThinking = createVertexImageClient(CONFIG, {
      ...OPTIONS,
      thinkingLevel: undefined as never,
      send,
    });
    await expect(noThinking.generateImage(REQUEST, signal())).rejects.toThrow(
      /thinking level/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("★ the usage it returns names the model that answered and counts its thinking", async () => {
    const client = createVertexImageClient(
      { ...CONFIG, projectId: "usage-named" },
      {
        ...OPTIONS,
        send: async () =>
          response({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    { inlineData: { mimeType: "image/jpeg", data: IMAGE } },
                  ],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 1213,
              candidatesTokenCount: 1680,
              thoughtsTokenCount: 1356,
            },
          }),
      },
    );
    const result = await client.generateImage(REQUEST, signal());
    expect(result.usage).toEqual({
      inputTokens: 1213,
      outputTokens: 1680,
      thinkingTokens: 1356,
      model: "gemini-nano-banana-2.1",
    });
    // Priced at 2.1's rates, thinking included: about $0.0624, as the
    // 25 Oct smoke test's 4:5 pack shot was.
    expect(estimateImageCostMicroUsd(result.usage)).toBe(62_390);
  });

  it("refuses to send a request the provider must never see", async () => {
    const send = vi.fn();
    const client = createVertexImageClient(CONFIG, { ...OPTIONS, send });
    await expect(
      client.generateImage({ ...REQUEST, purpose: "anchor" }, signal()),
    ).rejects.toThrow(/no references/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the request guard", () => {
  it("refuses unknown purposes and ratios, empty prompts and too many references", () => {
    const bad: Partial<ThemeImageRequest>[] = [
      { purpose: "preview" as never },
      { aspectRatio: "16:10" as never },
      { prompt: "  " },
      {
        references: Array.from({ length: 4 }, () => REQUEST.references[0]),
      },
    ];
    for (const change of bad) {
      expect(() =>
        assertThemeImageRequest({ ...REQUEST, ...change }),
      ).toThrow();
    }
  });
});

describe("the fake image client", () => {
  it("returns the same PNG for the same request, at the requested ratio", async () => {
    const client = createFakeImageClient();
    const a = await client.generateImage(REQUEST, signal());
    const b = await client.generateImage(REQUEST, signal());
    const c = await client.generateImage(
      { ...REQUEST, briefId: "other" },
      signal(),
    );
    expect(a.kind).toBe("ok");
    if (a.kind !== "ok" || b.kind !== "ok" || c.kind !== "ok") return;
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(Buffer.from(a.bytes).equals(Buffer.from(c.bytes))).toBe(false);
    const sharp = (await import("sharp")).default;
    const meta = await sharp(Buffer.from(a.bytes)).metadata();
    expect(meta.format).toBe("png");
    expect(meta.height).toBe(FAKE_IMAGE_LONG_EDGE);
    expect(meta.width).toBe(Math.round((FAKE_IMAGE_LONG_EDGE * 4) / 5));
  });

  it("can be told to refuse or fail", async () => {
    const client = createFakeImageClient();
    expect(
      await client.generateImage(
        { ...REQUEST, prompt: "x [[fake-image:refuse]]" },
        signal(),
      ),
    ).toMatchObject({ kind: "refused" });
    expect(
      await client.generateImage(
        { ...REQUEST, prompt: "x [[fake-image:error]]" },
        signal(),
      ),
    ).toMatchObject({ kind: "error", code: "provider_unavailable" });
  });
});

describe("image cost", () => {
  it("a usage that names no model is a Pro image's, as every one before 25 Oct 2026 was: about 13.5 cents at 2K", () => {
    expect(
      estimateImageCostMicroUsd({ inputTokens: 0, outputTokens: 1120 }),
    ).toBe(134_400);
    expect(
      estimateImageCostMicroUsd({ inputTokens: 1_000, outputTokens: 1_120 }),
    ).toBe(136_400);
    expect(
      estimateImageCostMicroUsd({ inputTokens: -5, outputTokens: 0 }),
    ).toBe(0);
  });

  it("★★ a 2K Nano Banana 2.1 picture is about 5 cents, and its thinking is counted", () => {
    expect(
      estimateImageCostMicroUsd({
        inputTokens: 0,
        outputTokens: 1_680,
        model: "gemini-nano-banana-2.1",
      }),
    ).toBe(50_400);
    expect(
      estimateImageCostMicroUsd({
        inputTokens: 1_000,
        outputTokens: 1_680,
        thinkingTokens: 1_000,
        model: "gemini-nano-banana-2.1",
      }),
    ).toBe(1_500 + 50_400 + 7_500);
  });
});

it("enforces the image attempt deadline even when the SDK ignores abort", async () => {
  const deadline = new AbortController();
  const timer = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  try {
    const send = vi.fn(() => new Promise<never>(() => {}));
    const client = createVertexImageClient(CONFIG, { ...OPTIONS, send });
    const pending = client.generateImage(REQUEST, signal());
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    deadline.abort(new Error("deadline"));
    await expect(pending).resolves.toMatchObject({
      kind: "error",
      code: "provider_timeout",
    });
    expect(send).toHaveBeenCalledOnce();
  } finally {
    timer.mockRestore();
  }
});

it("allows adults only for a request whose brief asked for them, with prominent people still blocked", async () => {
  const { themeImageConfig } = await import("./image-vertex");
  const base = {
    purpose: "hero" as const,
    briefId: "hero",
    aspectRatio: "16:9" as const,
    prompt: "A scene",
    references: [],
  };
  expect(themeImageConfig(base, SETTINGS).imageConfig?.personGeneration).toBe(
    "ALLOW_NONE",
  );
  const adults = themeImageConfig(
    { ...base, people: "adults" },
    SETTINGS,
  ).imageConfig;
  expect(adults?.personGeneration).toBe("ALLOW_ADULT");
  expect(String(adults?.prominentPeople)).toMatch(/BLOCK_PROMINENT_PEOPLE/);
});

// ---------------------------------------------------------------------------
// What an answer carried and what Google said, in the log (robustness audit
// P0-3 and B23).
// ---------------------------------------------------------------------------

/** A JPEG's first bytes (SOI, a JFIF APP0, a baseline SOF0), which is all
 *  imageDimensions reads, as an answer part carries them. */
function jpegHeader(width: number, height: number): string {
  return Buffer.from([
    ...[0xff, 0xd8],
    ...[0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00],
    ...[0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00],
    ...[0xff, 0xc0, 0x00, 0x11, 0x08],
    ...[height >> 8, height & 0xff, width >> 8, width & 0xff],
    ...[0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01],
  ]).toString("base64");
}

const DRAFT_1K = jpegHeader(1584, 672);
const FINAL_2K = jpegHeader(3168, 1344);

/** gemini-3-pro-image's answer to a 21:9 2K request as measured on
 *  storemink-staging (2026-10-23): thought text, a 1K thought image, thought
 *  text, then the final picture. */
function measuredAnswer(finalData = FINAL_2K): GenerateContentResponse {
  return response({
    candidates: [
      {
        finishReason: "STOP",
        content: {
          parts: [
            { text: "Planning the shot", thought: true },
            {
              thought: true,
              inlineData: { mimeType: "image/jpeg", data: DRAFT_1K },
            },
            { text: "Checking it", thought: true },
            {
              thoughtSignature: "sig",
              inlineData: { mimeType: "image/jpeg", data: finalData },
            },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 1120 },
  });
}

/** An answer with one final picture and nothing else. */
function singleAnswer(data: string): GenerateContentResponse {
  return response({
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ inlineData: { mimeType: "image/jpeg", data } }] },
      },
    ],
  });
}

const HERO: ThemeImageRequest = {
  purpose: "hero",
  briefId: "hero-1",
  aspectRatio: "21:9",
  prompt: "PROMPT-MARKER: almond shakes on a sunlit counter.",
  references: [],
};

/** The contexts one log line was written with, in order. */
function logged(log: typeof logInfo | typeof logWarn, message: string) {
  return vi
    .mocked(log)
    .mock.calls.filter(([m]) => m === message)
    .map(([, context]) => context);
}

describe("what an answer carried, in the log (P0-3)", () => {
  it("★★ a thought draft and the final 2K picture: one line with 2 parts, 1 draft and the final's size, and no warning", async () => {
    const client = createVertexImageClient(
      { ...CONFIG, projectId: "answer-2k" },
      { ...OPTIONS_2K, send: async () => measuredAnswer() },
    );
    expect((await client.generateImage(HERO, signal())).kind).toBe("ok");
    expect(logged(logInfo, "theme_studio.image_answer")).toEqual([
      {
        purpose: "hero",
        brief: "hero-1",
        model: "gemini-nano-banana-2.1",
        aspectRatio: "21:9",
        requestedSize: "2K",
        thinkingLevel: "HIGH",
        outcome: "ok",
        finishReason: "STOP",
        imageParts: 2,
        thoughtImages: 1,
        width: 3168,
        height: 1344,
      },
    ]);
    expect(logged(logWarn, "theme_studio.image_below_requested_size")).toEqual(
      [],
    );
    // Content-free: neither the prompt nor any picture reaches a log line.
    const lines = JSON.stringify([
      ...vi.mocked(logInfo).mock.calls,
      ...vi.mocked(logWarn).mock.calls,
    ]);
    for (const secret of ["PROMPT-MARKER", FINAL_2K, DRAFT_1K]) {
      expect(lines).not.toContain(secret);
    }
  });

  it("★★ a homepage hero slide asks for 4K and its 6336x2688 picture is not under that size; a 2K picture for it would warn", async () => {
    const hero4k = createVertexImageClient(
      { ...CONFIG, projectId: "answer-4k" },
      {
        ...OPTIONS,
        send: async () => measuredAnswer(jpegHeader(6336, 2688)),
      },
    );
    expect((await hero4k.generateImage(HERO, signal())).kind).toBe("ok");
    expect(logged(logInfo, "theme_studio.image_answer").at(-1)).toMatchObject({
      requestedSize: "4K",
      thinkingLevel: "HIGH",
      width: 6336,
      height: 2688,
    });
    expect(logged(logWarn, "theme_studio.image_below_requested_size")).toEqual(
      [],
    );
    const hero2k = createVertexImageClient(
      { ...CONFIG, projectId: "answer-4k-came-2k" },
      { ...OPTIONS, send: async () => measuredAnswer() },
    );
    await hero2k.generateImage(HERO, signal());
    expect(logged(logWarn, "theme_studio.image_below_requested_size")).toEqual([
      expect.objectContaining({
        requestedSize: "4K",
        longEdge: 3168,
        minimumLongEdge: 3482,
      }),
    ]);
  });

  it("★★ a picture that came back at 1K warns that it is under the size asked for", async () => {
    const client = createVertexImageClient(
      { ...CONFIG, projectId: "answer-1k" },
      { ...OPTIONS_2K, send: async () => singleAnswer(DRAFT_1K) },
    );
    expect((await client.generateImage(HERO, signal())).kind).toBe("ok");
    expect(logged(logWarn, "theme_studio.image_below_requested_size")).toEqual([
      expect.objectContaining({
        purpose: "hero",
        brief: "hero-1",
        aspectRatio: "21:9",
        requestedSize: "2K",
        imageParts: 1,
        thoughtImages: 0,
        width: 1584,
        height: 672,
        longEdge: 1584,
        minimumLongEdge: 1741,
      }),
    ]);
  });

  it("logs once per answer: a refusal before it is not an answer", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(status(429))
      .mockResolvedValueOnce(measuredAnswer());
    const client = createVertexImageClient(
      { ...CONFIG, projectId: "answer-once" },
      { ...OPTIONS_2K, send, sleep: async () => true, random: () => 0 },
    );
    await client.generateImage(HERO, signal());
    expect(logged(logInfo, "theme_studio.image_answer")).toHaveLength(1);
  });

  it("a draft-only answer and a header it cannot read log their parts and no size, and never warn", async () => {
    const draftOnly = response({
      candidates: [
        {
          finishReason: "IMAGE_SAFETY",
          content: {
            parts: [
              {
                thought: true,
                inlineData: { mimeType: "image/jpeg", data: DRAFT_1K },
              },
            ],
          },
        },
      ],
    });
    for (const [answer, projectId] of [
      [draftOnly, "answer-draft-only"],
      [okResponse, "answer-unreadable"],
    ] as const) {
      const client = createVertexImageClient(
        { ...CONFIG, projectId },
        { ...OPTIONS_2K, send: async () => answer },
      );
      await client.generateImage(HERO, signal());
    }
    expect(logged(logInfo, "theme_studio.image_answer")).toEqual([
      expect.objectContaining({
        outcome: "refused",
        finishReason: "IMAGE_SAFETY",
        imageParts: 1,
        thoughtImages: 1,
        width: null,
        height: null,
      }),
      expect.objectContaining({
        outcome: "ok",
        imageParts: 1,
        thoughtImages: 0,
        width: null,
        height: null,
      }),
    ]);
    expect(logged(logWarn, "theme_studio.image_below_requested_size")).toEqual(
      [],
    );
  });

  it("a log line that fails never costs the paid image", async () => {
    vi.mocked(logInfo).mockImplementationOnce(() => {
      throw new Error("log sink down");
    });
    const client = createVertexImageClient(
      { ...CONFIG, projectId: "answer-log-fails" },
      { ...OPTIONS_2K, send: async () => measuredAnswer() },
    );
    expect(await client.generateImage(HERO, signal())).toMatchObject({
      kind: "ok",
    });
  });

  it("counts every inline image part and the thought drafts among them", () => {
    expect(themeImageAnswerParts(measuredAnswer())).toEqual({
      imageParts: 2,
      thoughtImages: 1,
    });
    expect(themeImageAnswerParts(okResponse)).toEqual({
      imageParts: 1,
      thoughtImages: 0,
    });
    expect(themeImageAnswerParts(response({}))).toEqual({
      imageParts: 0,
      thoughtImages: 0,
    });
  });
});

describe("the size rule", () => {
  // Gemini 3 Pro Image's frames at 1K and 2K (Google's resolution table; the
  // 21:9, 4:3 and 4:5 entries also measured on storemink-staging).
  const FRAMES: Record<string, Record<"1K" | "2K", [number, number]>> = {
    "1:1": { "1K": [1024, 1024], "2K": [2048, 2048] },
    "2:3": { "1K": [848, 1264], "2K": [1696, 2528] },
    "3:2": { "1K": [1264, 848], "2K": [2528, 1696] },
    "3:4": { "1K": [896, 1200], "2K": [1792, 2400] },
    "4:3": { "1K": [1200, 896], "2K": [2400, 1792] },
    "4:5": { "1K": [928, 1152], "2K": [1856, 2304] },
    "5:4": { "1K": [1152, 928], "2K": [2304, 1856] },
    "9:16": { "1K": [768, 1376], "2K": [1536, 2752] },
    "16:9": { "1K": [1376, 768], "2K": [2752, 1536] },
    "21:9": { "1K": [1584, 672], "2K": [3168, 1344] },
  };

  it("★★ never warns for a real 2K picture of any frame and always for a 1K one, one size up too", () => {
    const minimum = minimumLongEdgePx("2K");
    expect(minimum).toBe(1741);
    for (const [ratio, sizes] of Object.entries(FRAMES)) {
      expect(Math.max(...sizes["2K"]), ratio).toBeGreaterThanOrEqual(minimum!);
      expect(Math.max(...sizes["1K"]), ratio).toBeLessThan(minimum!);
    }
    // The widest 2K frame is under a 4K request's floor.
    expect(Math.max(...FRAMES["21:9"]["2K"])).toBeLessThan(
      minimumLongEdgePx("4K")!,
    );
    expect(minimumLongEdgePx("1K")).toBe(870);
    expect(minimumLongEdgePx(undefined)).toBeNull();
    expect(minimumLongEdgePx("8K")).toBeNull();
  });

  it("through the client, every frame: a 2K answer logs no warning and a 1K answer warns", async () => {
    for (const [ratio, sizes] of Object.entries(FRAMES)) {
      for (const size of ["2K", "1K"] as const) {
        vi.mocked(logWarn).mockClear();
        const [width, height] = sizes[size];
        const client = createVertexImageClient(
          { ...CONFIG, projectId: `frames-${ratio}-${size}` },
          {
            ...OPTIONS_2K,
            send: async () => singleAnswer(jpegHeader(width, height)),
          },
        );
        await client.generateImage(
          {
            ...HERO,
            aspectRatio: ratio as ThemeImageRequest["aspectRatio"],
          },
          signal(),
        );
        expect(
          logged(logWarn, "theme_studio.image_below_requested_size"),
          `${ratio} at ${size}`,
        ).toHaveLength(size === "1K" ? 1 : 0);
      }
    }
  });
});

describe("imageDimensions", () => {
  it("reads JPEG (baseline and progressive), PNG and WebP (lossy, lossless, extended) headers without decoding", async () => {
    const sharp = (await import("sharp")).default;
    const solid = (channels: 3 | 4) =>
      sharp({
        create: {
          width: 37,
          height: 23,
          channels,
          background: { r: 120, g: 90, b: 60, alpha: 0.5 },
        },
      });
    const webp = [
      await solid(3).webp({ quality: 80 }).toBuffer(),
      await solid(3).webp({ lossless: true }).toBuffer(),
      await solid(4).webp({ quality: 80 }).toBuffer(),
    ];
    // All three WebP layouts are exercised.
    expect(webp.map((bytes) => bytes.toString("ascii", 12, 16))).toEqual([
      "VP8 ",
      "VP8L",
      "VP8X",
    ]);
    for (const bytes of [
      await solid(3).jpeg().toBuffer(),
      await solid(3).jpeg({ progressive: true }).toBuffer(),
      await solid(3).png().toBuffer(),
      ...webp,
    ]) {
      expect(imageDimensions(new Uint8Array(bytes))).toEqual({
        width: 37,
        height: 23,
      });
    }
    expect(
      imageDimensions(new Uint8Array(Buffer.from(FINAL_2K, "base64"))),
    ).toEqual({ width: 3168, height: 1344 });
  });

  it("is null for bytes that are none of those, or a header cut short", () => {
    expect(
      imageDimensions(new Uint8Array(Buffer.from("fake-jpeg"))),
    ).toBeNull();
    expect(imageDimensions(new Uint8Array())).toBeNull();
    const cut = Buffer.from(FINAL_2K, "base64").subarray(0, 24);
    expect(imageDimensions(new Uint8Array(cut))).toBeNull();
  });

  /** A JPEG with tables written BEFORE its frame header, as many encoders
   *  write them. libjpeg (and so sharp) puts DHT after SOF0, so the test
   *  above never meets one. */
  function jpegWithTables(
    width: number,
    height: number,
    tables: number[][],
    frameMarker = 0xc0,
  ): Uint8Array {
    return new Uint8Array([
      ...[0xff, 0xd8],
      ...[0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array<number>(64).fill(1)],
      ...tables.flat(),
      ...[0xff, frameMarker, 0x00, 0x11, 0x08],
      ...[height >> 8, height & 0xff, width >> 8, width & 0xff],
      ...[0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01],
    ]);
  }
  /** The standard DC luminance table (T.81 K.3). Read as a frame header, its
   *  code counts give 1281 x 1. */
  const DHT_DC = [
    ...[0xff, 0xc4, 0x00, 0x1f, 0x00],
    ...[0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  ];
  /** One arithmetic-coding conditioning entry (T.81 B.2.4.3). */
  const DAC = [0xff, 0xcc, 0x00, 0x04, 0x00, 0x10];

  it("★ skips a Huffman or arithmetic-conditioning table written before the frame header", () => {
    expect(imageDimensions(jpegWithTables(3168, 1344, [DHT_DC]))).toEqual({
      width: 3168,
      height: 1344,
    });
    // An arithmetic-coded frame (SOF9) is where a DAC segment appears.
    expect(imageDimensions(jpegWithTables(1584, 672, [DAC], 0xc9))).toEqual({
      width: 1584,
      height: 672,
    });
  });
});

describe("what Google said, in the image log (B23)", () => {
  const SHARED_POOL_MESSAGE = "Resource has been exhausted (e.g. check quota).";
  /** The shared pay-as-you-go pool's 429, exactly as measured on
   *  storemink-staging (23 Oct 2026): it names no quota. */
  const SHARED_POOL_BODY =
    '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}';
  const METRIC =
    "aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model";
  const refused = (body: unknown) =>
    new ApiError({ message: JSON.stringify(body), status: 429 });
  const exhausted = (details?: unknown[], message = SHARED_POOL_MESSAGE) =>
    refused({
      error: {
        code: 429,
        message,
        status: "RESOURCE_EXHAUSTED",
        ...(details ? { details } : {}),
      },
    });

  it("★★ a 429 with the shared pool's real body logs Google's status and words on the retry, naming no quota", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError({ message: SHARED_POOL_BODY, status: 429 }),
      )
      .mockResolvedValueOnce(okResponse);
    const client = createVertexImageClient(
      { ...CONFIG, projectId: "facts-shared-pool" },
      { ...OPTIONS, send, sleep: async () => true, random: () => 0 },
    );
    expect((await client.generateImage(REQUEST, signal())).kind).toBe("ok");
    expect(logged(logWarn, "theme_studio.image_rate_limited_retry")).toEqual([
      {
        purpose: "product",
        brief: "product-mug",
        retry: 1,
        waitMs: 7_500,
        httpStatus: 429,
        errorStatus: "RESOURCE_EXHAUSTED",
        errorMessage: SHARED_POOL_MESSAGE,
        quotaNamed: null,
      },
    ]);
  });

  it("★ an ErrorInfo body names its quota on the line a refused call ends with", async () => {
    const send = vi.fn().mockRejectedValue(
      exhausted([
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "RATE_LIMIT_EXCEEDED",
          metadata: {
            quota_metric: METRIC,
            quota_limit:
              "GenerateContentRequestsPerMinutePerProjectPerBaseModel",
            quota_limit_value: "2",
          },
        },
      ]),
    );
    const client = createVertexImageClient(
      { ...CONFIG, projectId: "facts-error-info" },
      { ...OPTIONS, send, sleep: async () => true, random: () => 1 },
    );
    expect(await client.generateImage(REQUEST, signal())).toMatchObject({
      kind: "error",
      code: "rate_limited",
    });
    expect(logged(logWarn, "theme_studio.image_provider_error")).toEqual([
      {
        purpose: "product",
        brief: "product-mug",
        model: "gemini-nano-banana-2.1",
        code: "rate_limited",
        tries: 6,
        httpStatus: 429,
        errorStatus: "RESOURCE_EXHAUSTED",
        errorMessage: SHARED_POOL_MESSAGE,
        quotaNamed: `${METRIC}, limit GenerateContentRequestsPerMinutePerProjectPerBaseModel, value 2`,
      },
    ]);
  });

  it("★ a QuotaFailure body and a message naming its quota each log it on their retry", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        exhausted([
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              {
                subject: "project:123456",
                quotaId: "GenerateContentRequestsPerMinute",
                quotaValue: "2",
              },
            ],
          },
        ]),
      )
      .mockRejectedValueOnce(
        exhausted(
          undefined,
          `Quota exceeded for ${METRIC} with base model: gemini-3-pro-image. Please submit a quota increase request.`,
        ),
      )
      .mockResolvedValueOnce(okResponse);
    const client = createVertexImageClient(
      { ...CONFIG, projectId: "facts-quota-failure" },
      { ...OPTIONS, send, sleep: async () => true, random: () => 0 },
    );
    expect((await client.generateImage(REQUEST, signal())).kind).toBe("ok");
    expect(
      logged(logWarn, "theme_studio.image_rate_limited_retry").map(
        (context) => context?.quotaNamed,
      ),
    ).toEqual(["GenerateContentRequestsPerMinute, value 2", METRIC]);
  });

  it("a provider error and a timeout each end the call with one line; a cancelled call writes none", async () => {
    const overloaded = new ApiError({
      message:
        '{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}',
      status: 503,
    });
    await createVertexImageClient(
      { ...CONFIG, projectId: "facts-503" },
      { ...OPTIONS, send: vi.fn().mockRejectedValue(overloaded) },
    ).generateImage(REQUEST, signal());
    const clock = new AbortController();
    const timer = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(clock.signal);
    try {
      const send = vi.fn(() => new Promise<never>(() => {}));
      const pending = createVertexImageClient(
        { ...CONFIG, projectId: "facts-timeout" },
        { ...OPTIONS, send },
      ).generateImage(REQUEST, signal());
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      clock.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
      await pending;
    } finally {
      timer.mockRestore();
    }
    const cancel = new AbortController();
    await createVertexImageClient(
      { ...CONFIG, projectId: "facts-cancelled" },
      {
        ...OPTIONS,
        send: async () => {
          cancel.abort();
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        },
      },
    ).generateImage(REQUEST, cancel.signal);
    expect(logged(logWarn, "theme_studio.image_provider_error")).toEqual([
      expect.objectContaining({
        code: "provider_unavailable",
        tries: 1,
        httpStatus: 503,
        errorStatus: "UNAVAILABLE",
        errorMessage: "The model is overloaded.",
        quotaNamed: null,
      }),
      expect.objectContaining({
        code: "provider_timeout",
        tries: 1,
        httpStatus: null,
        errorStatus: null,
        errorMessage: "The operation was aborted due to timeout",
      }),
    ]);
  });

  it("an error that escapes the call is logged, never swallowed silently", async () => {
    const client = createVertexImageClient(
      { ...CONFIG, projectId: "facts-escaped" },
      {
        ...OPTIONS,
        send: vi.fn().mockRejectedValueOnce(status(429)),
        sleep: () => Promise.reject(new Error("timer broke")),
        random: () => 0,
      },
    );
    expect(await client.generateImage(REQUEST, signal())).toMatchObject({
      kind: "error",
      code: "provider_unavailable",
    });
    expect(logged(logWarn, "theme_studio.image_provider_error")).toEqual([
      expect.objectContaining({
        code: "provider_unavailable",
        errorMessage: "timer broke",
      }),
    ]);
  });

  it("★ an error that escapes a call the run cancelled is the run's own: cancelled, and no line", async () => {
    const run = new AbortController();
    const client = createVertexImageClient(
      { ...CONFIG, projectId: "facts-escaped-cancelled" },
      {
        ...OPTIONS,
        send: vi.fn().mockRejectedValueOnce(status(429)),
        // The run is stopped while the call waits out its 429, and the wait
        // then fails instead of answering.
        sleep: () =>
          new Promise<boolean>((_, reject) =>
            setTimeout(() => {
              run.abort();
              reject(new Error("timer broke"));
            }, 0),
          ),
        random: () => 0,
      },
    );
    expect(await client.generateImage(REQUEST, run.signal)).toMatchObject({
      kind: "error",
      code: "cancelled",
    });
    // The call reached the wait (so the error escaped it), and wrote nothing.
    expect(
      logged(logWarn, "theme_studio.image_rate_limited_retry"),
    ).toHaveLength(1);
    expect(logged(logWarn, "theme_studio.image_provider_error")).toEqual([]);
  });
});
