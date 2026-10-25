// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { gate } from "@/lib/theme-studio/acceptance-gates";
import type { ThemeStudioAcceptanceRunView } from "@/lib/theme-studio/acceptance";
import {
  AcceptanceEvidence,
  AcceptanceRunBadge,
  findingStops,
  gateMark,
  runSummary,
} from "./acceptance-evidence";

// One check run as evidence, in the Checks tab's Technical details (wave
// TS-2, builder 2C): its facts, every check with its code, every finding as
// measured; the Studio's badge and tokens, no raw palette colour, no long
// dash.

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const PALETTE =
  /\b(?:text|bg|border)-(?:slate|gray|red|amber|emerald|green|sky|violet)-\d{2,3}\b/;

afterEach(() => cleanup());

function run(
  overrides: Partial<ThemeStudioAcceptanceRunView> = {},
): ThemeStudioAcceptanceRunView {
  return {
    id: "run-1",
    versionId: "v2",
    status: "passed",
    packageDigest: "a".repeat(64),
    assetsDigest: "b".repeat(64),
    buildId: "build-7",
    evidenceDigest: "c".repeat(64),
    createdByEmail: "op@storemink.com",
    createdAt: "2026-10-25T04:00:00Z",
    completedAt: "2026-10-25T04:05:00Z",
    gates: [],
    userAgent: "Chrome",
    currentBuild: true,
    ...overrides,
  };
}

const smallTarget = gate("browser.tap_targets", [
  {
    code: "small_target",
    where: "phone390 · shop",
    message: "20×20px interactive target (.chip); minimum is 24×24px.",
  },
]);

describe("gateMark and findingStops", () => {
  it("marks a required check holding only warnings as Warnings, never Must fix", () => {
    expect(gateMark(smallTarget)).toEqual({
      label: "Warnings",
      tone: "warning",
    });
    expect(gateMark(gate("routes.links", []))).toEqual({
      label: "Pass",
      tone: "success",
    });
    expect(
      gateMark(
        gate("routes.links", [{ code: "broken", message: "Returned 404." }]),
      ),
    ).toEqual({ label: "Must fix", tone: "danger" });
    expect(
      gateMark(
        gate("browser.coverage", [{ code: "skipped", message: "No." }], {
          status: "skipped",
        }),
      ),
    ).toEqual({ label: "Not run", tone: "neutral" });
  });

  it("counts a finding with no severity as serious", () => {
    const stored = { ...gate("routes.links", []), status: "fail" as const };
    expect(
      findingStops(stored, { code: "broken", message: "Returned 404." }),
    ).toBe(true);
    expect(findingStops(smallTarget, smallTarget.findings[0])).toBe(false);
  });
});

describe("runSummary", () => {
  it("says what a run came to in a sentence", () => {
    expect(runSummary(run({ gates: [smallTarget] }))).toBe(
      "Passed, with 1 warning. Warnings never stop Publish; they go live with the theme.",
    );
    expect(
      runSummary(
        run({
          status: "failed",
          gates: [
            gate("routes.links", [
              { code: "broken", message: "Returned 404." },
            ]),
          ],
        }),
      ),
    ).toBe("1 check found problems that stop Publish.");
    expect(runSummary(run({ status: "blocked" }))).toMatch(
      /security scan failed/,
    );
    expect(runSummary(run({ currentBuild: false }))).toMatch(
      /earlier StoreMink build, so Publish checks this design again on today's build first/,
    );
    expect(runSummary(run({ currentBuild: false }), false)).toBe(
      "Passed. It ran on an earlier StoreMink build.",
    );
    expect(runSummary(run({ status: "expired" }))).toMatch(
      /does not count as passed/,
    );
  });
});

describe("AcceptanceEvidence", () => {
  it("shows the run's facts and every check with its code, in the Studio's badges", () => {
    const { container } = render(
      <AcceptanceEvidence
        run={run({
          gates: [
            smallTarget,
            gate("routes.links", [
              {
                code: "broken",
                where: `/sale ${EM} spring`,
                message: `Returned 404 ${EN} gone.`,
              },
            ]),
          ],
          status: "failed",
        })}
      />,
    );
    expect(screen.getByText("run-1")).toBeTruthy();
    expect(screen.getByText("build-7")).toBeTruthy();
    expect(screen.getByText("(today's build)")).toBeTruthy();
    expect(screen.getByText("aaaaaaaaaaaa...")).toBeTruthy();
    const links = screen.getByText("routes.links").closest("li")!;
    expect(within(links).getByText("Must fix, 1")).toBeTruthy();
    expect(within(links).getByText("broken")).toBeTruthy();
    expect(links.textContent).toContain("/sale, spring");
    expect(links.textContent).toContain("Returned 404, gone.");
    const taps = screen.getByText("browser.tap_targets").closest("li")!;
    expect(within(taps).getByText(/^Warning, StoreMink's code$/)).toBeTruthy();
    expect(container.querySelectorAll(".studio-badge").length).toBeGreaterThan(
      2,
    );
    expect(container.innerHTML).not.toMatch(PALETTE);
    const text = container.textContent ?? "";
    expect(text.includes(EM) || text.includes(EN)).toBe(false);
  });

  it("marks evidence from an earlier build", () => {
    render(<AcceptanceEvidence run={run({ currentBuild: false })} />);
    expect(screen.getByText("Earlier build")).toBeTruthy();
    expect(screen.getByText("(an earlier build)")).toBeTruthy();
  });

  it("calls a security block a security problem", () => {
    render(<AcceptanceRunBadge status="blocked" />);
    expect(screen.getByText("Security problem").getAttribute("data-tone")).toBe(
      "danger",
    );
  });
});
