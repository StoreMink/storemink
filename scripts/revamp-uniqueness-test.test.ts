import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ★ A dry run must never build a model client: any attempt fails the test.
const vertex = vi.hoisted(() => ({
  create: vi.fn((): never => {
    throw new Error("a model client was built");
  }),
}));
vi.mock("../lib/theme-studio/gemini-vertex", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createVertexModelClient: vertex.create,
}));

import { estimateCostMicroUsd, ratesFor } from "../lib/theme-studio/cost";
import type { ThemeStudioModelClient } from "../lib/theme-studio/provider";
import { basket } from "../lib/themes/definitions/basket";
import { THEME_DEFINITIONS } from "../lib/themes";
import { revampDistinctnessBar } from "../lib/mink/revamp/distinctness";
import { fakeRevampSiteOutput } from "../lib/mink/revamp/fake-plan";
import {
  REVAMP_SECTION_CHOICES,
  compileRevampSite,
  revampSectionExample,
} from "../lib/mink/revamp/site-compiler";
import { RevampStepError } from "../lib/mink/revamp/step-error";
import { REVAMP_LIVE_FIXTURES } from "./revamp-live-fixtures";
import {
  CALL_OUTPUT_CEILING_TOKENS,
  MAX_BUDGET_USD,
  STAGING_PROJECT,
  UNIQUENESS_SHOPS,
  V4_AS_MEASURED,
  callCeilingUsd,
  callExpectedUsd,
  copiedChoices,
  dryPlanner,
  environmentProblems,
  estimateRun,
  formatTable,
  harnessRequest,
  harnessSnapshot,
  harnessUuid,
  livePlanner,
  liveRefusal,
  mayStart,
  promptChars,
  readOptions,
  reportJson,
  runUniquenessTest,
  uniquenessTargets,
  v4Answer,
  type HarnessPlanner,
} from "./revamp-uniqueness-test";

const STAGING = {
  THEME_STUDIO_GCP_PROJECT_ID: STAGING_PROJECT,
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  vi.stubEnv("MINK_REVAMP_PROVIDER", "fake");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the options and the refusals", () => {
  it("runs dry by default, on Basket, with no budget", () => {
    expect(readOptions([])).toEqual({
      live: false,
      budgetUsd: null,
      theme: "basket",
      out: null,
    });
    expect(readOptions(["--theme=ritual", "--out=/tmp/x.json"])).toEqual({
      live: false,
      budgetUsd: null,
      theme: "ritual",
      out: "/tmp/x.json",
    });
  });

  it("★★ takes a live run only with a budget, and never one above $2", () => {
    expect(readOptions(["--live", "--budget-usd=2"])).toMatchObject({
      live: true,
      budgetUsd: 2,
    });
    expect(readOptions(["--live", "--budget-usd=1.25"])).toMatchObject({
      budgetUsd: 1.25,
    });
    expect(MAX_BUDGET_USD).toBe(2);
    expect(readOptions(["--live"])).toMatch(/--budget-usd=<dollars>/);
    expect(readOptions(["--live", "--budget-usd="])).toMatch(/--budget-usd/);
    expect(readOptions(["--live", "--budget-usd=2.01"])).toMatch(
      /^Refused: --budget-usd=2\.01 is above \$2/,
    );
    expect(readOptions(["--live", "--budget-usd=50"])).toMatch(/^Refused/);
    for (const bad of ["0", "-1", "abc", "NaN", "Infinity"]) {
      expect(readOptions(["--live", `--budget-usd=${bad}`])).toMatch(
        /positive number|above/,
      );
    }
  });

  it("refuses a budget without --live, an unknown argument and an unknown theme", () => {
    expect(readOptions(["--budget-usd=1"])).toMatch(/is for a live run/);
    expect(readOptions(["--yes"])).toMatch(/^Unknown argument --yes/);
    expect(readOptions(["--live=1"])).toMatch(/^Unknown argument/);
    expect(readOptions(["--theme=arcade"])).toMatch(/No bundled theme/);
  });

  it("★★ never spends outside staging", () => {
    expect(environmentProblems(STAGING)).toEqual([]);
    expect(
      environmentProblems({ GCP_PROJECT_ID: STAGING_PROJECT } as never),
    ).toEqual([]);
    // Theme Studio's project wins over the platform's, as the client reads.
    expect(
      environmentProblems({
        THEME_STUDIO_GCP_PROJECT_ID: "storemink-prod",
        GCP_PROJECT_ID: STAGING_PROJECT,
      } as never).join(" "),
    ).toMatch(/storemink-prod/);
    expect(environmentProblems({} as never)).toHaveLength(1);
    // ★ Any project but staging, production or not.
    expect(
      environmentProblems({ GCP_PROJECT_ID: "someone-elses-dev" } as never),
    ).toEqual([
      `The planner would run in "someone-elses-dev"; this test runs only in ${STAGING_PROJECT}.`,
    ]);
    expect(
      environmentProblems({
        ...STAGING,
        GOOGLE_CLOUD_QUOTA_PROJECT: "storemink-prod",
      }),
    ).toHaveLength(1);
    expect(
      environmentProblems({
        ...STAGING,
        GOOGLE_VERTEX_BASE_URL: "https://elsewhere.example",
      }),
    ).toHaveLength(1);
  });

  it("★★ refuses a live run its budget cannot start, or outside staging, before any call", () => {
    const estimate = estimateRun(basket);
    expect(liveRefusal(2, STAGING, estimate)).toBeNull();
    expect(liveRefusal(estimate.callCeilingUsd, STAGING, estimate)).toBeNull();
    expect(
      liveRefusal(estimate.callCeilingUsd - 0.01, STAGING, estimate),
    ).toMatch(/^Refused: one planning call may cost up to/);
    expect(
      liveRefusal(2, { GCP_PROJECT_ID: "storemink-prod" } as never, estimate),
    ).toMatch(/^Refused: this test runs only against storemink-staging/);
    expect(vertex.create).not.toHaveBeenCalled();
  });
});

describe("the money", () => {
  it("prices a call's ceiling as its prompt and the longest answer, at the planner's rates", () => {
    const rate = ratesFor("gemini-3.8-flash", 10_000, new Date());
    expect(callCeilingUsd(30_000)).toBeCloseTo(
      (10_000 * rate.input + CALL_OUTPUT_CEILING_TOKENS * rate.output) / 1e6,
      9,
    );
    expect(callExpectedUsd(30_000)).toBeLessThan(callCeilingUsd(30_000));
  });

  it("starts a call only while what was spent and its ceiling fit the budget", () => {
    expect(mayStart(0, 0.38, 2)).toBe(true);
    expect(mayStart(1.62, 0.38, 2)).toBe(true);
    expect(mayStart(1.63, 0.38, 2)).toBe(false);
    expect(mayStart(0, 0.38, 0.37)).toBe(false);
  });

  it("★ the whole run is twelve calls, about one or two dollars, and one call fits the $2 cap", () => {
    const estimate = estimateRun(basket);
    expect(estimate.calls).toBe(12);
    expect(estimate.expectedUsd).toBeGreaterThan(0.5);
    expect(estimate.expectedUsd).toBeLessThan(MAX_BUDGET_USD);
    expect(estimate.callCeilingUsd).toBeLessThan(MAX_BUDGET_USD / 4);
  });
});

describe("the shops", () => {
  it("★ three bakeries and three skincare shops, two of them the live check's own", () => {
    expect(UNIQUENESS_SHOPS.map((shop) => shop.trade)).toEqual([
      "bakery",
      "bakery",
      "bakery",
      "skincare",
      "skincare",
      "skincare",
    ]);
    const crumb = REVAMP_LIVE_FIXTURES.find((f) => f.slug === "crumb-and-co")!;
    const neem = REVAMP_LIVE_FIXTURES.find((f) => f.slug === "neem-ritual")!;
    expect(UNIQUENESS_SHOPS[0].brief).toBe(crumb.request.brief);
    expect(UNIQUENESS_SHOPS[3].brief).toBe(neem.request.brief);
    expect(new Set(UNIQUENESS_SHOPS.map((shop) => shop.slug)).size).toBe(6);
    // ★ No long dash in anything a planner reads.
    expect(JSON.stringify(UNIQUENESS_SHOPS)).not.toMatch(/[\u2013\u2014]/);
  });

  it("every shop's request reads on every bundled theme, and its snapshot is a fresh install", () => {
    for (const theme of THEME_DEFINITIONS) {
      for (const [index, shop] of UNIQUENESS_SHOPS.entries()) {
        const request = harnessRequest(theme, shop);
        expect(request.kind).toBe("full");
        expect(request.products).toHaveLength(shop.products.length);
        expect(request.products.every((p) => p.photoUrl === null)).toBe(true);
        const snapshot = harnessSnapshot(
          theme,
          shop,
          harnessUuid(1, index + 1),
        );
        expect(snapshot.theme.id).toBe(theme.id);
        expect(snapshot.pages.some((page) => page.slug === "")).toBe(true);
        for (const page of snapshot.pages) {
          expect(Object.values(page.owners).every((o) => o === "theme")).toBe(
            true,
          );
        }
        // Every sample category is hidden, or kept at its address.
        const changed = new Set(request.categories.map((c) => c.slug));
        for (const category of snapshot.categories) {
          expect(changed.has(category.slug)).toBe(true);
        }
      }
    }
  });
});

describe("v4 as modelled, and the settings equal to the v4 default", () => {
  const shop = UNIQUENESS_SHOPS[0];
  const snapshot = harnessSnapshot(basket, shop, harnessUuid(1, 1));
  const request = harnessRequest(basket, shop);
  const input = {
    request,
    snapshot,
    previous: null,
    revampId: harnessUuid(2, 1),
  };
  const raw = fakeRevampSiteOutput(input) as Record<string, unknown>;

  it("reads an answer again as v4: no version, every printed setting at its printed value", () => {
    const v4 = v4Answer(raw) as Record<string, unknown>;
    expect(raw.promptVersion).toBeDefined();
    expect(v4).not.toHaveProperty("promptVersion");
    expect(v4.summary).toBe(raw.summary);
    expect(v4.design).toEqual(raw.design);
    let checked = 0;
    for (const page of v4.pages as Array<{ sections: unknown[] }>) {
      for (const section of page.sections as Array<Record<string, unknown>>) {
        if (typeof section.configJson !== "string") continue;
        const type = section.type as keyof typeof REVAMP_SECTION_CHOICES;
        const config = JSON.parse(section.configJson);
        const printed = revampSectionExample(type as never);
        for (const key of Object.keys(
          REVAMP_SECTION_CHOICES[type]?.fields ?? {},
        )) {
          if (key === "height" || printed[key] === undefined) continue;
          expect(config[key]).toEqual(printed[key]);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
    // The answer itself is never written to.
    expect(v4Answer(raw)).toEqual(v4);
    expect(raw.promptVersion).toBeDefined();
  });

  it("leaves anything it cannot read as it is", () => {
    expect(v4Answer(null)).toBeNull();
    expect(v4Answer("x")).toBe("x");
    const broken = {
      promptVersion: "x",
      pages: [{ sections: [{ type: "hero", configJson: "{not json" }] }],
    };
    expect(v4Answer(broken)).toEqual({ pages: broken.pages });
  });

  it("counts a setting as copied only when it equals the printed value, with the chance level", () => {
    const v5 = compileRevampSite(raw, input).plan!;
    const v4 = compileRevampSite(v4Answer(raw), {
      request,
      snapshot,
      previous: null,
    }).plan!;
    const before = copiedChoices(v4, snapshot);
    const after = copiedChoices(v5, snapshot);
    expect(before.total).toBeGreaterThan(5);
    expect(before.same).toBe(before.total);
    expect(after.total).toBe(before.total);
    expect(after.same).toBeLessThan(after.total);
    expect(after.chance).toBeGreaterThan(0);
    expect(after.chance).toBeLessThan(after.total);
    // ★ Sections the store keeps are the merchant's, never counted.
    const kept = {
      ...snapshot,
      pages: [
        {
          ...snapshot.pages[0],
          sections: v5.pages.flatMap((page) => page.sections),
        },
      ],
    };
    expect(copiedChoices(v5, kept)).toEqual({ same: 0, total: 0, chance: 0 });
  });
});

describe("★★ the dry run", () => {
  it("plans every shop twice on the offline planner, measures every target and spends nothing", async () => {
    const planner = vi.fn(dryPlanner());
    const report = await runUniquenessTest(
      { live: false, budgetUsd: null, theme: basket },
      planner,
    );
    expect(report.mode).toBe("dry");
    expect(planner).toHaveBeenCalledTimes(12);
    expect(report.calls).toBe(12);
    expect(report.spentUsd).toBe(0);
    expect(vertex.create).not.toHaveBeenCalled();
    expect(report.shops.every((shop) => shop.missing === null)).toBe(true);
    expect(report.theme.bar).toBe(revampDistinctnessBar(basket));
    expect(report.theme.bar).toBe(0.289);
    // Three pairs of each trade, and a redo per shop.
    expect(report.pairs.filter((p) => p.trade === "bakery")).toHaveLength(3);
    expect(report.pairs.filter((p) => p.trade === "skincare")).toHaveLength(3);
    expect(report.redo).toHaveLength(6);
    // ★ The redo planned with the first in mind: its summary, its own id.
    for (const [index] of UNIQUENESS_SHOPS.entries()) {
      const [first] = planner.mock.calls[index * 2];
      const [redo] = planner.mock.calls[index * 2 + 1];
      expect(first.earlierDesigns).toBeUndefined();
      expect(first.revampId).not.toBe(redo.revampId);
      expect(redo.earlierDesigns).toMatch(/^1 \(newest\)\. direction /);
      expect(redo.request).toBe(first.request);
    }
    for (const entry of report.redo) {
      expect(entry.after).toBeGreaterThanOrEqual(entry.before - 1e-9);
    }
    expect(report.copied.v4.same).toBe(report.copied.v4.total);
    expect(report.copied.v5.same).toBeLessThan(report.copied.v5.total);
    expect(report.pages.v5.total).toBe(12);
    // The offline planner meets every target on these six shops.
    expect(report.targets).toEqual({
      sameTrade: true,
      redo: true,
      copied: true,
      pages: true,
      complete: true,
    });

    const table = formatTable(report);
    expect(table).toContain("dry run, offline planner");
    expect(table).toContain("same-theme bar 0.289");
    expect(table).toContain(`${V4_AS_MEASURED.redo}`);
    expect(table).toContain("Every target met.");
    expect(table).not.toMatch(/[\u2013\u2014]/);
    // ★ The report holds numbers, slugs and design words, never the shops' own.
    const json = reportJson(report);
    for (const words of ["Aundh", "sourdough", "Kochi", "Pushkar", "kokum"]) {
      expect(json).not.toContain(words);
    }
  });

  it("★★ moves a redo that repeats the first redesign, as the runner's check does", async () => {
    // The redo's answer is the first one again: the audit's same-design-twice.
    const answers = new Map<string, unknown>();
    const repeating: HarnessPlanner = async (input) => {
      const shop = input.snapshot.storeId;
      if (!answers.has(shop)) answers.set(shop, fakeRevampSiteOutput(input));
      return { raw: answers.get(shop), usd: 0 };
    };
    const report = await runUniquenessTest(
      { live: false, budgetUsd: null, theme: basket },
      repeating,
    );
    expect(report.redo).toHaveLength(6);
    for (const entry of report.redo) {
      expect(entry.before).toBeLessThan(report.theme.bar);
      expect(entry.status).toMatch(/^(changed|too-close)$/);
      expect(entry.changes).toBeGreaterThan(0);
      expect(entry.after).toBeGreaterThan(entry.before);
    }
    expect(report.redo.some((entry) => entry.status === "changed")).toBe(true);
    expect(report.targets.redo).toBe(
      report.redo.every((entry) => entry.after >= report.theme.bar),
    );
  });

  it("is the same every time", async () => {
    const a = await runUniquenessTest(
      { live: false, budgetUsd: null, theme: basket },
      dryPlanner(),
    );
    const b = await runUniquenessTest(
      { live: false, budgetUsd: null, theme: basket },
      dryPlanner(),
    );
    expect(b.pairs).toEqual(a.pairs);
    expect(b.redo).toEqual(a.redo);
    expect(b.copied).toEqual(a.copied);
  });

  it("★★ never plans with a real model, whatever the environment says", async () => {
    vi.stubEnv("MINK_REVAMP_PROVIDER", "vertex");
    const report = await runUniquenessTest(
      { live: false, budgetUsd: null, theme: basket },
      dryPlanner(),
    );
    expect(report.calls).toBe(1);
    expect(report.shops[0].missing).toMatch(/offline fake only/);
    expect(report.stopped).toMatch(
      /^stopped: A dry run plans with the offline fake only/,
    );
    expect(
      report.shops
        .slice(1)
        .every((s) => s.missing === "not planned: the run stopped"),
    ).toBe(true);
    expect(report.targets.complete).toBe(false);
    expect(vertex.create).not.toHaveBeenCalled();
  });
});

describe("★★ a live run's budget, with a planner that only pretends to be paid", () => {
  /** The offline answer, priced as if a model had written it. */
  const priced =
    (usd: number): HarnessPlanner =>
    async (input) => ({
      raw: fakeRevampSiteOutput(input),
      usd,
    });

  it("never starts a call the budget cannot cover, and says where it stopped", async () => {
    const planner = vi.fn(priced(0.3));
    const report = await runUniquenessTest(
      { live: true, budgetUsd: 1, theme: basket },
      planner,
    );
    const ceiling = callCeilingUsd(
      promptChars({
        request: harnessRequest(basket, UNIQUENESS_SHOPS[1]),
        snapshot: harnessSnapshot(
          basket,
          UNIQUENESS_SHOPS[1],
          harnessUuid(1, 1),
        ),
        previous: null,
      }),
    );
    expect(ceiling).toBeGreaterThan(0.3);
    // 0.30 + 0.30 + 0.30 spent; a fourth could pass $1.
    expect(planner).toHaveBeenCalledTimes(3);
    expect(report.calls).toBe(3);
    expect(report.spentUsd).toBeCloseTo(0.9, 9);
    expect(report.spentUsd).toBeLessThanOrEqual(1);
    expect(report.stopped).toMatch(/^stopped before call 4: \$0\.90 spent/);
    expect(report.shops[0].missing).toBeNull();
    expect(report.shops[1].missing).toBe("not planned: the budget");
    expect(report.shops.slice(2).every((s) => s.missing)).toBe(true);
    expect(report.targets.complete).toBe(false);
    expect(formatTable(report)).toContain("INCOMPLETE:");
  });

  it("★ counts a failed call at its ceiling and carries on after a wait, a refusal or an answer it cannot use", async () => {
    const busy = vi.fn<HarnessPlanner>(async () => {
      throw new RevampStepError("model_unavailable", "busy", true);
    });
    const waited = await runUniquenessTest(
      { live: true, budgetUsd: 2, theme: basket },
      busy,
    );
    // Every failed call may have been billed: the ceiling stops the run.
    expect(waited.spentUsd).toBeLessThanOrEqual(2);
    expect(busy.mock.calls.length).toBeGreaterThan(1);
    expect(busy.mock.calls.length).toBeLessThan(6);
    expect(waited.shops[0].missing).toBe("failed: model_unavailable");
    expect(waited.stopped).toMatch(/^stopped before call/);

    // A request the model declined is that shop's alone.
    const declined = vi.fn<HarnessPlanner>(async () => {
      throw new RevampStepError("model_refused", "no", false);
    });
    const refused = await runUniquenessTest(
      { live: true, budgetUsd: 2, theme: basket },
      declined,
    );
    expect(declined.mock.calls.length).toBeGreaterThan(1);
    expect(refused.shops[0].missing).toBe("failed: model_refused");
    expect(refused.stopped).toMatch(/^stopped before call/);

    // ★ An answer nothing can be compiled from fails its shop, never the run.
    const empty = vi.fn<HarnessPlanner>(async () => ({ raw: null, usd: 0.05 }));
    const unusable = await runUniquenessTest(
      { live: true, budgetUsd: 2, theme: basket },
      empty,
    );
    expect(empty).toHaveBeenCalledTimes(6);
    expect(
      unusable.shops.every((s) => s.missing === "failed: plan_invalid"),
    ).toBe(true);
    expect(unusable.stopped).toBeNull();
  });

  it("★★ stops paying at once when the planner is not set up for good", async () => {
    const unset = vi.fn<HarnessPlanner>(async () => {
      throw new RevampStepError(
        "model_unavailable",
        "The design model refused the request; it needs a configuration fix.",
        false,
      );
    });
    const report = await runUniquenessTest(
      { live: true, budgetUsd: 2, theme: basket },
      unset,
    );
    expect(unset).toHaveBeenCalledTimes(1);
    expect(report.stopped).toBe(
      "stopped: the planner is not set up (model_unavailable)",
    );
    expect(report.shops[0].missing).toBe("failed: model_unavailable");
    expect(
      report.shops
        .slice(1)
        .every((s) => s.missing === "not planned: the run stopped"),
    ).toBe(true);
    expect(report.targets.complete).toBe(false);
  });
});

describe("★★ the targets of section 5", () => {
  const met = {
    bar: 0.289,
    pairs: [{ v5: 0.289 }, { v5: 0.5 }],
    redo: [{ after: 0.3 }],
    copied: { same: 49, total: 100 },
    pages: { notNearWhite: 1, total: 12 },
    complete: true,
  };

  it("are met at the bar, under half copied and one page not near-white", () => {
    expect(uniquenessTargets(met)).toEqual({
      sameTrade: true,
      redo: true,
      copied: true,
      pages: true,
      complete: true,
    });
  });

  it.each([
    [
      "a same-trade pair under the bar",
      { pairs: [{ v5: 0.5 }, { v5: 0.288 }] },
      "sameTrade",
    ],
    ["no pair measured", { pairs: [] }, "sameTrade"],
    [
      "a redo under the bar after the check",
      { redo: [{ after: 0.4 }, { after: 0.2 }] },
      "redo",
    ],
    ["no redo measured", { redo: [] }, "redo"],
    [
      "half the settings at the v4 default",
      { copied: { same: 50, total: 100 } },
      "copied",
    ],
    ["no setting measured", { copied: { same: 0, total: 0 } }, "copied"],
    [
      "every page near-white",
      { pages: { notNearWhite: 0, total: 12 } },
      "pages",
    ],
    ["no page measured", { pages: { notNearWhite: 0, total: 0 } }, "pages"],
    ["a run that did not plan every shop", { complete: false }, "complete"],
  ] as const)("are not met with %s", (_what, change, target) => {
    const targets = uniquenessTargets({ ...met, ...change });
    expect(targets[target]).toBe(false);
    for (const [name, value] of Object.entries(targets)) {
      if (name !== target) expect(value).toBe(true);
    }
  });
});

describe("the live planner, with a stand-in client (no network)", () => {
  it("★ sends the production planning request and prices the answer from its own tokens", async () => {
    vi.stubEnv("MINK_REVAMP_PROVIDER", "vertex");
    const usage = {
      inputTokens: 9_000,
      cachedTokens: 0,
      outputTokens: 11_000,
      thinkingTokens: 13_000,
    };
    const generate = vi.fn<ThemeStudioModelClient["generate"]>(async () => ({
      kind: "ok" as const,
      value: { promptVersion: "mink-revamp-site-v5" },
      usage,
    }));
    const planner = livePlanner({ provider: "vertex-gemini", generate });
    const shop = UNIQUENESS_SHOPS[0];
    const input = {
      request: harnessRequest(basket, shop),
      snapshot: harnessSnapshot(basket, shop, harnessUuid(1, 1)),
      previous: null,
      revampId: harnessUuid(2, 1),
      earlierDesigns: "1 (newest). direction bold-and-loud",
    };
    const answer = await planner(input);
    expect(generate).toHaveBeenCalledTimes(1);
    const request = generate.mock.calls[0][0];
    expect(request.modelKey).toBe("gemini-3.8-flash");
    expect(request.effort).toBe("high");
    const text = (request.content[0] as { text: string }).text;
    expect(text).toContain("<earlier_designs>");
    expect(text.length + request.system.length).toBe(promptChars(input));
    expect(answer.raw).toEqual({ promptVersion: "mink-revamp-site-v5" });
    expect(answer.usd).toBeCloseTo(
      estimateCostMicroUsd("gemini-3.8-flash", usage) / 1e6,
      9,
    );
    // Well inside the ceiling the budget assumed for it.
    expect(answer.usd).toBeLessThan(callCeilingUsd(promptChars(input)));
    expect(vertex.create).not.toHaveBeenCalled();
  });
});
