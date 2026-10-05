import "server-only";

// History endpoints must not load run execution, draft actions or email tooling.
import { and, desc, eq, gt, sql } from "drizzle-orm";
import {
  minkConversations,
  minkFeedback,
  minkMessages,
  minkRuns,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { MinkRequestError } from "./errors";
import type {
  MinkActorContext,
  MinkArtifact,
  MinkFeedbackIssue,
  MinkFeedbackRating,
} from "./types";

export const MINK_HISTORY_MESSAGE_LIMIT = 50;
export const MINK_CONVERSATION_LIMIT = 10;

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
          eq(minkRuns.status, "succeeded"),
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
