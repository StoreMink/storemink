import type { ThemeStudioAcceptanceRunView } from "@/lib/theme-studio/acceptance";
import type { ThemeStudioCheckScreenshots } from "@/lib/theme-studio/progress";
import type {
  ThemeStudioProjectDetail,
  ThemeStudioRunView,
  ThemeStudioVersionView,
} from "@/lib/theme-studio/repository";
import type { ThemeStudioSlotView } from "@/lib/theme-studio/slot-images";
import type { StudioDesignReview } from "./tab-reads";

// Fixtures for the theme page's tab tests (wave TS-2, builder 2C). Test
// support only: no screen imports this file.

export const EM = String.fromCharCode(0x2014);
export const EN = String.fromCharCode(0x2013);

export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const V2 = "22222222-2222-4222-8222-222222222222";
export const V1 = "33333333-3333-4333-8333-333333333333";
export const RUN_ID = "44444444-4444-4444-8444-444444444444";
export const REVIEW_ID = "55555555-5555-4555-8555-555555555555";
export const DIGEST = "d".repeat(64);

export function versionView(
  overrides: Partial<ThemeStudioVersionView> = {},
): ThemeStudioVersionView {
  return {
    id: V2,
    versionNumber: 2,
    parentVersionId: V1,
    runId: null,
    origin: "run",
    editedSlots: [],
    intentDigest: "intent",
    packageDigest: DIGEST,
    packageSummary: {
      pages: 4,
      sections: 12,
      products: 6,
      placeholders: 0,
      catalogPlaceholders: 0,
      missingCategoryImages: 0,
      gaps: [],
    },
    summary: "A calm skincare shop.",
    assumptions: [],
    hasPackage: true,
    qaStatus: "passed",
    qaIteration: 0,
    createdAt: "2026-10-25T06:10:00Z",
    ...overrides,
  };
}

export function runView(
  overrides: Partial<ThemeStudioRunView> = {},
): ThemeStudioRunView {
  return {
    id: "run-1",
    kind: "generate",
    status: "succeeded",
    provider: "vertex-gemini",
    modelKey: "gemini-3.8-flash",
    attemptCount: 1,
    maxAttempts: 3,
    errorCode: null,
    cancelRequested: false,
    retryOfRunId: null,
    baseVersionId: null,
    createdAt: "2026-10-25T04:00:00Z",
    startedAt: "2026-10-25T04:00:00Z",
    finishedAt: "2026-10-25T04:10:00Z",
    usage: null,
    images: null,
    imageSlotIds: [],
    questions: [],
    declineReason: null,
    refusalCategory: null,
    change: null,
    ...overrides,
  } as ThemeStudioRunView;
}

export function projectDetail(
  overrides: Partial<ThemeStudioProjectDetail> = {},
): ThemeStudioProjectDetail {
  return {
    id: PROJECT_ID,
    themeId: "aurora",
    name: "Aurora",
    status: "candidate",
    modelKey: "gemini-3.8-flash",
    industries: ["beauty"],
    catalogSizes: ["small"],
    requiredFeatures: [],
    baseThemeId: null,
    draftBrief: "",
    currentVersionId: V2,
    revision: 7,
    createdByEmail: "maker@storemink.com",
    createdAt: "2026-10-25T04:00:00Z",
    updatedAt: "2026-10-25T06:10:00Z",
    references: [],
    messages: [],
    runs: [],
    versions: [
      versionView(),
      versionView({
        id: V1,
        versionNumber: 1,
        parentVersionId: null,
        createdAt: "2026-10-25T05:00:00Z",
      }),
    ],
    previews: [],
    events: [],
    ...overrides,
  } as ThemeStudioProjectDetail;
}

export function checkRun(
  gates: ThemeStudioAcceptanceRunView["gates"],
  overrides: Partial<ThemeStudioAcceptanceRunView> = {},
): ThemeStudioAcceptanceRunView {
  return {
    id: RUN_ID,
    versionId: V2,
    status: "failed",
    packageDigest: DIGEST,
    assetsDigest: "a".repeat(64),
    buildId: "build-1",
    evidenceDigest: "e".repeat(64),
    createdByEmail: "maker@storemink.com",
    createdAt: "2026-10-25T06:20:00Z",
    completedAt: "2026-10-25T06:25:00Z",
    gates,
    userAgent: "Chrome",
    currentBuild: true,
    ...overrides,
  };
}

export function designReview(
  overrides: Partial<StudioDesignReview> = {},
): StudioDesignReview {
  return {
    id: REVIEW_ID,
    status: "passed",
    errorCode: null,
    createdAt: "2026-10-25T06:26:00Z",
    finishedAt: "2026-10-25T06:28:00Z",
    checkRunId: RUN_ID,
    build: "build-1",
    severity: { outcome: "pass", serious: [], warnings: [] },
    ...overrides,
  };
}

export function screenshots(
  overrides: Partial<ThemeStudioCheckScreenshots> = {},
): ThemeStudioCheckScreenshots {
  return {
    versionId: V2,
    checkRunId: RUN_ID,
    capturedAt: "2026-10-25T06:26:00Z",
    build: "build-1",
    coverage: {
      pages: ["home", "shop", "product", "cart"],
      widths: [360, 390],
      panels: ["menu", "cart"],
      cartWasEmpty: true,
    },
    samples: [
      {
        assetId: "66666666-6666-4666-8666-666666666666",
        page: "home",
        viewport: "phone360",
        width: 360,
        height: 3000,
      },
    ],
    ...overrides,
  };
}

export function slotView(
  overrides: Partial<ThemeStudioSlotView>,
): ThemeStudioSlotView {
  return {
    id: "slot",
    path: "theme-asset://slot",
    kind: "product",
    width: 1280,
    height: 1600,
    alt: "Alt",
    source: "generated",
    licenseNote: null,
    placeholder: false,
    catalogPreview: false,
    catalogScreenshot: false,
    usage: [],
    url: null,
    redrawable: true,
    brief: null,
    history: null,
    ...overrides,
  } as ThemeStudioSlotView;
}

/** The text of an element without the parts inside `skip` (for example
 * Technical details), to prove what the main view shows. */
export function textOutside(root: HTMLElement, skip: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  const id = skip.id;
  if (id) clone.querySelector(`#${CSS.escape(id)}`)?.remove();
  return clone.textContent ?? "";
}
