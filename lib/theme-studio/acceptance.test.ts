import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

import { withService } from "@/lib/db/client";
import {
  currentAcceptanceBuildId,
  manualAcceptanceTransition,
  startThemeStudioAcceptance,
  submitThemeStudioBrowserEvidence,
  verifyThemeStudioCandidateEvidence,
} from "./acceptance";
import { ThemeStudioError } from "./repository";

// The orchestration's database work is exercised against a real PostgreSQL
// (docs/mink-ai-theme-studio-phase5.md, "Verification"); these pin the
// refusals that must happen BEFORE any row is read or written.

const actor = { id: "00000000-0000-4000-8000-000000000001", email: "a@b.c" };
const UUID = "00000000-0000-4000-8000-0000000000aa";

afterEach(() => {
  delete process.env.THEME_STUDIO_BUILD_ID;
  delete process.env.K_REVISION;
});

describe("acceptance build identity", () => {
  it("prefers an explicit build id, then the Cloud Run revision", () => {
    expect(currentAcceptanceBuildId()).toBe("development");
    process.env.K_REVISION = "storemink-web-prod-00042-abc";
    expect(currentAcceptanceBuildId()).toBe("storemink-web-prod-00042-abc");
    process.env.THEME_STUDIO_BUILD_ID = "release-7";
    expect(currentAcceptanceBuildId()).toBe("release-7");
  });
});

describe("acceptance refusals before any database work", () => {
  it("refuses malformed ids on start", async () => {
    await expect(
      startThemeStudioAcceptance(actor, {
        projectId: "nope",
        versionId: UUID,
        sessionCookie: null,
      }),
    ).rejects.toBeInstanceOf(ThemeStudioError);
    expect(withService).not.toHaveBeenCalled();
  });

  it("refuses a malformed browser report without touching the run", async () => {
    await expect(
      submitThemeStudioBrowserEvidence(actor, {
        projectId: UUID,
        runId: UUID,
        nonce: "x",
        evidence: { samples: [] },
      }),
    ).rejects.toThrow(/no samples/);
    await expect(
      submitThemeStudioBrowserEvidence(actor, {
        projectId: UUID,
        runId: UUID,
        nonce: "x",
        evidence: {
          samples: [
            { viewport: "desktop1440", surface: "home", width: "1440" },
          ],
        },
      }),
    ).rejects.toThrow(/measurement/);
    expect(withService).not.toHaveBeenCalled();
  });

  it("an unknown project has no current evidence", async () => {
    expect(await verifyThemeStudioCandidateEvidence("nope")).toEqual({
      ok: false,
      reason: "Unknown project.",
    });
    expect(withService).not.toHaveBeenCalled();
  });
});

// The manual (operator-browser) path must not bypass the visual-QA scorecard
// where automatic QA is deployed; where it is not, promotion is still allowed
// but labelled, so a candidate made that way is identifiable.
describe("manual acceptance → candidate transition", () => {
  const base = {
    outcome: "pass" as const,
    projectStatus: "ready",
    versionIsCurrent: true,
    autoQaEnabled: true,
    finalVisualQaPassed: true,
  };

  it("promotes when every gate AND the final visual review passed", () => {
    expect(manualAcceptanceTransition(base)).toEqual({
      nextState: "candidate",
      visualQa: "passed",
    });
  });

  it("holds at ready when gates passed but visual QA has not", () => {
    expect(
      manualAcceptanceTransition({ ...base, finalVisualQaPassed: false }),
    ).toEqual({ nextState: null, visualQa: "required" });
  });

  it("promotes with a label where automatic QA is not deployed", () => {
    expect(
      manualAcceptanceTransition({
        ...base,
        autoQaEnabled: false,
        finalVisualQaPassed: false,
      }),
    ).toEqual({ nextState: "candidate", visualQa: "not_configured" });
  });

  it("never moves a project for a non-current version", () => {
    expect(
      manualAcceptanceTransition({ ...base, versionIsCurrent: false }),
    ).toEqual({ nextState: null, visualQa: null });
  });

  it("demotes a failed candidate and blocks a security failure as before", () => {
    expect(
      manualAcceptanceTransition({
        ...base,
        outcome: "fail",
        projectStatus: "candidate",
      }),
    ).toEqual({ nextState: "ready", visualQa: null });
    expect(manualAcceptanceTransition({ ...base, outcome: "blocked" })).toEqual(
      { nextState: "blocked", visualQa: null },
    );
    expect(
      manualAcceptanceTransition({
        ...base,
        outcome: "fail",
        projectStatus: "ready",
      }),
    ).toEqual({ nextState: null, visualQa: null });
  });
});
