import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => unknown) =>
    fn({ execute: h.execute }),
  ),
}));

import { withService } from "@/lib/db/client";
import {
  HELP_FEEDBACK_ANSWER_MAX,
  HELP_FEEDBACK_PAGE_SIZE,
  HELP_FEEDBACK_QUESTION_MAX,
  countHelpFeedback,
  listHelpFeedback,
  normalizeHelpFeedback,
  saveHelpFeedback,
  type NormalizedHelpFeedback,
} from "./assistant-feedback";

const UNREADABLE = { ok: false, error: "That rating couldn't be read." };
const CONVERSATION = "conv_12345678";
const MESSAGE = "msg-abcdefgh";

function input(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: CONVERSATION,
    messageKey: MESSAGE,
    rating: "up",
    language: "hi",
    question: "How do I add a product?",
    answer: "Open Products and select Add product.",
    sources: [
      {
        title: "Add a product",
        url: "/help/products/add-a-product",
        category: "Products",
      },
    ],
    ...overrides,
  };
}

function normalized(raw: unknown): NormalizedHelpFeedback {
  const result = normalizeHelpFeedback(raw);
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.value;
}

const query = (call = 0) =>
  new PgDialect().sqlToQuery(h.execute.mock.calls[call][0]);

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

beforeEach(() => {
  h.execute.mockResolvedValue({ rows: [] });
});

describe("normalizeHelpFeedback", () => {
  it("accepts a well-formed rating and keeps exactly the stored fields", () => {
    const result = normalizeHelpFeedback({ ...input(), extra: "dropped" });
    expect(result).toEqual({
      ok: true,
      value: {
        conversationId: CONVERSATION,
        messageKey: MESSAGE,
        rating: "up",
        language: "hi",
        question: "How do I add a product?",
        answer: "Open Products and select Add product.",
        sources: [
          {
            title: "Add a product",
            url: "/help/products/add-a-product",
            category: "Products",
          },
        ],
      },
    });
  });

  it.each([null, undefined, "rating", 7, true])(
    "refuses %j, which is not an object",
    (raw) => {
      expect(normalizeHelpFeedback(raw)).toEqual(UNREADABLE);
    },
  );

  it.each([
    ["a short conversation id", { conversationId: "abc" }],
    ["a long conversation id", { conversationId: "x".repeat(65) }],
    ["a conversation id with spaces", { conversationId: "conv 12345678" }],
    ["a numeric conversation id", { conversationId: 1234567890 }],
    ["a missing conversation id", { conversationId: undefined }],
    ["a short message key", { messageKey: "k" }],
    ["a message key with a slash", { messageKey: "msg/12345678" }],
    ["a numeric message key", { messageKey: 12345678 }],
  ])("refuses %s", (_label, overrides) => {
    expect(normalizeHelpFeedback(input(overrides))).toEqual(UNREADABLE);
  });

  it("accepts ids at both length bounds", () => {
    expect(
      normalizeHelpFeedback(
        input({ conversationId: "a".repeat(8), messageKey: "b".repeat(64) }),
      ).ok,
    ).toBe(true);
  });

  it("accepts up and down", () => {
    expect(normalized(input({ rating: "up" })).rating).toBe("up");
    expect(normalized(input({ rating: "down" })).rating).toBe("down");
  });

  it.each([undefined, "sideways", "UP", 1, true, ""])(
    "refuses the rating %j",
    (rating) => {
      expect(normalizeHelpFeedback(input({ rating }))).toEqual(UNREADABLE);
    },
  );

  it("accepts null, which clears a rating, even with no question or answer", () => {
    const value = normalized(
      input({ rating: null, question: "", answer: "", sources: undefined }),
    );
    expect(value).toMatchObject({
      rating: null,
      question: "",
      answer: "",
      sources: [],
    });
  });

  it.each([
    ["an empty question", { question: "" }],
    ["a whitespace question", { question: " \n\t " }],
    ["a missing question", { question: undefined }],
    ["an empty answer", { answer: "" }],
    ["a non-string answer", { answer: 42 }],
  ])("refuses a rating with %s", (_label, overrides) => {
    expect(normalizeHelpFeedback(input(overrides))).toEqual(UNREADABLE);
  });

  it("refuses a question made only of control characters", () => {
    const control = [0, 7, 0x0b, 0x1f, 0x7f]
      .map((code) => String.fromCharCode(code))
      .join("");
    expect(normalizeHelpFeedback(input({ question: control }))).toEqual(
      UNREADABLE,
    );
  });

  it("cleans the text: control characters, runs of spaces, blank lines and edges", () => {
    const nul = String.fromCharCode(0);
    const bell = String.fromCharCode(7);
    const del = String.fromCharCode(0x7f);
    const value = normalized(
      input({
        question: `  How${nul} do\t\tI  add${bell} a product?${del}  `,
        answer: "Step one.\n\n\n\n\nStep two.",
      }),
    );
    expect(value.question).toBe("How do I add a product?");
    expect(value.answer).toBe("Step one.\n\nStep two.");
  });

  it("normalises compatibility characters (NFKC)", () => {
    const value = normalized(input({ question: "Ｈｏｗ do I ﬁnd my orders?" }));
    expect(value.question).toBe("How do I find my orders?");
  });

  it("bounds the question and the answer to the table's limits", () => {
    expect(HELP_FEEDBACK_QUESTION_MAX).toBe(1200);
    expect(HELP_FEEDBACK_ANSWER_MAX).toBe(4000);
    const value = normalized(
      input({ question: "q".repeat(5_000), answer: "a".repeat(9_000) }),
    );
    expect(value.question).toHaveLength(HELP_FEEDBACK_QUESTION_MAX);
    expect(value.answer).toHaveLength(HELP_FEEDBACK_ANSWER_MAX);
  });

  it.each([
    ["an unknown code", "fr"],
    ["an upper-case code", "HI"],
    ["a number", 3],
    ["null", null],
    ["nothing", undefined],
  ])("stores no language for %s", (_label, language) => {
    expect(normalized(input({ language })).language).toBeNull();
  });

  it.each(["en", "hi", "bn", "ta", "te", "mr", "gu", "kn", "pa"])(
    "keeps the language %s",
    (language) => {
      expect(normalized(input({ language })).language).toBe(language);
    },
  );

  it("keeps only Help Centre sources with a title, at most six, in order", () => {
    const good = (n: number) => ({
      title: ` Guide ${n} `,
      url: `/help/topic-${n}/guide-${n}`,
      category: n === 0 ? "   " : `Topic ${n}`,
    });
    const value = normalized(
      input({
        sources: [
          null,
          "a string",
          { title: "Off site", url: "https://example.com/help/a" },
          { title: "Script", url: "javascript:alert(1)" },
          { title: "Climbs out", url: "/help/../admin" },
          { title: "Capitals", url: "/help/Products" },
          { title: "Too deep", url: "/help/a/b/c" },
          { title: "", url: "/help/products" },
          { url: "/help/products" },
          { title: "Category page", url: "/help/products" },
          ...Array.from({ length: 8 }, (_, n) => good(n)),
        ],
      }),
    );
    expect(value.sources).toHaveLength(6);
    expect(value.sources[0]).toEqual({
      title: "Category page",
      url: "/help/products",
      category: null,
    });
    expect(value.sources[1]).toEqual({
      title: "Guide 0",
      url: "/help/topic-0/guide-0",
      category: null,
    });
    expect(value.sources[2]).toEqual({
      title: "Guide 1",
      url: "/help/topic-1/guide-1",
      category: "Topic 1",
    });
    expect(value.sources.at(-1)?.title).toBe("Guide 4");
  });

  it("bounds a source's title and category", () => {
    const [source] = normalized(
      input({
        sources: [
          {
            title: "t".repeat(500),
            url: "/help/products",
            category: "c".repeat(500),
          },
        ],
      }),
    ).sources;
    expect(source.title).toHaveLength(200);
    expect(source.category).toHaveLength(120);
  });

  it("stores no sources when they are not a list", () => {
    expect(normalized(input({ sources: { title: "x" } })).sources).toEqual([]);
    expect(normalized(input({ sources: "x" })).sources).toEqual([]);
  });
});

describe("saveHelpFeedback", () => {
  it("deletes the row when the rating is cleared", async () => {
    await saveHelpFeedback(normalized(input({ rating: null })));
    expect(withService).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
    const { sql, params } = query();
    expect(flat(sql)).toMatch(
      /^DELETE FROM public\.help_assistant_feedback WHERE conversation_id = \$1 AND message_key = \$2$/,
    );
    expect(params).toEqual([CONVERSATION, MESSAGE]);
  });

  it("inserts or updates the one row per answer", async () => {
    const value = normalized(input({ rating: "down" }));
    await saveHelpFeedback(value);
    const { sql, params } = query();
    expect(flat(sql)).toContain(
      "INSERT INTO public.help_assistant_feedback (conversation_id, message_key, rating, language, question, answer, sources)",
    );
    expect(flat(sql)).toContain("$7::jsonb");
    expect(flat(sql)).toContain(
      "ON CONFLICT (conversation_id, message_key) DO UPDATE",
    );
    expect(flat(sql)).toContain("updated_at = now()");
    expect(params).toEqual([
      CONVERSATION,
      MESSAGE,
      "down",
      "hi",
      "How do I add a product?",
      "Open Products and select Add product.",
      JSON.stringify(value.sources),
    ]);
  });

  it("throws when the database fails", async () => {
    h.execute.mockRejectedValueOnce(new Error("connection reset"));
    await expect(saveHelpFeedback(normalized(input()))).rejects.toThrow(
      "connection reset",
    );
  });
});

describe("listHelpFeedback", () => {
  function row(n: number, overrides: Record<string, unknown> = {}) {
    return {
      id: n,
      rating: "up",
      language: "en",
      question: `Question ${n}`,
      answer: `Answer ${n}`,
      sources: [],
      created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, n)),
      updated_at: "2026-10-02T00:00:00.000Z",
      ...overrides,
    };
  }

  it("reads every rating, one page plus one row, from the first page", async () => {
    await listHelpFeedback({ filter: "all", page: 1 });
    const { sql, params } = query();
    expect(flat(sql)).toContain(
      "FROM public.help_assistant_feedback WHERE true",
    );
    expect(flat(sql)).toContain("ORDER BY updated_at DESC, id");
    expect(params).toEqual([HELP_FEEDBACK_PAGE_SIZE + 1, 0]);
  });

  it.each(["up", "down"] as const)("filters to %s ratings", async (filter) => {
    await listHelpFeedback({ filter, page: 1 });
    const { sql, params } = query();
    expect(flat(sql)).toContain("WHERE rating = $1");
    expect(params).toEqual([filter, HELP_FEEDBACK_PAGE_SIZE + 1, 0]);
  });

  it.each([
    [1, 0],
    [2, 50],
    [3, 100],
    [2.7, 50],
    [0, 0],
    [-4, 0],
    [Number.NaN, 0],
  ])("reads page %s from offset %s", async (page, offset) => {
    expect(HELP_FEEDBACK_PAGE_SIZE).toBe(50);
    await listHelpFeedback({ filter: "all", page });
    expect(query().params).toEqual([HELP_FEEDBACK_PAGE_SIZE + 1, offset]);
  });

  it("says there is more only when the extra row came back, and never shows it", async () => {
    h.execute.mockResolvedValueOnce({
      rows: Array.from({ length: HELP_FEEDBACK_PAGE_SIZE + 1 }, (_, n) =>
        row(n),
      ),
    });
    const full = await listHelpFeedback({ filter: "all", page: 1 });
    expect(full.hasMore).toBe(true);
    expect(full.rows).toHaveLength(HELP_FEEDBACK_PAGE_SIZE);
    expect(full.rows.at(-1)?.id).toBe(String(HELP_FEEDBACK_PAGE_SIZE - 1));

    h.execute.mockResolvedValueOnce({
      rows: Array.from({ length: HELP_FEEDBACK_PAGE_SIZE }, (_, n) => row(n)),
    });
    const last = await listHelpFeedback({ filter: "all", page: 2 });
    expect(last.hasMore).toBe(false);
    expect(last.rows).toHaveLength(HELP_FEEDBACK_PAGE_SIZE);
  });

  it("maps each row to the console's shape", async () => {
    h.execute.mockResolvedValueOnce({
      rows: [
        row(1, {
          sources: JSON.stringify([
            { title: "Guide", url: "/help/guide", category: "Topic" },
            { title: "Off site", url: "https://example.com" },
          ]),
        }),
        row(2, {
          rating: "something else",
          language: 5,
          question: null,
          answer: undefined,
          sources: "{not json",
          created_at: "2026-10-03T00:00:00.000Z",
          updated_at: 12345,
        }),
        row(3, {
          rating: "down",
          sources: [{ title: "Listed", url: "/help/listed/page" }],
        }),
      ],
    });
    const { rows, hasMore } = await listHelpFeedback({
      filter: "all",
      page: 1,
    });
    expect(hasMore).toBe(false);
    expect(rows[0]).toEqual({
      id: "1",
      rating: "up",
      language: "en",
      question: "Question 1",
      answer: "Answer 1",
      sources: [{ title: "Guide", url: "/help/guide", category: "Topic" }],
      createdAt: "2026-10-01T00:00:01.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    });
    expect(rows[1]).toEqual({
      id: "2",
      rating: "down",
      language: null,
      question: "",
      answer: "",
      sources: [],
      createdAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "",
    });
    expect(rows[2].sources).toEqual([
      { title: "Listed", url: "/help/listed/page", category: null },
    ]);
  });

  it("throws when the database fails", async () => {
    h.execute.mockRejectedValueOnce(new Error("timeout"));
    await expect(listHelpFeedback({ filter: "all", page: 1 })).rejects.toThrow(
      "timeout",
    );
  });
});

describe("countHelpFeedback", () => {
  it("counts all-time and last-30-day ratings from one row", async () => {
    h.execute.mockResolvedValueOnce({
      rows: [{ up: 12, down: "3", last30_up: 4, last30_down: 1 }],
    });
    expect(await countHelpFeedback()).toEqual({
      up: 12,
      down: 3,
      last30Up: 4,
      last30Down: 1,
    });
    const sql = flat(query().sql);
    expect(sql).toContain("count(*) FILTER (WHERE rating = 'up')::int AS up");
    expect(sql).toContain("interval '30 days'");
    expect(sql).toContain("FROM public.help_assistant_feedback");
  });

  it("reads zero for a missing row or missing counts", async () => {
    h.execute.mockResolvedValueOnce({ rows: [] });
    expect(await countHelpFeedback()).toEqual({
      up: 0,
      down: 0,
      last30Up: 0,
      last30Down: 0,
    });
    h.execute.mockResolvedValueOnce({ rows: [{ up: 2 }] });
    expect(await countHelpFeedback()).toEqual({
      up: 2,
      down: 0,
      last30Up: 0,
      last30Down: 0,
    });
  });
});
