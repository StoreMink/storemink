import { afterEach, describe, expect, it, vi } from "vitest";

// The runner's log lines, so a test can read what it leaves for diagnosis.
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: log.info,
  logWarn: log.warn,
  logError: vi.fn(),
}));
// ★ The redo memory's pure check, wrapped so a test can watch or replace a
//   call; by default the real functions run.
vi.mock("./distinctness", async (importOriginal) => {
  const real = await importOriginal<typeof import("./distinctness")>();
  return {
    ...real,
    makeDistinct: vi.fn(real.makeDistinct),
    earlierDesignsSummary: vi.fn(real.earlierDesignsSummary),
  };
});
// ★ The production reads a runner falls back to when its side effects leave
//   the memory out (the live check's): faked, so no test reaches a database.
const memory = vi.hoisted(() => ({
  readEarlierRevampPlans: vi.fn(async (_input: unknown): Promise<unknown[]> => {
    void _input;
    return [];
  }),
  resolveInstalledThemeDefinition: vi.fn(
    async (_selection: unknown): Promise<unknown> => {
      void _selection;
      return null;
    },
  ),
}));
vi.mock("./jobs", () => ({
  readEarlierRevampPlans: memory.readEarlierRevampPlans,
}));
vi.mock("@/lib/themes/runtime-registry", () => ({
  resolveInstalledThemeDefinition: memory.resolveInstalledThemeDefinition,
}));
import { basket } from "@/lib/themes/definitions/basket";
import type { MinkActorContext } from "../types";
import {
  REVAMP_EARLIER_PLANS_MAX,
  earlierDesignsSummary,
  makeDistinct,
  revampDistances,
  revampDistinctnessBar,
} from "./distinctness";
import { fakeRevampSiteOutput } from "./fake-plan";
import { compileRevampSite, finalizeRevampSite } from "./site-compiler";
import {
  REVAMP_LIMITS,
  REVAMP_STEPS,
  initialRevampProgress,
  type RevampPhotoOutcome,
  type RevampRequest,
  type RevampSitePlan,
  type RevampSnapshot,
  type RevampStep,
  type RevampStoredImage,
  type RevampStoredPlan,
} from "./contract";
import type {
  RevampDistinctnessRecord,
  RevampJobRow,
  RevampPlanColumn,
} from "./jobs";
import {
  RevampDrainedError,
  RevampOutOfCreditsError,
  RevampRetryLaterError,
  RevampStepError,
  ZERO_REVAMP_USAGE,
  type RevampDeps,
  type RevampPhotoReviews,
  type RevampStepContext,
  type RevampUsage,
} from "./ports";
import { revampReadyEvent } from "./ready-notice";
import {
  REVAMP_DEADLINE_GRACE_MS,
  REVAMP_LEASE_MARGIN_MS,
  REVAMP_PLAN_RETRY_MIN_LEFT_MS,
  REVAMP_READY_URL,
  REVAMP_RETRY_AFTER_MS,
  redrawFor,
  runRevampJob,
  type RevampRunnerJobs,
} from "./runner";

const ID = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const STORE = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const DRAFT = "55555555-5555-4555-8555-555555555555";
const ADMIN = "admin-uid";
const LEASE = "lease-token";

const REQUEST = {
  kind: "full",
  brief: { business: "Shoes" },
  products: [{ key: "p1", name: "Boot", photoUrl: "https://x/p1.webp" }],
  categories: [],
  pages: null,
  instruction: null,
  refineScope: null,
} as unknown as RevampRequest;
const SNAPSHOT = { storeId: STORE } as unknown as RevampSnapshot;
const plan = (name: string) =>
  ({
    summary: name,
    shots: [{ id: "hero" }, { id: "about" }],
  }) as unknown as RevampSitePlan;
const PLAN = plan("compiled");
const FINAL = plan("finalized");
const FITTED = plan("fitted");
const STORED = { explanation: "stored" } as unknown as RevampStoredPlan;
const CHECKED = { explanation: "checked" } as unknown as RevampStoredPlan;
const OUTCOME = {
  shotId: "hero",
  status: "generated",
  reason: null,
} as RevampPhotoOutcome;
const COMPILED: RevampPlanColumn = {
  stage: "compiled",
  plan: PLAN,
  productPhotoKeys: null,
};

const ACTOR = {
  storeId: STORE,
  adminId: ADMIN,
  permissions: { builder: ["view", "manage"] },
  isSuperadmin: false,
  draftingEnabled: true,
  runId: RUN,
  requestId: "req",
} as unknown as MinkActorContext;

const usage = (patch: Partial<RevampUsage>): RevampUsage => ({
  ...ZERO_REVAMP_USAGE,
  ...patch,
});

function makeJob(over: Partial<RevampJobRow> = {}): RevampJobRow {
  return {
    id: ID,
    storeId: STORE,
    adminId: ADMIN,
    requesterEmail: "owner@example.com",
    conversationId: null,
    originRunId: RUN,
    parentId: null,
    supersededBy: null,
    kind: "full",
    status: "running",
    step: "snapshot",
    progress: initialRevampProgress(),
    request: REQUEST,
    snapshot: null,
    plan: null,
    result: null,
    draftId: null,
    free: false,
    budgetCredits: null,
    credits: 0,
    leaseToken: LEASE,
    leaseUntil: null,
    attempts: 1,
    maxAttempts: 4,
    lastKickAt: null,
    cancelRequestedAt: null,
    errorCode: null,
    errorDetail: null,
    appliedAt: null,
    publishedAt: null,
    undoneAt: null,
    applySnapshot: null,
    publishSnapshot: null,
    usage: ZERO_REVAMP_USAGE,
    createdAt: "2026-10-21T00:00:00Z",
    updatedAt: "2026-10-21T00:00:00Z",
    finishedAt: null,
    ...over,
  };
}

/** A job that already holds every output the steps before `step` make. */
function jobAt(step: RevampStep, over: Partial<RevampJobRow> = {}) {
  const at = REVAMP_STEPS.indexOf(step);
  const past = (s: RevampStep) => REVAMP_STEPS.indexOf(s) < at;
  return makeJob({
    step,
    snapshot: past("snapshot") ? SNAPSHOT : null,
    plan: past("compile")
      ? COMPILED
      : past("plan")
        ? { stage: "raw", raw: { draft: 0 }, repairs: 0, issues: [] }
        : null,
    result: {
      ...(past("photos") ? { photos: { outcomes: [OUTCOME] } } : {}),
      ...(past("products") ? { products: { failed: [] } } : {}),
      ...(past("assemble") ? { stored: STORED } : {}),
      ...(past("checks") ? { stored: CHECKED, checked: true } : {}),
    } as RevampJobRow["result"],
    ...over,
  });
}

function makeJobs(
  job: RevampJobRow,
  over: Partial<RevampRunnerJobs> = {},
): RevampRunnerJobs {
  const images: Record<string, RevampStoredImage[]> = {
    [ID]: [{ slotId: "own" } as unknown as RevampStoredImage],
    [PARENT]: [{ slotId: "parent" } as unknown as RevampStoredImage],
  };
  return {
    claim: vi.fn(async () => ({ job, leaseToken: LEASE })),
    renew: vi.fn(async () => ({ ok: true, cancelRequested: false })),
    release: vi.fn(async () => {}),
    save: vi.fn(async () => true),
    report: vi.fn(async () => {}),
    finish: vi.fn(async () => true),
    fail: vi.fn(async () => "failed" as const),
    cancel: vi.fn(async () => "cancelled" as const),
    read: vi.fn(async () => null),
    rebuildActor: vi.fn(async () => ACTOR),
    listImages: vi.fn(async (revampId: string) => images[revampId] ?? []),
    kick: vi.fn(async () => {}),
    kickWaiting: vi.fn(async () => 0),
    hold: vi.fn(async () => true),
    reviews: vi.fn(async () => true),
    notify: vi.fn(async () => "event-id"),
    // ★ A store with no earlier redesign, on a real bundled theme: the check
    //   runs for real and records "not-compared".
    earlierPlans: vi.fn(async () => []),
    theme: vi.fn(async () => basket),
    ...over,
  };
}

function makeDeps(order: string[], over: Partial<RevampDeps> = {}): RevampDeps {
  const track =
    <A extends unknown[], R>(name: string, impl: (...args: A) => R) =>
    (...args: A) => {
      order.push(name);
      return impl(...args);
    };
  return {
    snapshot: vi.fn(track("snapshot", async () => SNAPSHOT)),
    plan: vi.fn(
      track("plan", async () => ({
        raw: { draft: 1 },
        usage: usage({ inputTokens: 100 }),
      })),
    ),
    repair: vi.fn(
      track("repair", async () => ({
        raw: { draft: 2 },
        usage: usage({ inputTokens: 10 }),
      })),
    ),
    compile: vi.fn(track("compile", () => ({ plan: PLAN, issues: [] }))),
    finalize: vi.fn(track("finalize", () => FINAL)),
    fitBudget: vi.fn(
      track("fitBudget", () => ({ plan: FITTED, productPhotoKeys: ["p1"] })),
    ),
    // ★ Like the real steps (L2-F): each paid call is reported through
    //   `onUsage` as it returns, and the same total comes back as well, so a
    //   runner that added both would count every call twice.
    photos: vi.fn(
      track(
        "photos",
        async (
          _ctx: RevampStepContext,
          input: Parameters<RevampDeps["photos"]>[1],
        ) => {
          const spent = usage({ images: 2, estimatedCostMicroUsd: 5 });
          input.onUsage?.(spent);
          return { images: [], outcomes: [OUTCOME], usage: spent };
        },
      ),
    ),
    products: vi.fn(
      track(
        "products",
        async (
          _ctx: RevampStepContext,
          input: Parameters<RevampDeps["products"]>[1],
        ) => {
          const spent = usage({ images: 1 });
          input.onUsage?.(spent);
          return {
            images: [],
            failed: [{ key: "p1", reason: "busy" }],
            usage: spent,
          };
        },
      ),
    ),
    assemble: vi.fn(track("assemble", () => STORED)),
    checks: vi.fn(track("checks", async () => ({ plan: CHECKED }))),
    card: vi.fn(track("card", async () => ({ draftId: DRAFT, credits: 12 }))),
    estimate: vi.fn(() => credits(10)),
    balance: vi.fn(async () => 1_000),
    productPhotoKeys: vi.fn(() => ["p1"]),
    carriedProductPhotoKeys: vi.fn(() => []),
    ...over,
  };
}

/** A credit breakdown with this total, for the estimate port. */
function credits(total: number) {
  return {
    pages: 0,
    photos: 0,
    design: 0,
    chrome: 0,
    categories: 0,
    productPhotos: 0,
    total,
  };
}

const untilAborted = (ctx: RevampStepContext) =>
  new Promise<never>((_, reject) => {
    if (ctx.signal.aborted) return reject(ctx.signal.reason);
    ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), {
      once: true,
    });
  });

const savedSteps = (jobs: RevampRunnerJobs) =>
  vi.mocked(jobs.save).mock.calls.map(([input]) => input.step);
const saveInput = (jobs: RevampRunnerJobs, n: number) => {
  const [input] = vi.mocked(jobs.save).mock.calls[n];
  return input as typeof input & { patch: { usage: RevampUsage } };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("runRevampJob", () => {
  it("does nothing when the job cannot be claimed", async () => {
    const jobs = makeJobs(makeJob(), { claim: vi.fn(async () => null) });
    const deps = makeDeps([]);
    expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
      outcome: "not_claimed",
    });
    expect(jobs.rebuildActor).not.toHaveBeenCalled();
  });

  it("runs every step in order, saving each output, then finishes and notifies", async () => {
    const order: string[] = [];
    const jobs = makeJobs(makeJob());
    const deps = makeDeps(order);
    const { outcome } = await runRevampJob({ revampId: ID, deps, jobs });
    expect(outcome).toBe("ready");
    expect(order).toEqual([
      "snapshot",
      "plan",
      "compile",
      "photos",
      "products",
      "assemble",
      "checks",
      "card",
    ]);
    // Each save names the step the job moves on to.
    expect(savedSteps(jobs)).toEqual(REVAMP_STEPS.slice(1));
    expect(saveInput(jobs, 0).patch.snapshot).toBe(SNAPSHOT);
    expect(saveInput(jobs, 1).patch.plan).toEqual({
      stage: "raw",
      raw: { draft: 1 },
      repairs: 0,
      issues: [],
    });
    // A revamp with no budget names its product photos too (f-5).
    expect(saveInput(jobs, 2).patch.plan).toEqual({
      ...COMPILED,
      productPhotoKeys: ["p1"],
    });
    const last = saveInput(jobs, 6);
    expect(last.progress.find((p) => p.step === "checks")?.state).toBe("done");
    expect(last.progress.find((p) => p.step === "card")?.state).toBe("running");
    expect(jobs.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        revampId: ID,
        leaseToken: LEASE,
        draftId: DRAFT,
        credits: 12,
        result: expect.objectContaining({
          stored: CHECKED,
          checked: true,
          photos: { outcomes: [OUTCOME] },
          products: { failed: [{ key: "p1", reason: "busy" }] },
        }),
      }),
    );
    expect(deps.card).toHaveBeenCalledWith(
      expect.objectContaining({
        revampId: ID,
        actor: ACTOR,
        deadline: expect.any(Number),
      }),
      { plan: CHECKED, free: false },
    );
    expect(jobs.notify).toHaveBeenCalledTimes(1);
    expect(jobs.notify).toHaveBeenCalledWith({
      type: "mink.revamp_ready",
      storeId: STORE,
      actor: { type: "system", label: "Mink AI" },
      subject: { type: "mink_revamp", id: ID, label: "Storefront redesign" },
      payload: { url: REVAMP_READY_URL },
      restrictToAdminIds: [ADMIN],
    });
    // ★ The one notice every path that turns a revamp ready sends (ops-4).
    expect(jobs.notify).toHaveBeenCalledWith(
      revampReadyEvent({ id: ID, storeId: STORE, adminId: ADMIN }),
    );
    expect(jobs.release).not.toHaveBeenCalled();
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it("★★ the ready notice opens the chat that holds the card (B20)", async () => {
    const chat = "66666666-6666-4666-8666-666666666666";
    const jobs = makeJobs(jobAt("card", { conversationId: chat }));
    expect(
      (await runRevampJob({ revampId: ID, deps: makeDeps([]), jobs })).outcome,
    ).toBe("ready");
    expect(jobs.notify).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { url: `/dashboard?chat=${chat}` } }),
    );
  });

  it("★★ hands the photos step the job's request, so a shot can show a product the merchant sent (B16)", async () => {
    // ★ The plan names the merchant's own products by their request key
    //   ("p1"); only the request resolves that key to the product's photo.
    const sent = {
      ...REQUEST,
      products: [{ key: "p1", name: "Boot", photoUrl: "https://x/boot.webp" }],
    } as unknown as RevampRequest;
    const jobs = makeJobs(jobAt("photos", { request: sent }));
    const deps = makeDeps([]);
    expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
      "ready",
    );
    expect(deps.photos).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ request: sent }),
    );
  });

  it.each(REVAMP_STEPS.map((step) => [step]))(
    "resumes at %s without redoing an earlier step",
    async (step) => {
      const order: string[] = [];
      const jobs = makeJobs(jobAt(step));
      const deps = makeDeps(order);
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      const expected = REVAMP_STEPS.slice(REVAMP_STEPS.indexOf(step));
      expect(order).toEqual(expected);
    },
  );

  it("goes back to the step that makes a missing input", async () => {
    const order: string[] = [];
    const jobs = makeJobs(jobAt("photos", { snapshot: null }));
    const deps = makeDeps(order);
    expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
      "ready",
    );
    expect(order.slice(0, 3)).toEqual(["snapshot", "plan", "compile"]);
  });

  it("repairs twice, saving each repair, then finalizes", async () => {
    const order: string[] = [];
    const jobs = makeJobs(makeJob());
    const deps = makeDeps(order, {
      compile: vi.fn(() => ({ plan: null, issues: ["broken"] })),
    });
    await runRevampJob({ revampId: ID, deps, jobs });
    expect(deps.repair).toHaveBeenCalledTimes(2);
    expect(deps.repair).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ raw: { draft: 2 }, issues: ["broken"] }),
    );
    expect(deps.finalize).toHaveBeenCalledWith(
      { draft: 2 },
      expect.objectContaining({ request: REQUEST, snapshot: SNAPSHOT }),
    );
    // plan, then two compile checkpoints, then the compiled plan.
    expect(savedSteps(jobs).slice(0, 5)).toEqual([
      "plan",
      "compile",
      "compile",
      "compile",
      "photos",
    ]);
    expect(saveInput(jobs, 2).patch.plan).toMatchObject({
      stage: "raw",
      repairs: 1,
    });
    expect(saveInput(jobs, 3).patch.plan).toMatchObject({
      stage: "raw",
      repairs: 2,
    });
    expect(saveInput(jobs, 4).patch.plan).toEqual({
      stage: "compiled",
      plan: FINAL,
      productPhotoKeys: ["p1"],
    });
  });

  it("★ leaves a trace of every compile repair: which one, how many issues, the first few, bounded", async () => {
    const issues = Array.from(
      { length: 12 },
      (_, index) =>
        `Issue ${index + 1}: ${"the heading is too long ".repeat(20)}`,
    );
    const deps = makeDeps([], {
      compile: vi.fn(() => ({ plan: null, issues })),
    });
    await runRevampJob({ revampId: ID, deps, jobs: makeJobs(makeJob()) });
    const repairs = log.info.mock.calls.filter(
      ([message]) => message === "mink.revamp: compile repair",
    );
    expect(repairs.map(([, context]) => context.repair)).toEqual([1, 2]);
    const first = repairs[0][1];
    expect(first).toMatchObject({ revampId: ID, repair: 1, issueCount: 12 });
    expect(first.issues).toHaveLength(5);
    expect(first.issues[0].startsWith("Issue 1:")).toBe(true);
    for (const issue of first.issues) {
      expect(issue.length).toBeLessThanOrEqual(200);
    }
    // ★ And what the mechanical finaliser was left to drop.
    const finalized = log.info.mock.calls.find(
      ([message]) => message === "mink.revamp: compile finalized",
    );
    expect(finalized?.[1]).toMatchObject({
      revampId: ID,
      repairs: 2,
      issueCount: 12,
    });
    expect(finalized?.[1].issues).toHaveLength(5);
  });

  it("stops repairing once the plan compiles, and resumes a repair count", async () => {
    const deps = makeDeps([], {
      compile: vi
        .fn()
        .mockReturnValueOnce({ plan: null, issues: ["x"] })
        .mockReturnValue({ plan: PLAN, issues: [] }),
    });
    await runRevampJob({ revampId: ID, deps, jobs: makeJobs(makeJob()) });
    expect(deps.repair).toHaveBeenCalledTimes(1);
    expect(deps.finalize).not.toHaveBeenCalled();

    const resumed = makeDeps([], {
      compile: vi.fn(() => ({ plan: null, issues: ["x"] })),
    });
    const job = jobAt("compile", {
      plan: { stage: "raw", raw: { draft: 9 }, repairs: 2, issues: [] },
    });
    await runRevampJob({ revampId: ID, deps: resumed, jobs: makeJobs(job) });
    expect(resumed.repair).not.toHaveBeenCalled();
    expect(resumed.finalize).toHaveBeenCalledWith(
      { draft: 9 },
      expect.anything(),
    );
  });

  describe("★★ a repair the model cannot answer never stops the redesign (L2-B)", () => {
    // The live run's failure: one empty accordion, a first repair that did
    // not fix it, then the second repair timing out on every claim.
    const ISSUES = [
      'Page "size-guide" section 2 (accordion): Add at least one row.',
    ];
    const BUSY = () =>
      new RevampStepError(
        "model_unavailable",
        "The design model is busy or did not answer in time.",
        true,
      );
    const atRepairTwo = (over: Partial<RevampPlanColumn> = {}) =>
      jobAt("compile", {
        plan: {
          stage: "raw",
          raw: { draft: 1 },
          repairs: 1,
          issues: ISSUES,
          ...over,
        } as RevampPlanColumn,
      });

    it("★★ finalises from the last answer when a repair call fails, in the same run", async () => {
      const jobs = makeJobs(atRepairTwo());
      const deps = makeDeps([], {
        compile: vi.fn(() => ({ plan: null, issues: ISSUES })),
        repair: vi.fn(async () => {
          throw BUSY();
        }),
      });
      expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
        outcome: "ready",
      });
      expect(deps.repair).toHaveBeenCalledTimes(1);
      expect(deps.finalize).toHaveBeenCalledWith(
        { draft: 1 },
        expect.objectContaining({ request: REQUEST, snapshot: SNAPSHOT }),
      );
      // ★ The failed repair is recorded before the plan is used...
      expect(saveInput(jobs, 0)).toMatchObject({
        step: "compile",
        patch: {
          plan: {
            stage: "raw",
            raw: { draft: 1 },
            repairs: 1,
            issues: ISSUES,
            repairFailed: true,
          },
        },
      });
      // ...then the finalised plan is saved, with no hand-over and no wait.
      expect(saveInput(jobs, 1)).toMatchObject({
        step: "photos",
        patch: { plan: { stage: "compiled", plan: FINAL } },
      });
      expect(jobs.release).not.toHaveBeenCalled();
      expect(jobs.fail).not.toHaveBeenCalled();
      const finalized = log.info.mock.calls.find(
        ([message]) =>
          message === "mink.revamp: compile repair failed, finalized instead",
      );
      expect(finalized?.[1]).toMatchObject({
        revampId: ID,
        repairs: 1,
        issueCount: 1,
      });
    });

    it("★★ a step claimed again after its repair failed finalises at once and asks nothing", async () => {
      const jobs = makeJobs(atRepairTwo({ repairFailed: true }));
      const deps = makeDeps([], {
        compile: vi.fn(() => ({ plan: null, issues: ISSUES })),
      });
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      expect(deps.repair).not.toHaveBeenCalled();
      expect(deps.finalize).toHaveBeenCalledWith(
        { draft: 1 },
        expect.anything(),
      );
      expect(log.info).toHaveBeenCalledWith(
        "mink.revamp: compile finalized",
        expect.objectContaining({ repairs: 1, repairFailed: true }),
      );
    });

    it.each([
      ["a refusal", new RevampStepError("model_refused", "declined", false)],
      [
        "a configuration fault",
        new RevampStepError("model_unavailable", "configuration", false),
      ],
      ["an error of no known kind", new Error("socket hang up")],
    ])("treats %s of a repair the same way", async (_label, failure) => {
      const jobs = makeJobs(atRepairTwo());
      const deps = makeDeps([], {
        compile: vi.fn(() => ({ plan: null, issues: ISSUES })),
        repair: vi.fn(async () => {
          throw failure;
        }),
      });
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      expect(deps.finalize).toHaveBeenCalledWith(
        { draft: 1 },
        expect.anything(),
      );
      expect(jobs.fail).not.toHaveBeenCalled();
    });

    it("★ an unreadable repair answer keeps the last answer and finalises from it", async () => {
      const jobs = makeJobs(makeJob());
      const deps = makeDeps([], {
        compile: vi.fn(() => ({ plan: null, issues: ISSUES })),
        repair: vi.fn(async () => ({
          raw: null,
          usage: usage({ inputTokens: 10 }),
        })),
      });
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      expect(deps.repair).toHaveBeenCalledTimes(1);
      expect(deps.finalize).toHaveBeenCalledWith(
        { draft: 1 },
        expect.anything(),
      );
      expect(saveInput(jobs, 2).patch.plan).toEqual({
        stage: "raw",
        raw: { draft: 1 },
        repairs: 1,
        issues: ISSUES,
        repairFailed: true,
      });
      // The unreadable answer was paid for, so it is counted.
      expect(saveInput(jobs, 2).patch.usage.inputTokens).toBe(110);
    });

    it("★ with nothing the finaliser can use, the repair is waited for as before", async () => {
      const unusable = () => {
        throw new RevampStepError("plan_invalid", "no pages", false);
      };
      for (const raw of [null, { pages: [] }]) {
        const jobs = makeJobs(
          jobAt("compile", {
            plan: { stage: "raw", raw, repairs: 0, issues: [] },
          }),
        );
        const deps = makeDeps([], {
          compile: vi.fn(() => ({ plan: null, issues: ["no homepage"] })),
          finalize: vi.fn(unusable),
          repair: vi.fn(async () => {
            throw BUSY();
          }),
        });
        expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
          outcome: "handover",
        });
        // ★ A busy model is a wait on Google: parked, not counted (B8).
        expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, {
          retryAfterMs: REVAMP_RETRY_AFTER_MS,
          counted: false,
        });
        // ★ Nothing recorded: the next claim must still ask the model.
        expect(jobs.save).not.toHaveBeenCalled();
        expect(jobs.fail).not.toHaveBeenCalled();
      }
    });

    it("★ a repair the drain never sent is handed over, not finalised (jobs-4)", async () => {
      vi.useFakeTimers();
      const jobs = makeJobs(atRepairTwo());
      const deps = makeDeps([], {
        compile: vi.fn(() => ({ plan: null, issues: ISSUES })),
        repair: vi.fn(
          (ctx: RevampStepContext) =>
            new Promise<never>((_, reject) => {
              ctx.draining?.addEventListener(
                "abort",
                () => reject(new RevampDrainedError()),
                { once: true },
              );
            }),
        ),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await run).toEqual({ outcome: "handover" });
      expect(deps.finalize).not.toHaveBeenCalled();
      expect(jobs.save).not.toHaveBeenCalled();
      expect(jobs.kick).toHaveBeenCalledWith(ID);
    });

    it("★ a repair that fails during the drain is still finalised: no paid call starts", async () => {
      vi.useFakeTimers();
      const jobs = makeJobs(atRepairTwo());
      const deps = makeDeps([], {
        compile: vi.fn(() => ({ plan: null, issues: ISSUES })),
        repair: vi.fn(
          (ctx: RevampStepContext) =>
            new Promise<never>((_, reject) => {
              // Sent before the deadline; the provider gives up during it.
              ctx.draining?.addEventListener(
                "abort",
                () => setTimeout(() => reject(BUSY()), 1_000),
                { once: true },
              );
            }),
        ),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await run).toEqual({ outcome: "handover" });
      expect(deps.finalize).toHaveBeenCalledTimes(1);
      // The compiled plan is kept; the next step is the next run's.
      expect(savedSteps(jobs)).toEqual(["compile", "photos"]);
      expect(deps.photos).not.toHaveBeenCalled();
    });

    describe("the plan step (L2-B)", () => {
      it("★★ asks the planner again in the same run when the first call is busy", async () => {
        const jobs = makeJobs(makeJob());
        const deps = makeDeps([], {
          plan: vi
            .fn()
            .mockRejectedValueOnce(BUSY())
            .mockResolvedValue({
              raw: { draft: 1 },
              usage: usage({ inputTokens: 100 }),
            }),
        });
        expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
          outcome: "ready",
        });
        expect(deps.plan).toHaveBeenCalledTimes(2);
        // ★ No minute's park and no claim spent on the busy answer.
        expect(jobs.release).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith(
          "mink.revamp: plan call failed, asking again in this run",
          expect.objectContaining({ revampId: ID, call: 1 }),
        );
      });

      it("asks only once more, then parks the job as before", async () => {
        const jobs = makeJobs(jobAt("plan"));
        const deps = makeDeps([], {
          plan: vi.fn(async () => {
            throw BUSY();
          }),
        });
        expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
          outcome: "handover",
        });
        expect(deps.plan).toHaveBeenCalledTimes(2);
        expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, {
          retryAfterMs: REVAMP_RETRY_AFTER_MS,
          counted: false,
        });
      });

      it("★ never asks again without time for a whole call before the deadline", async () => {
        const jobs = makeJobs(jobAt("plan"));
        const deps = makeDeps([], {
          plan: vi.fn(async () => {
            throw BUSY();
          }),
        });
        await runRevampJob({
          revampId: ID,
          deps,
          jobs,
          deadlineMs: REVAMP_PLAN_RETRY_MIN_LEFT_MS - 1,
        });
        expect(deps.plan).toHaveBeenCalledTimes(1);
        expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, {
          retryAfterMs: REVAMP_RETRY_AFTER_MS,
          counted: false,
        });
      });

      it("never asks again once the deadline drains the step", async () => {
        vi.useFakeTimers();
        const jobs = makeJobs(jobAt("plan"));
        const deps = makeDeps([], {
          plan: vi
            .fn()
            .mockImplementationOnce(
              (ctx: RevampStepContext) =>
                new Promise<never>((_, reject) => {
                  ctx.draining?.addEventListener(
                    "abort",
                    () => setTimeout(() => reject(BUSY()), 1_000),
                    { once: true },
                  );
                }),
            )
            .mockRejectedValue(BUSY()),
        });
        // ★ A clock that says there is time left, so the drain alone decides.
        const run = runRevampJob({
          revampId: ID,
          deps,
          jobs,
          deadlineMs: 10 * 60_000,
          now: () => 1_000_000,
        });
        await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
        expect((await run).outcome).toBe("handover");
        expect(deps.plan).toHaveBeenCalledTimes(1);
      });

      it.each([
        ["a refusal", new RevampStepError("model_refused", "declined", false)],
        [
          "a configuration fault",
          new RevampStepError("model_unavailable", "configuration", false),
        ],
        ["an error of no known kind", new Error("TypeError in the planner")],
      ])("never asks again after %s", async (_label, failure) => {
        const jobs = makeJobs(jobAt("plan"));
        const deps = makeDeps([], {
          plan: vi.fn(async () => {
            throw failure;
          }),
        });
        await runRevampJob({ revampId: ID, deps, jobs });
        expect(deps.plan).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("fits the budget only when the job has one", async () => {
    const free = makeDeps([]);
    const freeJobs = makeJobs(makeJob());
    await runRevampJob({ revampId: ID, deps: free, jobs: freeJobs });
    expect(free.fitBudget).not.toHaveBeenCalled();
    expect(free.products).toHaveBeenCalledWith(expect.anything(), {
      request: REQUEST,
      stored: expect.any(Array),
      only: ["p1"],
      inherited: [],
      carried: [],
      onUsage: expect.any(Function),
    });

    const paid = makeDeps([]);
    const paidJobs = makeJobs(makeJob({ budgetCredits: 50 }));
    await runRevampJob({ revampId: ID, deps: paid, jobs: paidJobs });
    expect(paid.fitBudget).toHaveBeenCalledWith(PLAN, {
      request: REQUEST,
      budget: 50,
    });
    // ★ The plan before the fit is kept too, so a balance that falls before
    //   the photos are drawn is re-fitted from it, never from the cut plan.
    expect(saveInput(paidJobs, 2).patch.plan).toEqual({
      stage: "compiled",
      plan: FITTED,
      productPhotoKeys: ["p1"],
      unfitted: PLAN,
    });
    expect(paid.photos).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ plan: FITTED }),
    );
    expect(paid.products).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ only: ["p1"] }),
    );
  });

  it("★★ hands the product photos one backdrop: the redesign's page colour, else the theme's", async () => {
    // ★ One staging for the whole shop: every studio photo is asked for on
    //   the same colour, the one the redesigned pages will show.
    const designed = {
      ...PLAN,
      design: { palette: { cream: "#f5efe6" }, fonts: {}, shape: {} },
    } as unknown as RevampSitePlan;
    const withDesign = makeDeps([]);
    await runRevampJob({
      revampId: ID,
      deps: withDesign,
      jobs: makeJobs(
        jobAt("products", {
          plan: { stage: "compiled", plan: designed, productPhotoKeys: null },
        }),
      ),
    });
    expect(withDesign.products).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ backdrop: "#f5efe6" }),
    );

    const themed = makeDeps([]);
    await runRevampJob({
      revampId: ID,
      deps: themed,
      jobs: makeJobs(
        jobAt("products", {
          snapshot: {
            storeId: STORE,
            theme: { palette: { page: "#ffffff" } },
          } as unknown as RevampSnapshot,
        }),
      ),
    });
    expect(themed.products).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ backdrop: "#ffffff" }),
    );
  });

  it.each([
    ["a Builder-only requester", ACTOR, false],
    [
      "a requester with Branding manage",
      {
        ...ACTOR,
        permissions: { builder: ["view", "manage"], branding: ["manage"] },
      } as unknown as MinkActorContext,
      true,
    ],
    [
      "a superadmin",
      { ...ACTOR, permissions: {}, isSuperadmin: true } as MinkActorContext,
      true,
    ],
  ])(
    "★★ tells assemble whether %s may change the tagline (f-3)",
    async (_label, actor, canChangeBrand) => {
      // ★ Apply refuses the whole card when its plan writes the tagline for a
      //   requester without Branding manage, so assembly must know.
      const deps = makeDeps([]);
      const jobs = makeJobs(jobAt("assemble"), {
        rebuildActor: vi.fn(async () => actor),
      });
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      expect(deps.assemble).toHaveBeenCalledWith(
        expect.objectContaining({ canChangeBrand }),
      );
    },
  );

  it("skips product photos when the budget leaves none to take", async () => {
    const deps = makeDeps([], {
      fitBudget: vi.fn(() => ({ plan: FITTED, productPhotoKeys: [] })),
    });
    const jobs = makeJobs(makeJob({ budgetCredits: 5 }));
    expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
      "ready",
    );
    expect(deps.products).not.toHaveBeenCalled();
    const save = saveInput(jobs, 4);
    expect(save.step).toBe("assemble");
    expect(save.progress.find((p) => p.step === "products")?.state).toBe(
      "skipped",
    );
    expect(save.patch.result).toMatchObject({ products: { failed: [] } });
  });

  describe("★★ a redesign takes only the product photos it can use (f-5)", () => {
    it("names the products of a revamp with no budget, so one the store has is never photographed", async () => {
      // ★ Null keys photographed every request product, a product the store
      //   already has included, whose photo then shows nowhere.
      const two = {
        ...REQUEST,
        products: [
          ...REQUEST.products,
          { key: "p2", name: "Sandal", photoUrl: "https://x/p2.webp" },
        ],
      } as unknown as RevampRequest;
      const deps = makeDeps([], { productPhotoKeys: vi.fn(() => ["p2"]) });
      const jobs = makeJobs(makeJob({ request: two }));
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      expect(deps.fitBudget).not.toHaveBeenCalled();
      expect(deps.productPhotoKeys).toHaveBeenCalledWith(PLAN, two);
      expect(saveInput(jobs, 2).patch.plan).toEqual({
        stage: "compiled",
        plan: PLAN,
        productPhotoKeys: ["p2"],
      });
      expect(deps.products).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ only: ["p2"] }),
      );
    });

    it("skips the studio photos of a free revamp when every product is one the store has", async () => {
      const deps = makeDeps([], { productPhotoKeys: vi.fn(() => []) });
      const jobs = makeJobs(makeJob({ free: true }));
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      expect(deps.products).not.toHaveBeenCalled();
      const save = saveInput(jobs, 4);
      expect(save.step).toBe("assemble");
      expect(save.progress.find((p) => p.step === "products")?.state).toBe(
        "skipped",
      );
    });

    it("finds the products again for a plan saved before they were named", async () => {
      const deps = makeDeps([], { productPhotoKeys: vi.fn(() => []) });
      const jobs = makeJobs(jobAt("products"));
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      expect(deps.productPhotoKeys).toHaveBeenCalledWith(PLAN, REQUEST);
      expect(deps.products).not.toHaveBeenCalled();
    });

    const REFINE = {
      ...REQUEST,
      kind: "refine",
      refineScope: { products: false },
    } as unknown as RevampRequest;
    const PARENT_IMAGES = [
      { role: "product", slotId: "p1" },
      { role: "slot", slotId: "hero" },
    ] as unknown as RevampStoredImage[];

    it("★★ hands a refinement its parent's photos and the products it carries over", async () => {
      // ★ The parent drew these and the card charges nothing for them, so
      //   drawing them again is a photograph StoreMink pays for twice.
      const jobs = makeJobs(
        jobAt("products", {
          kind: "refine",
          parentId: PARENT,
          request: REFINE,
        }),
        {
          listImages: vi.fn(async (revampId: string) =>
            revampId === PARENT ? PARENT_IMAGES : [],
          ),
        },
      );
      const deps = makeDeps([], {
        carriedProductPhotoKeys: vi.fn(() => ["p1"]),
      });
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      expect(deps.carriedProductPhotoKeys).toHaveBeenCalledWith(PLAN, REFINE);
      expect(jobs.listImages).toHaveBeenCalledWith(PARENT, STORE);
      expect(deps.products).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          only: ["p1"],
          inherited: PARENT_IMAGES,
          carried: ["p1"],
        }),
      );
    });

    it("reads no parent photo when a refinement carries no product, and a full revamp carries none", async () => {
      const refineJobs = makeJobs(
        jobAt("products", {
          kind: "refine",
          parentId: PARENT,
          request: REFINE,
        }),
      );
      const refine = makeDeps([]);
      await runRevampJob({ revampId: ID, deps: refine, jobs: refineJobs });
      expect(refineJobs.listImages).not.toHaveBeenCalledWith(PARENT, STORE);
      expect(refine.products).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ inherited: [], carried: [] }),
      );

      const fullJobs = makeJobs(jobAt("products"));
      const full = makeDeps([]);
      await runRevampJob({ revampId: ID, deps: full, jobs: fullJobs });
      expect(full.carriedProductPhotoKeys).not.toHaveBeenCalled();
      expect(full.products).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ inherited: [], carried: [] }),
      );
    });
  });

  describe("★★ a refinement carries what older versions made, not only its parent's (R-1)", () => {
    // The full redesign asked for the boot and photographed it; it was
    // applied, so the first refinement carried nothing of it; then it was
    // undone, and the boot came back into the next refinement's carry.
    const GRAND = "66666666-6666-4666-8666-666666666666";
    const BOOT = { key: "p1", name: "Boot", photoUrl: "https://x/p1.webp" };
    const REFINE = {
      ...REQUEST,
      kind: "refine",
      refineScope: { products: false },
      products: [BOOT],
    } as unknown as RevampRequest;
    const HERO = { id: "hero", subject: "The workshop", aspectRatio: "21:9" };
    const ABOUT = { id: "about", subject: "Hands at work", aspectRatio: "4:5" };
    /** A refinement's compiled plan that keeps `shots` and carries `products` from its parent. */
    const refinedPlan = (products: string[], shots: string[]) =>
      ({
        summary: "refined",
        shots: [HERO, ABOUT],
        basis: {
          categories: 0,
          productKeys: ["p1"],
          existingProductKeys: [],
          carried: {
            pages: [],
            shots,
            design: true,
            chrome: true,
            categories: 0,
            products,
          },
        },
      }) as unknown as RevampSitePlan;
    const image = (role: string, slotId: string, url = `${slotId}.webp`) =>
      ({ role, slotId, url }) as unknown as RevampStoredImage;

    function chain(
      job: RevampJobRow,
      grand: Partial<RevampJobRow> = {},
      parent: Partial<RevampJobRow> = {},
    ) {
      const rows: Record<string, RevampJobRow> = {
        [PARENT]: makeJob({
          id: PARENT,
          parentId: GRAND,
          kind: "refine",
          request: { ...REQUEST, products: [] } as unknown as RevampRequest,
          plan: {
            stage: "compiled",
            plan: refinedPlan([], ["hero"]),
            productPhotoKeys: [],
          },
          ...parent,
        }),
        [GRAND]: makeJob({
          id: GRAND,
          parentId: null,
          request: { ...REQUEST, products: [BOOT] } as unknown as RevampRequest,
          plan: {
            stage: "compiled",
            plan: { shots: [HERO, { ...ABOUT, subject: "Old" }] } as never,
            productPhotoKeys: ["p1"],
          },
          ...grand,
        }),
      };
      const images: Record<string, RevampStoredImage[]> = {
        [PARENT]: [image("slot", "about")],
        [GRAND]: [
          image("product", "p1", "grand-boot.webp"),
          image("product", "p9"),
          image("slot", "hero", "grand-hero.webp"),
          image("slot", "about", "grand-about.webp"),
          image("anchor", "anchor"),
        ],
      };
      return makeJobs(job, {
        read: vi.fn(async (id: string) => rows[id] ?? null),
        listImages: vi.fn(async (id: string) => images[id] ?? []),
      });
    }
    const refinement = (step: RevampStep, over: Partial<RevampJobRow> = {}) =>
      jobAt(step, {
        kind: "refine",
        parentId: PARENT,
        request: REFINE,
        ...over,
      });
    const carriedByBasis = vi.fn(
      (p: RevampSitePlan) => p.basis?.carried?.products ?? [],
    );

    it("★★ counts the older version's product as carried, so its photo is taken over and never charged", async () => {
      const jobs = chain(
        refinement("compile", {
          plan: { stage: "raw", raw: { draft: 1 }, repairs: 0, issues: [] },
        }),
      );
      const deps = makeDeps([], {
        compile: vi.fn(() => ({
          plan: refinedPlan([], ["hero", "about"]),
          issues: [],
        })),
        carriedProductPhotoKeys: carriedByBasis,
      });
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      // ★ The basis the charge, the fit and the carry-over all read.
      const compiled = saveInput(jobs, 0).patch.plan as Extract<
        RevampPlanColumn,
        { stage: "compiled" }
      >;
      expect(compiled.plan.basis?.carried?.products).toEqual(["p1"]);
      expect(deps.productPhotoKeys).toHaveBeenCalledWith(compiled.plan, REFINE);
      expect(deps.products).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          carried: ["p1"],
          // The parent's photos first, whole; then only the boot's studio photo.
          inherited: [
            image("slot", "about"),
            image("product", "p1", "grand-boot.webp"),
          ],
        }),
      );
      // ★ The shot this plan keeps, as the older version took it; never a
      //   shot of the same id it described differently.
      expect(deps.photos).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          inherited: [
            image("slot", "about"),
            image("slot", "hero", "grand-hero.webp"),
          ],
        }),
      );
    });

    it("★ never takes a photo of another product that once had the same key", async () => {
      const jobs = chain(refinement("products"), {
        request: {
          ...REQUEST,
          products: [{ ...BOOT, name: "Belt" }],
        } as unknown as RevampRequest,
      });
      const deps = makeDeps([], {
        carriedProductPhotoKeys: vi.fn(() => ["p1"]),
      });
      await runRevampJob({ revampId: ID, deps, jobs });
      expect(deps.products).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ inherited: [image("slot", "about")] }),
      );

      // Nor a photo of the same product made from another photo of it.
      const rephotographed = chain(refinement("products"), {
        request: {
          ...REQUEST,
          products: [{ ...BOOT, photoUrl: "https://x/p1-old.webp" }],
        } as unknown as RevampRequest,
      });
      const again = makeDeps([], {
        carriedProductPhotoKeys: vi.fn(() => ["p1"]),
      });
      await runRevampJob({ revampId: ID, deps: again, jobs: rephotographed });
      expect(again.products).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ inherited: [image("slot", "about")] }),
      );
    });

    it("★ reads only this store's versions, each once, and stops at a loop", async () => {
      const foreign = chain(
        refinement("compile", {
          plan: { stage: "raw", raw: { draft: 1 }, repairs: 0, issues: [] },
        }),
        { storeId: "other-store" },
      );
      const deps = makeDeps([], {
        compile: vi.fn(() => ({ plan: refinedPlan([], ["hero"]), issues: [] })),
        carriedProductPhotoKeys: carriedByBasis,
      });
      await runRevampJob({ revampId: ID, deps, jobs: foreign });
      const compiled = saveInput(foreign, 0).patch.plan as Extract<
        RevampPlanColumn,
        { stage: "compiled" }
      >;
      expect(compiled.plan.basis?.carried?.products).toEqual([]);
      expect(foreign.listImages).not.toHaveBeenCalledWith(GRAND, STORE);

      // A parent pointing back at this revamp: read once, then the chain ends.
      const looped = chain(refinement("products"), {}, { parentId: ID });
      const loopDeps = makeDeps([], {
        carriedProductPhotoKeys: vi.fn(() => ["p1"]),
      });
      expect(
        (await runRevampJob({ revampId: ID, deps: loopDeps, jobs: looped }))
          .outcome,
      ).toBe("ready");
      expect(looped.read).toHaveBeenCalledTimes(1);
      expect(looped.read).toHaveBeenCalledWith(PARENT);
    });

    it("★ an older version that cannot be read only costs its photos", async () => {
      const jobs = chain(refinement("products"));
      const read = jobs.read;
      jobs.read = vi.fn(async (id: string) => {
        if (id === GRAND) throw new Error("connection terminated");
        return read(id);
      });
      const deps = makeDeps([], {
        carriedProductPhotoKeys: vi.fn(() => ["p1"]),
      });
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      expect(deps.products).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ inherited: [image("slot", "about")] }),
      );
    });
  });

  describe("★★ a paid redesign checks the store can still pay before any photo (f-4)", () => {
    const UNFITTED = plan("unfitted");
    const REFITTED = plan("refitted");
    /** The estimate port, by plan. */
    const totals = (byPlan: Map<RevampSitePlan, number>) =>
      vi.fn((p: RevampSitePlan) => credits(byPlan.get(p) ?? 0));
    const paidAtPhotos = (column: Partial<RevampPlanColumn> = {}) =>
      jobAt("photos", {
        budgetCredits: 40,
        plan: { ...COMPILED, productPhotoKeys: ["p1"], ...column },
      } as Partial<RevampJobRow>);

    it("goes on when the balance still covers the fitted plan", async () => {
      const deps = makeDeps([], {
        estimate: totals(new Map([[PLAN, 30]])),
        balance: vi.fn(async () => 30),
      });
      const jobs = makeJobs(paidAtPhotos());
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      expect(deps.balance).toHaveBeenCalledTimes(1);
      expect(deps.fitBudget).not.toHaveBeenCalled();
      expect(deps.photos).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ plan: PLAN }),
      );
    });

    it("★★ re-fits the plan before it was cut to what is left, and saves it before drawing", async () => {
      const deps = makeDeps([], {
        estimate: totals(
          new Map([
            [PLAN, 30],
            [REFITTED, 18],
          ]),
        ),
        balance: vi.fn(async () => 20),
        fitBudget: vi.fn(() => ({ plan: REFITTED, productPhotoKeys: [] })),
      });
      const jobs = makeJobs(paidAtPhotos({ unfitted: UNFITTED }));
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      expect(deps.fitBudget).toHaveBeenCalledTimes(1);
      expect(deps.fitBudget).toHaveBeenCalledWith(UNFITTED, {
        request: REQUEST,
        budget: 20,
      });
      // ★ Saved at once, still at the photos step, so a resumed run draws
      //   for the plan the store can pay for.
      expect(saveInput(jobs, 0)).toMatchObject({
        step: "photos",
        patch: {
          plan: {
            stage: "compiled",
            plan: REFITTED,
            productPhotoKeys: [],
            unfitted: UNFITTED,
          },
        },
      });
      expect(deps.photos).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ plan: REFITTED }),
      );
      // The products step follows the new plan's keys.
      expect(deps.products).not.toHaveBeenCalled();
    });

    it("re-fits a plan saved before the unfitted copy existed without counting its dropped products again", async () => {
      const deps = makeDeps([], {
        estimate: totals(
          new Map([
            [PLAN, 30],
            [REFITTED, 18],
          ]),
        ),
        balance: vi.fn(async () => 20),
        fitBudget: vi.fn(() => ({ plan: REFITTED, productPhotoKeys: [] })),
      });
      const request = {
        ...REQUEST,
        products: [
          { key: "p1", name: "Boot", photoUrl: "https://x/p1.webp" },
          { key: "p2", name: "Bag", photoUrl: "https://x/p2.webp" },
        ],
      } as unknown as RevampRequest;
      const jobs = makeJobs({ ...paidAtPhotos(), request });
      await runRevampJob({ revampId: ID, deps, jobs });
      const [planArg, input] = vi.mocked(deps.fitBudget).mock.calls[0];
      expect(planArg).toBe(PLAN);
      expect(input.budget).toBe(20);
      // ★ p2 was already left out by the first fit (keys ["p1"]): it is not
      //   offered to the re-fit again, or "Not done this time" counts it twice.
      expect(
        input.request.products.map((p) => [p.key, p.photoUrl ?? null]),
      ).toEqual([
        ["p1", "https://x/p1.webp"],
        ["p2", null],
      ]);
    });

    it("★★ fails before any photo when the balance no longer covers the fixed part", async () => {
      const deps = makeDeps([], {
        estimate: totals(
          new Map([
            [PLAN, 30],
            [REFITTED, 8],
          ]),
        ),
        balance: vi.fn(async () => 5),
        fitBudget: vi.fn(() => ({ plan: REFITTED, productPhotoKeys: [] })),
      });
      const jobs = makeJobs(paidAtPhotos({ unfitted: UNFITTED }));
      expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
        outcome: "failed",
      });
      expect(deps.photos).not.toHaveBeenCalled();
      expect(deps.products).not.toHaveBeenCalled();
      expect(deps.card).not.toHaveBeenCalled();
      expect(jobs.fail).toHaveBeenCalledWith(
        expect.objectContaining({ code: "out_of_credits" }),
      );
      // ★ Never a number of credits, even in the logged detail.
      const [failure] = vi.mocked(jobs.fail).mock.calls[0];
      expect(failure.detail).not.toMatch(/\d/);
      // Nothing was saved for a plan that will not be drawn.
      expect(jobs.save).not.toHaveBeenCalled();
    });

    it.each([
      ["a free redesign", { free: true, budgetCredits: null }],
      ["an unmetered plan", { budgetCredits: null }],
    ])("never reads the balance for %s", async (_label, over) => {
      const deps = makeDeps([]);
      const jobs = makeJobs(jobAt("photos", over as Partial<RevampJobRow>));
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      expect(deps.balance).not.toHaveBeenCalled();
      expect(deps.fitBudget).not.toHaveBeenCalled();
    });

    it("goes on when the plan became unmetered since the start", async () => {
      const deps = makeDeps([], {
        estimate: totals(new Map([[PLAN, 30]])),
        balance: vi.fn(async () => null),
      });
      const jobs = makeJobs(paidAtPhotos());
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      expect(deps.fitBudget).not.toHaveBeenCalled();
    });

    it("★ retries later when the balance cannot be read, drawing nothing", async () => {
      const deps = makeDeps([], {
        balance: vi.fn(async () => {
          throw new Error("db down");
        }),
      });
      const jobs = makeJobs(paidAtPhotos());
      expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
        outcome: "handover",
      });
      expect(deps.photos).not.toHaveBeenCalled();
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, {
        retryAfterMs: REVAMP_RETRY_AFTER_MS,
      });
    });

    it("★★ a card whose charge the balance refuses fails with the same code, never internal", async () => {
      const deps = makeDeps([], {
        card: vi.fn(async () => {
          throw new RevampOutOfCreditsError("insufficient credits");
        }),
      });
      const jobs = makeJobs(jobAt("card"));
      expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
        outcome: "failed",
      });
      expect(jobs.fail).toHaveBeenCalledWith(
        expect.objectContaining({ code: "out_of_credits" }),
      );
    });
  });

  it("gives a refinement the parent's plan and photos, and maps the redraw", async () => {
    const parentPlan = plan("parent");
    const job = makeJob({
      kind: "refine",
      parentId: PARENT,
      request: {
        ...REQUEST,
        kind: "refine",
        refineScope: { photos: "all" },
      } as unknown as RevampRequest,
    });
    const jobs = makeJobs(job, {
      read: vi.fn(async () =>
        makeJob({
          id: PARENT,
          plan: { stage: "compiled", plan: parentPlan, productPhotoKeys: null },
        }),
      ),
    });
    const deps = makeDeps([]);
    await runRevampJob({ revampId: ID, deps, jobs });
    expect(jobs.read).toHaveBeenCalledWith(PARENT);
    expect(deps.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ previous: parentPlan }),
    );
    expect(deps.photos).toHaveBeenCalledWith(expect.anything(), {
      plan: PLAN,
      snapshot: SNAPSHOT,
      stored: [{ slotId: "own" }],
      inherited: [{ slotId: "parent" }],
      redraw: ["hero", "about"],
      request: job.request,
      onUsage: expect.any(Function),
    });
  });

  it("never uses a parent from another store", async () => {
    const jobs = makeJobs(makeJob({ parentId: PARENT }), {
      read: vi.fn(async () =>
        makeJob({ id: PARENT, storeId: "other-store", plan: COMPILED }),
      ),
    });
    const deps = makeDeps([]);
    await runRevampJob({ revampId: ID, deps, jobs });
    expect(deps.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ previous: null }),
    );
  });

  it("hands over at the deadline and kicks the next invocation", async () => {
    vi.useFakeTimers();
    const jobs = makeJobs(jobAt("photos"));
    const deps = makeDeps([], {
      photos: vi.fn((ctx: RevampStepContext) => untilAborted(ctx)),
    });
    const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
    // ★ A step that ignores the drain is stopped once its grace runs out.
    await vi.advanceTimersByTimeAsync(5_000 + REVAMP_DEADLINE_GRACE_MS);
    expect(await run).toEqual({ outcome: "handover" });
    expect(jobs.release).toHaveBeenCalledWith(ID, LEASE);
    expect(jobs.kick).toHaveBeenCalledWith(ID);
    expect(jobs.fail).not.toHaveBeenCalled();
    expect(jobs.save).not.toHaveBeenCalled();
  });

  describe("★★ a hand-over that stored photos gives the step its crash budget back (jobs-5)", () => {
    const image = (slotId: string) =>
      ({ slotId }) as unknown as RevampStoredImage;
    /** The job's photo rows, which a step adds to as it stores photos. */
    function photoRows() {
      const rows = [image("own")];
      return {
        rows,
        listImages: vi.fn(async (revampId: string) =>
          revampId === ID ? [...rows] : [],
        ),
      };
    }
    const untilDraining = (ctx: RevampStepContext) =>
      new Promise<void>((resolve) => {
        if (ctx.draining?.aborted) return resolve();
        ctx.draining?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });

    it("★★ hands over as progress when the photos step stored photos this invocation", async () => {
      vi.useFakeTimers();
      const photos = photoRows();
      const jobs = makeJobs(jobAt("photos"), { listImages: photos.listImages });
      const deps = makeDeps([], {
        photos: vi.fn(async (ctx: RevampStepContext) => {
          photos.rows.push(image("hero"));
          await untilDraining(ctx);
          throw new RevampDrainedError();
        }),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await run).toEqual({ outcome: "handover" });
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, {
        progressed: true,
      });
      expect(jobs.kick).toHaveBeenCalledWith(ID);
    });

    it("★ studio photos count too: the products step's hand-over", async () => {
      vi.useFakeTimers();
      const photos = photoRows();
      const jobs = makeJobs(jobAt("products"), {
        listImages: photos.listImages,
      });
      const deps = makeDeps([], {
        products: vi.fn(async (ctx: RevampStepContext) => {
          photos.rows.push(image("p1"));
          await untilDraining(ctx);
          throw new RevampDrainedError();
        }),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await run).toEqual({ outcome: "handover" });
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, {
        progressed: true,
      });
    });

    it("★ a step that stored nothing before the deadline still has the claim counted", async () => {
      vi.useFakeTimers();
      const photos = photoRows();
      const jobs = makeJobs(jobAt("photos"), { listImages: photos.listImages });
      const deps = makeDeps([], {
        photos: vi.fn(async (ctx: RevampStepContext) => {
          await untilDraining(ctx);
          throw new RevampDrainedError();
        }),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await run).toEqual({ outcome: "handover" });
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE);
    });

    it("★ the hard stop after the grace still counts what the step stored", async () => {
      vi.useFakeTimers();
      const photos = photoRows();
      const jobs = makeJobs(jobAt("photos"), { listImages: photos.listImages });
      const deps = makeDeps([], {
        photos: vi.fn((ctx: RevampStepContext) => {
          photos.rows.push(image("hero"));
          return untilAborted(ctx);
        }),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000 + REVAMP_DEADLINE_GRACE_MS);
      expect(await run).toEqual({ outcome: "handover" });
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, {
        progressed: true,
      });
    });

    it("a hand-over after the step finished and was saved is the next step's", async () => {
      vi.useFakeTimers();
      const photos = photoRows();
      const jobs = makeJobs(jobAt("photos"), { listImages: photos.listImages });
      const deps = makeDeps([], {
        photos: vi.fn(async (ctx: RevampStepContext) => {
          photos.rows.push(image("hero"));
          await untilDraining(ctx);
          return { images: [], outcomes: [OUTCOME], usage: usage({}) };
        }),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await run).toEqual({ outcome: "handover" });
      // ★ Saving the next step restarted its count at none (jobs.ts), and a
      //   hand-over between two steps counts nothing (B8).
      expect(savedSteps(jobs)).toEqual(["products"]);
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE);
    });

    it("★ a progress read that fails is not progress, and still hands over", async () => {
      vi.useFakeTimers();
      const photos = photoRows();
      // The step's own read answers; the hand-over's does not.
      let reads = 0;
      const listImages = vi.fn(async (revampId: string) => {
        reads += 1;
        if (reads > 1) throw new Error("connection terminated");
        return photos.listImages(revampId);
      });
      const jobs = makeJobs(jobAt("photos"), { listImages });
      const deps = makeDeps([], {
        photos: vi.fn(async (ctx: RevampStepContext) => {
          photos.rows.push(image("hero"));
          await untilDraining(ctx);
          throw new RevampDrainedError();
        }),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await run).toEqual({ outcome: "handover" });
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE);
      expect(jobs.kick).toHaveBeenCalledWith(ID);
    });

    it("never gives the budget back on a transient failure, whatever was stored", async () => {
      const photos = photoRows();
      const jobs = makeJobs(jobAt("photos"), { listImages: photos.listImages });
      const deps = makeDeps([], {
        photos: vi.fn(async () => {
          photos.rows.push(image("hero"));
          throw new RevampStepError("photos_unavailable", "busy", true);
        }),
      });
      expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
        outcome: "handover",
      });
      // Parked and not counted (a wait on Google, B8), never reset either.
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, {
        retryAfterMs: REVAMP_RETRY_AFTER_MS,
        counted: false,
      });
    });
  });

  describe("★★ waiting on Google is not failing (B8)", () => {
    const untilDrain = (ctx: RevampStepContext) =>
      new Promise<void>((resolve) => {
        if (ctx.draining?.aborted) return resolve();
        ctx.draining?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });

    it.each([
      [
        "a busy planner",
        () => new RevampStepError("model_unavailable", "busy", true),
        REVAMP_RETRY_AFTER_MS,
      ],
      [
        "a held or refused shoot",
        () => new RevampStepError("photos_unavailable", "held", true),
        REVAMP_RETRY_AFTER_MS,
      ],
      [
        "the platform's photo hour",
        () =>
          new RevampRetryLaterError(
            "photos_unavailable",
            "the hour is full",
            15 * 60_000,
          ),
        15 * 60_000,
      ],
      // ★ The class decides, not the code: a step that names its own wait
      //   is waiting on a window shared with other stores.
      [
        "a step that names its own wait, whatever its code",
        () =>
          new RevampRetryLaterError("internal", "a shared window", 5 * 60_000),
        5 * 60_000,
      ],
    ])(
      "★★ eight hand-overs in a row for %s never count",
      async (_label, error, wait) => {
        for (let claim = 0; claim < 8; claim += 1) {
          const jobs = makeJobs(jobAt("photos", { attempts: 0 }));
          const deps = makeDeps([], {
            photos: vi.fn(async () => {
              throw error();
            }),
          });
          expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
            outcome: "handover",
          });
          expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, {
            retryAfterMs: wait,
            counted: false,
          });
          expect(jobs.fail).not.toHaveBeenCalled();
        }
        expect(log.warn).toHaveBeenCalledWith(
          "mink.revamp: step will be retried",
          expect.objectContaining({ revampId: ID, counted: false }),
        );
      },
    );

    it("★ a transient error that is not Google's still counts", async () => {
      const jobs = makeJobs(jobAt("products"));
      const deps = makeDeps([], {
        products: vi.fn(async () => {
          throw new RevampStepError("model_unavailable", "busy", false);
        }),
      });
      // Not transient: a verdict, failed at once, as before.
      expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
        outcome: "failed",
      });
      const counted = makeJobs(jobAt("products"));
      await runRevampJob({
        revampId: ID,
        jobs: counted,
        deps: makeDeps([], {
          products: vi.fn(async () => {
            throw new RevampStepError("store_changed", "moved", true);
          }),
        }),
      });
      // No `counted` key: jobs.ts counts a parked release by default.
      expect(counted.release).toHaveBeenCalledWith(ID, LEASE, {
        retryAfterMs: REVAMP_RETRY_AFTER_MS,
      });
    });

    it("★★ a shoot that can never finish fails the job at once as photos_failed, as photos_unavailable's final verdict did", async () => {
      const detail =
        "1 of 1 photographs could not be drawn or cropped from the shoot.";
      const jobs = makeJobs(jobAt("photos"));
      const deps = makeDeps([], {
        photos: vi.fn(async () => {
          throw new RevampStepError("photos_failed", detail, false);
        }),
      });
      expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
        outcome: "failed",
      });
      expect(jobs.fail).toHaveBeenCalledWith({
        revampId: ID,
        leaseToken: LEASE,
        code: "photos_failed",
        detail,
      });
      // ★ Not a wait on Google: never parked for another claim.
      expect(jobs.release).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        "mink.revamp: step failed",
        expect.objectContaining({
          revampId: ID,
          step: "photos",
          code: "photos_failed",
        }),
      );
    });

    it("★★ a deadline that catches a step waiting on Google counts nothing", async () => {
      vi.useFakeTimers();
      const jobs = makeJobs(jobAt("plan"));
      const deps = makeDeps([], {
        plan: vi.fn((ctx: RevampStepContext) => untilAborted(ctx)),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000 + REVAMP_DEADLINE_GRACE_MS);
      expect(await run).toEqual({ outcome: "handover" });
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE);
      expect(log.info).toHaveBeenCalledWith(
        "mink.revamp: handed over at the deadline",
        expect.objectContaining({ step: "plan", counted: false }),
      );
    });

    it("★★ a deadline that catches a step that calls no model counts it: it is stuck", async () => {
      vi.useFakeTimers();
      const jobs = makeJobs(jobAt("snapshot"));
      const deps = makeDeps([], {
        snapshot: vi.fn((ctx: RevampStepContext) => untilAborted(ctx)),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000 + REVAMP_DEADLINE_GRACE_MS);
      expect(await run).toEqual({ outcome: "handover" });
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, { counted: true });
      expect(log.info).toHaveBeenCalledWith(
        "mink.revamp: handed over at the deadline",
        expect.objectContaining({ step: "snapshot", counted: true }),
      );
    });

    it("★ a deadline between two steps counts nothing, whichever step was last", async () => {
      vi.useFakeTimers();
      const jobs = makeJobs(jobAt("snapshot"));
      const deps = makeDeps([], {
        snapshot: vi.fn(async (ctx: RevampStepContext) => {
          await untilDrain(ctx);
          return SNAPSHOT;
        }),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await run).toEqual({ outcome: "handover" });
      // The step finished and was saved; the plan step was never started.
      expect(savedSteps(jobs)).toEqual(["plan"]);
      expect(deps.plan).not.toHaveBeenCalled();
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE);
    });

    it("★★ resumes an interrupted job at its persisted step, failures untouched", async () => {
      const order: string[] = [];
      const jobs = makeJobs(
        jobAt("photos", {
          attempts: 0,
          result: {
            firstClaimedAt: Date.now() - 60 * 60_000,
            interruptions: 6,
          } as RevampJobRow["result"],
        }),
      );
      const deps = makeDeps(order);
      expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
        outcome: "ready",
      });
      // Nothing before the persisted step runs again.
      expect(order[0]).toBe("photos");
      expect(order).not.toContain("snapshot");
      expect(order).not.toContain("plan");
      expect(log.info).toHaveBeenCalledWith(
        "mink.revamp: runner started",
        expect.objectContaining({ step: "photos", failures: 0 }),
      );
    });
  });

  describe("★★ the deadline drains a step instead of cutting its paid calls (jobs-4)", () => {
    /** Resolves when the deadline starts the drain (or the run is stopped). */
    const untilDraining = (ctx: RevampStepContext) =>
      new Promise<void>((resolve) => {
        const signals = [ctx.draining, ctx.signal].filter(
          (signal): signal is AbortSignal => !!signal,
        );
        if (signals.some((signal) => signal.aborted)) return resolve();
        for (const signal of signals) {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
    const wait = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    it("★★ lets the calls in flight finish, then hands over with the step undone", async () => {
      vi.useFakeTimers();
      const jobs = makeJobs(jobAt("photos"));
      const seen: unknown[] = [];
      const deps = makeDeps([], {
        photos: vi.fn(async (ctx: RevampStepContext) => {
          await untilDraining(ctx);
          // A draw already billed comes back ten seconds later.
          await wait(10_000);
          seen.push(ctx.draining?.aborted, ctx.signal.aborted);
          throw new RevampDrainedError();
        }),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000 + 10_000);
      expect(await run).toEqual({ outcome: "handover" });
      // Draining, and not cut off.
      expect(seen).toEqual([true, false]);
      // ★ Handed over at once, like any deadline: no wait before the claim.
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE);
      expect(jobs.kick).toHaveBeenCalledWith(ID);
      expect(jobs.save).not.toHaveBeenCalled();
      expect(jobs.fail).not.toHaveBeenCalled();
    });

    it("keeps a step that finished its work during the drain, then hands over", async () => {
      vi.useFakeTimers();
      const jobs = makeJobs(jobAt("photos"));
      const deps = makeDeps([], {
        photos: vi.fn(async (ctx: RevampStepContext) => {
          await untilDraining(ctx);
          await wait(1_000);
          return { images: [], outcomes: [OUTCOME], usage: usage({}) };
        }),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000 + 1_000);
      expect(await run).toEqual({ outcome: "handover" });
      expect(savedSteps(jobs)).toEqual(["products"]);
      expect(deps.products).not.toHaveBeenCalled();
      expect(jobs.kick).toHaveBeenCalledWith(ID);
    });

    it("★ still stops a step that ignores the drain once the grace has run out", async () => {
      vi.useFakeTimers();
      const jobs = makeJobs(jobAt("photos"));
      let signal: AbortSignal | null = null;
      const deps = makeDeps([], {
        photos: vi.fn((ctx: RevampStepContext) => {
          signal = ctx.signal;
          return untilAborted(ctx);
        }),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000 + REVAMP_DEADLINE_GRACE_MS - 1);
      expect(signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await run).toEqual({ outcome: "handover" });
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE);
    });

    it("lets a compile repair in flight finish, and starts no other", async () => {
      vi.useFakeTimers();
      const jobs = makeJobs(jobAt("compile"));
      const seen: boolean[] = [];
      const deps = makeDeps([], {
        compile: vi.fn(() => ({ plan: null, issues: ["still broken"] })),
        repair: vi.fn(async (ctx: RevampStepContext) => {
          await untilDraining(ctx);
          await wait(10_000);
          seen.push(ctx.signal.aborted);
          return { raw: { draft: 2 }, usage: usage({ inputTokens: 10 }) };
        }),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000 + 10_000);
      expect(await run).toEqual({ outcome: "handover" });
      expect(seen).toEqual([false]);
      expect(deps.repair).toHaveBeenCalledTimes(1);
      // ★ The answered repair is kept, so the next run never pays for it again.
      expect(savedSteps(jobs)).toEqual(["compile"]);
      expect(jobs.kick).toHaveBeenCalledWith(ID);
    });
  });

  describe("★★ one revamp per server process (jobs-1)", () => {
    /** A photos step that waits until the test lets it go. */
    function heldPhotos() {
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const photos = vi.fn(async () => {
        started();
        await gate;
        return { images: [], outcomes: [OUTCOME], usage: ZERO_REVAMP_USAGE };
      });
      return { photos, entered, release };
    }

    it("turns a second revamp away while one runs, claiming nothing, and kicks it once the first ends", async () => {
      const held = heldPhotos();
      const jobsA = makeJobs(jobAt("photos"));
      const runA = runRevampJob({
        revampId: ID,
        deps: makeDeps([], { photos: held.photos }),
        jobs: jobsA,
      });
      await held.entered;

      // ★ Refused before the claim: the lease and the attempt count of the
      //   waiting job are untouched, so the poll or the sweep can kick it.
      const jobsB = makeJobs(makeJob({ id: PARENT }));
      expect(
        await runRevampJob({
          revampId: PARENT,
          deps: makeDeps([]),
          jobs: jobsB,
        }),
      ).toEqual({ outcome: "busy" });
      expect(jobsB.claim).not.toHaveBeenCalled();
      expect(jobsB.rebuildActor).not.toHaveBeenCalled();

      held.release();
      expect((await runA).outcome).toBe("ready");
      // The instance hands its slot on: the oldest waiting revamp but itself.
      expect(jobsA.kickWaiting).toHaveBeenCalledTimes(1);
      expect(jobsA.kickWaiting).toHaveBeenCalledWith(ID);

      // And the slot is free again for the next one.
      const jobsC = makeJobs(makeJob({ id: PARENT }));
      expect(
        (
          await runRevampJob({
            revampId: PARENT,
            deps: makeDeps([]),
            jobs: jobsC,
          })
        ).outcome,
      ).toBe("ready");
      // It turned nobody away, so it kicks nobody.
      expect(jobsC.kickWaiting).not.toHaveBeenCalled();
    });

    it("frees the slot when the job cannot be claimed, and when a step throws", async () => {
      const unclaimed = makeJobs(makeJob(), { claim: vi.fn(async () => null) });
      expect(
        (
          await runRevampJob({
            revampId: ID,
            deps: makeDeps([]),
            jobs: unclaimed,
          })
        ).outcome,
      ).toBe("not_claimed");
      const crashing = makeJobs(jobAt("photos"));
      expect(
        (
          await runRevampJob({
            revampId: ID,
            deps: makeDeps([], {
              photos: vi.fn(async () => {
                throw new Error("socket hang up");
              }),
            }),
            jobs: crashing,
          })
        ).outcome,
      ).toBe("handover");
      expect(
        (
          await runRevampJob({
            revampId: ID,
            deps: makeDeps([]),
            jobs: makeJobs(makeJob()),
          })
        ).outcome,
      ).toBe("ready");
    });

    it("★ frees the slot before the deadline hand-over kicks the next invocation", async () => {
      vi.useFakeTimers();
      const nextJobs = makeJobs(jobAt("photos"));
      const next: { run: Promise<{ outcome: string }> | null } = { run: null };
      const jobs = makeJobs(jobAt("photos"), {
        // The self-kick lands on this same process: it must be taken.
        kick: vi.fn(async () => {
          next.run = runRevampJob({
            revampId: ID,
            deps: makeDeps([]),
            jobs: nextJobs,
          });
        }),
      });
      const deps = makeDeps([], {
        photos: vi.fn((ctx: RevampStepContext) => untilAborted(ctx)),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs, deadlineMs: 5_000 });
      // Past the deadline and any grace after it.
      await vi.advanceTimersByTimeAsync(5_000 + 120_000);
      expect(await run).toEqual({ outcome: "handover" });
      expect(next.run).not.toBeNull();
      expect((await next.run)?.outcome).toBe("ready");
      expect(nextJobs.claim).toHaveBeenCalledWith(ID);
    });
  });

  it("writes nothing more once a renewal says the lease is lost", async () => {
    vi.useFakeTimers();
    const jobs = makeJobs(jobAt("photos"), {
      renew: vi.fn(async () => ({ ok: false, cancelRequested: false })),
    });
    const deps = makeDeps([], {
      photos: vi.fn((ctx: RevampStepContext) => untilAborted(ctx)),
    });
    const run = runRevampJob({ revampId: ID, deps, jobs });
    await vi.advanceTimersByTimeAsync(REVAMP_LIMITS.leaseRenewMs);
    expect(await run).toEqual({ outcome: "handover" });
    expect(jobs.renew).toHaveBeenCalledWith(ID, LEASE);
    for (const write of [
      jobs.save,
      jobs.release,
      jobs.fail,
      jobs.cancel,
      jobs.finish,
      jobs.kick,
      jobs.report,
      jobs.notify,
    ]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("stops at once when a save finds the lease gone", async () => {
    const order: string[] = [];
    const jobs = makeJobs(makeJob(), {
      save: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
    });
    const deps = makeDeps(order);
    expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
      outcome: "handover",
    });
    expect(order).toEqual(["snapshot", "plan"]);
    expect(jobs.release).not.toHaveBeenCalled();
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it("marks the job cancelled when a renewal sees the request", async () => {
    vi.useFakeTimers();
    const jobs = makeJobs(jobAt("photos"), {
      renew: vi.fn(async () => ({ ok: true, cancelRequested: true })),
    });
    const deps = makeDeps([], {
      photos: vi.fn((ctx: RevampStepContext) => untilAborted(ctx)),
    });
    const run = runRevampJob({ revampId: ID, deps, jobs });
    await vi.advanceTimersByTimeAsync(REVAMP_LIMITS.leaseRenewMs);
    expect(await run).toEqual({ outcome: "cancelled" });
    expect(jobs.cancel).toHaveBeenCalledWith(ID, LEASE);
    expect(jobs.release).not.toHaveBeenCalled();
    expect(jobs.save).not.toHaveBeenCalled();
  });

  it("★★ asks the lease right before the card's charge, so a stop from the last minute is honoured", async () => {
    // The renewal timer runs once a minute; a Stop pressed after the last
    // tick must still be seen before the card is made and charged.
    const jobs = makeJobs(jobAt("card"), {
      renew: vi.fn(async () => ({ ok: true, cancelRequested: true })),
    });
    const deps = makeDeps([]);
    expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
      outcome: "cancelled",
    });
    expect(jobs.renew).toHaveBeenCalledWith(ID, LEASE);
    expect(deps.card).not.toHaveBeenCalled();
    expect(jobs.cancel).toHaveBeenCalledWith(ID, LEASE);
    expect(jobs.finish).not.toHaveBeenCalled();
  });

  it("★ a lease found lost right before the charge makes no card", async () => {
    const jobs = makeJobs(jobAt("card"), {
      renew: vi.fn(async () => ({ ok: false, cancelRequested: false })),
    });
    const deps = makeDeps([]);
    expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
      outcome: "handover",
    });
    expect(deps.card).not.toHaveBeenCalled();
    expect(jobs.cancel).not.toHaveBeenCalled();
  });

  it("★★ a stop that finds the card already made ends ready, never cancelled", async () => {
    // An earlier invocation made and paid for the card and could not attach
    // it; jobs.ts finishes such a job as ready instead of cancelling it.
    const jobs = makeJobs(jobAt("card"), {
      renew: vi.fn(async () => ({ ok: true, cancelRequested: true })),
      cancel: vi.fn(async () => "ready" as const),
    });
    const deps = makeDeps([]);
    expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
      outcome: "ready",
    });
    expect(deps.card).not.toHaveBeenCalled();
  });

  it("★★ a failure that finds the card already made ends ready, never failed", async () => {
    // An earlier invocation made and paid for the card and could not attach
    // it, and the requester has since lost the Website Builder: this run
    // fails the job before any step, and jobs.ts finishes it as ready.
    const jobs = makeJobs(jobAt("card"), {
      rebuildActor: vi.fn(
        async () =>
          ({
            ...ACTOR,
            permissions: { builder: ["view"] },
          }) as MinkActorContext,
      ),
      fail: vi.fn(async () => "ready" as const),
    });
    const deps = makeDeps([]);
    expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
      outcome: "ready",
    });
    expect(jobs.fail).toHaveBeenCalledWith(
      expect.objectContaining({ code: "not_allowed" }),
    );
    expect(deps.card).not.toHaveBeenCalled();
  });

  describe("★★ a renewal that throws is not a lost lease (D1)", () => {
    /** Drizzle's failure: its message carries the SQL and its parameters. */
    const failedQuery = () =>
      Object.assign(
        new Error(
          'Failed query: update "mink_revamps" set "lease_until" = now() where "lease_token" = $1\nparams: lease-token',
        ),
        {
          cause: Object.assign(new Error("canceling statement"), {
            code: "57014",
          }),
        },
      );
    /** The pool had no connection to give within its 5 s wait. */
    const poolBusy = () =>
      Object.assign(new Error("No database connection came free."), {
        name: "DatabaseBusyError",
        reason: "pool_wait_timeout",
      });
    /** When the watchdog stops a run whose renewals never succeed. */
    const LAPSE = REVAMP_LIMITS.leaseMs - REVAMP_LEASE_MARGIN_MS;
    /** A photos step that is stopped only by the run's own stop. */
    const watched = () => {
      const seen = { abortedAt: null as number | null };
      const photos = vi.fn((ctx: RevampStepContext) => {
        const started = Date.now();
        ctx.signal.addEventListener(
          "abort",
          () => {
            seen.abortedAt = Date.now() - started;
          },
          { once: true },
        );
        return untilAborted(ctx);
      });
      return { seen, photos };
    };
    const logged = () => JSON.stringify(log.warn.mock.calls);

    it("★★ logs it with a closed code, asks again at the next tick, and the paid work in flight goes on", async () => {
      vi.useFakeTimers();
      const jobs = makeJobs(jobAt("photos"), {
        renew: vi
          .fn(async () => ({ ok: true, cancelRequested: false }))
          .mockRejectedValueOnce(poolBusy()),
      });
      let aborted = false;
      const deps = makeDeps([], {
        // Google is drawing for two and a half minutes across both ticks.
        photos: vi.fn(async (ctx: RevampStepContext) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
          });
          await new Promise<void>((resolve) => setTimeout(resolve, 150_000));
          return { images: [], outcomes: [OUTCOME], usage: ZERO_REVAMP_USAGE };
        }),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs });
      await vi.advanceTimersByTimeAsync(150_000);
      expect(await run).toEqual({ outcome: "ready" });
      expect(aborted).toBe(false);
      // The throw at the first tick, the answer at the second, and the
      // card's own renewal before its charge.
      expect(jobs.renew).toHaveBeenCalledTimes(3);
      expect(jobs.release).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        "mink.revamp: lease renewal failed",
        {
          revampId: ID,
          attempt: 1,
          code: "pool_wait_timeout",
        },
      );
      expect(deps.card).toHaveBeenCalledTimes(1);
    });

    it("★★ renewals that keep throwing stop the work a few seconds before the lease could lapse, parked and counted as before", async () => {
      vi.useFakeTimers();
      const jobs = makeJobs(jobAt("photos"), {
        renew: vi.fn(async () => {
          throw failedQuery();
        }),
      });
      const { seen, photos } = watched();
      const deps = makeDeps([], { photos });
      const run = runRevampJob({ revampId: ID, deps, jobs });
      await vi.advanceTimersByTimeAsync(LAPSE - 1);
      // Four ticks have thrown, and Google is still drawing.
      expect(jobs.renew).toHaveBeenCalledTimes(4);
      expect(seen.abortedAt).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(await run).toEqual({ outcome: "handover" });
      expect(seen.abortedAt).toBe(LAPSE);
      // ★ The halt a throw used to make at once: parked and counted.
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, {
        retryAfterMs: REVAMP_RETRY_AFTER_MS,
      });
      expect(jobs.kick).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        "mink.revamp: lease could lapse, stopping",
        { revampId: ID, failures: 4 },
      );
      for (const attempt of [1, 2, 3, 4]) {
        expect(log.warn).toHaveBeenCalledWith(
          "mink.revamp: lease renewal failed",
          { revampId: ID, attempt, code: "57014" },
        );
      }
      // ★ Content-free: neither the SQL nor its parameters reach the log.
      expect(logged()).not.toMatch(/Failed query|params|lease-token/);
    });

    it("★★ a renewal that succeeds moves the watchdog: it counts from that renewal's start, not its answer", async () => {
      vi.useFakeTimers();
      const jobs = makeJobs(jobAt("photos"), {
        renew: vi
          .fn(async (): Promise<{ ok: boolean; cancelRequested: boolean }> => {
            throw failedQuery();
          })
          // ★ It answers 10 s after it was asked, and the lease it wrote runs
          //   from the database's now() inside it, near when it was asked:
          //   counting from the answer would stop the work after the lease
          //   had lapsed, when another invocation may pay for it again.
          .mockImplementationOnce(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10_000));
            return { ok: true, cancelRequested: false };
          }),
      });
      const { seen, photos } = watched();
      const deps = makeDeps([], { photos });
      const run = runRevampJob({ revampId: ID, deps, jobs });
      const renewedAt = REVAMP_LIMITS.leaseRenewMs;
      await vi.advanceTimersByTimeAsync(renewedAt + LAPSE - 1);
      expect(seen.abortedAt).toBeNull();
      // Past the moment counted from the answer too.
      await vi.advanceTimersByTimeAsync(10_000 + 1);
      expect(await run).toEqual({ outcome: "handover" });
      expect(seen.abortedAt).toBe(renewedAt + LAPSE);
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, {
        retryAfterMs: REVAMP_RETRY_AFTER_MS,
      });
    });

    it("★★ with no renewal to go by, it counts from before the claim, whose own write starts the lease", async () => {
      vi.useFakeTimers();
      const job = jobAt("photos");
      const CLAIM_MS = 10_000;
      const jobs = makeJobs(job, {
        // The claim's write answers 10 s after it was sent.
        claim: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, CLAIM_MS));
          return { job, leaseToken: LEASE };
        }),
        renew: vi.fn(async () => {
          throw failedQuery();
        }),
      });
      const { seen, photos } = watched();
      const deps = makeDeps([], { photos });
      const run = runRevampJob({ revampId: ID, deps, jobs });
      await vi.advanceTimersByTimeAsync(LAPSE - 1);
      expect(seen.abortedAt).toBeNull();
      // Past the moment counted from the claim's answer too.
      await vi.advanceTimersByTimeAsync(CLAIM_MS + 1);
      expect(await run).toEqual({ outcome: "handover" });
      // The step started once the claim answered.
      expect(seen.abortedAt).toBe(LAPSE - CLAIM_MS);
    });

    it("★ a renewal that answers after the run has ended arms nothing", async () => {
      vi.useFakeTimers();
      const jobs = makeJobs(jobAt("photos"), {
        renew: vi
          .fn(async () => ({ ok: true, cancelRequested: false }))
          // The first tick's renewal answers 5 s late, into a finished run.
          .mockImplementationOnce(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            return { ok: true, cancelRequested: false };
          }),
      });
      const deps = makeDeps([], {
        // The step fails for good a second after the first tick.
        photos: vi.fn(async () => {
          await new Promise((resolve) =>
            setTimeout(resolve, REVAMP_LIMITS.leaseRenewMs + 1_000),
          );
          throw new RevampStepError("internal", "broken", false);
        }),
      });
      const run = runRevampJob({ revampId: ID, deps, jobs });
      await vi.advanceTimersByTimeAsync(REVAMP_LIMITS.leaseRenewMs + 1_000);
      expect(await run).toEqual({ outcome: "failed" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(jobs.renew).toHaveBeenCalledOnce();
      // ★ No watchdog left behind to stop a run that already ended.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(REVAMP_LIMITS.leaseMs);
      expect(log.warn).not.toHaveBeenCalledWith(
        "mink.revamp: lease could lapse, stopping",
        expect.anything(),
      );
    });

    it("★★ a renewal that throws right before the card's charge makes no card: parked and counted as before", async () => {
      const jobs = makeJobs(jobAt("card"), {
        renew: vi.fn(async () => {
          throw failedQuery();
        }),
      });
      const deps = makeDeps([]);
      expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
        outcome: "handover",
      });
      expect(deps.card).not.toHaveBeenCalled();
      expect(jobs.finish).not.toHaveBeenCalled();
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, {
        retryAfterMs: REVAMP_RETRY_AFTER_MS,
      });
    });
  });

  it("★★ D2: the hard stop leaves half a minute to hand over inside the route's 1,200 s", () => {
    // app/api/internal/mink/revamps/run/route.ts `maxDuration` (its own test
    // pins 1200), and Cloud Run's --timeout=1200s.
    const ROUTE_MS = 1_200_000;
    expect(REVAMP_DEADLINE_GRACE_MS).toBe(REVAMP_LIMITS.deadlineGraceMs);
    expect(
      REVAMP_LIMITS.runnerDeadlineMs + REVAMP_DEADLINE_GRACE_MS + 30_000,
    ).toBeLessThanOrEqual(ROUTE_MS);
  });

  it.each([
    // ★ A real failure counts, as jobs.ts' parked release does by default.
    ["an unknown error", new Error("socket hang up"), {}],
    [
      "a transient step error of our own",
      new RevampStepError("internal", "a write failed", true),
      {},
    ],
    // ★★ A wait on Google is parked as before, and not counted (B8).
    [
      "a transient step error from Google",
      new RevampStepError("model_unavailable", "busy", true),
      { counted: false },
    ],
  ])("retries after a wait on %s", async (_label, error, terms) => {
    const jobs = makeJobs(jobAt("photos"));
    const deps = makeDeps([], {
      photos: vi.fn(async () => {
        throw error;
      }),
    });
    expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
      outcome: "handover",
    });
    expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, {
      retryAfterMs: 60_000,
      ...terms,
    });
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  describe("★★ the photo claim lives on the job row, fenced on this lease (jobs-3)", () => {
    const HOLD = { units: ["anchor:anchor", "slot:hero-1"] };
    const savedAt = (jobs: RevampRunnerJobs, step: RevampStep) =>
      vi
        .mocked(jobs.save)
        .mock.calls.map(([input]) => input)
        .find((input) => input.step === step);

    it("hands the step what a dead invocation held, and never saves a cleared claim back", async () => {
      const jobs = makeJobs(jobAt("photos", { result: { photoHold: HOLD } }));
      const seen: unknown[] = [];
      const deps = makeDeps([], {
        photos: vi.fn(async (ctx: RevampStepContext) => {
          seen.push(ctx.photoHold?.held());
          seen.push(await ctx.photoHold?.record(null));
          seen.push(ctx.photoHold?.held());
          return { images: [], outcomes: [OUTCOME], usage: usage({}) };
        }),
      });
      await runRevampJob({ revampId: ID, deps, jobs });
      expect(seen).toEqual([HOLD, true, null]);
      expect(jobs.hold).toHaveBeenCalledWith({
        revampId: ID,
        leaseToken: LEASE,
        hold: null,
      });
      // ★ The step's save carries the column as it is now, not as claimed.
      const next = savedAt(jobs, "products");
      expect(next?.patch.result).toEqual({ photos: { outcomes: [OUTCOME] } });
    });

    it("keeps a claim the step could not clear for the next step to settle", async () => {
      const jobs = makeJobs(jobAt("photos"));
      let productsSaw: unknown = "unread";
      const deps = makeDeps([], {
        photos: vi.fn(async (ctx: RevampStepContext) => {
          await ctx.photoHold?.record(HOLD);
          return { images: [], outcomes: [OUTCOME], usage: usage({}) };
        }),
        products: vi.fn(async (ctx: RevampStepContext) => {
          productsSaw = ctx.photoHold?.held();
          return { images: [], failed: [], usage: usage({}) };
        }),
      });
      await runRevampJob({ revampId: ID, deps, jobs });
      expect(savedAt(jobs, "products")?.patch.result?.photoHold).toEqual(HOLD);
      expect(productsSaw).toEqual(HOLD);
    });

    it("★ a record the lease refuses stops the run, and nothing more is written", async () => {
      const jobs = makeJobs(jobAt("photos"), {
        hold: vi.fn(async () => false),
      });
      const seen: unknown[] = [];
      const deps = makeDeps([], {
        photos: vi.fn(async (ctx: RevampStepContext) => {
          seen.push(await ctx.photoHold?.record(HOLD));
          seen.push(ctx.signal.aborted);
          ctx.signal.throwIfAborted();
          return { images: [], outcomes: [OUTCOME], usage: usage({}) };
        }),
      });
      expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
        outcome: "handover",
      });
      expect(seen).toEqual([false, true]);
      expect(jobs.save).not.toHaveBeenCalled();
      expect(jobs.release).not.toHaveBeenCalled();
    });
  });

  describe("★★ the photo checks' record lives on the job row, fenced on this lease (P0)", () => {
    const REVIEWS: RevampPhotoReviews = {
      shots: {
        hero: {
          sha256: "a".repeat(64),
          firstAskedAt: 1_000,
          tries: 2,
          lastTriedAt: 61_000,
        },
      },
    };
    const NEXT: RevampPhotoReviews = {
      shots: {
        hero: {
          ...REVIEWS.shots.hero,
          tries: 3,
          lastTriedAt: 121_000,
          verdict: { problems: [] },
        },
      },
    };
    const savedAt = (jobs: RevampRunnerJobs, step: RevampStep) =>
      vi
        .mocked(jobs.save)
        .mock.calls.map(([input]) => input)
        .find((input) => input.step === step);

    it("hands the step what earlier invocations recorded, and the step's save carries what it recorded", async () => {
      const jobs = makeJobs(
        jobAt("photos", { result: { photoReviews: REVIEWS } }),
      );
      const seen: unknown[] = [];
      let productsSaw: unknown = "unread";
      const deps = makeDeps([], {
        photos: vi.fn(async (ctx: RevampStepContext) => {
          seen.push(ctx.photoReviews?.held());
          seen.push(await ctx.photoReviews?.record(NEXT));
          seen.push(ctx.photoReviews?.held());
          return { images: [], outcomes: [OUTCOME], usage: usage({}) };
        }),
        products: vi.fn(async (ctx: RevampStepContext) => {
          productsSaw = ctx.photoReviews?.held();
          return { images: [], failed: [], usage: usage({}) };
        }),
      });
      await runRevampJob({ revampId: ID, deps, jobs });
      expect(seen).toEqual([REVIEWS, true, NEXT]);
      expect(jobs.reviews).toHaveBeenCalledWith({
        revampId: ID,
        leaseToken: LEASE,
        reviews: NEXT,
      });
      // ★ The step's save writes the whole column, with the record as it is
      //   now, so it never puts an older record back.
      expect(savedAt(jobs, "products")?.patch.result).toEqual({
        photoReviews: NEXT,
        photos: { outcomes: [OUTCOME] },
      });
      expect(productsSaw).toEqual(NEXT);
    });

    it("hands a first invocation no record", async () => {
      const jobs = makeJobs(jobAt("photos"));
      let saw: unknown = "unread";
      const deps = makeDeps([], {
        photos: vi.fn(async (ctx: RevampStepContext) => {
          saw = ctx.photoReviews?.held();
          return { images: [], outcomes: [OUTCOME], usage: usage({}) };
        }),
      });
      await runRevampJob({ revampId: ID, deps, jobs });
      expect(saw).toBeNull();
      expect(jobs.reviews).not.toHaveBeenCalled();
    });

    it("★ a record the lease refuses stops the run, keeps the old record, and nothing more is written", async () => {
      const jobs = makeJobs(
        jobAt("photos", { result: { photoReviews: REVIEWS } }),
        { reviews: vi.fn(async () => false) },
      );
      const seen: unknown[] = [];
      const deps = makeDeps([], {
        photos: vi.fn(async (ctx: RevampStepContext) => {
          seen.push(await ctx.photoReviews?.record(NEXT));
          seen.push(ctx.photoReviews?.held());
          seen.push(ctx.signal.aborted);
          // Once the lease is gone, a second record is not even tried.
          seen.push(await ctx.photoReviews?.record(NEXT));
          ctx.signal.throwIfAborted();
          return { images: [], outcomes: [OUTCOME], usage: usage({}) };
        }),
      });
      expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
        outcome: "handover",
      });
      expect(seen).toEqual([false, REVIEWS, true, false]);
      expect(jobs.reviews).toHaveBeenCalledTimes(1);
      expect(jobs.save).not.toHaveBeenCalled();
      expect(jobs.release).not.toHaveBeenCalled();
    });
  });

  it("★★ parks a step that knows its own wait for that long, not the usual minute (jobs-2)", async () => {
    const jobs = makeJobs(jobAt("photos"));
    const deps = makeDeps([], {
      photos: vi.fn(async () => {
        throw new RevampRetryLaterError(
          "photos_unavailable",
          "the platform's hour is full",
          20 * 60_000,
        );
      }),
    });
    expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
      outcome: "handover",
    });
    // ★ The platform's photo hour is a wait, not a failure (B8).
    expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, {
      retryAfterMs: 20 * 60_000,
      counted: false,
    });
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it.each([
    ["model_refused"],
    ["plan_invalid"],
    ["photos_unavailable"],
    ["photos_failed"],
    ["limit_reached"],
  ] as const)("fails the job with %s", async (code) => {
    const jobs = makeJobs(jobAt("plan"));
    const deps = makeDeps([], {
      plan: vi.fn(async () => {
        throw new RevampStepError(code, "detail", false);
      }),
    });
    expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
      outcome: "failed",
    });
    expect(jobs.fail).toHaveBeenCalledWith({
      revampId: ID,
      leaseToken: LEASE,
      code,
      detail: "detail",
    });
    expect(jobs.release).not.toHaveBeenCalled();
  });

  const refusals: Array<[string, MinkActorContext | null]> = [
    ["no actor", null],
    ["drafting off", { ...ACTOR, draftingEnabled: false }],
    [
      "no Builder manage",
      { ...ACTOR, permissions: { builder: ["view"] } } as MinkActorContext,
    ],
  ];
  it.each(refusals)("refuses a requester with %s", async (_label, actor) => {
    const jobs = makeJobs(makeJob(), {
      rebuildActor: vi.fn(async () => actor),
    });
    const deps = makeDeps([]);
    expect(await runRevampJob({ revampId: ID, deps, jobs })).toEqual({
      outcome: "failed",
    });
    expect(jobs.fail).toHaveBeenCalledWith(
      expect.objectContaining({ code: "not_allowed" }),
    );
    expect(deps.snapshot).not.toHaveBeenCalled();
  });

  it("lets a superadmin through without a Builder grant", async () => {
    const jobs = makeJobs(makeJob(), {
      rebuildActor: vi.fn(
        async () =>
          ({
            ...ACTOR,
            permissions: {},
            isSuperadmin: true,
          }) as MinkActorContext,
      ),
    });
    expect(
      (await runRevampJob({ revampId: ID, deps: makeDeps([]), jobs })).outcome,
    ).toBe("ready");
  });

  it("fails internal when the revamp has no run for its draft", async () => {
    const jobs = makeJobs(makeJob({ originRunId: null }));
    expect(
      (await runRevampJob({ revampId: ID, deps: makeDeps([]), jobs })).outcome,
    ).toBe("failed");
    expect(jobs.fail).toHaveBeenCalledWith(
      expect.objectContaining({ code: "internal" }),
    );
  });

  it("sums every model, photo and product usage into each save", async () => {
    const jobs = makeJobs(makeJob({ usage: usage({ inputTokens: 5 }) }));
    const deps = makeDeps([], {
      compile: vi
        .fn()
        .mockReturnValueOnce({ plan: null, issues: ["x"] })
        .mockReturnValue({ plan: PLAN, issues: [] }),
    });
    await runRevampJob({ revampId: ID, deps, jobs });
    expect(saveInput(jobs, 1).patch.usage.inputTokens).toBe(105);
    expect(saveInput(jobs, 2).patch.usage.inputTokens).toBe(115);
    expect(jobs.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: usage({
          inputTokens: 115,
          images: 3,
          estimatedCostMicroUsd: 5,
        }),
      }),
    );
  });

  describe("★★ every paid call is counted, across hand-overs (L2-F)", () => {
    const untilDraining = (ctx: RevampStepContext) =>
      new Promise<void>((resolve) => {
        if (ctx.draining?.aborted) return resolve();
        ctx.draining?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    const DRAW = usage({ images: 1, estimatedCostMicroUsd: 100 });
    const REVIEW = usage({
      reviews: 1,
      inputTokens: 50,
      estimatedCostMicroUsd: 3,
    });

    /** The job row as the database would keep it across invocations. */
    function persistedJobs(start: RevampJobRow) {
      let row = start;
      const jobs = makeJobs(start, {
        claim: vi.fn(async () => ({ job: row, leaseToken: LEASE })),
        release: vi.fn(
          async (
            _id: string,
            _lease: string,
            options?: { usage?: RevampUsage },
          ) => {
            if (options?.usage) row = { ...row, usage: options.usage };
          },
        ),
        save: vi.fn(async (input) => {
          row = {
            ...row,
            step: input.step,
            ...(input.patch.plan ? { plan: input.patch.plan } : {}),
            ...(input.patch.result ? { result: input.patch.result } : {}),
            ...(input.patch.usage ? { usage: input.patch.usage } : {}),
          };
          return true;
        }),
      });
      return { jobs, row: () => row };
    }

    it("★★ a photos step handed over twice still records every call it paid for", async () => {
      vi.useFakeTimers();
      const db = persistedJobs(
        jobAt("photos", { usage: usage({ inputTokens: 5 }) }),
      );
      let invocation = 0;
      const deps = makeDeps([], {
        photos: vi.fn(
          async (
            ctx: RevampStepContext,
            input: Parameters<RevampDeps["photos"]>[1],
          ) => {
            invocation += 1;
            // A draw and its review come back in every run...
            input.onUsage?.(DRAW);
            input.onUsage?.(REVIEW);
            // ...and the first two runs stop at their deadline.
            if (invocation < 3) {
              await untilDraining(ctx);
              throw new RevampDrainedError();
            }
            // ★ A total the runner must not add on top of the calls.
            return {
              images: [],
              outcomes: [OUTCOME],
              usage: usage({ images: 99 }),
            };
          },
        ),
        products: vi.fn(
          async (
            _ctx: RevampStepContext,
            input: Parameters<RevampDeps["products"]>[1],
          ) => {
            input.onUsage?.(usage({ images: 1 }));
            return { images: [], failed: [], usage: usage({ images: 99 }) };
          },
        ),
      });
      for (let n = 0; n < 2; n += 1) {
        const run = runRevampJob({
          revampId: ID,
          deps,
          jobs: db.jobs,
          deadlineMs: 5_000,
        });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await run).toEqual({ outcome: "handover" });
      }
      // ★ Each hand-over wrote what its run spent.
      expect(db.jobs.release).toHaveBeenNthCalledWith(1, ID, LEASE, {
        usage: usage({
          inputTokens: 55,
          images: 1,
          reviews: 1,
          estimatedCostMicroUsd: 103,
        }),
      });
      expect(db.row().usage).toEqual(
        usage({
          inputTokens: 105,
          images: 2,
          reviews: 2,
          estimatedCostMicroUsd: 206,
        }),
      );
      expect(
        (await runRevampJob({ revampId: ID, deps, jobs: db.jobs })).outcome,
      ).toBe("ready");
      // Three draws, three reviews and the studio photo, each once.
      expect(db.jobs.finish).toHaveBeenCalledWith(
        expect.objectContaining({
          usage: usage({
            inputTokens: 155,
            images: 4,
            reviews: 3,
            estimatedCostMicroUsd: 309,
          }),
        }),
      );
    });

    it("★ the 429s and timeouts of calls that got no answer are kept per model, across hand-overs (P0)", async () => {
      vi.useFakeTimers();
      const db = persistedJobs(jobAt("photos"));
      const BUSY = usage({
        calls: { "gemini-3-pro-image": { rateLimited: 2, timeouts: 0 } },
      });
      const CUT = usage({
        calls: { "gemini-3.8-flash": { rateLimited: 0, timeouts: 1 } },
      });
      let invocation = 0;
      const deps = makeDeps([], {
        photos: vi.fn(
          async (
            ctx: RevampStepContext,
            input: Parameters<RevampDeps["photos"]>[1],
          ) => {
            invocation += 1;
            input.onUsage?.(invocation === 1 ? BUSY : CUT);
            if (invocation === 1) {
              await untilDraining(ctx);
              throw new RevampDrainedError();
            }
            return { images: [], outcomes: [OUTCOME], usage: usage({}) };
          },
        ),
        products: vi.fn(
          async (
            _ctx: RevampStepContext,
            input: Parameters<RevampDeps["products"]>[1],
          ) => {
            input.onUsage?.(
              usage({
                calls: {
                  "gemini-3-pro-image": { rateLimited: 1, timeouts: 0 },
                },
              }),
            );
            return { images: [], failed: [], usage: usage({}) };
          },
        ),
      });
      const first = runRevampJob({
        revampId: ID,
        deps,
        jobs: db.jobs,
        deadlineMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await first).toEqual({ outcome: "handover" });
      // ★ A hand-over that paid for nothing but counted refusals still
      //   writes them.
      expect(db.jobs.release).toHaveBeenNthCalledWith(1, ID, LEASE, {
        usage: BUSY,
      });
      expect(
        (await runRevampJob({ revampId: ID, deps, jobs: db.jobs })).outcome,
      ).toBe("ready");
      expect(db.jobs.finish).toHaveBeenCalledWith(
        expect.objectContaining({
          usage: usage({
            calls: {
              "gemini-3-pro-image": { rateLimited: 3, timeouts: 0 },
              "gemini-3.8-flash": { rateLimited: 0, timeouts: 1 },
            },
          }),
        }),
      );
    });

    it("★ a transient failure, a failure and a stop record what the step spent", async () => {
      const failing = makeJobs(jobAt("photos"));
      await runRevampJob({
        revampId: ID,
        deps: makeDeps([], {
          photos: vi.fn(
            async (
              _ctx: RevampStepContext,
              input: Parameters<RevampDeps["photos"]>[1],
            ) => {
              input.onUsage?.(DRAW);
              throw new RevampStepError("photos_unavailable", "busy", true);
            },
          ),
        }),
        jobs: failing,
      });
      expect(failing.release).toHaveBeenCalledWith(ID, LEASE, {
        retryAfterMs: REVAMP_RETRY_AFTER_MS,
        counted: false,
        usage: DRAW,
      });

      const failed = makeJobs(jobAt("photos"));
      await runRevampJob({
        revampId: ID,
        deps: makeDeps([], {
          photos: vi.fn(
            async (
              _ctx: RevampStepContext,
              input: Parameters<RevampDeps["photos"]>[1],
            ) => {
              input.onUsage?.(DRAW);
              throw new RevampStepError("limit_reached", "day is full", false);
            },
          ),
        }),
        jobs: failed,
      });
      expect(failed.fail).toHaveBeenCalledWith(
        expect.objectContaining({ code: "limit_reached", usage: DRAW }),
      );

      vi.useFakeTimers();
      const stopped = makeJobs(jobAt("products"), {
        renew: vi.fn(async () => ({ ok: true, cancelRequested: true })),
      });
      const run = runRevampJob({
        revampId: ID,
        deps: makeDeps([], {
          products: vi.fn(
            (
              ctx: RevampStepContext,
              input: Parameters<RevampDeps["products"]>[1],
            ) => {
              input.onUsage?.(DRAW);
              return untilAborted(ctx);
            },
          ),
        }),
        jobs: stopped,
      });
      await vi.advanceTimersByTimeAsync(REVAMP_LIMITS.leaseRenewMs);
      expect(await run).toEqual({ outcome: "cancelled" });
      expect(stopped.cancel).toHaveBeenCalledWith(ID, LEASE, DRAW);
    });

    it("★ writes nothing extra when nothing was spent since the last save", async () => {
      const jobs = makeJobs(jobAt("photos"));
      await runRevampJob({
        revampId: ID,
        deps: makeDeps([], {
          photos: vi.fn(async () => {
            throw new RevampStepError("photos_unavailable", "busy", true);
          }),
        }),
        jobs,
      });
      expect(jobs.release).toHaveBeenCalledWith(ID, LEASE, {
        retryAfterMs: REVAMP_RETRY_AFTER_MS,
        counted: false,
      });

      // Spent, then saved with the step: the hand-over repeats nothing.
      vi.useFakeTimers();
      const saved = makeJobs(jobAt("photos"));
      const run = runRevampJob({
        revampId: ID,
        deps: makeDeps([], {
          photos: vi.fn(
            async (
              ctx: RevampStepContext,
              input: Parameters<RevampDeps["photos"]>[1],
            ) => {
              input.onUsage?.(DRAW);
              await untilDraining(ctx);
              return { images: [], outcomes: [OUTCOME], usage: DRAW };
            },
          ),
        }),
        jobs: saved,
        deadlineMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await run).toEqual({ outcome: "handover" });
      expect(saveInput(saved, 0).patch.usage).toEqual(DRAW);
      expect(saved.release).toHaveBeenCalledWith(ID, LEASE);
    });
  });

  it("reuses an existing card instead of making a second one", async () => {
    const jobs = makeJobs(
      jobAt("card", {
        draftId: DRAFT,
        credits: 7,
        result: { stored: CHECKED },
      }),
    );
    const deps = makeDeps([]);
    expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
      "ready",
    );
    expect(deps.card).not.toHaveBeenCalled();
    expect(jobs.finish).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: DRAFT, credits: 7 }),
    );
  });

  it("keeps the outcome when the notification fails, and stops when finishing finds no lease", async () => {
    const noisy = makeJobs(jobAt("card"), {
      notify: vi.fn(async () => {
        throw new Error("smtp");
      }),
    });
    expect(
      (await runRevampJob({ revampId: ID, deps: makeDeps([]), jobs: noisy }))
        .outcome,
    ).toBe("ready");

    const lost = makeJobs(jobAt("card"), { finish: vi.fn(async () => false) });
    expect(
      (await runRevampJob({ revampId: ID, deps: makeDeps([]), jobs: lost }))
        .outcome,
    ).toBe("handover");
    expect(lost.notify).not.toHaveBeenCalled();
  });

  it("throttles progress reports to one per two seconds and never throws", async () => {
    let clock = 1_000_000;
    const jobs = makeJobs(jobAt("photos"), {
      report: vi.fn(async () => {
        throw new Error("db");
      }),
    });
    const deps = makeDeps([], {
      photos: vi.fn(async (ctx: RevampStepContext) => {
        await ctx.report("1 of 3");
        clock += 1_000;
        await ctx.report("2 of 3");
        clock += 1_500;
        await ctx.report("3 of 3");
        return { images: [], outcomes: [OUTCOME], usage: ZERO_REVAMP_USAGE };
      }),
    });
    const { outcome } = await runRevampJob({
      revampId: ID,
      deps,
      jobs,
      now: () => clock,
    });
    expect(outcome).toBe("ready");
    expect(jobs.report).toHaveBeenCalledTimes(2);
    const progress = vi.mocked(jobs.report).mock.calls[1][2];
    expect(progress.find((p) => p.step === "photos")?.detail).toBe("3 of 3");
  });
});

describe("★★ the redo memory: a redesign is distinct from this store's earlier ones (robustness audit section 5, step 6)", () => {
  /** A bakery's full redesign, as the start tool reads it. */
  const BAKERY: RevampRequest = {
    kind: "full",
    brief: {
      business: "Rukmini's corner bakery in Kothrud, baking sourdough daily",
      look: "warm and homely",
      audience: "families nearby",
      facts: ["We bake every morning from 5 am"],
      avoid: "",
      language: "English",
    },
    products: [],
    categories: [],
    pages: null,
    instruction: null,
    refineScope: null,
  };
  /** The store as the snapshot reads it right after Basket was installed. */
  const BASKET_SNAPSHOT = {
    storeId: STORE,
    storeName: "Crumb Corner",
    storeSlug: "crumb-corner",
    launched: true,
    theme: {
      id: "basket",
      version: basket.release.version,
      name: "Basket",
      palette: {
        page: "#fbf7ef",
        surface: "#ffffff",
        ink: "#1d1d1b",
        accent: "#ef5a2a",
      },
      layout: {},
    },
    pages: basket.preset.pages.map((page, index) => ({
      id: `page-${index}`,
      slug: page.slug,
      title: page.title,
      status: "published",
      version: "v1",
      sectionsDigest: "d",
      sections: page.sections,
      owners: Object.fromEntries(
        page.sections.map((section) => [section.id, "theme" as const]),
      ),
      skipped: null,
      seoTitle: null,
      seoDescription: null,
    })),
    chrome: { rowExists: false, version: null, digest: "c", value: {} },
    brand: { tagline: null, blurb: null, digest: "b" },
    categories: [],
    products: [],
    facts: {
      delivery: null,
      freeDeliveryAbove: null,
      returns: null,
      pickup: false,
      onlinePayments: false,
      cashOnDelivery: true,
      city: "Pune",
      state: null,
    },
    photos: { replaceable: [], broken: [] },
    entitlements: { customCode: false },
  } as unknown as RevampSnapshot;

  /** A real compiled plan of this store, from the offline planner. */
  function compiledPlan(revampId: string): RevampSitePlan {
    const input = {
      request: BAKERY,
      snapshot: BASKET_SNAPSHOT,
      previous: null,
      revampId,
    };
    const raw = fakeRevampSiteOutput(input);
    return compileRevampSite(raw, input).plan ?? finalizeRevampSite(raw, input);
  }
  const EARLIER = compiledPlan("aaaaaaaa-aaaa-4aaa-8aaa-000000000001");
  const OLDER = compiledPlan("aaaaaaaa-aaaa-4aaa-8aaa-000000000002");

  /** A full redesign of the bakery waiting at `step`. */
  const bakeryAt = (step: RevampStep, over: Partial<RevampJobRow> = {}) =>
    jobAt(step, {
      request: BAKERY,
      ...(REVAMP_STEPS.indexOf(step) > 0 ? { snapshot: BASKET_SNAPSHOT } : {}),
      ...over,
    });

  /** The save that moved the job past the compile step. */
  const compileSave = (jobs: RevampRunnerJobs) => {
    const at = savedSteps(jobs).indexOf("photos");
    expect(at).toBeGreaterThanOrEqual(0);
    return saveInput(jobs, at);
  };
  const recordOf = (jobs: RevampRunnerJobs): RevampDistinctnessRecord =>
    compileSave(jobs).patch.result?.distinctness as RevampDistinctnessRecord;
  const distinctnessLines = () =>
    log.info.mock.calls.filter(
      ([message]) => message === "mink.revamp.distinctness",
    );

  it("★★ reads this store's earlier redesigns once, and gives the planner their summary and the redesign's id", async () => {
    const jobs = makeJobs(makeJob({ request: BAKERY }), {
      earlierPlans: vi.fn(async () => [EARLIER, OLDER]),
    });
    const deps = makeDeps([], {
      snapshot: vi.fn(async () => BASKET_SNAPSHOT),
    });
    expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
      "ready",
    );
    // One read for the plan, the compile and the check of this invocation.
    expect(jobs.earlierPlans).toHaveBeenCalledTimes(1);
    expect(jobs.earlierPlans).toHaveBeenCalledWith({
      storeId: STORE,
      revampId: ID,
      limit: REVAMP_EARLIER_PLANS_MAX,
    });
    expect(REVAMP_EARLIER_PLANS_MAX).toBe(5);
    const summary = earlierDesignsSummary([EARLIER, OLDER]);
    expect(summary).toMatch(/^1 \(newest\)\. direction /);
    expect(deps.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        request: BAKERY,
        revampId: ID,
        earlierDesigns: summary,
      }),
    );
    // ★ Design choices only: none of the store's words reach the prompt.
    for (const word of ["Rukmini", "Kothrud", "sourdough", "Crumb"]) {
      expect(summary).not.toContain(word);
    }
  });

  it("★★ gives the compile, the finaliser and every repair the redesign's id, and the repairs the same summary", async () => {
    const jobs = makeJobs(bakeryAt("compile"), {
      earlierPlans: vi.fn(async () => [EARLIER]),
    });
    const deps = makeDeps([], {
      compile: vi.fn(() => ({ plan: null, issues: ["broken"] })),
    });
    await runRevampJob({ revampId: ID, deps, jobs });
    const summary = earlierDesignsSummary([EARLIER]);
    expect(vi.mocked(deps.compile).mock.calls[0][1]).toMatchObject({
      revampId: ID,
      earlierDesigns: summary,
    });
    expect(deps.repair).toHaveBeenCalledTimes(2);
    for (const [, input] of vi.mocked(deps.repair).mock.calls) {
      expect(input).toMatchObject({ revampId: ID, earlierDesigns: summary });
    }
    expect(vi.mocked(deps.finalize).mock.calls[0][1]).toMatchObject({
      revampId: ID,
    });
  });

  it("★ a store's first redesign: no <earlier_designs>, and the check records that nothing was compared", async () => {
    const jobs = makeJobs(makeJob({ request: BAKERY }));
    const deps = makeDeps([], {
      snapshot: vi.fn(async () => BASKET_SNAPSHOT),
      compile: vi.fn(() => ({ plan: EARLIER, issues: [] })),
    });
    expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
      "ready",
    );
    const input = vi.mocked(deps.plan).mock.calls[0][1];
    expect(input).toMatchObject({ revampId: ID });
    expect(input).not.toHaveProperty("earlierDesigns");
    expect(recordOf(jobs)).toEqual({
      status: "not-compared",
      passed: true,
      bar: revampDistinctnessBar(basket),
      before: [],
      after: [],
      changed: [],
      kept: [],
    });
    // The plan is the compiler's, untouched.
    expect(compileSave(jobs).patch.plan).toMatchObject({ plan: EARLIER });
    expect(jobs.theme).toHaveBeenCalledWith({
      id: "basket",
      version: basket.release.version,
    });
  });

  it("★★ moves a redo too close to an earlier redesign, before the budget fit and any photograph", async () => {
    // The same design again: what the audit found (two runs 0.17 apart).
    const twin = structuredClone(EARLIER);
    const jobs = makeJobs(bakeryAt("compile", { budgetCredits: 50 }), {
      earlierPlans: vi.fn(async () => [EARLIER]),
    });
    const deps = makeDeps([], {
      compile: vi.fn(() => ({ plan: twin, issues: [] })),
      fitBudget: vi.fn((plan: RevampSitePlan) => ({
        plan,
        productPhotoKeys: [],
      })),
    });
    expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
      "ready",
    );
    const bar = revampDistinctnessBar(basket);
    const record = recordOf(jobs);
    expect(record).toMatchObject({
      status: "changed",
      passed: true,
      bar,
      before: [0],
    });
    expect(record.changed.length).toBeGreaterThan(0);
    expect(record.after[0]).toBeGreaterThanOrEqual(bar);
    // ★ The budget is fitted to the moved plan, whose uncut copy is kept for a
    //   later re-fit, and the photographs are drawn for it.
    const moved = vi.mocked(deps.fitBudget).mock.calls[0][0];
    expect(moved).not.toBe(twin);
    expect(revampDistances(basket, moved, [EARLIER])[0]).toBeCloseTo(
      record.after[0],
      3,
    );
    expect(compileSave(jobs).patch.plan).toMatchObject({
      stage: "compiled",
      plan: moved,
      unfitted: moved,
    });
    expect(deps.photos).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ plan: moved }),
    );
    // ★ Design choices only: the words, shots, links and menus are the
    //   plan's own.
    expect(moved.summary).toBe(twin.summary);
    expect(moved.shots).toEqual(twin.shots);
    expect(moved.menus).toEqual(twin.menus);
    expect(moved.design.palette).toEqual(twin.design.palette);
    // The twin itself is never written to.
    expect(twin).toEqual(EARLIER);
  });

  /** What the budget fit does when the balance cannot buy a plan's look. */
  const withoutLook = (plan: RevampSitePlan): RevampSitePlan => ({
    ...plan,
    design: { palette: {}, fonts: { body: null, display: null }, shape: {} },
  });
  const round3 = (d: number) => Math.round(d * 1000) / 1000;

  it("★★ checks the plan the budget fit leaves again: the record is the shown plan's (review fix, 25 Oct)", async () => {
    // The earlier redesign as its card showed it, fitted to a balance that
    // could not buy its look; this redo is planned the same and meets the
    // same balance.
    const shownBefore = withoutLook(EARLIER);
    const jobs = makeJobs(bakeryAt("compile", { budgetCredits: 17 }), {
      earlierPlans: vi.fn(async () => [shownBefore]),
    });
    const deps = makeDeps([], {
      compile: vi.fn(() => ({ plan: structuredClone(EARLIER), issues: [] })),
      fitBudget: vi.fn((plan: RevampSitePlan) => ({
        plan: withoutLook(plan),
        productPhotoKeys: [],
      })),
    });
    expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
      "ready",
    );
    // Before the fit, the plan's own look kept it apart: a check that stopped
    // there recorded "passed" for the twin shoppers would see.
    const first = vi.mocked(makeDistinct).mock.results[0].value;
    expect(first.report.passed).toBe(true);
    const saved = compileSave(jobs).patch.plan as Extract<
      RevampPlanColumn,
      { stage: "compiled" }
    >;
    const record = recordOf(jobs);
    const shown = revampDistances(basket, saved.plan, [shownBefore]).map(
      round3,
    );
    expect(record.after).toEqual(shown);
    expect(record.passed).toBe(
      shown.every((d) => d >= revampDistinctnessBar(basket)),
    );
    expect(record.before).toEqual(first.report.before);
    // ★ The uncut copy keeps the first check's changes, for a later re-fit,
    //   and the photographs are drawn for the plan the record describes.
    expect(saved.unfitted).toBe(vi.mocked(deps.fitBudget).mock.calls[0][0]);
    expect(saved.unfitted).toBe(first.plan);
    expect(deps.photos).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ plan: saved.plan }),
    );
    // One log line, with the shown plan's numbers.
    const lines = distinctnessLines();
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toMatchObject({
      status: record.status,
      passed: record.passed,
      after: record.after,
    });
  });

  it("★★ a plan fitted again to a fallen balance is checked again, and its record saved with it", async () => {
    const shownBefore = withoutLook(EARLIER);
    const context = { storeId: STORE, revampId: ID, keptSectionIds: [] };
    const moved = makeDistinct(
      basket,
      structuredClone(EARLIER),
      [shownBefore],
      BAKERY,
      context,
    );
    expect(moved.report.passed).toBe(true);
    const jobs = makeJobs(
      bakeryAt("photos", {
        budgetCredits: 40,
        plan: {
          stage: "compiled",
          plan: moved.plan,
          productPhotoKeys: [],
          unfitted: moved.plan,
        },
        result: { distinctness: moved.report },
      }),
      { earlierPlans: vi.fn(async () => [shownBefore]) },
    );
    const deps = makeDeps([], {
      estimate: vi.fn((p: RevampSitePlan) =>
        credits(p === moved.plan ? 30 : 0),
      ),
      balance: vi.fn(async () => 20),
      fitBudget: vi.fn((plan: RevampSitePlan) => ({
        plan: withoutLook(plan),
        productPhotoKeys: [],
      })),
    });
    expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
      "ready",
    );
    expect(deps.fitBudget).toHaveBeenCalledWith(moved.plan, {
      request: BAKERY,
      budget: 20,
    });
    const save = saveInput(jobs, 0);
    expect(save.step).toBe("photos");
    const column = save.patch.plan as Extract<
      RevampPlanColumn,
      { stage: "compiled" }
    >;
    const record = save.patch.result?.distinctness as RevampDistinctnessRecord;
    const shown = revampDistances(basket, column.plan, [shownBefore]).map(
      round3,
    );
    expect(record.after).toEqual(shown);
    expect(record.passed).toBe(
      shown.every((d) => d >= revampDistinctnessBar(basket)),
    );
    expect(column.unfitted).toBe(moved.plan);
    expect(deps.photos).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ plan: column.plan }),
    );
    expect(jobs.earlierPlans).toHaveBeenCalledTimes(1);
    expect(distinctnessLines()).toHaveLength(1);
    // Every later save carries the new record.
    const at = savedSteps(jobs).indexOf("products");
    expect(saveInput(jobs, at).patch.result?.distinctness).toEqual(record);
  });

  it("★ a plan fitted again with no compared record reads no memory and keeps its record", async () => {
    const jobs = makeJobs(
      bakeryAt("photos", {
        budgetCredits: 40,
        plan: {
          stage: "compiled",
          plan: EARLIER,
          productPhotoKeys: [],
          unfitted: EARLIER,
        },
        result: {
          distinctness: {
            status: "not-compared",
            passed: true,
            bar: 0.289,
            before: [],
            after: [],
            changed: [],
            kept: [],
          },
        },
      }),
      { earlierPlans: vi.fn(async () => [OLDER]) },
    );
    const deps = makeDeps([], {
      estimate: vi.fn((p: RevampSitePlan) => credits(p === EARLIER ? 30 : 0)),
      balance: vi.fn(async () => 20),
      fitBudget: vi.fn((plan: RevampSitePlan) => ({
        plan: withoutLook(plan),
        productPhotoKeys: [],
      })),
    });
    await runRevampJob({ revampId: ID, deps, jobs });
    expect(deps.fitBudget).toHaveBeenCalledTimes(1);
    expect(jobs.earlierPlans).not.toHaveBeenCalled();
    expect(saveInput(jobs, 0).patch).not.toHaveProperty("result");
    expect(distinctnessLines()).toHaveLength(0);
  });

  it("★★ saves the record with the compiled plan in the same fenced write, and every later save carries it", async () => {
    const jobs = makeJobs(bakeryAt("compile"), {
      earlierPlans: vi.fn(async () => [EARLIER]),
    });
    const deps = makeDeps([], {
      compile: vi.fn(() => ({ plan: structuredClone(EARLIER), issues: [] })),
    });
    await runRevampJob({ revampId: ID, deps, jobs });
    const save = compileSave(jobs);
    expect(save.step).toBe("photos");
    expect(save.patch.plan?.stage).toBe("compiled");
    const record = save.patch.result?.distinctness;
    expect(record?.status).toBe("changed");
    // The photos, products, assemble and checks saves and the finish keep it.
    for (const step of ["products", "assemble", "checks", "card"] as const) {
      const at = savedSteps(jobs).indexOf(step);
      expect(saveInput(jobs, at).patch.result?.distinctness).toEqual(record);
    }
    expect(jobs.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ distinctness: record }),
      }),
    );
  });

  it("★★ logs one content-free line with the distances and the number of changes", async () => {
    const jobs = makeJobs(bakeryAt("compile"), {
      earlierPlans: vi.fn(async () => [EARLIER, OLDER]),
    });
    const deps = makeDeps([], {
      compile: vi.fn(() => ({ plan: structuredClone(EARLIER), issues: [] })),
    });
    await runRevampJob({ revampId: ID, deps, jobs });
    const lines = distinctnessLines();
    expect(lines).toHaveLength(1);
    const [, fields] = lines[0];
    const record = recordOf(jobs);
    expect(fields).toEqual({
      revampId: ID,
      status: record.status,
      passed: record.passed,
      bar: record.bar,
      before: record.before,
      after: record.after,
      changes: record.changed.length,
    });
    expect(fields.before).toHaveLength(2);
    // ★ Nothing of the store's: not its words, its name, nor its plan.
    const text = JSON.stringify(lines);
    for (const word of ["Rukmini", "Kothrud", "Crumb", EARLIER.summary]) {
      expect(text).not.toContain(word);
    }
  });

  it("★★ a refinement reads no memory, sends no summary and is never checked", async () => {
    const refine = { ...BAKERY, kind: "refine" as const, instruction: "x" };
    const jobs = makeJobs(
      makeJob({ kind: "refine", parentId: PARENT, request: refine }),
      {
        earlierPlans: vi.fn(async () => [EARLIER]),
        read: vi.fn(async () =>
          makeJob({
            id: PARENT,
            plan: { stage: "compiled", plan: EARLIER, productPhotoKeys: null },
          }),
        ),
      },
    );
    const deps = makeDeps([], {
      snapshot: vi.fn(async () => BASKET_SNAPSHOT),
    });
    expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
      "ready",
    );
    expect(jobs.earlierPlans).not.toHaveBeenCalled();
    expect(jobs.theme).not.toHaveBeenCalled();
    expect(makeDistinct).not.toHaveBeenCalled();
    const input = vi.mocked(deps.plan).mock.calls[0][1];
    expect(input).toMatchObject({ revampId: ID, previous: EARLIER });
    expect(input).not.toHaveProperty("earlierDesigns");
    expect(compileSave(jobs).patch).not.toHaveProperty("result");
    expect(distinctnessLines()).toHaveLength(0);
  });

  it("★★ earlier redesigns that cannot be read skip the memory and the check, never the redesign", async () => {
    const jobs = makeJobs(makeJob({ request: BAKERY }), {
      earlierPlans: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    });
    const deps = makeDeps([], {
      snapshot: vi.fn(async () => BASKET_SNAPSHOT),
    });
    expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
      "ready",
    );
    expect(vi.mocked(deps.plan).mock.calls[0][1]).not.toHaveProperty(
      "earlierDesigns",
    );
    expect(recordOf(jobs)).toEqual({
      status: "skipped",
      reason: "earlier_unreadable",
      passed: false,
      bar: null,
      before: [],
      after: [],
      changed: [],
      kept: [],
    });
    expect(compileSave(jobs).patch.plan).toMatchObject({ plan: PLAN });
    expect(log.warn).toHaveBeenCalledWith(
      "mink.revamp: earlier redesigns could not be read",
      { revampId: ID, error: "connection refused" },
    );
    expect(distinctnessLines()[0][1]).toMatchObject({
      status: "skipped",
      reason: "earlier_unreadable",
    });
    // ★ Neither a wait nor a failure.
    expect(jobs.release).not.toHaveBeenCalled();
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it.each([
    ["serves none", vi.fn(async () => null)],
    [
      "throws",
      vi.fn(async () => {
        throw new Error("registry down");
      }),
    ],
  ])(
    "★ a theme the registry %s skips the check, and the plan goes on as compiled",
    async (_how, theme) => {
      const jobs = makeJobs(bakeryAt("compile"), {
        earlierPlans: vi.fn(async () => [EARLIER]),
        theme,
      });
      const twin = structuredClone(EARLIER);
      const deps = makeDeps([], {
        compile: vi.fn(() => ({ plan: twin, issues: [] })),
      });
      expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
        "ready",
      );
      expect(recordOf(jobs)).toMatchObject({
        status: "skipped",
        reason: "theme_unavailable",
        before: [],
      });
      expect(compileSave(jobs).patch.plan).toMatchObject({ plan: twin });
      expect(makeDistinct).not.toHaveBeenCalled();
    },
  );

  it("★ a check that throws keeps the plan as compiled and records the error", async () => {
    vi.mocked(makeDistinct).mockImplementationOnce(() => {
      throw new Error("bug");
    });
    const twin = structuredClone(EARLIER);
    const jobs = makeJobs(bakeryAt("compile"), {
      earlierPlans: vi.fn(async () => [EARLIER]),
    });
    const deps = makeDeps([], {
      compile: vi.fn(() => ({ plan: twin, issues: [] })),
    });
    expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
      "ready",
    );
    expect(recordOf(jobs)).toEqual({
      status: "error",
      passed: false,
      bar: null,
      before: [],
      after: [],
      changed: [],
      kept: [],
    });
    expect(compileSave(jobs).patch.plan).toMatchObject({ plan: twin });
  });

  it("★★ measures over the store's current theme, with the merchant's sections kept and the request's asks", async () => {
    const snapshot = {
      ...BASKET_SNAPSHOT,
      pages: BASKET_SNAPSHOT.pages.map((page, index) =>
        index === 0
          ? {
              ...page,
              owners: { ...page.owners, [page.sections[0].id]: "merchant" },
            }
          : page,
      ),
    } as RevampSnapshot;
    const jobs = makeJobs(bakeryAt("compile", { snapshot }), {
      earlierPlans: vi.fn(async () => [EARLIER]),
    });
    const twin = structuredClone(EARLIER);
    const deps = makeDeps([], {
      compile: vi.fn(() => ({ plan: twin, issues: [] })),
    });
    await runRevampJob({ revampId: ID, deps, jobs });
    expect(makeDistinct).toHaveBeenCalledTimes(1);
    const [theme, plan, earlier, request, context] =
      vi.mocked(makeDistinct).mock.calls[0];
    expect(theme).toBe(basket);
    expect(plan).toBe(twin);
    expect(earlier).toEqual([EARLIER]);
    expect(request).toBe(BAKERY);
    expect(context.storeId).toBe(STORE);
    expect(context.revampId).toBe(ID);
    expect([...context.keptSectionIds]).toEqual([
      snapshot.pages[0].sections[0].id,
    ]);
  });

  it("★ a compile step resumed with a compiled plan is not checked again", async () => {
    const jobs = makeJobs(
      bakeryAt("compile", {
        plan: { stage: "compiled", plan: EARLIER, productPhotoKeys: null },
      }),
      { earlierPlans: vi.fn(async () => [OLDER]) },
    );
    await runRevampJob({ revampId: ID, deps: makeDeps([]), jobs });
    expect(jobs.earlierPlans).not.toHaveBeenCalled();
    expect(makeDistinct).not.toHaveBeenCalled();
    expect(compileSave(jobs).patch).not.toHaveProperty("result");
  });

  it("★ a runner whose side effects leave the memory out (the live check's) reads it the production way", async () => {
    memory.readEarlierRevampPlans.mockResolvedValueOnce([EARLIER]);
    memory.resolveInstalledThemeDefinition.mockResolvedValueOnce(basket);
    const jobs = makeJobs(bakeryAt("compile"));
    delete jobs.earlierPlans;
    delete jobs.theme;
    const deps = makeDeps([], {
      compile: vi.fn(() => ({ plan: structuredClone(EARLIER), issues: [] })),
    });
    expect((await runRevampJob({ revampId: ID, deps, jobs })).outcome).toBe(
      "ready",
    );
    expect(memory.readEarlierRevampPlans).toHaveBeenCalledWith({
      storeId: STORE,
      revampId: ID,
      limit: REVAMP_EARLIER_PLANS_MAX,
    });
    expect(memory.resolveInstalledThemeDefinition).toHaveBeenCalledWith({
      id: "basket",
      version: basket.release.version,
    });
    expect(recordOf(jobs).status).toBe("changed");
  });
});

describe("redrawFor", () => {
  const shots = { shots: plan("x").shots };
  it("maps a refinement's photo scope to shot ids", () => {
    expect(redrawFor({ photos: "all" } as never, shots)).toEqual([
      "hero",
      "about",
    ]);
    expect(redrawFor({ photos: ["hero", "hero", ""] } as never, shots)).toEqual(
      ["hero"],
    );
    expect(redrawFor({ photos: null } as never, shots)).toBeNull();
    expect(redrawFor(null, shots)).toBeNull();
    expect(redrawFor(undefined, shots)).toBeNull();
  });
});
