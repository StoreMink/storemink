import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();
const constructed: Record<string, unknown>[] = [];

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
    constructor(options: Record<string, unknown>) {
      constructed.push(options);
    }
  },
  HarmBlockThreshold: {
    BLOCK_LOW_AND_ABOVE: "BLOCK_LOW_AND_ABOVE",
  },
  HarmCategory: {
    HARM_CATEGORY_HARASSMENT: "HARM_CATEGORY_HARASSMENT",
    HARM_CATEGORY_HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    HARM_CATEGORY_DANGEROUS_CONTENT: "HARM_CATEGORY_DANGEROUS_CONTENT",
  },
  Modality: { TEXT: "TEXT", IMAGE: "IMAGE" },
  ProminentPeople: { BLOCK_PROMINENT_PEOPLE: "BLOCK_PROMINENT_PEOPLE" },
  ThinkingLevel: {
    MINIMAL: "MINIMAL",
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
  },
}));
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
const spend = vi.hoisted(() => ({
  claim: vi.fn(async () => ({
    ok: true,
    claimedAt: "2026-10-23 18:00:00.000001+00",
  })),
  release: vi.fn(async () => undefined),
}));
vi.mock("./spend-limits", () => ({
  MINK_IMAGE_GLOBAL_LIMIT: {
    key: "mink-image-global",
    max: 200,
    windowSeconds: 3_600,
  },
  claimSpendLimits: spend.claim,
  releaseSpendLimits: spend.release,
}));
vi.mock("./image-prompt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./image-prompt")>();
  return {
    ...actual,
    renderMinkImagePrompt: vi.fn(actual.renderMinkImagePrompt),
  };
});

const {
  generateMinkMediaImage,
  isUnbilledImageFailure,
  MinkImageNotSentError,
  MINK_CHAT_IMAGE_RETRY,
  MIN_IMAGE_ATTEMPT_MS,
  requestMinkImage,
  reserveMinkImageGeneration,
} = await import("./media-generation");
const { ThinkingLevel } = await import("@google/genai");
const { IMAGE_SAMPLING_PARAMETERS } =
  await import("@/lib/theme-studio/image-models");
const { renderMinkImagePrompt } = await import("./image-prompt");
const { MinkImageRateLimitedError, MinkRequestError, MinkToolInputError } =
  await import("./errors");

const config = {
  projectId: "project-1" as string | null,
  imageModel: "gemini-nano-banana-2.1",
  imageLocation: "global",
};

/** What every Mink call site states (owner, 25 Oct 2026): 2K, MINIMAL. */
const DRAW = {
  imageSize: "2K" as const,
  thinkingLevel: ThinkingLevel.MINIMAL,
};

const request = {
  schemaVersion: 3 as const,
  purpose: "hero" as const,
  prompt: "A warm overhead still life of loose grains on linen.",
  referenceImageUrls: [],
  alt: "Grains and pulses on linen",
};

const PRODUCT_REFERENCE = {
  url: "https://storage.googleapis.com/bucket/products/milk.webp",
  fileUri: "gs://bucket/products/milk.webp",
  mimeType: "image/webp" as const,
  source: "product" as const,
};

const PIXEL = Buffer.from("hello").toString("base64");

beforeEach(() => {
  generateContent.mockReset();
});

function imageResponse(
  mimeType = "image/jpeg",
  data: string | undefined = PIXEL,
) {
  return {
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ inlineData: { data, mimeType } }] },
      },
    ],
  };
}

describe("asking Gemini for one storefront image", () => {
  it("★★ FIXES EVERY SAFETY LEVER IN CODE, NOT IN THE REQUEST", () => {
    // These are properties of the FEATURE, not of one call. If they could be
    // passed in, a merchant reviewing one image would not be reviewing the
    // same guarantees as on every other — and `personGeneration` in particular
    // has a tempting middle setting (ALLOW_ADULT) that is precisely the one
    // that invents a face nobody released.
    generateContent.mockResolvedValue(imageResponse());
    return generateMinkMediaImage(config as never, request, [], DRAW).then(
      () => {
        const call = generateContent.mock.calls[0][0];
        const sent = call.config;
        expect(sent.responseModalities).toEqual(["TEXT", "IMAGE"]);
        expect(sent.candidateCount).toBe(1);
        expect(sent.imageConfig.personGeneration).toBe("ALLOW_NONE");
        expect(sent.imageConfig.prominentPeople).toBe("BLOCK_PROMINENT_PEOPLE");
        expect(sent.safetySettings).toHaveLength(4);
        expect(
          sent.safetySettings.every(
            (setting: { threshold: string }) =>
              setting.threshold === "BLOCK_LOW_AND_ABOVE",
          ),
        ).toBe(true);
        const instruction = call.contents[0].parts[0].text;
        expect(instruction).toContain(request.prompt);
        for (const exclusion of ["headlines", "watermarks", "people"]) {
          expect(instruction).toContain(exclusion);
        }
        // ★ The aspect comes from the purpose. A model choosing 9:16 for a hero
        //   produces an image the renderer crops through its subject.
        expect(sent.imageConfig.aspectRatio).toBe("21:9");
        expect(sent.imageConfig.imageSize).toBe("2K");
        expect(sent.imageConfig.outputCompressionQuality).toBe(95);
        expect(instruction).toContain("ultra-wide campaign scene");
        expect(instruction).toContain("not a product cutout pasted");
        expect(instruction).toContain("commercial quality");
      },
    );
  });

  it("sends verified product images as model-visible references", async () => {
    generateContent.mockResolvedValue(imageResponse());
    await generateMinkMediaImage(
      config as never,
      { ...request, referenceImageUrls: [PRODUCT_REFERENCE.url] },
      [PRODUCT_REFERENCE],
      DRAW,
    );

    const parts = generateContent.mock.calls[0][0].contents[0].parts;
    expect(parts[0].text).toContain("authentic current-store product image");
    expect(parts).toContainEqual({
      fileData: {
        fileUri: PRODUCT_REFERENCE.fileUri,
        mimeType: PRODUCT_REFERENCE.mimeType,
      },
    });
  });

  it("gives a blog cover its editorial crop and no-text direction", async () => {
    generateContent.mockResolvedValue(imageResponse());
    await generateMinkMediaImage(
      config as never,
      {
        ...request,
        purpose: "blog_cover",
        prompt: "An editorial still life about keeping pantry staples fresh.",
      },
      [],
      DRAW,
    );

    const call = generateContent.mock.calls[0][0];
    expect(call.config.imageConfig.aspectRatio).toBe("16:9");
    expect(call.contents[0].parts[0].text).toContain(
      "expresses the article's central idea",
    );
    expect(call.contents[0].parts[0].text).toContain(
      "do not put the article title",
    );
  });

  it("★★ ASKS FOR THE ITEM ITSELF, NOT A CAMPAIGN SCENE, FOR A PRODUCT PHOTO", async () => {
    generateContent.mockResolvedValue(imageResponse());
    await generateMinkMediaImage(
      config as never,
      {
        ...request,
        purpose: "product",
        prompt: "The 1 litre milk carton on a plain white studio background.",
        referenceImageUrls: [PRODUCT_REFERENCE.url],
        productPhotoShape: "square",
      },
      [PRODUCT_REFERENCE],
      DRAW,
    );

    const call = generateContent.mock.calls[0][0];
    // The store's card is square, so the photo is square; the default is 3:4.
    expect(call.config.imageConfig.aspectRatio).toBe("1:1");
    const text = call.contents[0].parts[0].text as string;
    expect(text).toContain("one product photograph");
    expect(text).toContain("not a campaign scene");
    expect(text).toContain("real photograph of the product");
    expect(text).toContain("Do not restyle it");
    // The photo editor's rules, shared so chat and editor cannot drift.
    expect(text).toContain("KEEP THE PRODUCT EXACTLY THE SAME");
    expect(text).toContain("Include a person only if the request asks");
    // Adults may appear in a product photo (a model wearing it); famous
    // people never.
    expect(call.config.imageConfig.personGeneration).toBe("ALLOW_ADULT");
    expect(call.config.imageConfig.prominentPeople).toBeDefined();
  });

  it("★ NEVER PEOPLE IN CAMPAIGN ART", async () => {
    generateContent.mockResolvedValue(imageResponse());
    await generateMinkMediaImage(
      config as never,
      {
        ...request,
        purpose: "hero",
      },
      [],
      DRAW,
    );
    expect(
      generateContent.mock.calls[0][0].config.imageConfig.personGeneration,
    ).toBe("ALLOW_NONE");
  });

  it("★ TELLS AN EARLIER AI PHOTO FROM THE REAL ONE IN A FOLLOW-UP", async () => {
    generateContent.mockResolvedValue(imageResponse());
    const earlier = {
      ...PRODUCT_REFERENCE,
      url: "https://storage.googleapis.com/bucket/stores/s/mink-generated/product-photos/p.jpg",
      fileUri: "gs://bucket/stores/s/mink-generated/product-photos/p.jpg",
      source: "media" as const,
    };
    await generateMinkMediaImage(
      config as never,
      {
        ...request,
        purpose: "product",
        prompt: "The coat in a close-up on a model standing in a forest.",
        referenceImageUrls: [PRODUCT_REFERENCE.url, earlier.url],
        productPhotoShape: "portrait",
      },
      [PRODUCT_REFERENCE, earlier],
      DRAW,
    );
    const text = generateContent.mock.calls[0][0].contents[0].parts[0]
      .text as string;
    expect(text).toMatch(/Reference 1 is a real photograph of the product/);
    expect(text).toMatch(
      /Reference 2 is an earlier AI photo of this same product/,
    );
    expect(text).toMatch(/never from this picture/);
  });

  it("gives a portrait-card store a 3:4 catalogue photo", async () => {
    generateContent.mockResolvedValue(imageResponse());
    await generateMinkMediaImage(
      config as never,
      {
        ...request,
        purpose: "product",
        prompt: "The 1 litre milk carton on a plain white studio background.",
        referenceImageUrls: [PRODUCT_REFERENCE.url],
        productPhotoShape: "portrait",
      },
      [PRODUCT_REFERENCE],
      DRAW,
    );
    expect(
      generateContent.mock.calls[0][0].config.imageConfig.aspectRatio,
    ).toBe("3:4");
  });

  it("decodes the image the provider returned", async () => {
    generateContent.mockResolvedValue(imageResponse("image/png"));
    const image = await generateMinkMediaImage(
      config as never,
      request,
      [],
      DRAW,
    );
    expect(image.bytes.toString()).toBe("hello");
    expect(image.mimeType).toBe("image/png");
  });

  it("★★ sends 2.1 the caller's size and thinking level, and never a sampling parameter (owner, 25 Oct 2026)", async () => {
    generateContent.mockResolvedValue(imageResponse());
    await generateMinkMediaImage(config as never, request, [], DRAW);
    const call = generateContent.mock.calls[0][0];
    expect(call.model).toBe("gemini-nano-banana-2.1");
    expect(call.config.imageConfig.imageSize).toBe("2K");
    expect(call.config.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
    for (const parameter of IMAGE_SAMPLING_PARAMETERS) {
      expect(call.config).not.toHaveProperty(parameter);
    }
    // A caller's own size and level are what is sent.
    await generateMinkMediaImage(config as never, request, [], {
      imageSize: "4K",
      thinkingLevel: ThinkingLevel.HIGH,
    });
    expect(generateContent.mock.calls[1][0].config).toMatchObject({
      imageConfig: { imageSize: "4K" },
      thinkingConfig: { thinkingLevel: "HIGH" },
    });
    // A legacy 512 or 0.5K, which 2.1 refuses, is asked for as 1K.
    for (const legacy of ["512", "0.5K"] as const) {
      generateContent.mockClear();
      await generateMinkMediaImage(config as never, request, [], {
        ...DRAW,
        imageSize: legacy,
      });
      expect(
        generateContent.mock.calls[0][0].config.imageConfig.imageSize,
      ).toBe("1K");
    }
  });

  it("★★ a MINK_IMAGE_MODEL rollback is sent what it always was: the size, and no thinking config", async () => {
    generateContent.mockResolvedValue(imageResponse());
    await generateMinkMediaImage(
      { ...config, imageModel: "gemini-3.1-flash-image" } as never,
      request,
      [],
      DRAW,
    );
    const call = generateContent.mock.calls[0][0];
    expect(call.model).toBe("gemini-3.1-flash-image");
    expect(call.config.imageConfig.imageSize).toBe("2K");
    expect(call.config).not.toHaveProperty("thinkingConfig");
  });

  it("★★ every request is fitted to its model, a sampling parameter included: removed for 2.1, kept for another", async () => {
    generateContent.mockResolvedValue(imageResponse());
    const stated = {
      contents: [{ role: "user", parts: [{ text: "A cup." }] }],
      config: {
        temperature: 1,
        topK: 40,
        seed: 7,
        imageConfig: { aspectRatio: "1:1", imageSize: "2K" },
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    };
    await requestMinkImage(
      {
        projectId: "p",
        imageModel: "gemini-nano-banana-2.1",
        imageLocation: "global",
      },
      stated,
    );
    const toNanoBanana = generateContent.mock.calls[0][0].config;
    expect(toNanoBanana).not.toHaveProperty("temperature");
    expect(toNanoBanana).not.toHaveProperty("topK");
    expect(toNanoBanana).not.toHaveProperty("seed");
    expect(toNanoBanana.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
    await requestMinkImage(
      {
        projectId: "p",
        imageModel: "gemini-3-pro-image",
        imageLocation: "global",
      },
      stated,
    );
    const toPro = generateContent.mock.calls[1][0].config;
    expect(toPro).toMatchObject({ temperature: 1, topK: 40, seed: 7 });
    expect(toPro).not.toHaveProperty("thinkingConfig");
    // The caller's own config is never changed.
    expect(stated.config.temperature).toBe(1);
  });

  it("★ a request that states no size is refused before anything is sent, so nothing is billed", async () => {
    generateContent.mockResolvedValue(imageResponse());
    const error = await generateMinkMediaImage(config as never, request, [], {
      ...DRAW,
      imageSize: undefined as never,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MinkImageNotSentError);
    expect(isUnbilledImageFailure(error)).toBe(true);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("★★ a Nano Banana 2.1 answer: the final picture, never the draft before it, with or without thought text; and one with no draft", async () => {
    // Every 2.1 answer on storemink-staging (25 Oct 2026) carried a draft
    // first; at HIGH thinking also two thought TEXT parts.
    const part = (text: string) => Buffer.from(text).toString("base64");
    generateContent.mockResolvedValue({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { text: "Composing", thought: true },
              {
                thought: true,
                inlineData: { data: part("draft"), mimeType: "image/jpeg" },
              },
              { text: "Checking the product", thought: true },
              {
                thoughtSignature: "sig",
                inlineData: { data: part("final"), mimeType: "image/jpeg" },
              },
              { text: "Here is the scene." },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 1210,
        candidatesTokenCount: 1680,
        thoughtsTokenCount: 1300,
      },
    });
    const drafted = await generateMinkMediaImage(
      config as never,
      request,
      [],
      DRAW,
    );
    expect(drafted.bytes.toString()).toBe("final");
    generateContent.mockResolvedValue(imageResponse());
    const plain = await generateMinkMediaImage(
      config as never,
      request,
      [],
      DRAW,
    );
    expect(plain.bytes.toString()).toBe("hello");
  });

  it("★★ KEEPS THE FINAL PICTURE, NEVER A THOUGHT DRAFT SENT AHEAD OF IT", async () => {
    // gemini-3-pro-image's answer shape since about 22 Oct 2026 (measured on
    // storemink-staging): a 1K thought image first, the size asked for last.
    const part = (text: string) => Buffer.from(text).toString("base64");
    generateContent.mockResolvedValue({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { text: "Planning", thought: true },
              {
                thought: true,
                inlineData: { data: part("draft"), mimeType: "image/jpeg" },
              },
              {
                thoughtSignature: "sig",
                inlineData: { data: part("final"), mimeType: "image/jpeg" },
              },
            ],
          },
        },
      ],
    });
    const image = await generateMinkMediaImage(
      config as never,
      request,
      [],
      DRAW,
    );
    expect(image.bytes.toString()).toBe("final");

    // A draft alone is not a picture to hand back.
    generateContent.mockResolvedValue({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              {
                thought: true,
                inlineData: { data: part("draft"), mimeType: "image/jpeg" },
              },
            ],
          },
        },
      ],
    });
    await expect(
      generateMinkMediaImage(config as never, request, [], DRAW),
    ).rejects.toThrow(/returned no image/);
  });

  it("★★ HANDS BACK THE PROVIDER'S OWN REFUSAL REASON", async () => {
    // A filtered image is a refusal WITH a reason, and the reason is the only
    // thing that lets a merchant rephrase rather than guess. Reporting it as a
    // generic failure spends their credit and tells them nothing.
    generateContent.mockResolvedValue({
      promptFeedback: {
        blockReasonMessage: "The prompt requested prominent people",
      },
    });
    await expect(
      generateMinkMediaImage(config as never, request, [], DRAW),
    ).rejects.toThrow(/requested prominent people/);
    await expect(
      generateMinkMediaImage(config as never, request, [], DRAW),
    ).rejects.toBeInstanceOf(MinkToolInputError);
  });

  it("★ SAYS SOMETHING DIFFERENT WHEN THERE IS NO REASON AT ALL", async () => {
    // An empty response with no reason is a different fact from a refusal, and
    // inventing a reason would send the merchant rewriting a prompt that was
    // never the problem.
    generateContent.mockResolvedValue({ candidates: [] });
    await expect(
      generateMinkMediaImage(config as never, request, [], DRAW),
    ).rejects.toThrow(/returned no image/);
  });

  it("★★ A PROVIDER FAILURE IS NEVER REPORTED AS A MERCHANT MISTAKE", async () => {
    // The commonest cause is the image model not being enabled on the project, which is
    // an operator problem. Surfacing it as a refused prompt has merchants
    // rewriting descriptions against an outage.
    generateContent.mockRejectedValue(new Error("404 model not found"));
    const error = await generateMinkMediaImage(
      config as never,
      request,
      [],
      DRAW,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(MinkRequestError);
    expect(error.status).toBe(503);
    // ⚠ The provider's own words name models, regions and quotas. They belong
    //   in the log, never in a merchant-facing message.
    expect(error.message).not.toContain("404");
  });

  it("refuses before calling the provider when no project is configured", async () => {
    const error = await generateMinkMediaImage(
      { ...config, projectId: null } as never,
      request,
      [],
      DRAW,
    ).catch((e) => e);
    expect(error.message).toMatch(/GCP_PROJECT_ID/);
    expect(generateContent).not.toHaveBeenCalled();
    // ★ Nothing was sent, so a reserved allowance may be given back.
    expect(error).toBeInstanceOf(MinkImageNotSentError);
    expect(isUnbilledImageFailure(error)).toBe(true);
  });

  it("★★ ASKS THE SDK FOR EXACTLY ONE ATTEMPT, AT THE IMAGE REGION", async () => {
    // A retry is a second charge for the same request, and the caller has
    // already been billed a credit for this proposal.
    // ⚠ The image location remains independently configurable even though its
    // current default is the same global endpoint as chat.
    generateContent.mockResolvedValue(imageResponse(undefined));
    const image = await generateMinkMediaImage(
      config as never,
      request,
      [],
      DRAW,
    );
    expect(image.mimeType).toBe("image/jpeg");
    expect(clientsFor("project-1", "global")[0]).toMatchObject({
      enterprise: true,
      apiVersion: "v1",
      httpOptions: { retryOptions: { attempts: 1 } },
    });
  });

  it("★★ USES THE SHARED CLIENT, NOT A NEW ONE PER CALL (B25)", async () => {
    // One Google client per project and location for the life of the
    // process (vertex-clients.ts), as chat, the writer and the namer use.
    generateContent.mockResolvedValue(imageResponse());
    await generateMinkMediaImage(config as never, request, [], DRAW);
    await generateMinkMediaImage(config as never, request, [], DRAW);
    await generateMinkMediaImage(config as never, request, [], DRAW);
    expect(clientsFor("project-1", "global")).toHaveLength(1);
    // Another image location is another client, built once too.
    await generateMinkMediaImage(
      { ...config, imageLocation: "asia-south1" } as never,
      request,
      [],
      DRAW,
    );
    await generateMinkMediaImage(
      { ...config, imageLocation: "asia-south1" } as never,
      request,
      [],
      DRAW,
    );
    expect(clientsFor("project-1", "asia-south1")).toHaveLength(1);
  });
});

/** The clients built for one project and location since the file began. */
function clientsFor(project: string, location: string) {
  return constructed.filter(
    (options) => options.project === project && options.location === location,
  );
}

describe("drawing for a storefront slot", () => {
  it.each(["4:5", "1:1", "4:3"] as const)(
    "★★ a %s slot gets its own frame and is told to be a photograph with no words",
    async (slotAspectRatio) => {
      // The first 4:5 guidance described the slot as "beside a block of
      // text", and the image model drew one: a panel of invented words beside
      // the photo (staging, 2026-10-20). The storefront sets its own words.
      generateContent.mockResolvedValue(imageResponse());
      await generateMinkMediaImage(
        config as never,
        {
          ...request,
          slotAspectRatio,
        },
        [],
        DRAW,
      );
      const call = generateContent.mock.calls[0][0];
      const instruction: string = call.contents[0].parts[0].text;
      expect(call.config.imageConfig.aspectRatio).toBe(slotAspectRatio);
      expect(instruction).toContain(
        "It is a single photograph and nothing else",
      );
      expect(instruction).not.toMatch(/block of text/i);
    },
  );

  it("keeps the purpose's own frame when no slot is named", async () => {
    generateContent.mockResolvedValue(imageResponse());
    await generateMinkMediaImage(config as never, request, [], DRAW);
    const call = generateContent.mock.calls[0][0];
    expect(call.config.imageConfig.aspectRatio).toBe("21:9");
    expect(call.contents[0].parts[0].text).not.toContain(
      "It is a single photograph and nothing else",
    );
  });
});

describe("a rate-limited image request", () => {
  const rateLimited = Object.assign(new Error("RESOURCE_EXHAUSTED"), {
    status: 429,
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("★★ is asked again only when the caller allows it", async () => {
    // A 429 is refused before the model runs, so asking again is never a
    // second bill. The personalisation run allows it; a chat image does not.
    generateContent
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce(imageResponse());
    const pending = generateMinkMediaImage(config as never, request, [], {
      ...DRAW,
      rateLimitRetries: 1,
    });
    await vi.advanceTimersByTimeAsync(7_000);
    const image = await pending;
    expect(image.bytes.toString()).toBe("hello");
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("fails at once without a retry allowance", async () => {
    generateContent.mockRejectedValue(rateLimited);
    await expect(
      generateMinkMediaImage(config as never, request, [], DRAW),
    ).rejects.toBeInstanceOf(MinkRequestError);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("★ never retries a failure that may have been billed", async () => {
    // A timeout or a 5xx may have produced an image nobody received.
    generateContent.mockRejectedValue(
      Object.assign(new Error("Internal"), { status: 500 }),
    );
    await expect(
      generateMinkMediaImage(config as never, request, [], {
        ...DRAW,
        rateLimitRetries: 3,
      }),
    ).rejects.toBeInstanceOf(MinkRequestError);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("★★ says when the service was still refusing with 429, and only then", async () => {
    // A caller that can wait longer than this call (the revamp's product
    // photos) asks again later; it must be able to tell this from a failure
    // that may have been billed. The code and words stay the same for
    // everyone else.
    generateContent.mockRejectedValue(rateLimited);
    const pending = generateMinkMediaImage(config as never, request, [], {
      ...DRAW,
      rateLimitRetries: 1,
    });
    const settled = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const limited = await settled;
    expect(limited).toBeInstanceOf(MinkImageRateLimitedError);
    expect(limited).toMatchObject({
      code: "image_provider_unavailable",
      status: 503,
    });

    generateContent.mockReset();
    generateContent.mockRejectedValue(
      Object.assign(new Error("Internal"), { status: 500 }),
    );
    const billed = await generateMinkMediaImage(config as never, request, [], {
      ...DRAW,
      rateLimitRetries: 1,
    }).catch((error) => error);
    expect(billed).toBeInstanceOf(MinkRequestError);
    expect(billed).not.toBeInstanceOf(MinkImageRateLimitedError);
  });

  it("caps the retries at three, whatever the caller asks for", async () => {
    generateContent.mockRejectedValue(rateLimited);
    const pending = generateMinkMediaImage(config as never, request, [], {
      ...DRAW,
      rateLimitRetries: 10,
    });
    const settled = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await settled).toBeInstanceOf(MinkRequestError);
    expect(generateContent).toHaveBeenCalledTimes(4);
  });

  /**
   * One provider attempt that answers after `ms` (an image, or a 429), and
   * stops at once when its abort signal fires, as the SDK does.
   */
  function answersAfter(ms: number, outcome: "image" | "busy") {
    return (params: { config: { abortSignal: AbortSignal } }) =>
      new Promise((resolve, reject) => {
        const signal = params.config.abortSignal;
        const timer = setTimeout(
          () =>
            outcome === "image"
              ? resolve(imageResponse())
              : reject(rateLimited),
          ms,
        );
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("This operation was aborted"));
          },
          { once: true },
        );
      });
  }

  it("★★ gives every attempt its own clock when asked, so a 429's wait never cuts the next attempt short", async () => {
    // Live, 2026-10-22: the revamp's studio photo of p1 was refused with 429,
    // then cut off at the whole call's 45 s ("This operation was aborted"),
    // because the refusals and the waits had used up the clock the attempt
    // that got through needed.
    generateContent
      .mockImplementationOnce(answersAfter(40_000, "busy"))
      .mockImplementationOnce(answersAfter(70_000, "image"));
    const pending = generateMinkMediaImage(config as never, request, [], {
      ...DRAW,
      rateLimitRetries: 1,
      attemptTimeoutMs: 75_000,
    });
    const settled = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(40_000 + 6_000 + 70_000);
    const image = await settled;
    expect(image).not.toBeInstanceOf(Error);
    expect((image as { bytes: Buffer }).bytes.toString()).toBe("hello");
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("★ stops an attempt that outlasts its own clock, as a failure that may have been billed", async () => {
    generateContent.mockImplementationOnce(answersAfter(120_000, "image"));
    const pending = generateMinkMediaImage(config as never, request, [], {
      ...DRAW,
      attemptTimeoutMs: 75_000,
    });
    const settled = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(74_000);
    expect(generateContent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    const failure = await settled;
    expect(failure).toBeInstanceOf(MinkRequestError);
    expect(failure).not.toBeInstanceOf(MinkImageRateLimitedError);
    expect(failure).toMatchObject({ code: "image_provider_unavailable" });
  });

  it("bounds the per-attempt clock and still listens to the caller's stop", async () => {
    // A clock of 1 ms is read as the 5 s floor.
    generateContent.mockImplementationOnce(answersAfter(4_000, "image"));
    const quick = generateMinkMediaImage(config as never, request, [], {
      ...DRAW,
      attemptTimeoutMs: 1,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await quick).bytes.toString()).toBe("hello");

    const controller = new AbortController();
    generateContent.mockImplementationOnce(answersAfter(60_000, "image"));
    const stopped = generateMinkMediaImage(config as never, request, [], {
      ...DRAW,
      abortSignal: controller.signal,
      attemptTimeoutMs: 75_000,
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error("lease lost"));
    expect(await stopped).toBeInstanceOf(MinkRequestError);
  });
});

describe("★★ a chat image's own retry rule (B10)", () => {
  const rateLimited = Object.assign(new Error("RESOURCE_EXHAUSTED"), {
    status: 429,
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A try that answers after `ms`, or stops at once when its signal fires. */
  function answersAfter(ms: number, outcome: "image" | "busy") {
    return (params: { config: { abortSignal: AbortSignal } }) =>
      new Promise((resolve, reject) => {
        const signal = params.config.abortSignal;
        const timer = setTimeout(
          () =>
            outcome === "image"
              ? resolve(imageResponse())
              : reject(rateLimited),
          ms,
        );
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("This operation was aborted"));
          },
          { once: true },
        );
      });
  }

  it("★★ asks again after two refusals, 5 to 15 s apart, and draws once", async () => {
    // Every refusal came back in under a second (measured): asking again is
    // free, so the third try is the one that draws.
    vi.spyOn(Math, "random").mockReturnValue(0);
    generateContent
      .mockRejectedValueOnce(rateLimited)
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce(imageResponse());
    const pending = generateMinkMediaImage(config as never, request, [], {
      ...DRAW,
      ...MINK_CHAT_IMAGE_RETRY,
    });
    await vi.advanceTimersByTimeAsync(4_900);
    // Not asked again before the 5 s floor of the wait.
    expect(generateContent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(generateContent).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_100);
    const image = await pending;
    expect(image.bytes.toString()).toBe("hello");
    expect(generateContent).toHaveBeenCalledTimes(3);
  });

  it("★ waits at most 15 s between tries", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    generateContent
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce(imageResponse());
    const pending = generateMinkMediaImage(config as never, request, [], {
      ...DRAW,
      ...MINK_CHAT_IMAGE_RETRY,
    });
    await vi.advanceTimersByTimeAsync(14_900);
    expect(generateContent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(generateContent).toHaveBeenCalledTimes(2);
    await pending;
  });

  it("★★ three refusals end as a refusal Google never billed, and are not asked a fourth time", async () => {
    generateContent.mockRejectedValue(rateLimited);
    const settled = generateMinkMediaImage(config as never, request, [], {
      ...DRAW,
      ...MINK_CHAT_IMAGE_RETRY,
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await settled;
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(MinkImageRateLimitedError);
    expect(isUnbilledImageFailure(error)).toBe(true);
  });

  it("★★ gives every try its own 45 s clock", async () => {
    // A refusal at 44 s, then a try that takes 44 s: under one clock for the
    // whole call the second would have been cut off at 1 s.
    vi.spyOn(Math, "random").mockReturnValue(0);
    generateContent
      .mockImplementationOnce(answersAfter(44_000, "busy"))
      .mockImplementationOnce(answersAfter(44_000, "image"));
    const settled = generateMinkMediaImage(config as never, request, [], {
      ...DRAW,
      ...MINK_CHAT_IMAGE_RETRY,
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(44_000 + 5_000 + 44_000);
    const image = await settled;
    expect(image).not.toBeInstanceOf(Error);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("★ a try that outlasts its clock is not asked again: it may have been billed", async () => {
    generateContent.mockImplementation(answersAfter(120_000, "image"));
    const settled = generateMinkMediaImage(config as never, request, [], {
      ...DRAW,
      ...MINK_CHAT_IMAGE_RETRY,
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(45_100);
    const error = await settled;
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(MinkRequestError);
    expect(isUnbilledImageFailure(error)).toBe(false);
  });

  it("★ asks at the same location every time, never another region", async () => {
    generateContent
      .mockRejectedValueOnce(rateLimited)
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce(imageResponse());
    const before = constructed.length;
    const pending = generateMinkMediaImage(config as never, request, [], {
      ...DRAW,
      ...MINK_CHAT_IMAGE_RETRY,
    });
    await vi.advanceTimersByTimeAsync(40_000);
    await pending;
    // No client for any other location was built for the retries.
    expect(
      constructed
        .slice(before)
        .filter((options) => options.location !== "global"),
    ).toEqual([]);
    expect(
      generateContent.mock.calls.every(
        ([params]) => params.model === "gemini-nano-banana-2.1",
      ),
    ).toBe(true);
  });

  describe("★★ the chain stops at the caller's deadline (B6)", () => {
    it("cuts a try's clock to the time left", async () => {
      generateContent.mockImplementationOnce(answersAfter(60_000, "image"));
      const settled = generateMinkMediaImage(config as never, request, [], {
        ...DRAW,
        ...MINK_CHAT_IMAGE_RETRY,
        deadlineAt: Date.now() + 30_000,
      }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(generateContent).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_100);
      const error = await settled;
      // Stopped at the deadline (30 s), not at its own 45 s.
      expect(error).toBeInstanceOf(MinkRequestError);
      expect(isUnbilledImageFailure(error)).toBe(false);
    });

    it("does not start a retry, nor wait for one, without room for it to finish", async () => {
      vi.spyOn(Math, "random").mockReturnValue(1);
      generateContent.mockRejectedValue(rateLimited);
      // A 15 s wait would leave less than the least a try is started with.
      const settled = generateMinkMediaImage(config as never, request, [], {
        ...DRAW,
        ...MINK_CHAT_IMAGE_RETRY,
        deadlineAt: Date.now() + MIN_IMAGE_ATTEMPT_MS + 10_000,
      }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      const error = await settled;
      expect(generateContent).toHaveBeenCalledTimes(1);
      // Every try that was sent answered 429: nothing billed.
      expect(error).toBeInstanceOf(MinkImageRateLimitedError);
      expect(isUnbilledImageFailure(error)).toBe(true);
    });

    it("sends nothing when even the first try has no room", async () => {
      const error = await generateMinkMediaImage(config as never, request, [], {
        ...DRAW,
        ...MINK_CHAT_IMAGE_RETRY,
        deadlineAt: Date.now() + MIN_IMAGE_ATTEMPT_MS - 1,
      }).catch((e) => e);
      expect(generateContent).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(MinkImageNotSentError);
      expect(isUnbilledImageFailure(error)).toBe(true);
    });
  });

  describe("★★ the caller's stop", () => {
    it("aborts the request in flight, which may have been billed", async () => {
      const controller = new AbortController();
      let seen: AbortSignal | undefined;
      generateContent.mockImplementationOnce(
        (params: { config: { abortSignal: AbortSignal } }) => {
          seen = params.config.abortSignal;
          return answersAfter(40_000, "image")(params);
        },
      );
      const settled = generateMinkMediaImage(config as never, request, [], {
        ...DRAW,
        ...MINK_CHAT_IMAGE_RETRY,
        abortSignal: controller.signal,
      }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      controller.abort(new Error("tool timeout"));
      const error = await settled;
      expect(seen?.aborted).toBe(true);
      expect(error).toBeInstanceOf(MinkRequestError);
      expect(isUnbilledImageFailure(error)).toBe(false);
    });

    it("during the wait ends the chain at once, as a refusal nothing billed", async () => {
      vi.spyOn(Math, "random").mockReturnValue(1);
      const controller = new AbortController();
      generateContent.mockRejectedValue(rateLimited);
      const settled = generateMinkMediaImage(config as never, request, [], {
        ...DRAW,
        ...MINK_CHAT_IMAGE_RETRY,
        abortSignal: controller.signal,
      }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(2_000);
      controller.abort(new Error("tool timeout"));
      await vi.advanceTimersByTimeAsync(0);
      const error = await settled;
      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(MinkImageRateLimitedError);
      expect(isUnbilledImageFailure(error)).toBe(true);
    });

    it("before anything was sent sends nothing", async () => {
      const controller = new AbortController();
      controller.abort(new Error("tool timeout"));
      const error = await generateMinkMediaImage(config as never, request, [], {
        ...DRAW,
        ...MINK_CHAT_IMAGE_RETRY,
        abortSignal: controller.signal,
      }).catch((e) => e);
      expect(generateContent).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(MinkImageNotSentError);
    });

    it("★ the instant after the try was handed over sends nothing", async () => {
      // The request starts a microtask after it is handed over; a stop in
      // that gap means this try never left, so nothing was billed.
      const controller = new AbortController();
      const settled = generateMinkMediaImage(config as never, request, [], {
        ...DRAW,
        ...MINK_CHAT_IMAGE_RETRY,
        abortSignal: controller.signal,
      }).catch((error) => error);
      controller.abort(new Error("tool timeout"));
      const error = await settled;
      expect(generateContent).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(MinkImageNotSentError);
      expect(isUnbilledImageFailure(error)).toBe(true);
    });

    it("★ ends at once even when the SDK does not listen to the stop", async () => {
      const controller = new AbortController();
      generateContent.mockImplementationOnce(() => new Promise(() => {}));
      const settled = generateMinkMediaImage(config as never, request, [], {
        ...DRAW,
        ...MINK_CHAT_IMAGE_RETRY,
        abortSignal: controller.signal,
      }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(generateContent).toHaveBeenCalledTimes(1);
      controller.abort(new Error("tool timeout"));
      const error = await settled;
      // Sent: it may have been billed, so it is not a refusal.
      expect(error).toBeInstanceOf(MinkRequestError);
      expect(isUnbilledImageFailure(error)).toBe(false);
    });
  });
});

describe("★★ the store's image allowance (B3)", () => {
  const actor = { storeId: "store-1", adminId: "admin-1" } as never;

  it("claims the minute, the store's hour and day, the platform's hour and the run, in that order", async () => {
    await reserveMinkImageGeneration(actor, "run-1");
    const limits = (
      spend.claim.mock.calls[0] as unknown as [Array<{ key: string }>]
    )[0];
    expect(limits.map((limit) => limit.key)).toEqual([
      "mink-image-owner:store-1:admin-1",
      "mink-image-store:store-1",
      "mink-image-day:store-1",
      "mink-image-global",
      "mink-image-run:store-1:run-1",
    ]);
  });

  it("★★ gives back the store's hour and day and the platform's hour, to the window that counted them, once", async () => {
    const allowance = await reserveMinkImageGeneration(actor, "run-1");
    await allowance.giveBack();
    await allowance.giveBack();
    expect(spend.release).toHaveBeenCalledTimes(1);
    const [limits, options] = spend.release.mock.calls[0] as unknown as [
      Array<{ key: string }>,
      { claimedAt?: string },
    ];
    // ★ The per-minute and per-run caps stay spent: they stop a loop.
    expect(limits.map((limit) => limit.key)).toEqual([
      "mink-image-store:store-1",
      "mink-image-day:store-1",
      "mink-image-global",
    ]);
    expect(options).toEqual({ claimedAt: "2026-10-23 18:00:00.000001+00" });
  });

  it("refuses when a limit is reached, giving nothing to give back", async () => {
    spend.claim.mockResolvedValueOnce({
      ok: false,
      refusedKey: "mink-image-day:store-1",
    } as never);
    await expect(
      reserveMinkImageGeneration(actor, "run-1"),
    ).rejects.toMatchObject({ code: "image_rate_limit", status: 429 });
  });
});

describe("a prompt that cannot be rendered", () => {
  it("★ sends nothing, so a reserved allowance may be given back", async () => {
    vi.mocked(renderMinkImagePrompt).mockImplementationOnce(() => {
      throw new Error("image prompt document is invalid");
    });
    const error = await generateMinkMediaImage(
      config as never,
      request,
      [],
      DRAW,
    ).catch((e) => e);
    expect(generateContent).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(MinkImageNotSentError);
    expect(error.message).not.toContain("invalid");
  });
});
