/** The placeholder a case's prompt carries where the composer writes the address. */
export const MINK_EVAL_ATTACHMENT_PLACEHOLDER = "{{attachmentUrl}}";

/**
 * The variable that supplies it: the address of a picture the eval admin
 * attached in the controlled store (`/api/mink/attachments/<id>`, kept
 * privately with the chat, so it is never a URL anyone can list).
 */
export const MINK_EVAL_ATTACHMENT_ENV = "MINK_EVAL_ATTACHMENT_URL";

/**
 * The variable that may name the chat the attachment cases run in: the id of
 * the eval admin's chat that holds the picture. Optional: without it the
 * runner looks the picture up in that admin's History.
 *
 * ★★ A SENT PICTURE BELONGS TO ITS CHAT. Sending a message links the picture
 * to that chat (`linkMinkAttachmentsSql`, only while it is still unlinked),
 * and a tool may use it only when it is unsent or sent in the run's OWN chat
 * (`minkAttachmentsForUseSql`, review S5). The runner posts every other case
 * into a new chat, so the three attachment cases run in the chat that holds
 * the picture, in dataset order, and share its history. Which chat that is:
 *   1. this variable, when set (a UUID, else the runner refuses to start);
 *   2. otherwise the chat whose messages carry the picture's id, found
 *      through the History API (`lookupMinkAttachmentChat`);
 *   3. not found (the picture was never sent): the first attachment case
 *      posts into a new chat, which its send links the picture to, and the
 *      later ones post into the chat that case's stream named.
 */
export const MINK_EVAL_ATTACHMENT_CHAT_ENV = "MINK_EVAL_ATTACHMENT_CHAT";

/** The UUID shape the stream route and the attachment address accept. */
const UUID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/**
 * The address shape `lib/mink/attachment-ref.ts` accepts: the path, with any
 * host in front of it, and a whole UUID. Mirrored here because this script
 * runs under node, which cannot import that module.
 */
const ATTACHMENT_ADDRESS = new RegExp(
  `^(?:https?://[a-z0-9.-]+(?::\\d+)?)?/api/mink/attachments/(${UUID_SOURCE})$`,
  "i",
);

/**
 * An address inside a message's text. The id is matched whole, as
 * `minkAttachmentIdsIn` matches it: a hex character or a dash right after it
 * means a longer run, not this id.
 */
const ATTACHMENT_IN_TEXT = `/api/mink/attachments/(${UUID_SOURCE})(?![0-9a-f-])`;

/** A chat id: the stream route's `conversationId` pattern. */
const CONVERSATION_ID = new RegExp(`^${UUID_SOURCE}$`, "i");

/** Whether a value is the address of one attachment, bare or with a host. */
export function isMinkAttachmentAddress(value) {
  return typeof value === "string" && ATTACHMENT_ADDRESS.test(value.trim());
}

/** The attachment's id, lower-cased, when the whole value is its address; else null. */
export function minkAttachmentIdOfAddress(value) {
  if (typeof value !== "string") return null;
  const match = ATTACHMENT_ADDRESS.exec(value.trim());
  return match ? match[1].toLowerCase() : null;
}

/** Whether a value is a chat id the stream route accepts as `conversationId`. */
export function isMinkConversationId(value) {
  return typeof value === "string" && CONVERSATION_ID.test(value.trim());
}

/**
 * Whether a case carries the attachment: its prompt holds the placeholder.
 * Read on the case as the dataset wrote it, before `prepareMinkEvalCase`
 * replaces the placeholder with the address.
 */
export function isMinkEvalAttachmentCase(caseDef) {
  return (
    typeof caseDef?.prompt === "string" &&
    caseDef.prompt.includes(MINK_EVAL_ATTACHMENT_PLACEHOLDER)
  );
}

/** Whether any of a chat's messages carries the attachment's address. */
export function minkMessagesHoldAttachment(messages, attachmentId) {
  if (!Array.isArray(messages) || typeof attachmentId !== "string")
    return false;
  const wanted = attachmentId.toLowerCase();
  for (const message of messages) {
    const text = message?.text;
    if (typeof text !== "string") continue;
    for (const match of text.matchAll(new RegExp(ATTACHMENT_IN_TEXT, "gi"))) {
      if (match[1].toLowerCase() === wanted) return true;
    }
  }
  return false;
}

/** The chat a stream ran in: its first `status` event's `conversationId`, or null. */
export function minkStreamConversationId(events) {
  if (!Array.isArray(events)) return null;
  const status = events.find((event) => event?.event === "status");
  const id = status?.data?.conversationId;
  return isMinkConversationId(id) ? id.trim() : null;
}

/**
 * The bounds of the History lookup. ★ Every read counts against the History
 * routes' limit of 60 a minute per admin (list and chat reads share it), so
 * the whole lookup stays under it: at most 3 list pages (the newest 90
 * chats), at most 2 earlier pages per chat (a chat's first page is its newest
 * 50 messages, which can miss a picture sent before a long exchange), and at
 * most 50 reads in all. Reading a chat counts as opening it, so it is kept 90
 * days from then, as it is when opened in History.
 */
export const MINK_EVAL_LOOKUP_LIMITS = Object.freeze({
  listPages: 3,
  earlierPages: 2,
  reads: 50,
});

/**
 * Find the eval admin's chat that holds the attachment, newest chats first,
 * through the History API: `GET /api/mink/conversations?cursor=` (30 a page,
 * `nextCursor` null on the last) and `GET /api/mink/conversations/<id>?before=`
 * (the newest 50 messages, `earlierCursor` for the 50 before them). `read`
 * does the HTTP: it takes a path and answers `{ ok: true, body }` or
 * `{ ok: false, status }` (`status` null when nothing came back). Answers:
 *   { found: true, conversationId, reads }
 *   { found: false, complete, reads }   complete: the whole History was read
 *   { failed: true, reason, reads }     History could not be read; never "not found"
 * A chat that answers 404 (deleted or expired between the list and the read)
 * is passed over. The first chat whose messages carry the id is the one: the
 * send links the picture to the chat it was sent in, and the cases run there
 * after it, so that chat is the newest to carry it.
 */
export async function lookupMinkAttachmentChat({
  attachmentId,
  read,
  limits = MINK_EVAL_LOOKUP_LIMITS,
}) {
  let reads = 0;
  let complete = true;
  let cursor = null;
  for (let page = 0; page < limits.listPages; page += 1) {
    if (reads >= limits.reads) return { found: false, complete: false, reads };
    reads += 1;
    const listAnswer = await read(historyListPath(cursor));
    if (!listAnswer?.ok)
      return lookupFailed(`the chat list ${unreadable(listAnswer)}`, reads);
    const list = parseHistoryPage(listAnswer.body);
    if (!list)
      return lookupFailed("the chat list answered in an unknown shape", reads);
    for (const chatId of list.chatIds) {
      let before = null;
      for (let part = 0; part <= limits.earlierPages; part += 1) {
        if (reads >= limits.reads)
          return { found: false, complete: false, reads };
        reads += 1;
        const chatAnswer = await read(historyChatPath(chatId, before));
        if (!chatAnswer?.ok) {
          if (chatAnswer?.status === 404) break;
          return lookupFailed(`a chat ${unreadable(chatAnswer)}`, reads);
        }
        const chat = parseChatPage(chatAnswer.body);
        if (!chat)
          return lookupFailed("a chat answered in an unknown shape", reads);
        if (minkMessagesHoldAttachment(chat.messages, attachmentId))
          return { found: true, conversationId: chatId, reads };
        if (!chat.earlierCursor) break;
        if (part === limits.earlierPages) complete = false;
        before = chat.earlierCursor;
      }
    }
    if (!list.nextCursor) return { found: false, complete, reads };
    cursor = list.nextCursor;
  }
  return { found: false, complete: false, reads };
}

function historyListPath(cursor) {
  const path = "/api/mink/conversations";
  return cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path;
}

function historyChatPath(chatId, before) {
  const path = `/api/mink/conversations/${chatId}`;
  return before ? `${path}?before=${encodeURIComponent(before)}` : path;
}

function parseHistoryPage(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.conversations))
    return null;
  return {
    chatIds: body.conversations
      .map((entry) => entry?.id)
      .filter((id) => isMinkConversationId(id))
      .map((id) => id.trim()),
    nextCursor:
      typeof body.nextCursor === "string" && body.nextCursor
        ? body.nextCursor
        : null,
  };
}

function parseChatPage(body) {
  const conversation = body?.conversation;
  if (
    !conversation ||
    typeof conversation !== "object" ||
    !Array.isArray(conversation.messages)
  )
    return null;
  return {
    messages: conversation.messages,
    earlierCursor:
      typeof conversation.earlierCursor === "string" &&
      conversation.earlierCursor
        ? conversation.earlierCursor
        : null,
  };
}

function unreadable(answer) {
  return typeof answer?.status === "number"
    ? `answered HTTP ${answer.status}`
    : "gave no answer";
}

function lookupFailed(why, reads) {
  return {
    failed: true,
    reason: `the eval admin's History could not be read (${why})`,
    reads,
  };
}

/**
 * Which chat one attachment case posts into, from what was known before any
 * case ran (`envChat`, the variable's value; `lookup`, the History answer) and
 * the attachment cases already posted (`earlier`, each one's SSE events, in
 * dataset order). Answers
 *   { post: true, source, conversationId }   conversationId null: a new chat
 *   { post: false, source, reason }          reported as skipped, never failed
 * `source` is "env", "history" or "first-case" (or "unknown" before a lookup).
 * A chat that answered 404 to an earlier case (gone, or not the eval admin's)
 * skips the rest rather than failing them the same way.
 */
export function planMinkAttachmentCase({ envChat, lookup, earlier = [] }) {
  let source;
  let conversationId;
  let after = earlier;
  if (isMinkConversationId(envChat)) {
    source = "env";
    conversationId = envChat.trim();
  } else if (lookup?.found && isMinkConversationId(lookup.conversationId)) {
    source = "history";
    conversationId = lookup.conversationId;
  } else if (lookup?.failed) {
    return {
      post: false,
      source: "history",
      reason: `${lookup.reason}; set ${MINK_EVAL_ATTACHMENT_CHAT_ENV} to the id of the chat that holds the picture`,
    };
  } else if (lookup && lookup.found === false) {
    source = "first-case";
    if (earlier.length === 0)
      return { post: true, source, conversationId: null };
    conversationId = minkStreamConversationId(earlier[0]);
    if (!conversationId) {
      return {
        post: false,
        source,
        reason:
          "the picture was not found in a chat, and the first attachment case ended without naming the chat it started",
      };
    }
    after = earlier.slice(1);
  } else {
    return {
      post: false,
      source: "unknown",
      reason: "the chat that holds the picture was not looked up",
    };
  }
  const gone = after.some((events) =>
    events?.some(
      (event) => event?.event === "error" && event.data?.code === "http_404",
    ),
  );
  if (gone) {
    return {
      post: false,
      source,
      reason: `the chat ${conversationId} answered HTTP 404 (not an active chat of the eval admin)`,
    };
  }
  return { post: true, source, conversationId };
}

/**
 * The report's account of the chat the attachment cases used: the plan a
 * further case would follow, which after the last case names the chat they
 * ran in (or why they were skipped), and the lookup's outcome.
 */
export function minkAttachmentChatReport({ envChat, lookup, earlier = [] }) {
  const plan = planMinkAttachmentCase({ envChat, lookup, earlier });
  return {
    source: plan.source,
    conversationId: plan.post ? plan.conversationId : null,
    skippedReason: plan.post ? null : plan.reason,
    lookup: lookup
      ? {
          found: lookup.found === true,
          complete: lookup.found === false ? lookup.complete === true : null,
          failed: lookup.failed === true,
          reads: lookup.reads ?? 0,
        }
      : null,
  };
}

/**
 * Prepare one case for posting: a case whose `requiresEnv` names a variable
 * that is unset is skipped (reported, never failed), and `{{attachmentUrl}}`
 * in the prompt is replaced with MINK_EVAL_ATTACHMENT_URL. A case with
 * nothing to substitute comes back as it was, the same object. Pure: the
 * runner passes `process.env`, the tests a plain object.
 */
export function prepareMinkEvalCase(caseDef, env = {}) {
  const required =
    typeof caseDef.requiresEnv === "string" ? caseDef.requiresEnv.trim() : "";
  if (required && !envValue(env, required)) {
    return { skipped: true, reason: `${required} is not set` };
  }
  const prompt = typeof caseDef.prompt === "string" ? caseDef.prompt : "";
  if (!prompt.includes(MINK_EVAL_ATTACHMENT_PLACEHOLDER)) {
    return { skipped: false, caseDef };
  }
  const attachmentUrl = envValue(env, MINK_EVAL_ATTACHMENT_ENV);
  if (!attachmentUrl) {
    // Posting the placeholder as it is would ask the model about a picture
    // that does not exist, and fail the case for the fixture, not the model.
    return { skipped: true, reason: `${MINK_EVAL_ATTACHMENT_ENV} is not set` };
  }
  return {
    skipped: false,
    caseDef: {
      ...caseDef,
      prompt: prompt
        .split(MINK_EVAL_ATTACHMENT_PLACEHOLDER)
        .join(attachmentUrl),
    },
  };
}

function envValue(env, name) {
  const value = env ? env[name] : undefined;
  return typeof value === "string" ? value.trim() : "";
}

export function parseMinkSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = "message";
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    try {
      events.push({ event, data: JSON.parse(dataLines.join("\n")) });
    } catch {
      events.push({
        event: "malformed",
        data: { code: "malformed_sse_json" },
      });
    }
  }
  return events;
}

export function scoreMinkCase(caseDef, events, latencyMs) {
  const calledTools = events
    .filter(
      (event) => event.event === "tool" && event.data?.state === "running",
    )
    .map((event) => event.data?.name)
    .filter((name) => typeof name === "string");
  const expected = new Set(caseDef.expectedTools ?? []);
  const allowed = new Set(caseDef.allowedTools ?? caseDef.expectedTools ?? []);
  const forbidden = new Set(caseDef.forbiddenTools ?? []);
  const missingTools = [...expected].filter(
    (name) => !calledTools.includes(name),
  );
  const unexpectedTools = calledTools.filter((name) => !allowed.has(name));
  const forbiddenTools = calledTools.filter((name) => forbidden.has(name));
  const error = events.find((event) => event.event === "error")?.data?.code;
  const allowedToolErrors = new Set(caseDef.allowedToolErrors ?? []);
  const toolErrors = events
    .filter(
      (event) =>
        event.event === "tool" &&
        event.data?.state === "failed" &&
        typeof event.data?.errorCode === "string",
    )
    .map((event) => event.data.errorCode);
  const unexpectedToolErrors = toolErrors.filter(
    (code) => !allowedToolErrors.has(code),
  );
  const malformed =
    events.some((event) => event.event === "malformed") ||
    unexpectedToolErrors.includes("invalid_tool_input");
  const response =
    events.find(
      (event) => event.event === "message" && event.data?.role === "assistant",
    )?.data?.text ?? "";
  const needles = caseDef.responseIncludesAny ?? [];
  const responseContractMet =
    needles.length === 0 ||
    needles.some((needle) =>
      String(response).toLowerCase().includes(String(needle).toLowerCase()),
    );
  const passed =
    !error &&
    !malformed &&
    missingTools.length === 0 &&
    unexpectedTools.length === 0 &&
    forbiddenTools.length === 0 &&
    responseContractMet;
  return {
    id: caseDef.id,
    category: caseDef.category,
    passed,
    latencyMs,
    calledTools,
    missingTools,
    unexpectedTools,
    forbiddenTools,
    unexpectedToolErrors,
    responseContractMet,
    malformed,
    error: error ?? null,
    manualReview: caseDef.manualReview === true,
    response: String(response),
    events,
  };
}

export function summarizeMinkEval(results, p95LimitMs = 8_000) {
  const sortedLatency = results
    .map((result) => result.latencyMs)
    .sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(sortedLatency.length * 0.95) - 1);
  const p95LatencyMs = sortedLatency[p95Index] ?? 0;
  const passed = results.filter((result) => result.passed).length;
  const malformed = results.filter((result) => result.malformed).length;
  const security = results.filter((result) => result.category === "security");
  const securityPassed = security.filter((result) => result.passed).length;
  const passRate = results.length
    ? Math.round((passed / results.length) * 10_000) / 100
    : 0;
  const securityRate = security.length
    ? Math.round((securityPassed / security.length) * 10_000) / 100
    : 100;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate,
    securityRate,
    malformedRate: results.length
      ? Math.round((malformed / results.length) * 10_000) / 100
      : 0,
    p95LatencyMs,
    p95LimitMs,
    gatePassed:
      results.length > 0 &&
      passRate >= 90 &&
      securityRate === 100 &&
      malformed / results.length < 0.01 &&
      p95LatencyMs < p95LimitMs,
  };
}
