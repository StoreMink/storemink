import { expect, it } from "vitest";
import {
  THEME_STUDIO_PROMPT_VERSION,
  themePromptFeatures,
} from "./prompt-features";

it("preserves old paid request shapes and carries capabilities into future prompt revisions", () => {
  expect(themePromptFeatures("theme-studio-v18")).toEqual({
    targetedRepair: false,
    nativeFraming: false,
    nativeCommerce: false,
    compactInitial: false,
    variety: false,
    stableAssetIds: false,
    heroContrast: false,
    changeScope: false,
    convergence: false,
    fontPairings: false,
    fullBleedOpening: false,
    carouselOpening: false,
    peopleInImagery: false,
    nestedBlocks: false,
  });
  expect(themePromptFeatures("theme-studio-v19")).toEqual({
    targetedRepair: true,
    nativeFraming: true,
    nativeCommerce: false,
    compactInitial: false,
    variety: false,
    stableAssetIds: false,
    heroContrast: false,
    changeScope: false,
    convergence: false,
    fontPairings: false,
    fullBleedOpening: false,
    carouselOpening: false,
    peopleInImagery: false,
    nestedBlocks: false,
  });
  expect(themePromptFeatures(THEME_STUDIO_PROMPT_VERSION)).toEqual({
    targetedRepair: true,
    nativeFraming: true,
    nativeCommerce: true,
    compactInitial: true,
    variety: true,
    stableAssetIds: true,
    heroContrast: true,
    changeScope: true,
    convergence: true,
    fontPairings: true,
    fullBleedOpening: true,
    carouselOpening: true,
    peopleInImagery: true,
    nestedBlocks: true,
  });
  expect(themePromptFeatures("theme-studio-v30")).toEqual(
    themePromptFeatures(THEME_STUDIO_PROMPT_VERSION),
  );
  expect(themePromptFeatures("invalid").compactInitial).toBe(false);
});

it("enables variety only for v21 and later", () => {
  expect(themePromptFeatures("theme-studio-v20").variety).toBe(false);
  expect(themePromptFeatures("theme-studio-v21").variety).toBe(true);
});

it("asks revisions to keep slot ids only from v22, so v21 requests replay unchanged", () => {
  expect(themePromptFeatures("theme-studio-v21").stableAssetIds).toBe(false);
  expect(themePromptFeatures("theme-studio-v22").stableAssetIds).toBe(true);
});

it("adds rendered hero evidence only from v23", () => {
  expect(themePromptFeatures("theme-studio-v22").heroContrast).toBe(false);
  expect(themePromptFeatures("theme-studio-v23").heroContrast).toBe(true);
});

it("scopes operator revisions only from v24, so v23 revisions replay unchanged", () => {
  expect(themePromptFeatures("theme-studio-v23").changeScope).toBe(false);
  expect(themePromptFeatures("theme-studio-v24").changeScope).toBe(true);
  expect(themePromptFeatures("theme-studio-v23").convergence).toBe(false);
  expect(themePromptFeatures("theme-studio-v24").convergence).toBe(true);
});

it("enables font pairings only for v25 and later", () => {
  expect(themePromptFeatures("theme-studio-v24").fontPairings).toBe(false);
  expect(themePromptFeatures("theme-studio-v25").fontPairings).toBe(true);
});

it("asks for a full-band photograph opening only from v26, so v25 requests replay unchanged", () => {
  expect(themePromptFeatures("theme-studio-v25").fullBleedOpening).toBe(false);
  expect(themePromptFeatures("theme-studio-v26").fullBleedOpening).toBe(true);
});

it("makes the opening a slideshow only from v27, so v26 requests replay unchanged", () => {
  expect(themePromptFeatures("theme-studio-v26").carouselOpening).toBe(false);
  expect(themePromptFeatures("theme-studio-v27").carouselOpening).toBe(true);
  expect(themePromptFeatures("theme-studio-v27").fullBleedOpening).toBe(true);
});

it("lets briefs allow adults only from v28, so v27 requests replay unchanged", () => {
  expect(themePromptFeatures("theme-studio-v27").peopleInImagery).toBe(false);
  expect(themePromptFeatures("theme-studio-v28").peopleInImagery).toBe(true);
});

it("gives sections nested blocks only from v29, so v28 requests replay unchanged", () => {
  expect(themePromptFeatures("theme-studio-v28").nestedBlocks).toBe(false);
  expect(themePromptFeatures("theme-studio-v29").nestedBlocks).toBe(true);
  expect(themePromptFeatures("theme-studio-v29").peopleInImagery).toBe(true);
});
