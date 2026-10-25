import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";
import {
  minkDraftCreditUsage,
  minkDrafts,
  minkMessages,
  minkRevamps,
  minkRuns,
  minkUsageLedger,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError, logWarn } from "@/lib/observability/logger";
import { MINK_STALE_RUN_MS } from "./conversation-history";
import {
  MINK_STALE_RUN_SWEEP_LIMIT,
  closeStaleMinkRuns,
  failMinkRun,
} from "./persistence";
import type { MinkActorContext } from "./types";

// ---------------------------------------------------------------------------
// B4: a chat run that fails or is stopped KEEPS the storefront redesign it
// started and saves the redesign's card as its answer. B7: a run a dead server
// left "running" is closed through the same record. The behaviour is proven
// against Postgres in persistence.local.test.ts; these pin, without a
// database, the rules that test cannot see drift in.
// ---------------------------------------------------------------------------

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const STORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REVAMP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_DRAFT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONVERSATION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const actor = { storeId: STORE, adminId: "owner" } as MinkActorContext;
let mock: ReturnType<typeof makeDbMock>;

function lockedRun(status = "cancelled") {
  return {
    id: RUN,
    storeId: STORE,
    conversationId: CONVERSATION,
    requestedBy: "owner",
    model: "fixture",
    status,
  };
}

type DraftFixture = { id: string; card: boolean };

/**
 * The redesign tables' reads, in order: which drafts are cards (asked only
 * when the run has drafts), then the live redesigns the run started.
 */
function revampReads(
  drafts: DraftFixture[],
  revamps: Array<{ id: string; kind: string; status: string }>,
) {
  const cards = drafts
    .filter((draft) => draft.card)
    .map((draft) => ({ id: draft.id, draftId: draft.id }));
  return drafts.length > 0 ? [cards, revamps] : [revamps];
}

/**
 * A database the failure record reads: the run it closes, the run's drafts,
 * the redesigns it started. `closed` decides whether this call closed the run.
 */
function database(input: {
  closed?: boolean;
  runStatus?: string;
  drafts?: DraftFixture[];
  revamps?: Array<{ id: string; kind: string; status: string }>;
  failDeleteFor?: unknown[];
}) {
  const drafts = input.drafts ?? [];
  mock = makeDbMock({
    returningQueue: [input.closed === false ? [] : [{ id: RUN }]],
    selectByTable: {
      mink_runs: [[lockedRun(input.runStatus)]],
      mink_drafts: [drafts.map((draft) => ({ id: draft.id }))],
      mink_revamps: revampReads(drafts, input.revamps ?? []),
      mink_draft_credit_usage: [[{ charged: 0, proposals: 0 }]],
    },
    failDeleteFor: input.failDeleteFor,
  });
  vi.mocked(withService).mockImplementation(async (fn) => fn(mock.db));
}

async function fail(status: "failed" | "cancelled" = "cancelled") {
  return failMinkRun({
    actor,
    started: { conversationId: CONVERSATION, runId: RUN },
    status,
    errorCode: status === "cancelled" ? "cancelled" : "run_timeout",
    latencyMs: 10,
    model: "fixture",
    pricingLocation: "global",
    progress: {
      steps: 1,
      toolCalls: 1,
      retryCount: 0,
      usage: {
        promptTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        basePromptTokens: 0,
      },
    },
    usageStatus: "unavailable",
  });
}

/** The SQL a fragment compiles to: the db mock never parses SQL. */
const compiled = (fragment: unknown) =>
  new PgDialect().sqlToQuery(fragment as SQL).sql;

function discardCalls() {
  return mock.calls.execute.filter((query) =>
    sqlText(query).includes("discard_failed_mink_run_drafts"),
  );
}

function insertedMessages() {
  return mock.calls.insert
    .map((table, index) => ({ table, values: mock.calls.values[index] }))
    .filter((call) => call.table === minkMessages)
    .map((call) => call.values as Record<string, unknown>);
}

beforeEach(() => {
  vi.mocked(logWarn).mockClear();
  vi.mocked(logError).mockClear();
});

describe("B4: a failed or stopped run keeps the redesign it started", () => {
  it("★ never cancels, asks to stop or refunds the redesign", async () => {
    database({ revamps: [{ id: REVAMP, kind: "full", status: "running" }] });
    await fail();
    // Nothing writes the redesign: it is read, never updated.
    expect(mock.calls.update).not.toContain(minkRevamps);
  });

  it("★ saves one plain line with the redesign's card, marked as kept", async () => {
    database({ revamps: [{ id: REVAMP, kind: "full", status: "running" }] });
    const record = await fail();
    const messages = insertedMessages();
    expect(messages).toHaveLength(1);
    const artifact = {
      type: "storefront_revamp",
      revampId: REVAMP,
      kind: "full",
      status: "running",
    };
    expect(messages[0]).toMatchObject({
      storeId: STORE,
      conversationId: CONVERSATION,
      runId: RUN,
      role: "assistant",
      model: null,
      contentJson: {
        text: "Your storefront redesign is being made. You can follow it here.",
        artifacts: [artifact],
        interrupted: true,
      },
    });
    // ★ Dated just after the run's own messages, not at the moment of the close.
    const createdAt = compiled(messages[0].createdAt);
    expect(createdAt).toContain(
      'coalesce(max("mink_messages"."created_at"), now())',
    );
    expect(createdAt).toContain("interval '1 millisecond'");
    expect(sqlParamValues(messages[0].createdAt)).toEqual([RUN, STORE]);
    expect(record).toEqual({
      closed: true,
      card: {
        text: "Your storefront redesign is being made. You can follow it here.",
        artifacts: [artifact],
      },
    });
  });

  it("says ready when every kept redesign is ready", async () => {
    database({
      drafts: [{ id: REVAMP, card: true }],
      revamps: [{ id: REVAMP, kind: "refine", status: "ready" }],
    });
    const record = await fail("failed");
    expect(record.card?.text).toBe(
      "Your storefront redesign is ready. You can review it here.",
    );
  });

  it("★ reads only this store's redesigns that this run started and that are still live", async () => {
    database({ revamps: [{ id: REVAMP, kind: "full", status: "queued" }] });
    await fail();
    const revampRead = mock.calls.where.find((where) => {
      const values = sqlParamValues(where);
      return values.includes("queued") && values.includes(RUN);
    });
    expect(sqlParamValues(revampRead)).toEqual([
      STORE,
      RUN,
      "queued",
      "running",
      "ready",
    ]);
  });

  it("saves no card when the run started no redesign", async () => {
    database({});
    const record = await fail();
    expect(insertedMessages()).toHaveLength(0);
    expect(record).toEqual({ closed: true, card: null });
  });

  it("★ saves no second card when another record already closed the run", async () => {
    database({
      closed: false,
      revamps: [{ id: REVAMP, kind: "full", status: "running" }],
    });
    const record = await fail();
    expect(insertedMessages()).toHaveLength(0);
    expect(record).toEqual({ closed: false, card: null });
  });

  it("drops a redesign row that does not read as a card", async () => {
    database({
      revamps: [{ id: "not-a-uuid", kind: "full", status: "ready" }],
    });
    const record = await fail();
    expect(record.card).toBeNull();
    expect(insertedMessages()).toHaveLength(0);
  });
});

describe("B4: the unseen proposals of a failed run", () => {
  it("are discarded and refunded as before when the run holds no redesign card", async () => {
    database({ drafts: [{ id: OTHER_DRAFT, card: false }] });
    await fail();
    expect(discardCalls()).toHaveLength(1);
    expect(sqlParamValues(discardCalls()[0])).toEqual([STORE, RUN]);
  });

  it("★ never discard the redesign's card draft", async () => {
    database({
      drafts: [{ id: REVAMP, card: true }],
      revamps: [{ id: REVAMP, kind: "full", status: "ready" }],
    });
    await fail();
    expect(discardCalls()).toHaveLength(0);
    expect(mock.calls.delete).toHaveLength(0);
    expect(mock.calls.insert).not.toContain(minkRuns);
  });

  it("★★ beside a card, are moved to a holder run that the function discards, so only they are refunded", async () => {
    database({
      drafts: [
        { id: REVAMP, card: true },
        { id: OTHER_DRAFT, card: false },
      ],
      revamps: [{ id: REVAMP, kind: "full", status: "ready" }],
    });
    await fail();

    const holder = mock.calls.insert
      .map((table, index) => ({ table, values: mock.calls.values[index] }))
      .find((call) => call.table === minkRuns)?.values as Record<
      string,
      unknown
    >;
    expect(holder).toMatchObject({
      storeId: STORE,
      conversationId: CONVERSATION,
      requestedBy: "owner",
      status: "cancelled",
      errorCode: "draft_discard",
    });
    const holderId = holder.id as string;
    expect(holderId).not.toBe(RUN);
    // The other proposal and its credit row move; the card stays.
    const moves = mock.calls.update
      .map((table, index) => ({ table, set: mock.calls.set[index] }))
      .filter(
        (call) =>
          call.table === minkDrafts || call.table === minkDraftCreditUsage,
      );
    expect(moves.map((move) => move.table)).toEqual([
      minkDrafts,
      minkDraftCreditUsage,
    ]);
    for (const move of moves) expect(move.set).toEqual({ runId: holderId });
    const movedWheres = mock.calls.where.filter((where) => {
      const values = sqlParamValues(where);
      return values.includes(OTHER_DRAFT) && values.includes(RUN);
    });
    expect(movedWheres).toHaveLength(2);
    for (const where of movedWheres) {
      expect(sqlParamValues(where)).toEqual([STORE, RUN, OTHER_DRAFT]);
    }
    // The function refunds only what is on the holder, which is then removed.
    expect(discardCalls()).toHaveLength(1);
    expect(sqlParamValues(discardCalls()[0])).toEqual([STORE, holderId]);
    expect(mock.calls.delete).toEqual([minkRuns]);
    expect(logError).not.toHaveBeenCalled();
  });

  it("★ beside a card, when the move is refused, are kept and named, and the record still lands", async () => {
    database({
      drafts: [
        { id: REVAMP, card: true },
        { id: OTHER_DRAFT, card: false },
      ],
      revamps: [{ id: REVAMP, kind: "full", status: "ready" }],
      failDeleteFor: [minkRuns],
    });

    const record = await fail();

    const statements = mock.calls.execute.map((query) => sqlText(query));
    expect(statements).toContain(
      "ROLLBACK TO SAVEPOINT mink_discard_beside_card",
    );
    expect(logError).toHaveBeenCalledWith(
      "mink.run: unseen proposals kept beside a redesign card",
      expect.any(Error),
      { storeId: STORE, runId: RUN, proposals: 1 },
    );
    // The card is still saved and the usage still recorded.
    expect(record.closed).toBe(true);
    expect(record.card?.artifacts[0].revampId).toBe(REVAMP);
    expect(mock.calls.insert).toContain(minkUsageLedger);
  });

  it("★ tell a card by the redesign's id or its draft_id, in this store", async () => {
    database({
      drafts: [
        { id: REVAMP, card: false },
        { id: OTHER_DRAFT, card: false },
      ],
    });
    await fail();
    const cardRead = mock.calls.where.find((where) => {
      const text = compiled(where);
      return text.includes('"mink_revamps"."draft_id" in');
    });
    const text = compiled(cardRead);
    expect(text).toContain('"mink_revamps"."store_id" = $1');
    expect(text).toContain('"mink_revamps"."id" in ($2, $3)');
    expect(text).toContain('"mink_revamps"."draft_id" in ($4, $5)');
    expect(sqlParamValues(cardRead)).toEqual([
      STORE,
      REVAMP,
      OTHER_DRAFT,
      REVAMP,
      OTHER_DRAFT,
    ]);
  });

  it("★ a draft named only by a redesign's draft_id is a card", async () => {
    mock = makeDbMock({
      returningQueue: [[{ id: RUN }]],
      selectByTable: {
        mink_runs: [[lockedRun()]],
        mink_drafts: [[{ id: OTHER_DRAFT }]],
        mink_revamps: [
          [{ id: REVAMP, draftId: OTHER_DRAFT }],
          [{ id: REVAMP, kind: "full", status: "ready" }],
        ],
        mink_draft_credit_usage: [[{ charged: 0, proposals: 0 }]],
      },
    });
    vi.mocked(withService).mockImplementation(async (fn) => fn(mock.db));
    await fail();
    expect(discardCalls()).toHaveLength(0);
  });

  it("asks nothing about cards when the run has no drafts", async () => {
    database({ revamps: [{ id: REVAMP, kind: "full", status: "queued" }] });
    await fail();
    const revampReadsSeen = mock.calls.where.filter((where) =>
      compiled(where).includes('"mink_revamps"'),
    );
    // Only the live-redesign read.
    expect(revampReadsSeen).toHaveLength(1);
    expect(discardCalls()).toHaveLength(1);
  });
});

describe("the failure record's run", () => {
  it("★ is locked FOR UPDATE, scoped to this store and run", async () => {
    database({});
    await fail();
    expect(mock.calls.forUpdate).toEqual(["update"]);
    const lock = mock.calls.where.find((where) => {
      const values = sqlParamValues(where);
      return (
        values.length === 2 && values.includes(RUN) && values.includes(STORE)
      );
    });
    expect(lock).toBeDefined();
  });

  it("★ refuses a run that succeeded, before discarding or saving anything", async () => {
    database({
      runStatus: "succeeded",
      revamps: [{ id: REVAMP, kind: "full", status: "running" }],
    });
    await expect(fail()).rejects.toThrow(
      "Mink failed-run record scope rejected",
    );
    expect(discardCalls()).toHaveLength(0);
    expect(insertedMessages()).toHaveLength(0);
    expect(mock.calls.insert).not.toContain(minkUsageLedger);
  });

  it("clamps the latency to what the integer column holds", async () => {
    database({});
    await failMinkRun({
      actor,
      started: { conversationId: CONVERSATION, runId: RUN },
      status: "failed",
      errorCode: "run_abandoned",
      latencyMs: 9_999_999_999,
      model: "fixture",
      pricingLocation: "global",
      progress: {
        steps: 0,
        toolCalls: 0,
        retryCount: 0,
        usage: {
          promptTokens: 0,
          outputTokens: 0,
          thoughtTokens: 0,
          totalTokens: 0,
          cachedTokens: 0,
          basePromptTokens: 0,
        },
      },
      usageStatus: "unavailable",
    });
    const runSet = mock.calls.set.find(
      (set) => (set as Record<string, unknown>).errorCode === "run_abandoned",
    ) as Record<string, unknown>;
    expect(runSet.latencyMs).toBe(2_147_483_647);
  });
});

describe("B7: closing runs a dead server left running", () => {
  function deadRun(id: string, ageMs = 2_000_000) {
    return {
      id,
      storeId: STORE,
      conversationId: CONVERSATION,
      requestedBy: "owner",
      model: "fixture",
      ageMs,
      toolCalls: 2,
    };
  }

  function sweepDatabase(
    dead: ReturnType<typeof deadRun>[],
    locks: unknown[][],
  ) {
    mock = makeDbMock({
      returningQueue: dead.map(() => [{ id: "closed" }]),
      selectByTable: {
        mink_runs: [dead, ...locks],
        mink_revamps: dead.map(() => []),
        mink_drafts: dead.map(() => []),
        mink_draft_credit_usage: dead.map(() => [{ charged: 0, proposals: 0 }]),
      },
    });
    vi.mocked(withService).mockImplementation(async (fn) => fn(mock.db));
  }

  it("★ reads only runs the stale-run rule calls dead", async () => {
    sweepDatabase([], []);
    await closeStaleMinkRuns();
    const read = mock.calls.where[0];
    const text = compiled(read);
    expect(text).toContain(`"mink_runs"."status" = 'running'`);
    expect(text).toContain(`"mink_runs"."started_at" < now() -`);
    expect(text).toContain("not exists");
    expect(text).toContain(`"mink_tool_calls"."started_at" >= now() -`);
    expect(sqlParamValues(read)).toContain(MINK_STALE_RUN_MS);
  });

  it("★ closes each through the failure record, as failed with run_abandoned", async () => {
    sweepDatabase([deadRun(RUN, 3_600_000)], [[{ ...lockedRun("failed") }]]);
    const result = await closeStaleMinkRuns();
    expect(result).toEqual({ closed: 1, failed: 0 });
    const runSet = mock.calls.set.find(
      (set) => (set as Record<string, unknown>).errorCode === "run_abandoned",
    ) as Record<string, unknown>;
    expect(runSet).toMatchObject({
      status: "failed",
      errorCode: "run_abandoned",
      latencyMs: 3_600_000,
      toolCallCount: 2,
    });
    expect(discardCalls()).toHaveLength(1);
    // ★ The tool-call count names the outer run by hand (see persistence.ts).
    const projection = mock.calls.select[0] as { toolCalls: unknown };
    const count = compiled(projection.toolCalls);
    expect(count).toContain('dead_run_call.run_id = "mink_runs".id');
    expect(count).toContain('dead_run_call.store_id = "mink_runs".store_id');
    expect(logWarn).toHaveBeenCalledWith("mink.run: abandoned run closed", {
      storeId: STORE,
      runId: RUN,
      ageMs: 3_600_000,
      keptRedesign: false,
    });
  });

  it("★ is bounded: at most MINK_STALE_RUN_SWEEP_LIMIT a pass, never fewer than one", async () => {
    expect(MINK_STALE_RUN_SWEEP_LIMIT).toBe(20);
    sweepDatabase([], []);
    await closeStaleMinkRuns({ limit: 500 });
    await closeStaleMinkRuns({ limit: 3 });
    await closeStaleMinkRuns({ limit: 0 });
    await closeStaleMinkRuns();
    await closeStaleMinkRuns({ limit: Number.NaN });
    expect(mock.calls.limit).toEqual([20, 3, 1, 20, 20]);
  });

  it("is narrowed to one store, admin and conversation when asked", async () => {
    sweepDatabase([], []);
    await closeStaleMinkRuns({
      storeId: STORE,
      adminId: "owner",
      conversationId: CONVERSATION,
    });
    const values = sqlParamValues(mock.calls.where[0]);
    expect(values).toEqual(
      expect.arrayContaining([STORE, "owner", CONVERSATION]),
    );
  });

  it("logs a run it could not close and carries on with the next", async () => {
    const second = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    sweepDatabase(
      [deadRun(RUN), deadRun(second)],
      // The first lock reads a run that succeeded meanwhile: refused.
      [[lockedRun("succeeded")], [{ ...lockedRun("failed"), id: second }]],
    );
    const result = await closeStaleMinkRuns();
    expect(result).toEqual({ closed: 1, failed: 1 });
    expect(logError).toHaveBeenCalledWith(
      "mink.run: abandoned run not closed",
      expect.any(Error),
      { storeId: STORE, runId: RUN },
    );
  });
});
