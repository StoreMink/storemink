import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MINK_ATTACHMENT_MARKER,
  addSavedMinkMediaReference,
} from "../lib/mink/media-attachment";
import {
  MINK_EVAL_ATTACHMENT_CHAT_ENV,
  MINK_EVAL_ATTACHMENT_ENV,
  MINK_EVAL_ATTACHMENT_PLACEHOLDER,
  MINK_EVAL_LOOKUP_LIMITS,
  isMinkAttachmentAddress,
  isMinkConversationId,
  isMinkEvalAttachmentCase,
  lookupMinkAttachmentChat,
  minkAttachmentChatReport,
  minkAttachmentIdOfAddress,
  minkMessagesHoldAttachment,
  minkStreamConversationId,
  parseMinkSse,
  planMinkAttachmentCase,
  prepareMinkEvalCase,
  scoreMinkCase,
  summarizeMinkEval,
} from "./mink-eval-core.mjs";

describe("Mink live evaluation core", () => {
  it("parses SSE and scores expected bounded tools", () => {
    const events = parseMinkSse(
      'event: tool\ndata: {"state":"running","name":"get_sales_summary"}\n\n' +
        'event: message\ndata: {"role":"assistant","text":"Sales use INR."}\n\n',
    );
    expect(
      scoreMinkCase(
        {
          id: "sales",
          category: "sales",
          expectedTools: ["get_sales_summary"],
          allowedTools: ["get_sales_summary"],
        },
        events,
        100,
      ),
    ).toMatchObject({ passed: true, calledTools: ["get_sales_summary"] });
  });

  it("fails unexpected tools and enforces the release thresholds", () => {
    const failed = scoreMinkCase(
      {
        id: "refusal",
        category: "security",
        expectedTools: [],
        allowedTools: [],
      },
      parseMinkSse(
        'event: tool\ndata: {"state":"running","name":"search_products"}\n\n',
      ),
      9_000,
    );
    expect(failed).toMatchObject({
      passed: false,
      unexpectedTools: ["search_products"],
    });
    expect(summarizeMinkEval([failed], 8_000)).toMatchObject({
      gatePassed: false,
      securityRate: 0,
      p95LatencyMs: 9_000,
    });
  });
});

const ADDRESS = "/api/mink/attachments/0f9c1c0e-6c0e-4d6a-9c2a-4b1d2e3f4a5b";

describe("preparing a case for the attachment address", () => {
  const attachmentCase = {
    id: "attachment-product-photo",
    category: "attachments",
    prompt: addSavedMinkMediaReference("Use this photo as the main photo.", {
      filename: "almond-shake.webp",
      url: MINK_EVAL_ATTACHMENT_PLACEHOLDER,
    }),
    expectedTools: ["search_products", "propose_product_images"],
    manualReview: true,
    requiresEnv: MINK_EVAL_ATTACHMENT_ENV,
  };

  it("substitutes the address the environment supplies, and nothing else", () => {
    const prepared = prepareMinkEvalCase(attachmentCase, {
      [MINK_EVAL_ATTACHMENT_ENV]: ` ${ADDRESS} `,
    });
    expect(prepared.skipped).toBe(false);
    expect(prepared.caseDef.prompt).toBe(
      addSavedMinkMediaReference("Use this photo as the main photo.", {
        filename: "almond-shake.webp",
        url: ADDRESS,
      }),
    );
    expect(prepared.caseDef.prompt).not.toContain(
      MINK_EVAL_ATTACHMENT_PLACEHOLDER,
    );
    // Every other field rides along, and the original case is not mutated.
    expect(prepared.caseDef).toMatchObject({
      id: "attachment-product-photo",
      expectedTools: ["search_products", "propose_product_images"],
      requiresEnv: MINK_EVAL_ATTACHMENT_ENV,
    });
    expect(attachmentCase.prompt).toContain(MINK_EVAL_ATTACHMENT_PLACEHOLDER);
  });

  it("skips a case whose required variable is unset or blank, naming it", () => {
    expect(prepareMinkEvalCase(attachmentCase, {})).toEqual({
      skipped: true,
      reason: `${MINK_EVAL_ATTACHMENT_ENV} is not set`,
    });
    expect(
      prepareMinkEvalCase(attachmentCase, { [MINK_EVAL_ATTACHMENT_ENV]: "  " }),
    ).toEqual({
      skipped: true,
      reason: `${MINK_EVAL_ATTACHMENT_ENV} is not set`,
    });
    // A placeholder with no `requiresEnv` is skipped too, never posted as is.
    const unmarked = { ...attachmentCase };
    delete unmarked.requiresEnv;
    expect(prepareMinkEvalCase(unmarked, {})).toEqual({
      skipped: true,
      reason: `${MINK_EVAL_ATTACHMENT_ENV} is not set`,
    });
  });

  it("leaves a case with no placeholder untouched, whatever the environment", () => {
    const plain = {
      id: "sales-today",
      category: "sales",
      prompt: "How much did I sell today?",
      expectedTools: ["get_sales_summary"],
    };
    expect(prepareMinkEvalCase(plain, {})).toEqual({
      skipped: false,
      caseDef: plain,
    });
    expect(
      prepareMinkEvalCase(plain, { [MINK_EVAL_ATTACHMENT_ENV]: ADDRESS })
        .caseDef,
    ).toBe(plain);
  });

  it("recognises an attachment address bare or with a host, and nothing else", () => {
    expect(isMinkAttachmentAddress(ADDRESS)).toBe(true);
    expect(
      isMinkAttachmentAddress(`https://echoss.storemink.com${ADDRESS}`),
    ).toBe(true);
    expect(
      isMinkAttachmentAddress(`http://echoss.localtest.me:3000${ADDRESS}`),
    ).toBe(true);
    for (const wrong of [
      "",
      "https://storage.googleapis.com/bucket/stores/x/media/photo.webp",
      "/api/mink/attachments/not-a-uuid",
      `${ADDRESS}0`,
      `${ADDRESS}/download`,
      undefined,
    ])
      expect(isMinkAttachmentAddress(wrong)).toBe(false);
  });
});

describe("★ the corpus carries the attachment exactly as the composer writes it", () => {
  const corpus = JSON.parse(
    readFileSync(join(process.cwd(), "evals/mink/read-alpha.json"), "utf8"),
  );
  const attachmentCases = corpus.cases.filter(
    (entry) => entry.requiresEnv === MINK_EVAL_ATTACHMENT_ENV,
  );

  it("has the three cases design 5.15 names, each manual and skippable", () => {
    expect(attachmentCases.map((entry) => entry.id)).toEqual([
      "attachment-product-photo",
      "attachment-product-photo-scene",
      "attachment-blog-cover",
    ]);
    for (const entry of attachmentCases) {
      expect(entry.manualReview, entry.id).toBe(true);
      expect(entry.prompt, entry.id).toContain(
        MINK_EVAL_ATTACHMENT_PLACEHOLDER,
      );
      expect(prepareMinkEvalCase(entry, {})).toEqual({
        skipped: true,
        reason: `${MINK_EVAL_ATTACHMENT_ENV} is not set`,
      });
    }
  });

  it.each(attachmentCases.map((entry) => [entry.id, entry]))(
    "%s: the prompt is the merchant's words plus the new marker and the composer's JSON",
    (_id, entry) => {
      const at = entry.prompt.indexOf(MINK_ATTACHMENT_MARKER);
      expect(at).toBeGreaterThan(0);
      const words = entry.prompt.slice(0, at);
      expect(entry.prompt).toBe(
        addSavedMinkMediaReference(words, {
          filename: "almond-shake.webp",
          url: MINK_EVAL_ATTACHMENT_PLACEHOLDER,
        }),
      );
      // After substitution it is byte for byte what a real send carries.
      const prepared = prepareMinkEvalCase(entry, {
        [MINK_EVAL_ATTACHMENT_ENV]: ADDRESS,
      });
      expect(prepared.caseDef.prompt).toBe(
        addSavedMinkMediaReference(words, {
          filename: "almond-shake.webp",
          url: ADDRESS,
        }),
      );
    },
  );

  it("every case that needs the address, and no other, is marked requiresEnv", () => {
    for (const entry of corpus.cases) {
      const carries = String(entry.prompt).includes(
        MINK_EVAL_ATTACHMENT_PLACEHOLDER,
      );
      expect(entry.requiresEnv === MINK_EVAL_ATTACHMENT_ENV, entry.id).toBe(
        carries,
      );
    }
  });
});

const PICTURE = "0f9c1c0e-6c0e-4d6a-9c2a-4b1d2e3f4a5b";
const CHAT_A = "1a2b3c4d-1111-4aaa-8bbb-000000000001";
const CHAT_B = "1a2b3c4d-2222-4aaa-8bbb-000000000002";
const CHAT_C = "1a2b3c4d-3333-4aaa-8bbb-000000000003";
const CHAT_D = "1a2b3c4d-4444-4aaa-8bbb-000000000004";

/** A user message carrying the picture exactly as the composer writes it. */
function sentPicture(words = "Use this photo.", url = ADDRESS) {
  return {
    role: "user",
    text: addSavedMinkMediaReference(words, {
      filename: "almond-shake.webp",
      url,
    }),
  };
}

const plainMessage = (text) => ({ role: "assistant", text });

/** A History reader over fixed answers by path, recording every path asked. */
function historyReader(answers) {
  const asked = [];
  const read = async (path) => {
    asked.push(path);
    const answer = answers[path];
    return answer ?? { ok: false, status: 404 };
  };
  return { read, asked };
}

const listPage = (ids, nextCursor = null) => ({
  ok: true,
  body: {
    conversations: ids.map((id) => ({ id, title: "Chat" })),
    nextCursor,
  },
});
const chatPage = (messages, earlierCursor = null) => ({
  ok: true,
  body: { conversation: { id: "x", title: "Chat", messages, earlierCursor } },
});

/** The events of an attachment case whose stream started (or used) a chat. */
const streamIn = (chatId) =>
  parseMinkSse(
    `event: status\ndata: {"state":"thinking","conversationId":"${chatId}","runId":"${CHAT_D}"}\n\n` +
      'event: message\ndata: {"role":"assistant","text":"Done."}\n\n',
  );
const httpError = (status) => [
  { event: "error", data: { code: `http_${status}` } },
];

describe("the chat the attachment cases run in", () => {
  it("recognises a chat id the stream route accepts, and nothing else", () => {
    expect(isMinkConversationId(CHAT_A)).toBe(true);
    expect(isMinkConversationId(` ${CHAT_A.toUpperCase()} `)).toBe(true);
    for (const wrong of [
      "",
      "not-a-uuid",
      `${CHAT_A}0`,
      "1a2b3c4d-1111-4aaa-7bbb-000000000001", // variant outside 8, 9, a, b
      ADDRESS,
      null,
      undefined,
      42,
    ])
      expect(isMinkConversationId(wrong), String(wrong)).toBe(false);
  });

  it("reads the picture's id out of its address, bare or with a host", () => {
    expect(minkAttachmentIdOfAddress(ADDRESS)).toBe(PICTURE);
    expect(
      minkAttachmentIdOfAddress(
        ` https://echoss.storemink.com/api/mink/attachments/${PICTURE.toUpperCase()} `,
      ),
    ).toBe(PICTURE);
    expect(minkAttachmentIdOfAddress(`${ADDRESS}/download`)).toBeNull();
    expect(minkAttachmentIdOfAddress(undefined)).toBeNull();
  });

  it("marks as attachment cases exactly those whose prompt carries the placeholder", () => {
    expect(
      isMinkEvalAttachmentCase({
        prompt: `Use ${MINK_EVAL_ATTACHMENT_PLACEHOLDER}`,
      }),
    ).toBe(true);
    expect(isMinkEvalAttachmentCase({ prompt: "How much did I sell?" })).toBe(
      false,
    );
    expect(isMinkEvalAttachmentCase({})).toBe(false);
    expect(isMinkEvalAttachmentCase(undefined)).toBe(false);
    // A prepared case no longer carries it, which is why the runner asks the
    // case as the dataset wrote it.
    const corpus = JSON.parse(
      readFileSync(join(process.cwd(), "evals/mink/read-alpha.json"), "utf8"),
    );
    expect(
      corpus.cases.filter(isMinkEvalAttachmentCase).map((entry) => entry.id),
    ).toEqual([
      "attachment-product-photo",
      "attachment-product-photo-scene",
      "attachment-blog-cover",
    ]);
    const prepared = prepareMinkEvalCase(
      corpus.cases.find(isMinkEvalAttachmentCase),
      { [MINK_EVAL_ATTACHMENT_ENV]: ADDRESS },
    );
    expect(isMinkEvalAttachmentCase(prepared.caseDef)).toBe(false);
  });

  it("finds the picture in a chat's messages, by its whole id only", () => {
    expect(minkMessagesHoldAttachment([sentPicture()], PICTURE)).toBe(true);
    expect(
      minkMessagesHoldAttachment(
        [sentPicture("Use it.", `https://echoss.storemink.com${ADDRESS}`)],
        PICTURE.toUpperCase(),
      ),
    ).toBe(true);
    // Another picture, a longer hex run, an empty chat and junk hold nothing.
    expect(
      minkMessagesHoldAttachment(
        [
          sentPicture(
            "Other.",
            "/api/mink/attachments/9f9c1c0e-6c0e-4d6a-9c2a-4b1d2e3f4a5b",
          ),
        ],
        PICTURE,
      ),
    ).toBe(false);
    expect(
      minkMessagesHoldAttachment(
        [plainMessage(`See ${ADDRESS}0 for it.`)],
        PICTURE,
      ),
    ).toBe(false);
    expect(minkMessagesHoldAttachment([], PICTURE)).toBe(false);
    expect(
      minkMessagesHoldAttachment([{ role: "user", text: null }, {}], PICTURE),
    ).toBe(false);
    expect(minkMessagesHoldAttachment(undefined, PICTURE)).toBe(false);
  });

  it("takes the chat a stream ran in from its first status event", () => {
    expect(minkStreamConversationId(streamIn(CHAT_B))).toBe(CHAT_B);
    expect(minkStreamConversationId(httpError(429))).toBeNull();
    expect(
      minkStreamConversationId(
        parseMinkSse('event: status\ndata: {"conversationId":"nope"}\n\n'),
      ),
    ).toBeNull();
    expect(minkStreamConversationId(undefined)).toBeNull();
  });
});

describe("looking the picture up in the eval admin's History", () => {
  it("finds it in the newest chat with the fewest reads, and stops there", async () => {
    const { read, asked } = historyReader({
      "/api/mink/conversations": listPage([CHAT_A, CHAT_B]),
      [`/api/mink/conversations/${CHAT_A}`]: chatPage([
        sentPicture(),
        plainMessage("Here is the proposal."),
      ]),
    });
    await expect(
      lookupMinkAttachmentChat({ attachmentId: PICTURE, read }),
    ).resolves.toEqual({ found: true, conversationId: CHAT_A, reads: 2 });
    expect(asked).toEqual([
      "/api/mink/conversations",
      `/api/mink/conversations/${CHAT_A}`,
    ]);
  });

  it("walks newest first past chats without it, earlier pages and list pages included", async () => {
    const { read, asked } = historyReader({
      "/api/mink/conversations": listPage([CHAT_A], "page/2=="),
      [`/api/mink/conversations/${CHAT_A}`]: chatPage([plainMessage("Hi")]),
      "/api/mink/conversations?cursor=page%2F2%3D%3D": listPage([CHAT_B]),
      [`/api/mink/conversations/${CHAT_B}`]: chatPage(
        [plainMessage("Later talk")],
        "older/1",
      ),
      [`/api/mink/conversations/${CHAT_B}?before=older%2F1`]: chatPage([
        sentPicture(),
      ]),
    });
    await expect(
      lookupMinkAttachmentChat({ attachmentId: PICTURE, read }),
    ).resolves.toEqual({ found: true, conversationId: CHAT_B, reads: 5 });
    expect(asked).toEqual([
      "/api/mink/conversations",
      `/api/mink/conversations/${CHAT_A}`,
      "/api/mink/conversations?cursor=page%2F2%3D%3D",
      `/api/mink/conversations/${CHAT_B}`,
      `/api/mink/conversations/${CHAT_B}?before=older%2F1`,
    ]);
  });

  it("reports not found, and complete, when the whole History was read", async () => {
    const { read } = historyReader({
      "/api/mink/conversations": listPage([CHAT_A, CHAT_B]),
      [`/api/mink/conversations/${CHAT_A}`]: chatPage([plainMessage("Hi")]),
      // CHAT_B went between the list and the read: 404, passed over.
    });
    await expect(
      lookupMinkAttachmentChat({ attachmentId: PICTURE, read }),
    ).resolves.toEqual({ found: false, complete: true, reads: 3 });
  });

  it("stops at its bounds and says the History was not read to the end", async () => {
    // Three list pages, each still naming a next one.
    const pages = {};
    for (const [index, cursor] of [null, "c2", "c3"].entries()) {
      const path = cursor
        ? `/api/mink/conversations?cursor=${cursor}`
        : "/api/mink/conversations";
      pages[path] = listPage([], index < 2 ? `c${index + 2}` : "c4");
    }
    const lists = historyReader(pages);
    await expect(
      lookupMinkAttachmentChat({ attachmentId: PICTURE, read: lists.read }),
    ).resolves.toEqual({ found: false, complete: false, reads: 3 });
    expect(lists.asked).not.toContain("/api/mink/conversations?cursor=c4");

    // A chat whose picture is past its last earlier page allowed.
    const deep = historyReader({
      "/api/mink/conversations": listPage([CHAT_A]),
      [`/api/mink/conversations/${CHAT_A}`]: chatPage([], "e1"),
      [`/api/mink/conversations/${CHAT_A}?before=e1`]: chatPage([], "e2"),
      [`/api/mink/conversations/${CHAT_A}?before=e2`]: chatPage([], "e3"),
      [`/api/mink/conversations/${CHAT_A}?before=e3`]: chatPage([
        sentPicture(),
      ]),
    });
    await expect(
      lookupMinkAttachmentChat({ attachmentId: PICTURE, read: deep.read }),
    ).resolves.toEqual({ found: false, complete: false, reads: 4 });
    expect(MINK_EVAL_LOOKUP_LIMITS.earlierPages).toBe(2);

    // The read budget, shared by list and chat reads.
    const many = historyReader({
      "/api/mink/conversations": listPage([CHAT_A, CHAT_B, CHAT_C]),
      [`/api/mink/conversations/${CHAT_A}`]: chatPage([plainMessage("a")]),
      [`/api/mink/conversations/${CHAT_B}`]: chatPage([plainMessage("b")]),
      [`/api/mink/conversations/${CHAT_C}`]: chatPage([sentPicture()]),
    });
    await expect(
      lookupMinkAttachmentChat({
        attachmentId: PICTURE,
        read: many.read,
        limits: { ...MINK_EVAL_LOOKUP_LIMITS, reads: 3 },
      }),
    ).resolves.toEqual({ found: false, complete: false, reads: 3 });
    expect(many.asked).toHaveLength(3);
    // Under the History routes' 60 a minute, whatever the History holds.
    expect(MINK_EVAL_LOOKUP_LIMITS.reads).toBeLessThan(60);
  });

  it("fails, never reports not found, when the History cannot be read", async () => {
    const refused = historyReader({
      "/api/mink/conversations": { ok: false, status: 401 },
    });
    const failed = await lookupMinkAttachmentChat({
      attachmentId: PICTURE,
      read: refused.read,
    });
    expect(failed).toEqual({
      failed: true,
      reason:
        "the eval admin's History could not be read (the chat list answered HTTP 401)",
      reads: 1,
    });
    expect(failed.found).toBeUndefined();

    const busyChat = historyReader({
      "/api/mink/conversations": listPage([CHAT_A]),
      [`/api/mink/conversations/${CHAT_A}`]: { ok: false, status: 429 },
    });
    await expect(
      lookupMinkAttachmentChat({ attachmentId: PICTURE, read: busyChat.read }),
    ).resolves.toMatchObject({
      failed: true,
      reason: expect.stringContaining("a chat answered HTTP 429"),
    });

    const silent = historyReader({
      "/api/mink/conversations": { ok: false, status: null },
    });
    await expect(
      lookupMinkAttachmentChat({ attachmentId: PICTURE, read: silent.read }),
    ).resolves.toMatchObject({
      failed: true,
      reason: expect.stringContaining("the chat list gave no answer"),
    });

    const odd = historyReader({
      "/api/mink/conversations": { ok: true, body: { items: [] } },
    });
    await expect(
      lookupMinkAttachmentChat({ attachmentId: PICTURE, read: odd.read }),
    ).resolves.toMatchObject({
      failed: true,
      reason: expect.stringContaining("unknown shape"),
    });
  });
});

describe("planning the chat of each attachment case", () => {
  const notFound = { found: false, complete: true, reads: 1 };

  it("posts every case into the chat the variable names", () => {
    for (const earlier of [
      [],
      [streamIn(CHAT_A)],
      [streamIn(CHAT_A), streamIn(CHAT_A)],
    ])
      expect(
        planMinkAttachmentCase({
          envChat: ` ${CHAT_A} `,
          lookup: null,
          earlier,
        }),
      ).toEqual({ post: true, source: "env", conversationId: CHAT_A });
  });

  it("posts every case into the chat History found", () => {
    const lookup = { found: true, conversationId: CHAT_B, reads: 2 };
    expect(planMinkAttachmentCase({ envChat: null, lookup })).toEqual({
      post: true,
      source: "history",
      conversationId: CHAT_B,
    });
    expect(
      planMinkAttachmentCase({
        envChat: null,
        lookup,
        earlier: [streamIn(CHAT_B), streamIn(CHAT_B)],
      }),
    ).toEqual({ post: true, source: "history", conversationId: CHAT_B });
  });

  it("not found: the first case starts a new chat and the others follow it there", () => {
    expect(
      planMinkAttachmentCase({ envChat: null, lookup: notFound, earlier: [] }),
    ).toEqual({ post: true, source: "first-case", conversationId: null });
    // Whatever the first case scored, its stream named the chat its send
    // linked the picture to.
    const firstFailed = [
      ...streamIn(CHAT_C),
      { event: "error", data: { code: "run_timeout" } },
    ];
    expect(
      planMinkAttachmentCase({
        envChat: null,
        lookup: notFound,
        earlier: [firstFailed],
      }),
    ).toEqual({ post: true, source: "first-case", conversationId: CHAT_C });
    expect(
      planMinkAttachmentCase({
        envChat: null,
        lookup: { found: false, complete: false, reads: 50 },
        earlier: [streamIn(CHAT_C), streamIn(CHAT_C)],
      }),
    ).toEqual({ post: true, source: "first-case", conversationId: CHAT_C });
  });

  it("not found and the first case named no chat: the rest are skipped, never failed", () => {
    const plan = planMinkAttachmentCase({
      envChat: null,
      lookup: notFound,
      earlier: [httpError(429)],
    });
    expect(plan).toEqual({
      post: false,
      source: "first-case",
      reason:
        "the picture was not found in a chat, and the first attachment case ended without naming the chat it started",
    });
  });

  it("a History that could not be read skips them all, naming the variable", () => {
    const plan = planMinkAttachmentCase({
      envChat: null,
      lookup: {
        failed: true,
        reason:
          "the eval admin's History could not be read (the chat list answered HTTP 401)",
        reads: 1,
      },
    });
    expect(plan.post).toBe(false);
    expect(plan.reason).toContain("HTTP 401");
    expect(plan.reason).toContain(MINK_EVAL_ATTACHMENT_CHAT_ENV);
    // A variable that is set wins over any lookup.
    expect(
      planMinkAttachmentCase({
        envChat: CHAT_A,
        lookup: { failed: true, reason: "x" },
      }),
    ).toMatchObject({ post: true, conversationId: CHAT_A });
    // No variable and no lookup: nothing to post into.
    expect(
      planMinkAttachmentCase({ envChat: null, lookup: null }),
    ).toMatchObject({
      post: false,
      source: "unknown",
    });
  });

  it("a chat that answered 404 skips the cases after it", () => {
    expect(
      planMinkAttachmentCase({
        envChat: CHAT_A,
        lookup: null,
        earlier: [httpError(404)],
      }),
    ).toEqual({
      post: false,
      source: "env",
      reason: `the chat ${CHAT_A} answered HTTP 404 (not an active chat of the eval admin)`,
    });
    // Other failures of an earlier case are that case's score, not the chat's.
    expect(
      planMinkAttachmentCase({
        envChat: CHAT_A,
        lookup: null,
        earlier: [httpError(503)],
      }),
    ).toMatchObject({ post: true, conversationId: CHAT_A });
    // Not found: the first case's own failure is the "no chat" rule, and a
    // 404 from a case posted into its chat skips the rest.
    expect(
      planMinkAttachmentCase({
        envChat: null,
        lookup: notFound,
        earlier: [streamIn(CHAT_C), httpError(404)],
      }),
    ).toMatchObject({ post: false, source: "first-case" });
  });

  it("the report names the chat the cases used, or why they were skipped", () => {
    expect(
      minkAttachmentChatReport({
        envChat: null,
        lookup: { found: false, complete: false, reads: 50 },
        earlier: [streamIn(CHAT_C), streamIn(CHAT_C), streamIn(CHAT_C)],
      }),
    ).toEqual({
      source: "first-case",
      conversationId: CHAT_C,
      skippedReason: null,
      lookup: { found: false, complete: false, failed: false, reads: 50 },
    });
    expect(
      minkAttachmentChatReport({ envChat: CHAT_A, lookup: null, earlier: [] }),
    ).toEqual({
      source: "env",
      conversationId: CHAT_A,
      skippedReason: null,
      lookup: null,
    });
    const skippedReport = minkAttachmentChatReport({
      envChat: null,
      lookup: {
        failed: true,
        reason: "the eval admin's History could not be read (x)",
        reads: 1,
      },
    });
    expect(skippedReport).toMatchObject({
      source: "history",
      conversationId: null,
      lookup: { found: false, complete: null, failed: true, reads: 1 },
    });
    expect(skippedReport.skippedReason).toContain(
      MINK_EVAL_ATTACHMENT_CHAT_ENV,
    );
  });
});
