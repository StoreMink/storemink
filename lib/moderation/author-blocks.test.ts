import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import {
  AUTHOR_GUARD_MESSAGES,
  authorBlockRefusal,
  authorBlockSentence,
  liveAuthorBlock,
} from "./author-blocks";
import { SHOPPER } from "./copy";

const STORE = "a0000000-0000-4000-8000-000000000001";
const PRODUCT = "0e7e2a3c-1b2c-4d5e-8f90-123456789abc";

function useDb(mock: ReturnType<typeof makeDbMock>) {
  vi.mocked(withService).mockImplementation(async (fn) => fn(mock.db));
}

function compiled(where: unknown) {
  return new PgDialect().sqlToQuery(where as never);
}

function guardError(message: string, code = "P0001") {
  return Object.assign(new Error("Failed query: insert into ..."), {
    cause: Object.assign(new Error(message), { code }),
  });
}

describe("liveAuthorBlock", () => {
  beforeEach(() => {
    useDb(makeDbMock());
  });

  it("answers the live block that names this author on this item", async () => {
    const mock = makeDbMock({ selectQueue: [[{ id: "block-1" }]] });
    useDb(mock);
    const block = await liveAuthorBlock({
      kind: "review",
      storeId: STORE,
      authorUserId: " user-1 ",
      parentItemId: PRODUCT,
    });
    expect(block).toEqual({ blockId: "block-1" });
    const query = compiled(mock.calls.where[0]);
    expect(query.sql).toContain('"content_blocks"."lifted_at" is null');
    expect(query.sql).toContain('"content_blocks"."item_kind" = $1');
    expect(query.sql).toContain('"content_blocks"."author_user_id" = $2');
    expect(query.sql).toContain('"content_blocks"."parent_item_id" = $3');
    expect(query.sql).toContain('"content_blocks"."store_id" = $4');
    expect(query.params).toEqual(["review", "user-1", PRODUCT, STORE]);
    expect(mock.calls.limit).toEqual([1]);
  });

  it("answers null when no live block names them", async () => {
    const mock = makeDbMock({ selectQueue: [[]] });
    useDb(mock);
    const block = await liveAuthorBlock({
      kind: "blog_comment",
      storeId: STORE,
      authorUserId: "user-1",
      parentItemId: PRODUCT,
    });
    expect(block).toBeNull();
    expect(compiled(mock.calls.where[0]).params[0]).toBe("blog_comment");
  });

  it("does not ask when an id cannot name a row", async () => {
    for (const input of [
      { storeId: STORE, authorUserId: "user-1", parentItemId: "p1" },
      { storeId: "store", authorUserId: "user-1", parentItemId: PRODUCT },
      { storeId: STORE, authorUserId: "  ", parentItemId: PRODUCT },
    ]) {
      expect(await liveAuthorBlock({ kind: "review", ...input })).toBeNull();
    }
    expect(withService).not.toHaveBeenCalled();
  });

  it("answers null and logs when the read fails (the guard still refuses)", async () => {
    const mock = makeDbMock({ selectQueue: [new Error("connection reset")] });
    useDb(mock);
    const block = await liveAuthorBlock({
      kind: "review",
      storeId: STORE,
      authorUserId: "user-1",
      parentItemId: PRODUCT,
    });
    expect(block).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "moderation.author_blocks: pre-check failed",
      expect.anything(),
      { kind: "review", storeId: STORE },
    );
  });

  it("answers null quietly before the takedown tables exist", async () => {
    const missing = Object.assign(new Error("no table"), { code: "42P01" });
    useDb(makeDbMock({ selectQueue: [missing] }));
    const block = await liveAuthorBlock({
      kind: "review",
      storeId: STORE,
      authorUserId: "user-1",
      parentItemId: PRODUCT,
    });
    expect(block).toBeNull();
    expect(logError).not.toHaveBeenCalled();
  });
});

describe("authorBlockRefusal", () => {
  it("reads the review guard's refusal as the shopper's sentence", () => {
    expect(authorBlockRefusal(guardError(AUTHOR_GUARD_MESSAGES.review))).toBe(
      SHOPPER.reviewRemoved,
    );
  });

  it("reads the comment guard's refusal as the shopper's sentence", () => {
    expect(
      authorBlockRefusal(guardError(AUTHOR_GUARD_MESSAGES.blog_comment)),
    ).toBe(SHOPPER.commentRemoved);
  });

  it("reads an unwrapped guard error too", () => {
    const err = Object.assign(new Error(AUTHOR_GUARD_MESSAGES.review), {
      code: "P0001",
    });
    expect(authorBlockRefusal(err)).toBe(SHOPPER.reviewRemoved);
  });

  it("leaves every other error alone", () => {
    expect(authorBlockRefusal(guardError("something else"))).toBeNull();
    expect(
      authorBlockRefusal(guardError(AUTHOR_GUARD_MESSAGES.review, "23505")),
    ).toBeNull();
    expect(authorBlockRefusal(new Error("boom"))).toBeNull();
    expect(authorBlockRefusal("boom")).toBeNull();
    expect(authorBlockRefusal(null)).toBeNull();
  });
});

describe("authorBlockSentence", () => {
  it("gives the two sentences of design 7.4", () => {
    expect(authorBlockSentence("review")).toBe(SHOPPER.reviewRemoved);
    expect(authorBlockSentence("blog_comment")).toBe(SHOPPER.commentRemoved);
  });
});

describe("the guard's messages", () => {
  it("match what migration 0269 raises, word for word", () => {
    const migration = readFileSync(
      join(
        process.cwd(),
        "drizzle/migrations/sql/20261030_0269_content_takedown.sql",
      ),
      "utf8",
    );
    for (const message of Object.values(AUTHOR_GUARD_MESSAGES)) {
      expect(migration).toContain(`message = '${message}'`);
    }
  });
});
