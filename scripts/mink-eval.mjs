import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  MINK_EVAL_ATTACHMENT_CHAT_ENV,
  MINK_EVAL_ATTACHMENT_ENV,
  isMinkAttachmentAddress,
  isMinkConversationId,
  isMinkEvalAttachmentCase,
  lookupMinkAttachmentChat,
  minkAttachmentChatReport,
  minkAttachmentIdOfAddress,
  parseMinkSse,
  planMinkAttachmentCase,
  prepareMinkEvalCase,
  scoreMinkCase,
  summarizeMinkEval,
} from "./mink-eval-core.mjs";

const baseUrl = process.env.MINK_EVAL_BASE_URL?.trim();
const cookie = process.env.MINK_EVAL_COOKIE?.trim();
if (!baseUrl || !cookie) {
  console.error(
    "Set MINK_EVAL_BASE_URL and MINK_EVAL_COOKIE for a controlled signed-in internal store.",
  );
  process.exit(2);
}
// The attachment cases post this address exactly as the composer writes it.
// A value that is not an attachment address (a Media Library URL pasted by
// mistake) would spend a run on the wrong question, so it is refused here,
// before anything is posted. Unset is fine: those cases are then skipped.
const attachmentUrl = process.env[MINK_EVAL_ATTACHMENT_ENV]?.trim();
if (attachmentUrl && !isMinkAttachmentAddress(attachmentUrl)) {
  console.error(
    `${MINK_EVAL_ATTACHMENT_ENV} must be the address of a picture attached in the controlled store (/api/mink/attachments/<id>, with or without the host). Leave it unset to skip the attachment cases.`,
  );
  process.exit(2);
}
// The chat the attachment cases run in, when the tester names it (the
// report's attachmentChat names the one each run used). Refused before
// anything is posted when it is not a chat id; unset, the runner finds it.
const attachmentChat =
  process.env[MINK_EVAL_ATTACHMENT_CHAT_ENV]?.trim() || null;
if (attachmentChat && !isMinkConversationId(attachmentChat)) {
  console.error(
    `${MINK_EVAL_ATTACHMENT_CHAT_ENV} must be the id of the eval admin's chat that holds the picture (a UUID, as a report's attachmentChat names it). Leave it unset to let the runner find the chat.`,
  );
  process.exit(2);
}
if (attachmentChat && !attachmentUrl) {
  console.error(
    `${MINK_EVAL_ATTACHMENT_CHAT_ENV} is ignored: ${MINK_EVAL_ATTACHMENT_ENV} is not set, so the attachment cases are skipped.`,
  );
}

const datasetPath = fileURLToPath(
  new URL("../evals/mink/read-alpha.json", import.meta.url),
);
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const limit = boundedInt(
  process.env.MINK_EVAL_CASE_LIMIT,
  dataset.cases.length,
  1,
  dataset.cases.length,
);
const delayMs = boundedInt(process.env.MINK_EVAL_DELAY_MS, 3_200, 0, 60_000);
const p95LimitMs = boundedInt(
  process.env.MINK_EVAL_P95_LIMIT_MS,
  8_000,
  1_000,
  300_000,
);
const requestTimeoutMs = boundedInt(
  process.env.MINK_EVAL_REQUEST_TIMEOUT_MS,
  150_000,
  15_000,
  360_000,
);
const includeResponses = process.env.MINK_EVAL_INCLUDE_RESPONSES === "true";
const endpoint = new URL("/api/mink/stream", baseUrl);
const origin = new URL(baseUrl).origin;
const cases = dataset.cases.slice(0, limit);
const results = [];
/** Cases not posted: their `requiresEnv` was unset. Reported, never scored. */
const skipped = [];

if (includeResponses) {
  console.error(
    "Warning: MINK_EVAL_INCLUDE_RESPONSES=true prints model answers, which may contain controlled-store business data.",
  );
}

// The attachment cases run in the chat that holds the picture, worked out
// before any case is posted (mink-eval-core.mjs, MINK_EVAL_ATTACHMENT_CHAT_ENV).
const runsAttachmentCases =
  Boolean(attachmentUrl) && cases.some(isMinkEvalAttachmentCase);
let attachmentLookup = null;
if (runsAttachmentCases && !attachmentChat) {
  attachmentLookup = await lookupMinkAttachmentChat({
    attachmentId: minkAttachmentIdOfAddress(attachmentUrl),
    read: readHistory,
  });
  console.error(
    attachmentLookup.found
      ? `The picture is in chat ${attachmentLookup.conversationId}; the attachment cases run there.`
      : attachmentLookup.failed
        ? `Attachment cases will be skipped: ${attachmentLookup.reason}.`
        : `The picture was not found in ${attachmentLookup.complete ? "any chat" : "the newest chats read"}; the first attachment case starts a new chat and the others follow it.`,
  );
}
/** Each posted attachment case's events, in order: the plan reads them. */
const attachmentRuns = [];

for (let index = 0; index < cases.length; index += 1) {
  const prepared = prepareMinkEvalCase(cases[index], process.env);
  if (prepared.skipped) {
    skipped.push({ id: cases[index].id, reason: prepared.reason });
    console.error(
      `[${index + 1}/${cases.length}] ${cases[index].id}: skipped (${prepared.reason})`,
    );
    continue;
  }
  const caseDef = prepared.caseDef;
  const attachmentCase = isMinkEvalAttachmentCase(cases[index]);
  let conversationId = null;
  if (attachmentCase) {
    const plan = planMinkAttachmentCase({
      envChat: attachmentChat,
      lookup: attachmentLookup,
      earlier: attachmentRuns,
    });
    if (!plan.post) {
      skipped.push({ id: caseDef.id, reason: plan.reason });
      console.error(
        `[${index + 1}/${cases.length}] ${caseDef.id}: skipped (${plan.reason})`,
      );
      continue;
    }
    conversationId = plan.conversationId;
  }
  const startedAt = Date.now();
  let events;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: origin,
      },
      body: JSON.stringify(
        conversationId
          ? { message: caseDef.prompt, conversationId }
          : { message: caseDef.prompt },
      ),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const body = await response.text();
    events = response.ok
      ? parseMinkSse(body)
      : [
          {
            event: "error",
            data: { code: `http_${response.status}` },
          },
        ];
  } catch (error) {
    events = [
      {
        event: "error",
        data: {
          code: isTimeout(error) ? "client_timeout" : "network_error",
        },
      },
    ];
  }
  if (attachmentCase) attachmentRuns.push(events);
  const result = scoreMinkCase(caseDef, events, Date.now() - startedAt);
  results.push(result);
  console.error(
    `[${index + 1}/${cases.length}] ${caseDef.id}: ${result.passed ? "pass" : "FAIL"} (${result.latencyMs}ms)`,
  );
  if (delayMs && index + 1 < cases.length) await delay(delayMs);
}

const summary = summarizeMinkEval(results, p95LimitMs);
const model = results
  .flatMap((result) => result.events)
  .find((event) => event.event === "usage")?.data?.model;
const report = {
  dataset: dataset.version,
  baseOrigin: origin,
  model: typeof model === "string" ? model : null,
  generatedAt: new Date().toISOString(),
  summary,
  skipped,
  attachmentChat: runsAttachmentCases
    ? minkAttachmentChatReport({
        envChat: attachmentChat,
        lookup: attachmentLookup,
        earlier: attachmentRuns,
      })
    : null,
  results: results.map((result) => {
    const output = { ...result };
    delete output.events;
    if (!includeResponses) delete output.response;
    return output;
  }),
};
if (skipped.length) {
  console.error(
    `${skipped.length} case(s) skipped, not scored: ${skipped.map((entry) => entry.id).join(", ")}`,
  );
}
console.log(JSON.stringify(report, null, 2));
if (!summary.gatePassed) process.exitCode = 1;

/**
 * One History read for the lookup, with the eval cookie (the GET routes need
 * no Origin). Never throws: a failed read is an answer the lookup reports.
 */
async function readHistory(path) {
  let response;
  try {
    response = await fetch(new URL(path, baseUrl), {
      headers: { Accept: "application/json", Cookie: cookie },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, status: null };
  }
  if (!response.ok) return { ok: false, status: response.status };
  try {
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false, status: null };
  }
}

/** `AbortSignal.timeout` rejects with a TimeoutError; an abort with AbortError. */
function isTimeout(error) {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}
