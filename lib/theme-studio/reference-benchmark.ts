// The screenshot-led benchmark's pure parts: the case list
// (evals/theme-studio/reference-benchmark.json) and how reference screenshots
// pair with a finished theme's QA screenshots for the fidelity judge.

import cases from "@/evals/theme-studio/reference-benchmark.json";
import type { ThemeIndustry } from "@/lib/themes/meta";

export interface ReferenceBenchmarkCase {
  id: string;
  industry: ThemeIndustry;
  shopifyTheme: string;
  url: string;
  brief: string;
}

export const REFERENCE_BENCHMARK_CASES =
  cases.cases as readonly ReferenceBenchmarkCase[];

/** One captured reference screenshot, as the capture script names it. */
export interface ReferenceShot {
  file: string;
  /** desktop-home-1, desktop-collection, desktop-product, phone-home-1 … */
  page: string;
}

/** One QA screenshot of the finished theme: its asset and evidence sample. */
export interface ThemeShot {
  assetId: string;
  viewport: string;
  surface: string;
}

export interface FidelityPair {
  page: string;
  reference: ReferenceShot[];
  theme: ThemeShot[];
}

const PAGES: {
  page: string;
  reference: RegExp;
  viewport: string;
  surface: string;
}[] = [
  {
    page: "Home page, desktop",
    reference: /^desktop-home-\d+$/,
    viewport: "desktop1440",
    surface: "home",
  },
  {
    page: "Collection / shop page, desktop",
    reference: /^desktop-collection$/,
    viewport: "desktop1440",
    surface: "shop",
  },
  {
    page: "Product page, desktop",
    reference: /^desktop-product$/,
    viewport: "desktop1440",
    surface: "product",
  },
  {
    page: "Home page, phone",
    reference: /^phone-home-\d+$/,
    viewport: "phone390",
    surface: "home",
  },
];

/**
 * Like with like: reference home screens against the theme's home page at the
 * same width, collection against shop, product against product. A page with
 * no screenshot on either side is left out rather than judged against nothing.
 * Only the first theme shot per page is used — QA can capture a surface more
 * than once (several content pages), and one is what the reference shows.
 */
export function fidelityPairs(
  reference: readonly ReferenceShot[],
  theme: readonly ThemeShot[],
): FidelityPair[] {
  return PAGES.flatMap((spec) => {
    const refs = reference.filter((shot) => spec.reference.test(shot.page));
    const shot = theme.find(
      (t) => t.viewport === spec.viewport && t.surface === spec.surface,
    );
    return refs.length && shot
      ? [{ page: spec.page, reference: refs, theme: [shot] }]
      : [];
  });
}

/** QA samples are positional: sample i describes screenshotAssetIds[i]. */
export function themeShotsFromQa(qa: {
  screenshotAssetIds: readonly string[];
  browserReport: unknown;
}): ThemeShot[] {
  const evidence = (qa.browserReport as { evidence?: { samples?: unknown } })
    ?.evidence;
  const samples = Array.isArray(evidence?.samples) ? evidence.samples : [];
  return qa.screenshotAssetIds.flatMap((assetId, index) => {
    const sample = samples[index] as
      | { viewport?: unknown; surface?: unknown }
      | undefined;
    return typeof sample?.viewport === "string" &&
      typeof sample?.surface === "string"
      ? [{ assetId, viewport: sample.viewport, surface: sample.surface }]
      : [];
  });
}

/** Mean of each dimension across scored themes, to one decimal. */
export function meanFidelity(
  scores: readonly Record<string, number>[],
): Record<string, number> | null {
  if (!scores.length) return null;
  const keys = Object.keys(scores[0]);
  return Object.fromEntries(
    keys.map((key) => [
      key,
      Math.round(
        (scores.reduce((sum, s) => sum + (s[key] ?? 0), 0) / scores.length) *
          10,
      ) / 10,
    ]),
  );
}
