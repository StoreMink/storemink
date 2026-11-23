/* eslint-disable @typescript-eslint/no-explicit-any */
// The record of submitted image jobs. A job that was submitted is paid for,
// so it is collected by the next try for the same picture, never drawn again;
// and a database that cannot be reached costs that saving, never the picture.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock } from "@/app/actions/_test-helpers";

const logger = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/observability/logger", () => logger);
const dbHolder = vi.hoisted(() => ({ current: null as any, fail: false }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => {
    if (dbHolder.fail) throw new Error("db down");
    return fn(dbHolder.current.db);
  }),
}));

import {
  GENERATION_ADOPT_WINDOW_MS,
  GENERATION_CLAIM_STALE_MS,
  noGenerationStore,
  postgresGenerationStore as store,
} from "./elevenlabs-generations";
import {
  imageProviderGenerations,
  imageProviderSubmits,
} from "@/drizzle/schema";

const NOW = new Date("2026-11-22T10:00:00.000Z");
const DIGEST = "a".repeat(64);
const render = (q: unknown) => {
  const out = new PgDialect().sqlToQuery(q as never);
  return { sql: out.sql.replace(/\s+/g, " ").trim(), params: out.params };
};

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.fail = false;
  dbHolder.current = makeDbMock({});
});

describe("claimUndelivered", () => {
  it("★★ one statement claims the oldest uncollected job for this picture in this scope", async () => {
    dbHolder.current = makeDbMock({
      executeQueue: [[{ generation_id: "gen_7" }]],
    });
    expect(await store.claimUndelivered("revamp:r1", DIGEST, NOW)).toBe(
      "gen_7",
    );
    const q = render(dbHolder.current.calls.execute[0]);
    // Only a job still `submitted`, inside the window, that no live draw holds.
    expect(q.sql).toContain("state = 'submitted'");
    expect(q.sql).toContain("for update skip locked");
    expect(q.sql).toContain("returning g.generation_id");
    expect(q.params).toEqual([
      NOW.toISOString(),
      NOW.toISOString(),
      "elevenlabs",
      "revamp:r1",
      DIGEST,
      new Date(NOW.getTime() - GENERATION_ADOPT_WINDOW_MS).toISOString(),
      new Date(NOW.getTime() - GENERATION_CLAIM_STALE_MS).toISOString(),
    ]);
  });

  it("nothing to collect is null", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[]] });
    expect(await store.claimUndelivered("revamp:r1", DIGEST, NOW)).toBeNull();
  });

  it("★★ a database that cannot be reached is 'nothing to collect', never an error", async () => {
    dbHolder.fail = true;
    expect(await store.claimUndelivered("revamp:r1", DIGEST, NOW)).toBeNull();
    expect(logger.logWarn).toHaveBeenCalledTimes(1);
  });
});

describe("recordSubmitted", () => {
  it("writes the job as submitted and held by the draw that made it", async () => {
    await store.recordSubmitted("revamp:r1", DIGEST, "gen_1", NOW);
    expect(dbHolder.current.calls.insert[0]).toBe(imageProviderGenerations);
    expect(dbHolder.current.calls.values[0]).toEqual({
      provider: "elevenlabs",
      scope: "revamp:r1",
      requestDigest: DIGEST,
      generationId: "gen_1",
      state: "submitted",
      claimedAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  it("never throws", async () => {
    dbHolder.fail = true;
    await expect(
      store.recordSubmitted("revamp:r1", DIGEST, "gen_1", NOW),
    ).resolves.toBeUndefined();
  });
});

describe("settle and release", () => {
  it("★ delivered or failed is final, written only over a job still submitted, and frees the claim", async () => {
    await store.settle("gen_1", "delivered", NOW);
    expect(dbHolder.current.calls.set[0]).toEqual({
      state: "delivered",
      claimedAt: null,
      updatedAt: NOW.toISOString(),
    });
    const where = render(dbHolder.current.calls.where[0]);
    expect(where.sql).toBe(
      '("image_provider_generations"."provider" = $1 and "image_provider_generations"."generation_id" = $2 and "image_provider_generations"."state" = $3)',
    );
    expect(where.params).toEqual(["elevenlabs", "gen_1", "submitted"]);
  });

  it("★★ release lets go of the claim and leaves the job to be collected", async () => {
    await store.release("gen_1", NOW);
    expect(dbHolder.current.calls.set[0]).toEqual({
      claimedAt: null,
      updatedAt: NOW.toISOString(),
    });
    expect(dbHolder.current.calls.set[0]).not.toHaveProperty("state");
  });

  it("neither throws when the database is down", async () => {
    dbHolder.fail = true;
    await expect(store.settle("gen_1", "failed", NOW)).resolves.toBeUndefined();
    await expect(store.release("gen_1", NOW)).resolves.toBeUndefined();
  });
});

describe("★★ the record of submits (migration 0285)", () => {
  const LOST = {
    id: "s1",
    sentAt: NOW.getTime(),
    lostAt: NOW.getTime() + 4_000,
  };

  it("a submit is written down before it leaves", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "s1" }] });
    expect(await store.openSubmit("revamp:r1", DIGEST, NOW)).toBe("s1");
    expect(dbHolder.current.calls.insert[0]).toBe(imageProviderSubmits);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      provider: "elevenlabs",
      scope: "revamp:r1",
      requestDigest: DIGEST,
      state: "sending",
      sentAt: NOW.toISOString(),
    });
  });

  it("★★ an answered submit is closed in the same scope that records its job", async () => {
    await store.recordSubmitted("revamp:r1", DIGEST, "gen_1", NOW, "s1");
    expect(dbHolder.current.calls.insert).toEqual([imageProviderGenerations]);
    expect(dbHolder.current.calls.delete).toEqual([imageProviderSubmits]);
    const { withService } = await import("@/lib/db/client");
    expect(withService).toHaveBeenCalledTimes(1);
  });

  it("with no submit row, the job is still recorded and nothing is deleted", async () => {
    await store.recordSubmitted("revamp:r1", DIGEST, "gen_1", NOW);
    expect(dbHolder.current.calls.delete).toEqual([]);
  });

  it("★★ a database that cannot be reached never stops a draw, and never lets a search take a job", async () => {
    dbHolder.fail = true;
    expect(await store.openSubmit("revamp:r1", DIGEST, NOW)).toBeNull();
    await expect(store.dropSubmit("s1")).resolves.toBeUndefined();
    await expect(store.markSubmitLost("s1", NOW)).resolves.toBeUndefined();
    await expect(store.giveUpSubmit("s1", NOW)).resolves.toBeUndefined();
    expect(await store.findLostSubmit("revamp:r1", DIGEST, NOW)).toBeNull();
    // Unreadable is "cannot tell", which a search treats as unsure.
    expect(await store.inspectWindow(LOST, ["gen_1"])).toBeNull();
    expect(
      await store.adoptFound(LOST, "revamp:r1", DIGEST, "gen_1", NOW),
    ).toBe(false);
  });
});

describe("noGenerationStore", () => {
  it("remembers nothing", async () => {
    expect(
      await noGenerationStore.claimUndelivered("s", DIGEST, NOW),
    ).toBeNull();
    await noGenerationStore.recordSubmitted("s", DIGEST, "g", NOW);
    await noGenerationStore.settle("g", "delivered", NOW);
    await noGenerationStore.release("g", NOW);
  });
});
