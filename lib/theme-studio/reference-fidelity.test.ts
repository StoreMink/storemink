import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  FIDELITY_SYSTEM_PROMPT,
  parseFidelity,
  prepareFidelityImage,
  scoreReferenceFidelity,
} from "./reference-fidelity";
import {
  REFERENCE_BENCHMARK_CASES,
  fidelityPairs,
  meanFidelity,
  themeShotsFromQa,
} from "./reference-benchmark";
import { INDUSTRY_PLAYBOOKS } from "./industry-playbooks";
import {
  ZERO_USAGE,
  type StructuredRequest,
  type StructuredResult,
  type ThemeStudioModelClient,
} from "./provider";

const valid = {
  scores: { layout: 4, palette: 5, typography: 3, imagery: 4, overall: 4 },
  copiedBrand: false,
  matched: ["full-bleed hero", "three-up product row"],
  missed: ["serif headings"],
};

const png = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: "#d4c3a8" },
  })
    .png()
    .toBuffer();

describe("reference benchmark cases", () => {
  it("has eight cases, two per industry, each with a distinct Shopify demo", () => {
    expect(REFERENCE_BENCHMARK_CASES).toHaveLength(8);
    const byIndustry = new Map<string, number>();
    for (const c of REFERENCE_BENCHMARK_CASES) {
      expect(Object.keys(INDUSTRY_PLAYBOOKS)).toContain(c.industry);
      expect(c.url).toMatch(/^https:\/\/[a-z0-9-]+\.myshopify\.com\/$/);
      expect(c.brief).toMatch(/Do not copy the reference's brand name/);
      byIndustry.set(c.industry, (byIndustry.get(c.industry) ?? 0) + 1);
    }
    expect([...byIndustry.values()]).toEqual([2, 2, 2, 2]);
    expect(new Set(REFERENCE_BENCHMARK_CASES.map((c) => c.url)).size).toBe(8);
    expect(new Set(REFERENCE_BENCHMARK_CASES.map((c) => c.id)).size).toBe(8);
  });
});

describe("fidelity pairing", () => {
  const reference = [
    { file: "01.jpg", page: "desktop-home-1" },
    { file: "02.jpg", page: "desktop-home-2" },
    { file: "04.jpg", page: "desktop-collection" },
    { file: "05.jpg", page: "desktop-product" },
    { file: "06.jpg", page: "phone-home-1" },
  ];

  it("compares like with like and skips pages missing on either side", () => {
    const theme = themeShotsFromQa({
      screenshotAssetIds: ["a", "b", "c", "d", "e"],
      browserReport: {
        evidence: {
          samples: [
            { viewport: "desktop1440", surface: "home" },
            { viewport: "desktop1440", surface: "shop" },
            { viewport: "phone390", surface: "home" },
            { viewport: "desktop1440", surface: "content" },
            { viewport: "desktop1440", surface: "home" },
          ],
        },
      },
    });
    const pairs = fidelityPairs(reference, theme);
    expect(pairs.map((p) => p.page)).toEqual([
      "Home page, desktop",
      "Collection / shop page, desktop",
      "Home page, phone",
    ]);
    expect(pairs[0].reference.map((r) => r.page)).toEqual([
      "desktop-home-1",
      "desktop-home-2",
    ]);
    // The first home capture, not a later duplicate.
    expect(pairs[0].theme.map((t) => t.assetId)).toEqual(["a"]);
    expect(pairs[2].theme.map((t) => t.assetId)).toEqual(["c"]);
  });

  it("ignores screenshots without evidence rather than guessing their page", () => {
    expect(
      themeShotsFromQa({
        screenshotAssetIds: ["a", "b"],
        browserReport: { evidence: { samples: [{ viewport: "phone390" }] } },
      }),
    ).toEqual([]);
  });

  it("averages each dimension to one decimal", () => {
    expect(
      meanFidelity([
        { layout: 4, overall: 3 },
        { layout: 5, overall: 4 },
        { layout: 3, overall: 4 },
      ]),
    ).toEqual({ layout: 4, overall: 3.7 });
    expect(meanFidelity([])).toBeNull();
  });
});

describe("fidelity scoring", () => {
  it("accepts only complete 1–5 scores", () => {
    expect(parseFidelity(valid)?.scores.overall).toBe(4);
    expect(
      parseFidelity({ ...valid, scores: { ...valid.scores, layout: 6 } }),
    ).toBeNull();
    expect(
      parseFidelity({ ...valid, scores: { ...valid.scores, imagery: 2.5 } }),
    ).toBeNull();
    const partial: Record<string, number> = { ...valid.scores };
    delete partial.palette;
    expect(parseFidelity({ ...valid, scores: partial })).toBeNull();
    expect(parseFidelity({ ...valid, copiedBrand: "no" })).toBeNull();
  });

  it("crops long captures to the height the references cover", async () => {
    const desktop = await prepareFidelityImage({
      label: "home",
      kind: "desktop",
      bytes: await png(1440, 9000),
    });
    const meta = await sharp(
      Buffer.from((desktop as { base64: string }).base64, "base64"),
    ).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(Math.round(1280 * (2700 / 1440)));
    const phone = await prepareFidelityImage({
      label: "home",
      kind: "phone",
      bytes: await png(780, 6000),
    });
    const phoneMeta = await sharp(
      Buffer.from((phone as { base64: string }).base64, "base64"),
    ).metadata();
    expect(phoneMeta.width).toBe(600);
    expect(phoneMeta.height).toBe(Math.round(600 * ((844 * 2) / 390)));
  });

  const client = (
    answers: StructuredResult[],
    seen: StructuredRequest[] = [],
  ): ThemeStudioModelClient => ({
    provider: "fake",
    async generate(request) {
      seen.push(request);
      return answers.shift()!;
    },
  });
  const pairs = async () => [
    {
      page: "Home page, desktop",
      reference: [
        {
          label: "desktop-home-1",
          kind: "desktop" as const,
          bytes: await png(1440, 900),
        },
      ],
      theme: [
        {
          label: "home desktop1440",
          kind: "desktop" as const,
          bytes: await png(1440, 4000),
        },
      ],
    },
  ];

  it("labels references and theme images in order and retries one invalid answer", async () => {
    const seen: StructuredRequest[] = [];
    const result = await scoreReferenceFidelity(
      client(
        [
          { kind: "ok", value: { scores: {} }, usage: ZERO_USAGE },
          {
            kind: "ok",
            value: valid,
            usage: { ...ZERO_USAGE, inputTokens: 100 },
          },
        ],
        seen,
      ),
      {
        modelKey: "gemini-3.8-flash",
        providerModel: "m",
        pairs: await pairs(),
      },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0].system).toBe(FIDELITY_SYSTEM_PROMPT);
    const texts = seen[0].content.flatMap((b) =>
      b.type === "text" ? [b.text] : [],
    );
    expect(texts).toEqual([
      "Page: Home page, desktop",
      "REFERENCE — desktop-home-1",
      "THEME — home desktop1440",
    ]);
    expect(seen[0].content.filter((b) => b.type === "image")).toHaveLength(2);
  });

  it("reports a provider failure instead of a score", async () => {
    const result = await scoreReferenceFidelity(
      client([{ kind: "error", code: "rate_limited", usage: ZERO_USAGE }]),
      {
        modelKey: "gemini-3.8-flash",
        providerModel: "m",
        pairs: await pairs(),
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, reason: "rate_limited" });
  });

  it("refuses to call the model with nothing to compare", async () => {
    const seen: StructuredRequest[] = [];
    const result = await scoreReferenceFidelity(
      client([], seen),
      {
        modelKey: "gemini-3.8-flash",
        providerModel: "m",
        pairs: [{ page: "x", reference: [], theme: [] }],
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, reason: "no_comparable_pages" });
    expect(seen).toHaveLength(0);
  });
});
