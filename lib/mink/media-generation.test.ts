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
}));
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

const { generateMinkMediaImage } = await import("./media-generation");
const { MinkRequestError, MinkToolInputError } = await import("./errors");

const config = {
  projectId: "project-1" as string | null,
  imageModel: "gemini-3.1-flash-image",
  imageLocation: "global",
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
    return generateMinkMediaImage(config as never, request).then(() => {
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
    });
  });

  it("sends verified product images as model-visible references", async () => {
    generateContent.mockResolvedValue(imageResponse());
    await generateMinkMediaImage(
      config as never,
      { ...request, referenceImageUrls: [PRODUCT_REFERENCE.url] },
      [PRODUCT_REFERENCE],
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
    await generateMinkMediaImage(config as never, {
      ...request,
      purpose: "blog_cover",
      prompt: "An editorial still life about keeping pantry staples fresh.",
    });

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
    await generateMinkMediaImage(config as never, {
      ...request,
      purpose: "hero",
    });
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
    );
    expect(
      generateContent.mock.calls[0][0].config.imageConfig.aspectRatio,
    ).toBe("3:4");
  });

  it("decodes the image the provider returned", async () => {
    generateContent.mockResolvedValue(imageResponse("image/png"));
    const image = await generateMinkMediaImage(config as never, request);
    expect(image.bytes.toString()).toBe("hello");
    expect(image.mimeType).toBe("image/png");
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
      generateMinkMediaImage(config as never, request),
    ).rejects.toThrow(/requested prominent people/);
    await expect(
      generateMinkMediaImage(config as never, request),
    ).rejects.toBeInstanceOf(MinkToolInputError);
  });

  it("★ SAYS SOMETHING DIFFERENT WHEN THERE IS NO REASON AT ALL", async () => {
    // An empty response with no reason is a different fact from a refusal, and
    // inventing a reason would send the merchant rewriting a prompt that was
    // never the problem.
    generateContent.mockResolvedValue({ candidates: [] });
    await expect(
      generateMinkMediaImage(config as never, request),
    ).rejects.toThrow(/returned no image/);
  });

  it("★★ A PROVIDER FAILURE IS NEVER REPORTED AS A MERCHANT MISTAKE", async () => {
    // The commonest cause is the image model not being enabled on the project, which is
    // an operator problem. Surfacing it as a refused prompt has merchants
    // rewriting descriptions against an outage.
    generateContent.mockRejectedValue(new Error("404 model not found"));
    const error = await generateMinkMediaImage(config as never, request).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(MinkRequestError);
    expect(error.status).toBe(503);
    // ⚠ The provider's own words name models, regions and quotas. They belong
    //   in the log, never in a merchant-facing message.
    expect(error.message).not.toContain("404");
  });

  it("refuses before calling the provider when no project is configured", async () => {
    await expect(
      generateMinkMediaImage({ ...config, projectId: null } as never, request),
    ).rejects.toThrow(/GCP_PROJECT_ID/);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("★★ ASKS THE SDK FOR EXACTLY ONE ATTEMPT, AT THE IMAGE REGION", async () => {
    // A retry is a second charge for the same request, and the caller has
    // already been billed a credit for this proposal.
    // ⚠ The image location remains independently configurable even though its
    // current default is the same global endpoint as chat.
    constructed.length = 0;
    generateContent.mockResolvedValue(imageResponse(undefined));
    const image = await generateMinkMediaImage(config as never, request);
    expect(image.mimeType).toBe("image/jpeg");
    expect(constructed[0]).toMatchObject({
      location: "global",
      httpOptions: { retryOptions: { attempts: 1 } },
    });
  });
});

describe("drawing for a storefront slot", () => {
  it.each(["4:5", "1:1", "4:3"] as const)(
    "★★ a %s slot gets its own frame and is told to be a photograph with no words",
    async (slotAspectRatio) => {
      // The first 4:5 guidance described the slot as "beside a block of
      // text", and the image model drew one: a panel of invented words beside
      // the photo (staging, 2026-10-20). The storefront sets its own words.
      generateContent.mockResolvedValue(imageResponse());
      await generateMinkMediaImage(config as never, {
        ...request,
        slotAspectRatio,
      });
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
    await generateMinkMediaImage(config as never, request);
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
      generateMinkMediaImage(config as never, request),
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
        rateLimitRetries: 3,
      }),
    ).rejects.toBeInstanceOf(MinkRequestError);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("caps the retries at three, whatever the caller asks for", async () => {
    generateContent.mockRejectedValue(rateLimited);
    const pending = generateMinkMediaImage(config as never, request, [], {
      rateLimitRetries: 10,
    });
    const settled = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await settled).toBeInstanceOf(MinkRequestError);
    expect(generateContent).toHaveBeenCalledTimes(4);
  });
});
