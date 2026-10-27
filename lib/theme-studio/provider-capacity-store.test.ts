// The SQL the shared capacity sends, rendered without a database. The opt-in
// provider-capacity-postgres.test.ts runs the same statements for real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const db = vi.hoisted(() => ({
  sent: [] as { sql: string; params: unknown[] }[],
  /** Rows a statement answers with, chosen by its text. */
  answer: (() => []) as (text: string) => Record<string, unknown>[],
}));
vi.mock("@/lib/db/client", () => ({
  withService: async (work: (handle: unknown) => Promise<unknown>) =>
    work({
      execute: async (statement: SQL) => {
        const query = new PgDialect().sqlToQuery(statement);
        const text = query.sql.replace(/\s+/g, " ").trim();
        db.sent.push({ sql: text, params: query.params });
        return { rows: db.answer(text) };
      },
    }),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

import { logInfo } from "@/lib/observability/logger";
import {
  IMAGE_START_PACING,
  providerCapacityKey,
  type CapacityLease,
} from "./provider-capacity";
import {
  PACE_LOG_MIN_CHANGE_MS,
  postgresCapacityStore,
  sharedProviderCapacity,
} from "./provider-capacity-store";

const LEASE: CapacityLease = {
  id: "8f2b1c55-62b9-4a2a-9d2c-0f6a3a1f0c11",
  epoch: 7,
};

beforeEach(() => {
  db.sent = [];
  db.answer = (text) =>
    text.includes("insert into public.theme_studio_provider_leases")
      ? [{ ...LEASE }]
      : text.startsWith(
            "delete from public.theme_studio_provider_leases where scope_key=$1 and id=",
          )
        ? [{ id: LEASE.id }]
        : [];
});

const statement = (fragment: string) =>
  db.sent.find((sent) => sent.sql.includes(fragment));

async function oneCall(model: string, options?: { scope?: string }) {
  await sharedProviderCapacity("project", "global", model, options).run(
    async (permit) => {
      await permit.rateLimited(120_000);
      permit.succeeded();
    },
    new AbortController().signal,
  );
}

describe("sharedProviderCapacity", () => {
  it("★★ start-paces an image model: the claim waits for the next start and stamps the one after it", async () => {
    await oneCall("gemini-3-pro-image");
    const claim = statement("insert into public.theme_studio_provider_leases");
    expect(claim?.sql).toContain("and c.next_start_at<=clock_timestamp()");
    expect(claim?.sql).toContain(
      "spaced as ( update public.theme_studio_provider_capacity set next_start_at=clock_timestamp()+gap_ms*interval '1 millisecond'",
    );
    // ★★ Only an ADMISSION stamps the next start. A claim refused for its
    //   start that stamped it anyway would push the start a gap past every
    //   other waiter's wake time, and two waiters would hold each other off
    //   the key for good (the opt-in Postgres test runs it for real).
    expect(claim?.sql).toMatch(
      /spaced as \( update public\.theme_studio_provider_capacity set next_start_at=clock_timestamp\(\)\+gap_ms\*interval '1 millisecond', updated_at=now\(\) where scope_key=\$\d+ and exists \(select 1 from admitted\) returning 1\) select id, epoch from admitted$/,
    );
    expect(claim?.params).toContain(
      providerCapacityKey("project", "global", "gemini-3-pro-image"),
    );
  });

  it("★★ leaves a text model on plain permits: no statement names the pace", async () => {
    await oneCall("gemini-3.8-flash");
    expect(db.sent.length).toBeGreaterThan(0);
    for (const sent of db.sent) {
      expect(sent.sql).not.toMatch(/next_start_at|gap_ms/);
    }
  });

  it("★ a scope queues on a row of its own (the revamp planner)", async () => {
    await oneCall("gemini-3.8-flash", { scope: "revamp-planner" });
    const keys = new Set(
      db.sent
        .filter((sent) => sent.sql.includes("theme_studio_capacity_lock"))
        .map((sent) => sent.params[0]),
    );
    expect([...keys]).toEqual([
      providerCapacityKey(
        "project",
        "global",
        "gemini-3.8-flash",
        "revamp-planner",
      ),
    ]);
  });

  /** The gaps the paced pause and release statements answer with. */
  function answerGaps(
    refusal: [before: number, after: number],
    success: [before: number, after: number],
  ) {
    const base = db.answer;
    db.answer = (text) =>
      !text.includes("returning (select gap_ms from before)")
        ? base(text)
        : text.includes("set capacity=1,")
          ? [{ gap_before: refusal[0], gap_after: refusal[1], epoch: 8 }]
          : [{ gap_before: success[0], gap_after: success[1], epoch: 8 }];
  }

  it("★★ logs an image key's gap each time it moves: the model, never the project", async () => {
    answerGaps([10_000, 15_000], [15_000, 13_500]);
    await oneCall("gemini-3-pro-image", { scope: "night" });
    expect(vi.mocked(logInfo).mock.calls).toEqual([
      [
        "theme_studio.provider_pace",
        {
          model: "gemini-3-pro-image",
          location: "global",
          scope: "night",
          outcome: "rate_limited",
          gapBeforeMs: 10_000,
          gapAfterMs: 15_000,
          refusals: 8,
        },
      ],
      [
        "theme_studio.provider_pace",
        {
          model: "gemini-3-pro-image",
          location: "global",
          scope: "night",
          outcome: "success",
          gapBeforeMs: 15_000,
          gapAfterMs: 13_500,
          refusals: 8,
        },
      ],
    ]);
    expect(JSON.stringify(vi.mocked(logInfo).mock.calls)).not.toContain(
      "project",
    );
  });

  it("★ stays quiet when a gap moves less than a second: at a bound, or the last step onto one", async () => {
    expect(PACE_LOG_MIN_CHANGE_MS).toBe(1_000);
    // A refusal at the ceiling moves nothing; a success onto the floor 0.5 s.
    answerGaps([45_000, 45_000], [10_500, 10_000]);
    await oneCall("gemini-3-pro-image");
    expect(logInfo).not.toHaveBeenCalled();
    // A move of exactly a second is a line (no scope: none named).
    answerGaps([44_000, 45_000], [11_000, 10_000]);
    await oneCall("gemini-3.1-flash-image");
    expect(vi.mocked(logInfo).mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ outcome: "rate_limited", gapAfterMs: 45_000 }),
      expect.objectContaining({ outcome: "success", gapAfterMs: 10_000 }),
    ]);
    expect(vi.mocked(logInfo).mock.calls[0][1]).not.toHaveProperty("scope");
  });

  it("★ never logs a text model's pace: it has none", async () => {
    answerGaps([10_000, 15_000], [15_000, 13_500]);
    await oneCall("gemini-3.8-flash");
    expect(logInfo).not.toHaveBeenCalled();
  });
});

describe("postgresCapacityStore", () => {
  it("answers a paced key's wait as the later of its pause and its next start", async () => {
    db.answer = (text) =>
      text.includes("as delay") ? [{ delay: 38_500 }] : [];
    await expect(
      postgresCapacityStore.claim("k", LEASE.id, IMAGE_START_PACING),
    ).resolves.toEqual({ retryAfterMs: 38_500 });
    expect(statement("as delay")?.sql).toContain(
      "greatest(pause_until,next_start_at)-clock_timestamp()",
    );
    db.sent = [];
    await postgresCapacityStore.claim("k", LEASE.id, null);
    expect(statement("as delay")?.sql).toContain(
      "greatest(pause_until)-clock_timestamp()",
    );
  });

  it("★★ a success gives back one permit, and narrows a paced gap 10% down to 10 s, fenced on the epoch", async () => {
    db.answer = (text) =>
      text.startsWith(
        "delete from public.theme_studio_provider_leases where scope_key=$1 and id=",
      )
        ? [{ id: LEASE.id }]
        : text.includes("returning (select gap_ms from before)")
          ? [{ gap_before: 40_000, gap_after: 36_000, epoch: LEASE.epoch }]
          : [];
    await expect(
      postgresCapacityStore.release("k", LEASE, true, IMAGE_START_PACING),
    ).resolves.toEqual({
      outcome: "success",
      gapBeforeMs: 40_000,
      gapAfterMs: 36_000,
      epoch: LEASE.epoch,
    });
    const update = statement("update public.theme_studio_provider_capacity");
    // ★ The gap before and after come back from this one statement.
    expect(update?.sql).toMatch(
      /^with before as \(select gap_ms from public\.theme_studio_provider_capacity where scope_key=\$1\) update public\.theme_studio_provider_capacity set capacity=least\(\$/,
    );
    expect(update?.sql).toContain("capacity+1), successes=0");
    expect(update?.sql).toContain(
      "next_start_at=next_start_at-(gap_ms-least($",
    );
    expect(update?.sql).toContain("gap_ms=least($");
    expect(update?.sql).toContain("CASE WHEN epoch > 0 AND pause_until +");
    expect(update?.sql).toContain("> statement_timestamp() THEN");
    expect(update?.params).toContain(600_000);
    expect(update?.params).toContain(40_000);
    expect(update?.sql).toContain("and epoch=$");
    expect(update?.sql).toMatch(
      / returning \(select gap_ms from before\) as gap_before, gap_ms as gap_after, epoch$/,
    );
    expect(update?.params).toEqual([
      "k",
      3,
      45_000,
      600_000,
      40_000,
      10_000,
      0.9,
      45_000,
      600_000,
      40_000,
      10_000,
      0.9,
      "k",
      LEASE.epoch,
    ]);

    // A stale (fenced) success matches no row and reports nothing.
    db.answer = (text) =>
      text.startsWith("delete from public.theme_studio_provider_leases")
        ? [{ id: LEASE.id }]
        : [];
    await expect(
      postgresCapacityStore.release("k", LEASE, true, IMAGE_START_PACING),
    ).resolves.toBeNull();

    db.sent = [];
    await expect(
      postgresCapacityStore.release("k", LEASE, true, null),
    ).resolves.toBeNull();
    expect(
      statement("update public.theme_studio_provider_capacity")?.sql,
    ).not.toMatch(/gap_ms|next_start_at|returning/);

    // A failed or stale release changes nothing.
    db.sent = [];
    await expect(
      postgresCapacityStore.release("k", LEASE, false, IMAGE_START_PACING),
    ).resolves.toBeNull();
    expect(statement("update public.theme_studio_provider_capacity")).toBe(
      undefined,
    );
  });

  it("★★ a refusal pauses the others 15 s at most and widens a paced gap 1.5x up to 45 s", async () => {
    db.answer = (text) =>
      text.includes("returning (select gap_ms from before)")
        ? [{ gap_before: 36_000, gap_after: 45_000, epoch: 8 }]
        : [];
    await expect(
      postgresCapacityStore.pause("k", 120_000, IMAGE_START_PACING),
    ).resolves.toEqual({
      outcome: "rate_limited",
      gapBeforeMs: 36_000,
      gapAfterMs: 45_000,
      epoch: 8,
    });
    const update = statement("update public.theme_studio_provider_capacity");
    expect(update?.sql).toMatch(
      /^with before as \(select gap_ms from public\.theme_studio_provider_capacity where scope_key=\$1\) update public\.theme_studio_provider_capacity set capacity=1, successes=0, epoch=epoch\+1/,
    );
    // Never past the ceiling, even over a longer pause already on the row.
    expect(update?.sql).toContain("pause_until=least( greatest(pause_until");
    expect(update?.sql).toContain("gap_ms=least($");
    expect(update?.sql).toMatch(
      / returning \(select gap_ms from before\) as gap_before, gap_ms as gap_after, epoch$/,
    );
    expect(update?.params).toEqual([
      "k",
      15_000,
      15_000,
      45_000,
      40_000,
      1.5,
      45_000,
      40_000,
      1.5,
      "k",
    ]);

    db.sent = [];
    db.answer = () => [];
    await expect(
      postgresCapacityStore.pause("k", 7_500, null),
    ).resolves.toBeNull();
    const plain = statement("update public.theme_studio_provider_capacity");
    expect(plain?.params).toEqual([7_500, 15_000, "k"]);
    expect(plain?.sql).not.toMatch(/gap_ms|next_start_at|returning/);

    for (const bad of [Number.NaN, -1, 120_001]) {
      await expect(postgresCapacityStore.pause("k", bad)).rejects.toThrow(
        "Invalid provider cooldown",
      );
    }
  });

  it("★ an answer without readable gaps reports nothing rather than a made-up change", async () => {
    db.answer = (text) =>
      text.includes("returning (select gap_ms from before)")
        ? [{ gap_before: null, gap_after: 45_000, epoch: 8 }]
        : [];
    await expect(
      postgresCapacityStore.pause("k", 7_500, IMAGE_START_PACING),
    ).resolves.toBeNull();
  });
});
