import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// ★★ Owner, 25 Oct 2026: one image model for every picture. Theme Studio's
// photo client (worker.ts `imageClientFor`) asks Nano Banana 2.1 for 2K, the
// homepage's hero slides (the slots the run names) for 4K, with HIGH
// thinking; the owner's rollback to Pro is sent the same sizes and no
// thinking config.

const h = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  /** Every request the SDK was asked to send. */
  sent: [] as {
    model: string;
    config: Record<string, unknown> & {
      imageConfig: Record<string, unknown>;
    };
  }[],
  rows: [] as string[],
}));

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  return {
    ...actual,
    GoogleGenAI: class {
      models = {
        generateContent: async (params: (typeof h.sent)[number]) => {
          h.sent.push(params);
          return {
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
                    {
                      inlineData: {
                        mimeType: "image/jpeg",
                        data: Buffer.from("final").toString("base64"),
                      },
                    },
                  ],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 100,
              candidatesTokenCount: 1680,
              thoughtsTokenCount: 1300,
            },
          };
        },
      };
    },
  };
});
vi.mock("./image-vertex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./image-vertex")>();
  return {
    ...actual,
    // The real client, with the options the worker built it with recorded.
    createVertexImageClient: (
      config: Parameters<typeof actual.createVertexImageClient>[0],
      options: Parameters<typeof actual.createVertexImageClient>[1],
    ) => {
      h.options.push(options as unknown as Record<string, unknown>);
      return actual.createVertexImageClient(config, options);
    },
  };
});
vi.mock("./provider-capacity-store", () => ({
  sharedProviderCapacity: vi.fn(
    (project: string, location: string, model: string) => {
      h.rows.push(`${project}/${location}/${model}`);
      return {
        run: (
          operation: (permit: {
            signal: AbortSignal;
            succeeded(): void;
            rateLimited(ms: number): Promise<void>;
          }) => Promise<unknown>,
          signal: AbortSignal,
        ) => operation({ signal, succeeded() {}, async rateLimited() {} }),
      };
    },
  ),
}));

import { ThinkingLevel } from "@google/genai";
import { IMAGE_SAMPLING_PARAMETERS } from "./image-models";
import type { ThemeImageRequest } from "./image-provider";
import { imageClientFor } from "./worker";

const PRODUCT: ThemeImageRequest = {
  purpose: "product",
  briefId: "product-mug",
  aspectRatio: "4:5",
  prompt: "A stoneware mug.",
  references: [],
};
const HERO: ThemeImageRequest = {
  purpose: "hero",
  briefId: "hero-pantry-table",
  aspectRatio: "21:9",
  prompt: "A sunlit pantry table.",
  references: [],
};
/** The homepage opens with HERO (image-models.ts homepageOpeningPhotoIds). */
const HOMEPAGE_SLIDES: ReadonlySet<string> = new Set([HERO.briefId]);
/** A wide banner hero that opens another page. */
const STORY_HERO: ThemeImageRequest = {
  ...HERO,
  briefId: "story-page-hero",
  prompt: "A potter at her wheel.",
};

function reset() {
  h.options.length = 0;
  h.sent.length = 0;
  h.rows.length = 0;
  vi.unstubAllEnvs();
  vi.stubEnv("THEME_STUDIO_GCP_PROJECT_ID", "studio-project");
  vi.stubEnv("THEME_STUDIO_IMAGE_MODEL", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Theme Studio's photo client (worker.ts imageClientFor)", () => {
  it("★★ asks Nano Banana 2.1 for 2K, a homepage hero slide for 4K, with HIGH thinking, on its own photo line", async () => {
    reset();
    const client = imageClientFor("vertex-gemini", HOMEPAGE_SLIDES);
    if (!client) throw new Error("no client");
    expect(h.options).toHaveLength(1);
    expect(h.options[0].thinkingLevel).toBe(ThinkingLevel.HIGH);
    expect(h.rows).toEqual(["studio-project/global/gemini-nano-banana-2.1"]);

    const signal = new AbortController().signal;
    const product = await client.generateImage(PRODUCT, signal);
    const hero = await client.generateImage(HERO, signal);
    // ★ The final picture, never the draft before it.
    for (const result of [product, hero]) {
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(Buffer.from(result.bytes).toString()).toBe("final");
      // ★ The usage names the model and counts its thinking.
      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 1680,
        thinkingTokens: 1300,
        model: "gemini-nano-banana-2.1",
      });
    }
    expect(h.sent.map((request) => request.model)).toEqual([
      "gemini-nano-banana-2.1",
      "gemini-nano-banana-2.1",
    ]);
    expect(
      h.sent.map((request) => request.config.imageConfig.imageSize),
    ).toEqual(["2K", "4K"]);
    for (const request of h.sent) {
      expect(request.config.thinkingConfig).toEqual({
        thinkingLevel: ThinkingLevel.HIGH,
      });
      for (const parameter of IMAGE_SAMPLING_PARAMETERS) {
        expect(request.config).not.toHaveProperty(parameter);
      }
    }
  });

  it("★★ a wide hero the homepage does not open with is 2K, and so is every photo of a run that names no slides", async () => {
    reset();
    const signal = new AbortController().signal;
    const client = imageClientFor("vertex-gemini", HOMEPAGE_SLIDES);
    if (!client) throw new Error("no client");
    await client.generateImage(STORY_HERO, signal);
    await client.generateImage(HERO, signal);
    const none = imageClientFor("vertex-gemini");
    if (!none) throw new Error("no client");
    await none.generateImage(HERO, signal);
    expect(
      h.sent.map((request) => request.config.imageConfig.imageSize),
    ).toEqual(["2K", "4K", "2K"]);
  });

  it("★★ the owner's rollback draws with Pro at the same sizes, with no thinking config, on Pro's line", async () => {
    reset();
    vi.stubEnv("THEME_STUDIO_IMAGE_MODEL", "gemini-3-pro-image");
    const client = imageClientFor("vertex-gemini", HOMEPAGE_SLIDES);
    if (!client) throw new Error("no client");
    expect(h.rows).toEqual(["studio-project/global/gemini-3-pro-image"]);
    const signal = new AbortController().signal;
    await client.generateImage(PRODUCT, signal);
    await client.generateImage(HERO, signal);
    expect(h.sent.map((request) => request.model)).toEqual([
      "gemini-3-pro-image",
      "gemini-3-pro-image",
    ]);
    expect(
      h.sent.map((request) => request.config.imageConfig.imageSize),
    ).toEqual(["2K", "4K"]);
    for (const request of h.sent) {
      expect(request.config).not.toHaveProperty("thinkingConfig");
    }
  });

  it("★ refuses any other model, gives the offline provider its fake, and no project no client", () => {
    reset();
    vi.stubEnv("THEME_STUDIO_IMAGE_MODEL", "gemini-3.1-flash-image");
    expect(() => imageClientFor("vertex-gemini")).toThrow(/model family/);
    reset();
    expect(imageClientFor("fake")?.provider).toBe("fake");
    expect(imageClientFor("other")).toBeNull();
    vi.stubEnv("THEME_STUDIO_GCP_PROJECT_ID", "");
    vi.stubEnv("GCP_PROJECT_ID", "");
    expect(imageClientFor("vertex-gemini")).toBeNull();
    expect(h.options).toEqual([]);
  });
});

describe("★ a photo run names the homepage's opening photos (worker.ts executeImages)", () => {
  it("builds its image client with the slots its package's homepage opens with", () => {
    // executeImages needs a claimed run and a database, and the
    // real-database suites draw with the offline provider, which has no
    // sizes; so this pins the one line that hands the package's opening
    // photos to the client (image-models.ts homepageOpeningPhotoIds).
    const source = readFileSync(
      path.join(__dirname, "worker.ts"),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(source).toContain(
      "imageClientFor( run.provider, homepageOpeningPhotoIds(input.package), )",
    );
    // ...and it is the only call of it in worker.ts.
    expect(source.match(/(?<!function )imageClientFor\(/g)).toHaveLength(1);
  });
});
