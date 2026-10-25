import "server-only";

// History endpoints must not load run execution, draft actions or email tooling.
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import {
  minkConversations,
  minkFeedback,
  minkMessages,
  minkRevamps,
  minkRuns,
  minkToolCalls,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import { logError } from "@/lib/observability/logger";
import { MINK_CONVERSATION_LIMIT } from "./chat-session";
import { MinkRequestError } from "./errors";
import { MAX_RUN_BUDGET_MS } from "./tools/registry";
import type {
  MinkActorContext,
  MinkArtifact,
  MinkFeedbackIssue,
  MinkFeedbackRating,
} from "./types";

export const MINK_HISTORY_MESSAGE_LIMIT = 50;

/**
 * ★★ A RUN STILL "running" THIS LONG AFTER ITS LAST SIGN OF LIFE IS DEAD (B7).
 *   The stream route records every run it ends, so one left running is one
 *   whose server stopped (a crash, a deploy, an out-of-memory kill), and it
 *   blocked deleting its chat for ever. A live run's deadline is at most
 *   `MAX_RUN_BUDGET_MS` after it started or after its latest tool call (a
 *   tool with a run budget pushes the deadline out again, so a start time
 *   alone is not a bound); a tool still writing may hold its timeout up to a
 *   minute more, and the failure record follows within seconds. Ten minutes
 *   beyond the budget is the margin.
 * ⚠ The sign of life is the run's start and its tool calls' starts: a model
 *   turn records nothing, but it cannot stretch the deadline either.
 */
export const MINK_STALE_RUN_MS = MAX_RUN_BUDGET_MS + 10 * 60_000;

/**
 * The runs `MINK_STALE_RUN_MS` says are dead: still "running", started that
 * long ago, and no tool call started since. ★ One definition, read by the
 * History delete below and by the sweep that closes them (persistence.ts), so
 * the two cannot disagree about which run is dead.
 */
export function staleMinkRunCondition(): SQL {
  const window = sql`(${MINK_STALE_RUN_MS}::int * interval '1 millisecond')`;
  return sql`(
    ${minkRuns.status} = 'running'
    and ${minkRuns.startedAt} < now() - ${window}
    and not exists (
      select 1 from ${minkToolCalls}
      where ${minkToolCalls.runId} = ${minkRuns.id}
        and ${minkToolCalls.storeId} = ${minkRuns.storeId}
        and ${minkToolCalls.startedAt} >= now() - ${window}
    )
  )`;
}

/**
 * The marker on the answer a failed or stopped run's failure record saves when
 * the run started a storefront redesign it keeps (persistence.ts, B4): the
 * card, which otherwise reached the merchant only in the run's answer.
 */
export const MINK_KEPT_ANSWER_MARKER = "interrupted";

/**
 * ★ A run that did not succeed is shown only when its failure record kept an
 * answer (the redesign card): its own messages then read as the turn they were,
 * the merchant's message and the card. Any other failed run stays hidden, as
 * before. The model's replay (persistence.ts `startMinkRun`) still reads only
 * runs that succeeded: the next turn learns of the redesign from the flags-only
 * reference the stream route adds.
 */
function keptAnswerOfRun(): SQL {
  return sql`exists (
    select 1 from ${minkMessages} as kept
    where kept.run_id = ${minkRuns.id}
      and kept.store_id = ${minkRuns.storeId}
      and kept.role = 'assistant'
      and kept.content_json @> ${JSON.stringify({ [MINK_KEPT_ANSWER_MARKER]: true })}::jsonb
  )`;
}
// Kept in the client-safe chat-session module so the History sidebar can
// mirror the pruning a new chat causes.
export { MINK_CONVERSATION_LIMIT };

export interface MinkStoredMessage {
  role: "user" | "assistant";
  text: string;
}

export interface MinkConversationSummary {
  id: string;
  title: string;
  lastMessageAt: string;
  createdAt: string;
}

export interface MinkConversationMessage extends MinkStoredMessage {
  id: string;
  runId: string;
  createdAt: string;
  artifacts: MinkArtifact[];
  feedback: {
    rating: MinkFeedbackRating;
    issueCategory: MinkFeedbackIssue | null;
  } | null;
}

export interface MinkConversationDetail {
  id: string;
  title: string;
  messages: MinkConversationMessage[];
}

/**
 * A storefront revamp still being made (queued, running) or whose card is
 * ready: the card lives in its conversation, as an answer of the run that
 * started it, and its draft belongs to that run.
 */
export const MINK_LIVE_REVAMP_STATUSES = ["queued", "running", "ready"];

/**
 * ★★ A CONVERSATION WITH A LIVE REVAMP IS NEVER DELETED, by the History delete
 * below or by the overflow prune (persistence.ts), which both ask this. Its
 * runs cascade to the card's draft: a ready revamp left without one breaks
 * `mink_revamps_ready_check` (the delete failed with a raw database error), and
 * one still being made loses the run it is drafted under and can only fail.
 * `conversationId` is a value or, for the prune, the outer row's column.
 */
export function liveRevampOfConversation(
  storeId: string,
  conversationId: SQLWrapper | string,
): SQL {
  return sql`
    select 1
    from ${minkRevamps}
    where ${minkRevamps.conversationId} = ${conversationId}
      and ${minkRevamps.storeId} = ${storeId}
      and ${inArray(minkRevamps.status, MINK_LIVE_REVAMP_STATUSES)}
  `;
}

const CONVERSATION_HAS_REDESIGN =
  "This chat holds your storefront redesign card, so it cannot be deleted. Stop the redesign from its card first if it is still being made.";

export async function listMinkConversations(
  actor: MinkActorContext,
): Promise<MinkConversationSummary[]> {
  const now = new Date().toISOString();
  return withService((db) =>
    db
      .select({
        id: minkConversations.id,
        title: minkConversations.title,
        lastMessageAt: minkConversations.lastMessageAt,
        createdAt: minkConversations.createdAt,
      })
      .from(minkConversations)
      .where(
        and(
          eq(minkConversations.storeId, actor.storeId),
          eq(minkConversations.adminId, actor.adminId),
          eq(minkConversations.status, "active"),
          gt(minkConversations.expiresAt, now),
        ),
      )
      .orderBy(
        desc(minkConversations.lastMessageAt),
        desc(minkConversations.createdAt),
        desc(minkConversations.id),
      )
      .limit(MINK_CONVERSATION_LIMIT),
  );
}

export async function getMinkConversation(
  actor: MinkActorContext,
  conversationId: string,
): Promise<MinkConversationDetail> {
  const now = new Date().toISOString();
  return withService(async (db) => {
    const conversations = await db
      .select({
        id: minkConversations.id,
        title: minkConversations.title,
      })
      .from(minkConversations)
      .where(
        and(
          eq(minkConversations.id, conversationId),
          eq(minkConversations.storeId, actor.storeId),
          eq(minkConversations.adminId, actor.adminId),
          eq(minkConversations.status, "active"),
          gt(minkConversations.expiresAt, now),
        ),
      )
      .limit(1);
    const conversation = conversations[0];
    if (!conversation) {
      throw new MinkRequestError(
        "conversation_not_found",
        "That Mink AI conversation is no longer available.",
        404,
      );
    }

    const rows = await db
      .select({
        id: minkMessages.id,
        role: minkMessages.role,
        content: minkMessages.contentJson,
        runId: minkMessages.runId,
        createdAt: minkMessages.createdAt,
        feedbackRating: minkFeedback.rating,
        feedbackIssueCategory: minkFeedback.issueCategory,
      })
      .from(minkMessages)
      .innerJoin(
        minkRuns,
        and(
          eq(minkRuns.id, minkMessages.runId),
          eq(minkRuns.storeId, minkMessages.storeId),
          or(
            eq(minkRuns.status, "succeeded"),
            and(
              inArray(minkRuns.status, ["failed", "cancelled"]),
              keptAnswerOfRun(),
            ),
          ),
        ),
      )
      .leftJoin(
        minkFeedback,
        and(
          eq(minkFeedback.runId, minkMessages.runId),
          eq(minkFeedback.storeId, actor.storeId),
          eq(minkFeedback.adminId, actor.adminId),
        ),
      )
      .where(
        and(
          eq(minkMessages.storeId, actor.storeId),
          eq(minkMessages.conversationId, conversationId),
        ),
      )
      .orderBy(desc(minkMessages.createdAt), desc(minkMessages.id))
      .limit(MINK_HISTORY_MESSAGE_LIMIT);

    return {
      ...conversation,
      messages: rows.reverse().flatMap(toConversationMessage),
    };
  });
}

export async function deleteMinkConversation(
  actor: MinkActorContext,
  conversationId: string,
): Promise<void> {
  // ★★ B7: a run left "running" by a server that stopped blocked this delete
  //   for ever. A dead one is closed first, each through the stream route's
  //   own failure record, so its drafts, credits and redesign follow the
  //   normal rules; a run still within its limit keeps the chat busy below.
  await closeDeadRunsOfConversation(actor, conversationId);
  await withService(async (db) => {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`mink-conversation:${conversationId}`}, 0))`,
    );
    const running = await db
      .select({ id: minkRuns.id })
      .from(minkRuns)
      .where(
        and(
          eq(minkRuns.storeId, actor.storeId),
          eq(minkRuns.conversationId, conversationId),
          eq(minkRuns.status, "running"),
        ),
      )
      .limit(1);
    if (running[0]) {
      throw new MinkRequestError(
        "conversation_busy",
        "Wait for Mink AI to finish before deleting this conversation.",
        409,
      );
    }
    const revamp = await db.execute(
      sql`select exists (${liveRevampOfConversation(actor.storeId, conversationId)}) as live`,
    );
    if ((revamp.rows[0] as { live?: unknown } | undefined)?.live === true) {
      throw new MinkRequestError(
        "conversation_has_redesign",
        CONVERSATION_HAS_REDESIGN,
        409,
      );
    }

    const deleted = await db
      .delete(minkConversations)
      .where(
        and(
          eq(minkConversations.id, conversationId),
          eq(minkConversations.storeId, actor.storeId),
          eq(minkConversations.adminId, actor.adminId),
        ),
      )
      .returning({ id: minkConversations.id });
    if (!deleted[0]) {
      throw new MinkRequestError(
        "conversation_not_found",
        "That Mink AI conversation is no longer available.",
        404,
      );
    }
  });
}

/**
 * Close the dead runs of the actor's own conversation (`staleMinkRunCondition`)
 * before its delete. ★ Asked first with one light read, and the failure path
 * (persistence.ts, which loads draft execution) is imported only when there is
 * a dead run: an ordinary delete stays clear of it, as this module's rule asks.
 * ★ Best effort: a run that could not be closed stays running, and the delete
 * then refuses as busy, exactly as before.
 */
async function closeDeadRunsOfConversation(
  actor: MinkActorContext,
  conversationId: string,
): Promise<void> {
  const dead = await withService((db) =>
    db
      .select({ id: minkRuns.id })
      .from(minkRuns)
      .where(
        and(
          eq(minkRuns.storeId, actor.storeId),
          eq(minkRuns.conversationId, conversationId),
          eq(minkRuns.requestedBy, actor.adminId),
          staleMinkRunCondition(),
        ),
      )
      .limit(1),
  );
  if (!dead[0]) return;
  try {
    const { closeStaleMinkRuns } = await import("./persistence");
    await closeStaleMinkRuns({
      storeId: actor.storeId,
      adminId: actor.adminId,
      conversationId,
    });
  } catch (error) {
    logError("mink.history: dead runs not closed", loggableError(error), {
      storeId: actor.storeId,
      conversationId,
    });
  }
}

function toStoredMessage(row: {
  role: string;
  content: unknown;
}): MinkStoredMessage[] {
  if (row.role !== "user" && row.role !== "assistant") return [];
  if (!row.content || typeof row.content !== "object") return [];
  const text = (row.content as Record<string, unknown>).text;
  if (typeof text !== "string" || !text.trim()) return [];
  return [{ role: row.role, text }];
}

function toConversationMessage(row: {
  id: string;
  role: string;
  content: unknown;
  runId: string;
  createdAt: string;
  feedbackRating: string | null;
  feedbackIssueCategory: string | null;
}): MinkConversationMessage[] {
  const stored = toStoredMessage(row)[0];
  if (!stored) return [];
  const content = row.content as Record<string, unknown>;
  const artifacts = Array.isArray(content.artifacts)
    ? (content.artifacts as MinkArtifact[]).slice(0, 6)
    : [];
  const rating =
    row.feedbackRating === "helpful" || row.feedbackRating === "unhelpful"
      ? row.feedbackRating
      : null;
  const issueCategory = isFeedbackIssue(row.feedbackIssueCategory)
    ? row.feedbackIssueCategory
    : null;
  return [
    {
      ...stored,
      id: row.id,
      runId: row.runId,
      createdAt: row.createdAt,
      artifacts,
      feedback: rating ? { rating, issueCategory } : null,
    },
  ];
}

function isFeedbackIssue(value: unknown): value is MinkFeedbackIssue {
  return (
    value === "incorrect" ||
    value === "missing_context" ||
    value === "privacy" ||
    value === "slow" ||
    value === "other"
  );
}
