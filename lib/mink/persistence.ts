import "server-only";

import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  minkConversations,
  minkDraftCreditUsage,
  minkDrafts,
  minkMessages,
  minkRevamps,
  minkRuns,
  minkToolCalls,
  minkUsageLedger,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import { logError, logWarn } from "@/lib/observability/logger";
import { minkAttachmentIdsIn } from "./attachment-ref";
import { linkMinkAttachmentsSql } from "./attachments";
import { basePromptTokens, cachedPromptTokens, estimateMinkCost } from "./cost";
import { historyWithCompaction } from "./compaction";
import { provisionalMinkConversationTitle } from "./conversation-title";
import { MinkRequestError, MinkRunStoppedError } from "./errors";
import { minkShadowMeter } from "./metering";
import { discardFailedMinkRunDrafts, getMinkRunDraftUsage } from "./drafts";
import { isRevampArtifact, type RevampArtifact } from "./revamp/contract";
import type {
  MinkActorContext,
  MinkRunProgress,
  MinkRunResult,
  MinkToolCall,
} from "./types";
import type { MinkThinkingLevel } from "./thinking";

import {
  MINK_HISTORY_MESSAGE_LIMIT,
  MINK_KEPT_ANSWER_MARKER,
  MINK_LIVE_REVAMP_STATUSES,
  minkRetentionDeadline,
  staleMinkRunCondition,
  type MinkStoredMessage,
} from "./conversation-history";
export {
  listMinkConversations,
  getMinkConversation,
  deleteMinkConversation,
} from "./conversation-history";
export type {
  MinkStoredMessage,
  MinkConversationSummary,
  MinkConversationMessage,
  MinkConversationDetail,
} from "./conversation-history";

export interface MinkStartedRun {
  conversationId: string;
  runId: string;
  history: MinkStoredMessage[];
  /**
   * The provisional title, present only when this run created the chat: the
   * stream route then asks for a generated one (conversation-namer.ts).
   */
  createdTitle?: string;
}

export type MinkUsageStatus = "reported" | "partial" | "unavailable";

export async function startMinkRun(input: {
  actor: MinkActorContext;
  conversationId?: string;
  message: string;
  model: string;
  thinkingLevel?: MinkThinkingLevel;
}): Promise<MinkStartedRun> {
  const { actor, message, model } = input;
  const now = new Date().toISOString();

  return withService(async (db) => {
    let conversationId = input.conversationId;
    let createdTitle: string | undefined;
    if (conversationId) {
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`mink-conversation:${conversationId}`}, 0))`,
      );
      const existing = await db
        .select({ id: minkConversations.id })
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
      if (!existing[0]) {
        throw new MinkRequestError(
          "conversation_not_found",
          "That Mink AI conversation is no longer available. Start a new conversation.",
          404,
        );
      }
    } else {
      // ★★ NO CAP: a new chat deletes nothing, however many chats exist
      //   (owner's decision, 25 Oct 2026). Chats leave 90 days after their
      //   last use, through the nightly retention sweep
      //   (conversation-retention.ts), never here: the ten-chat prune that
      //   ran here twice broke every run for the heaviest users, before any
      //   run row existed to tell anyone.
      // A short excerpt until a model names the chat (conversation-namer.ts),
      // and what stays if it cannot.
      createdTitle = provisionalMinkConversationTitle(message);
      const created = await db
        .insert(minkConversations)
        .values({
          storeId: actor.storeId,
          adminId: actor.adminId,
          title: createdTitle,
        })
        .returning({ id: minkConversations.id });
      conversationId = created[0]?.id;
      if (!conversationId)
        throw new Error("Mink conversation insert returned no id");
    }

    const previous = await db
      .select({
        role: minkMessages.role,
        content: minkMessages.contentJson,
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
      .where(
        and(
          eq(minkMessages.storeId, actor.storeId),
          eq(minkMessages.conversationId, conversationId),
        ),
      )
      .orderBy(desc(minkMessages.createdAt), desc(minkMessages.id))
      .limit(MINK_HISTORY_MESSAGE_LIMIT);

    const compacted = historyWithCompaction(
      previous.reverse().flatMap(toStoredMessage),
    );
    if (compacted.summary) {
      await db
        .update(minkConversations)
        .set({
          summaryJson: { text: compacted.summary },
          summarizedMessageCount: compacted.summarizedMessageCount,
          updatedAt: now,
        })
        .where(
          and(
            eq(minkConversations.id, conversationId),
            eq(minkConversations.storeId, actor.storeId),
            eq(minkConversations.adminId, actor.adminId),
          ),
        );
    }

    const createdRuns = await db
      .insert(minkRuns)
      .values({
        storeId: actor.storeId,
        conversationId,
        requestedBy: actor.adminId,
        requestId: actor.requestId,
        model,
        thinkingLevel: input.thinkingLevel ?? "low",
        promptVersion: actor.draftingEnabled
          ? "draft-action-beta-v67"
          : "read-beta-v44",
        toolRegistryVersion: actor.draftingEnabled
          ? "draft-beta-v50"
          : "read-beta-v29",
        riskTier: actor.draftingEnabled ? "R1" : "R0",
        currentPath: actor.currentPath ?? null,
        selectedResourceType: actor.selectedResource?.type ?? null,
        selectedResourceId: actor.selectedResource?.id ?? null,
      })
      .returning({ id: minkRuns.id });
    const runId = createdRuns[0]?.id;
    if (!runId) throw new Error("Mink run insert returned no id");

    await db.insert(minkMessages).values({
      storeId: actor.storeId,
      conversationId,
      runId,
      role: "user",
      contentJson: { text: message },
      model: null,
    });
    // ★ The pictures the message names (`/api/mink/attachments/{id}`) are
    //   linked to this chat here, in the same transaction and under the same
    //   advisory lock (lib/mink/attachments.ts): a run start that rolls back
    //   links nothing, and a retry links again. One statement, only when the
    //   message carries a reference; a forged id, another admin's picture or
    //   one already sent or marked links nothing (the statement's own
    //   predicate).
    const link = linkMinkAttachmentsSql({
      storeId: actor.storeId,
      adminId: actor.adminId,
      conversationId,
      ids: minkAttachmentIdsIn(message),
    });
    if (link) await db.execute(link);
    // ★ Sending a message is using the chat: it is kept 90 days from now
    //   (conversation-history.ts). The answer landing minutes later is not a
    //   separate use (completeMinkRun leaves the expiry alone).
    await db
      .update(minkConversations)
      .set({
        lastMessageAt: now,
        updatedAt: now,
        expiresAt: minkRetentionDeadline(),
      })
      .where(
        and(
          eq(minkConversations.id, conversationId),
          eq(minkConversations.storeId, actor.storeId),
          eq(minkConversations.adminId, actor.adminId),
        ),
      );

    return {
      conversationId,
      runId,
      history: compacted.history,
      ...(createdTitle ? { createdTitle } : {}),
    };
  });
}

/**
 * Gives a chat its generated title.
 *
 * ★ COMPARE-AND-SET: only while the chat still has the title it was created
 * with, so a title that arrives late cannot overwrite anything else, and a
 * chat deleted meanwhile is simply not found. True when it was renamed.
 */
export async function renameMinkConversation(input: {
  actor: Pick<MinkActorContext, "storeId" | "adminId">;
  conversationId: string;
  from: string;
  to: string;
}): Promise<boolean> {
  const updated = await withService((db) =>
    db
      .update(minkConversations)
      .set({ title: input.to, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(minkConversations.id, input.conversationId),
          eq(minkConversations.storeId, input.actor.storeId),
          eq(minkConversations.adminId, input.actor.adminId),
          eq(minkConversations.title, input.from),
        ),
      )
      .returning({ id: minkConversations.id }),
  );
  return updated.length > 0;
}

export async function completeMinkRun(input: {
  actor: MinkActorContext;
  started: MinkStartedRun;
  result: MinkRunResult;
  latencyMs: number;
  pricingLocation: string;
}): Promise<{ draftCredits: number }> {
  const { actor, started, result } = input;
  const completedAt = new Date().toISOString();
  return withService(async (db) => {
    const updated = await db
      .update(minkRuns)
      .set({
        status: "succeeded",
        // ★ The model that ANSWERED: startMinkRun records the configured one
        // before routing decides, and a light route may start on the lite
        // model and restart on the main one.
        model: result.model,
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.outputTokens,
        thoughtTokens: result.usage.thoughtTokens,
        totalTokens: result.usage.totalTokens,
        stepCount: result.steps,
        toolCallCount: result.toolCalls,
        retryCount: result.retryCount,
        latencyMs: input.latencyMs,
        completedAt,
      })
      .where(
        and(
          eq(minkRuns.id, started.runId),
          eq(minkRuns.storeId, actor.storeId),
          eq(minkRuns.requestedBy, actor.adminId),
          eq(minkRuns.status, "running"),
          // ★★ A run the merchant stopped stores no answer (run-stop.ts): the
          //   stop may land while the final text streams, after every tool.
          //   Migration 0244's CHECK holds the same rule for any other writer.
          isNull(minkRuns.stopRequestedAt),
        ),
      )
      .returning({ id: minkRuns.id });
    if (!updated[0]) {
      // Nothing was written: say whether a stop is why.
      const stopped = await db
        .select({ stopRequestedAt: minkRuns.stopRequestedAt })
        .from(minkRuns)
        .where(
          and(
            eq(minkRuns.id, started.runId),
            eq(minkRuns.storeId, actor.storeId),
          ),
        )
        .limit(1);
      if (stopped[0]?.stopRequestedAt) throw new MinkRunStoppedError();
      throw new Error("Mink run was not in a completable state");
    }

    await db.insert(minkMessages).values({
      storeId: actor.storeId,
      conversationId: started.conversationId,
      runId: started.runId,
      role: "assistant",
      contentJson: { text: result.text, artifacts: result.artifacts },
      model: result.model,
    });
    const draftCredits = await insertUsage(db, {
      actor,
      runId: started.runId,
      model: result.model,
      pricingLocation: input.pricingLocation,
      usage: result.usage,
      usageStatus: "reported",
      status: "succeeded",
      toolCalls: result.toolCalls,
      steps: result.steps,
    });
    await db
      .update(minkConversations)
      .set({ lastMessageAt: completedAt, updatedAt: completedAt })
      .where(
        and(
          eq(minkConversations.id, started.conversationId),
          eq(minkConversations.storeId, actor.storeId),
          eq(minkConversations.adminId, actor.adminId),
        ),
      );
    return { draftCredits };
  });
}

/** The card a failure record kept for the merchant (B4). */
export interface MinkKeptCard {
  /** One plain line above the card, never written by a model. */
  text: string;
  artifacts: RevampArtifact[];
}

/** What `failMinkRun` did. */
export interface MinkFailureRecord {
  /**
   * Whether this call closed the run. False when it was already closed (a
   * second record of the same run, or the sweep and the stream route racing).
   */
  closed: boolean;
  /** The card message it saved, when the run started a redesign it keeps. */
  card: MinkKeptCard | null;
}

/** The first line of the kept card: a redesign still being made, or ready. */
const KEPT_CARD_MAKING =
  "Your storefront redesign is being made. You can follow it here.";
const KEPT_CARD_READY =
  "Your storefront redesign is ready. You can review it here.";

/** `latency_ms` is a Postgres integer: a run closed weeks late must fit. */
const MAX_LATENCY_MS = 2_147_483_647;

/**
 * Record a run that failed or was stopped: its tool calls, its status, its
 * unseen proposals discarded with their credits given back, its usage.
 *
 * ★★ A STOREFRONT REDESIGN IT STARTED IS KEPT (B4, 2026-10-24). A redesign
 *   takes 40 to 70 minutes and is started by a chat run that lasts minutes,
 *   so a stalled last turn, a barge-in, Stop or a closed tab used to cancel
 *   a redesign the merchant had asked for, even a finished one, and refund
 *   it: its card reached the merchant only in the run's answer, and a failed
 *   run saves none. Now the redesign (queued, running or ready) is never
 *   cancelled or refunded, its card's draft is never discarded, and the
 *   record saves the answer the run could not: one plain line with the same
 *   `storefront_revamp` artifact the success path saves, marked as kept
 *   (`MINK_KEPT_ANSWER_MARKER`) so History shows it after a reload. A
 *   merchant who does not want the redesign stops it from the card, which
 *   gives a free one back as before.
 * ★ A run that SUCCEEDED is untouched: the record refuses it, as the draft
 *   discard always has, and the transaction rolls back.
 * ★ The same record closes a run whose server died (`closeStaleMinkRuns`), so
 *   a dead run's drafts, credits and redesigns follow these rules too.
 */
export async function failMinkRun(input: {
  actor: Pick<MinkActorContext, "storeId" | "adminId">;
  started: Pick<MinkStartedRun, "conversationId" | "runId">;
  status: "failed" | "cancelled";
  errorCode: string;
  latencyMs: number;
  model: string;
  pricingLocation: string;
  progress: MinkRunProgress;
  usageStatus: MinkUsageStatus;
}): Promise<MinkFailureRecord> {
  const completedAt = new Date().toISOString();
  const { actor, started } = input;
  return withService(async (db) => {
    await db
      .update(minkToolCalls)
      .set({
        status: "failed",
        resultSummary: { ok: false },
        errorCode: input.status === "cancelled" ? "cancelled" : "run_failed",
        completedAt,
      })
      .where(
        and(
          eq(minkToolCalls.storeId, actor.storeId),
          eq(minkToolCalls.runId, started.runId),
          eq(minkToolCalls.status, "running"),
        ),
      );
    const closed = await db
      .update(minkRuns)
      .set({
        status: input.status,
        model: input.model,
        errorCode: safeErrorCode(input.errorCode),
        inputTokens: input.progress.usage.promptTokens,
        outputTokens: input.progress.usage.outputTokens,
        thoughtTokens: input.progress.usage.thoughtTokens,
        totalTokens: input.progress.usage.totalTokens,
        stepCount: input.progress.steps,
        toolCallCount: input.progress.toolCalls,
        retryCount: input.progress.retryCount,
        latencyMs: Math.min(
          MAX_LATENCY_MS,
          Math.max(0, Math.round(input.latencyMs)),
        ),
        completedAt,
      })
      .where(
        and(
          eq(minkRuns.id, started.runId),
          eq(minkRuns.storeId, actor.storeId),
          eq(minkRuns.requestedBy, actor.adminId),
          eq(minkRuns.status, "running"),
        ),
      )
      .returning({ id: minkRuns.id });
    const run = await lockFailedRun(db, actor.storeId, started.runId);
    await discardUnseenDrafts(db, run);
    // ★ Only the call that closed the run saves its card, so a second record
    //   of the same run (the sweep racing the stream route) adds no second one.
    const card = closed[0] ? await saveKeptRevampCard(db, run) : null;
    await insertUsage(db, {
      actor,
      runId: started.runId,
      model: input.model,
      pricingLocation: input.pricingLocation,
      usage: input.progress.usage,
      usageStatus: input.usageStatus,
      status: input.status,
      toolCalls: input.progress.toolCalls,
      steps: input.progress.steps,
    });
    return { closed: Boolean(closed[0]), card };
  });
}

interface FailedRun {
  id: string;
  storeId: string;
  conversationId: string;
  requestedBy: string;
  model: string;
}

/**
 * The run this record is for, locked. ★ `FOR UPDATE` blocks a redesign's card
 *   step from adding the card's draft to this run until the record commits (a
 *   new draft must share-lock the run it names), so the drafts read below are
 *   every draft the run has. ★ A run that is not failed or cancelled (one that
 *   succeeded) is refused, as `discard_failed_mink_run_drafts` refuses it.
 */
async function lockFailedRun(
  db: Db,
  storeId: string,
  runId: string,
): Promise<FailedRun> {
  const rows = await db
    .select({
      id: minkRuns.id,
      storeId: minkRuns.storeId,
      conversationId: minkRuns.conversationId,
      requestedBy: minkRuns.requestedBy,
      model: minkRuns.model,
      status: minkRuns.status,
    })
    .from(minkRuns)
    .where(and(eq(minkRuns.id, runId), eq(minkRuns.storeId, storeId)))
    .for("update")
    .limit(1);
  const run = rows[0];
  if (!run || (run.status !== "failed" && run.status !== "cancelled")) {
    throw new Error("Mink failed-run record scope rejected");
  }
  return run;
}

/**
 * Discard the run's unseen proposals and give their credits back, keeping
 * every storefront redesign card among them.
 *
 * ★★ `discard_failed_mink_run_drafts` (migration 0040) deletes EVERY draft of
 *   the run and refunds EVERY credit row of the run, and a redesign's card is
 *   one: the card step writes it under the run that started the redesign,
 *   with the redesign's own id. A ready redesign left without it breaks
 *   `mink_revamps_ready_check` and rolls this whole record back, which is also
 *   what kept a dead run open for ever (B7). The function is left as it is,
 *   the one place a refund is written:
 *   - no card among the drafts: the discard runs as before;
 *   - only cards: nothing to discard;
 *   - cards and other proposals (rare: a run that died, whose redesign
 *     finished before it was closed): `discardBesideCard`.
 * ★ A card is any draft that is a redesign's (`cardDraftIds`).
 */
async function discardUnseenDrafts(db: Db, run: FailedRun): Promise<void> {
  const drafts = await db
    .select({ id: minkDrafts.id })
    .from(minkDrafts)
    .where(
      and(eq(minkDrafts.storeId, run.storeId), eq(minkDrafts.runId, run.id)),
    );
  const ids = drafts.map((draft) => draft.id);
  const cards = await cardDraftIds(db, run.storeId, ids);
  if (cards.size === 0) {
    await discardFailedMinkRunDrafts(db, run.storeId, run.id);
    return;
  }
  const others = ids.filter((id) => !cards.has(id));
  if (others.length === 0) return;
  // ★ In its own savepoint: should any step of it be refused (it needs the
  //   service role's UPDATE on the credit rows and DELETE on runs, which the
  //   schema's default privileges grant), the proposals are kept, still
  //   charged, and named for an operator, and the record itself still lands.
  await db.execute(sql.raw(`SAVEPOINT ${DISCARD_SAVEPOINT}`));
  try {
    await discardBesideCard(db, run, others);
    await db.execute(sql.raw(`RELEASE SAVEPOINT ${DISCARD_SAVEPOINT}`));
  } catch (error) {
    await db.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${DISCARD_SAVEPOINT}`));
    await db.execute(sql.raw(`RELEASE SAVEPOINT ${DISCARD_SAVEPOINT}`));
    // Content-free: ids and a count.
    logError(
      "mink.run: unseen proposals kept beside a redesign card",
      loggableError(error),
      {
        storeId: run.storeId,
        runId: run.id,
        proposals: others.length,
      },
    );
  }
}

const DISCARD_SAVEPOINT = "mink_discard_beside_card";

/**
 * Which of these drafts are a storefront redesign's card: by the redesign's
 * id (the card step's fixed id, so a card still being recorded counts) or by
 * its `draft_id`. ★ A separate read, not a subquery in the drafts' select
 *   list: Drizzle writes a select list's columns without their table, so a
 *   correlated subquery there compares the inner table with itself (it read
 *   every draft as a card wherever any redesign existed).
 */
async function cardDraftIds(
  db: Db,
  storeId: string,
  draftIds: string[],
): Promise<Set<string>> {
  if (draftIds.length === 0) return new Set();
  const rows = await db
    .select({ id: minkRevamps.id, draftId: minkRevamps.draftId })
    .from(minkRevamps)
    .where(
      and(
        eq(minkRevamps.storeId, storeId),
        or(
          inArray(minkRevamps.id, draftIds),
          inArray(minkRevamps.draftId, draftIds),
        ),
      ),
    );
  const asked = new Set(draftIds);
  const cards = new Set<string>();
  for (const row of rows) {
    if (asked.has(row.id)) cards.add(row.id);
    if (row.draftId && asked.has(row.draftId)) cards.add(row.draftId);
  }
  return cards;
}

/**
 * Discard and refund the run's other proposals while its redesign card stays:
 * they and their credit rows move to a holder run (cancelled, made inside this
 * transaction, seen by nobody), the function discards that, and the holder is
 * deleted. ★ The function still writes every refund; this only chooses which
 *   drafts it sees.
 */
async function discardBesideCard(
  db: Db,
  run: FailedRun,
  others: string[],
): Promise<void> {
  const holderId = crypto.randomUUID();
  await db.insert(minkRuns).values({
    id: holderId,
    storeId: run.storeId,
    conversationId: run.conversationId,
    requestedBy: run.requestedBy,
    requestId: crypto.randomUUID(),
    status: "cancelled",
    model: run.model,
    errorCode: "draft_discard",
    completedAt: sql`now()`,
  });
  await db
    .update(minkDrafts)
    .set({ runId: holderId })
    .where(
      and(
        eq(minkDrafts.storeId, run.storeId),
        eq(minkDrafts.runId, run.id),
        inArray(minkDrafts.id, others),
      ),
    );
  await db
    .update(minkDraftCreditUsage)
    .set({ runId: holderId })
    .where(
      and(
        eq(minkDraftCreditUsage.storeId, run.storeId),
        eq(minkDraftCreditUsage.runId, run.id),
        inArray(minkDraftCreditUsage.draftId, others),
      ),
    );
  await discardFailedMinkRunDrafts(db, run.storeId, holderId);
  await db
    .delete(minkRuns)
    .where(and(eq(minkRuns.id, holderId), eq(minkRuns.storeId, run.storeId)));
}

/**
 * Save the answer the run could not: the card of each redesign it started
 * that is still being made or ready, under one plain line. Null when it
 * started none.
 * ★ Dated a moment after the run's own messages, not now: a dead run closed
 *   hours later (`closeStaleMinkRuns`) puts its card beside the message that
 *   asked for it, never below the turns that came after.
 */
async function saveKeptRevampCard(
  db: Db,
  run: FailedRun,
): Promise<MinkKeptCard | null> {
  const revamps = await db
    .select({
      id: minkRevamps.id,
      kind: minkRevamps.kind,
      status: minkRevamps.status,
    })
    .from(minkRevamps)
    .where(
      and(
        eq(minkRevamps.storeId, run.storeId),
        eq(minkRevamps.originRunId, run.id),
        inArray(minkRevamps.status, MINK_LIVE_REVAMP_STATUSES),
      ),
    )
    .orderBy(minkRevamps.createdAt, minkRevamps.id);
  const artifacts = revamps.flatMap((row): RevampArtifact[] => {
    const artifact = {
      type: "storefront_revamp",
      revampId: row.id,
      kind: row.kind,
      status: row.status,
    };
    return isRevampArtifact(artifact) ? [artifact] : [];
  });
  if (artifacts.length === 0) return null;
  const text = artifacts.every((artifact) => artifact.status === "ready")
    ? KEPT_CARD_READY
    : KEPT_CARD_MAKING;
  await db.insert(minkMessages).values({
    storeId: run.storeId,
    conversationId: run.conversationId,
    runId: run.id,
    role: "assistant",
    contentJson: { text, artifacts, [MINK_KEPT_ANSWER_MARKER]: true },
    model: null,
    createdAt: sql`(
      select coalesce(max(${minkMessages.createdAt}), now()) + interval '1 millisecond'
      from ${minkMessages}
      where ${minkMessages.runId} = ${run.id}
        and ${minkMessages.storeId} = ${run.storeId}
    )`,
  });
  return { text, artifacts };
}

/** At most this many dead runs are closed in one pass (B7). */
export const MINK_STALE_RUN_SWEEP_LIMIT = 20;

/**
 * Close the runs a dead server left "running" (`staleMinkRunCondition`), each
 * through `failMinkRun`, the stream route's own failure record, so its
 * drafts, credits and redesign follow the normal rules (B4 included).
 *
 * ★ Called by the per-minute workflow heartbeat for every store, and by the
 *   History delete for one conversation (dev has no scheduler, so the delete
 *   is its cure). ★ Bounded (`MINK_STALE_RUN_SWEEP_LIMIT`) and oldest first;
 *   each run is its own transaction, and one that cannot be closed is logged
 *   and left for the next pass. ★ Never a run younger than the limit.
 */
export async function closeStaleMinkRuns(
  scope: {
    storeId?: string;
    adminId?: string;
    conversationId?: string;
    limit?: number;
  } = {},
): Promise<{ closed: number; failed: number }> {
  const asked =
    typeof scope.limit === "number" && Number.isFinite(scope.limit)
      ? Math.floor(scope.limit)
      : MINK_STALE_RUN_SWEEP_LIMIT;
  const limit = Math.max(1, Math.min(MINK_STALE_RUN_SWEEP_LIMIT, asked));
  const conditions: SQL[] = [staleMinkRunCondition()];
  if (scope.storeId) conditions.push(eq(minkRuns.storeId, scope.storeId));
  if (scope.adminId) conditions.push(eq(minkRuns.requestedBy, scope.adminId));
  if (scope.conversationId) {
    conditions.push(eq(minkRuns.conversationId, scope.conversationId));
  }
  const dead = await withService((db) =>
    db
      .select({
        id: minkRuns.id,
        storeId: minkRuns.storeId,
        conversationId: minkRuns.conversationId,
        requestedBy: minkRuns.requestedBy,
        model: minkRuns.model,
        ageMs: sql<number>`least(floor(extract(epoch from (now() - ${minkRuns.startedAt})) * 1000), ${MAX_LATENCY_MS})::int`,
        // ★ Qualified by hand: Drizzle writes a select list's columns without
        //   their table, which inside this subquery would name the tool call.
        toolCalls: sql<number>`(
          select count(*)::int from ${minkToolCalls} as dead_run_call
          where dead_run_call.run_id = ${minkRuns}.id
            and dead_run_call.store_id = ${minkRuns}.store_id
        )`,
      })
      .from(minkRuns)
      .where(and(...conditions))
      .orderBy(minkRuns.startedAt, minkRuns.id)
      .limit(limit),
  );
  let closed = 0;
  let failed = 0;
  for (const run of dead) {
    try {
      const record = await failMinkRun({
        actor: { storeId: run.storeId, adminId: run.requestedBy },
        started: { conversationId: run.conversationId, runId: run.id },
        status: "failed",
        errorCode: "run_abandoned",
        latencyMs: Number(run.ageMs) || 0,
        model: run.model,
        // Unused: nothing is known of a dead run's usage, so it is priced at
        // nothing ("unavailable").
        pricingLocation: "global",
        progress: {
          steps: 0,
          toolCalls: Number(run.toolCalls) || 0,
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
      if (record.closed) {
        closed += 1;
        // Content-free: ids and the age only.
        logWarn("mink.run: abandoned run closed", {
          storeId: run.storeId,
          runId: run.id,
          ageMs: Number(run.ageMs) || 0,
          keptRedesign: record.card !== null,
        });
      }
    } catch (error) {
      failed += 1;
      logError("mink.run: abandoned run not closed", loggableError(error), {
        storeId: run.storeId,
        runId: run.id,
      });
    }
  }
  return { closed, failed };
}

export async function startMinkToolCall(input: {
  actor: MinkActorContext;
  started: MinkStartedRun;
  sequence: number;
  call: MinkToolCall;
}): Promise<void> {
  await withService((db) =>
    db.insert(minkToolCalls).values({
      storeId: input.actor.storeId,
      runId: input.started.runId,
      sequence: input.sequence,
      providerCallId: input.call.id ?? null,
      toolName: input.call.name,
      toolVersion: input.call.name.startsWith("propose_") ? 4 : 2,
      riskTier: input.call.name.startsWith("propose_") ? "R1" : "R0",
      // Arguments intentionally stay redacted in the alpha ledger. The model
      // receives them, but telemetry never needs a product search phrase.
      argumentsSummary: {},
    }),
  );
}

export async function completeMinkToolCall(input: {
  actor: MinkActorContext;
  started: MinkStartedRun;
  sequence: number;
  ok: boolean;
  errorCode?: string;
}): Promise<void> {
  const completedAt = new Date().toISOString();
  await withService((db) =>
    db
      .update(minkToolCalls)
      .set({
        status: input.ok ? "succeeded" : "failed",
        resultSummary: { ok: input.ok },
        errorCode: input.errorCode ? safeErrorCode(input.errorCode) : null,
        completedAt,
      })
      .where(
        and(
          eq(minkToolCalls.storeId, input.actor.storeId),
          eq(minkToolCalls.runId, input.started.runId),
          eq(minkToolCalls.sequence, input.sequence),
          eq(minkToolCalls.status, "running"),
        ),
      ),
  );
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

function safeErrorCode(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return normalized || "mink_failed";
}

async function insertUsage(
  db: Db,
  input: {
    actor: Pick<MinkActorContext, "storeId" | "adminId">;
    runId: string;
    model: string;
    pricingLocation: string;
    usage: MinkRunProgress["usage"];
    usageStatus: MinkUsageStatus;
    status: "succeeded" | "failed" | "cancelled";
    toolCalls: number;
    /** Model turns, for the band's repeated-prompt subtraction (metering.ts). */
    steps: number;
  },
): Promise<number> {
  const estimate =
    input.usageStatus === "unavailable"
      ? { estimatedCostMicrousd: null, pricingVersion: null }
      : estimateMinkCost({
          model: input.model,
          location: input.pricingLocation,
          usage: input.usage,
        });
  const shadow = minkShadowMeter({
    status: input.status,
    toolCalls: input.toolCalls,
    usageKnown: input.usageStatus !== "unavailable",
    usage: input.usage,
    steps: input.steps,
  });
  const draftUsage = await getMinkRunDraftUsage(
    db,
    input.actor.storeId,
    input.runId,
  );
  await db
    .insert(minkUsageLedger)
    .values({
      storeId: input.actor.storeId,
      adminId: input.actor.adminId,
      runId: input.runId,
      model: input.model,
      inputTokens: input.usage.promptTokens,
      outputTokens: input.usage.outputTokens,
      thoughtTokens: input.usage.thoughtTokens,
      totalTokens: input.usage.totalTokens,
      // Clamped through the SAME helper the cost estimate uses. This insert
      // shares its transaction with the run-completion update and the
      // assistant message, so tripping the ledger's cached_tokens CHECK would
      // roll back a reply the merchant has already read.
      cachedTokens: cachedPromptTokens(input.usage),
      // The first turn's prompt size, so a run reconciled hours later is
      // banded by the same rule a timely one was. Zero means unknown, and
      // every reader then charges the whole prompt (metering.ts).
      basePromptTokens: basePromptTokens(input.usage),
      usageStatus: input.usageStatus,
      estimatedCostMicrousd: estimate.estimatedCostMicrousd,
      pricingVersion: estimate.pricingVersion,
      // Read-only work remains shadow-metered. Phase 3 proposal tools reserve
      // their documented weight atomically and are summed into this run row.
      chargedCredits: draftUsage.chargedCredits,
      shadowCredits: shadow.shadowCredits,
      costCohort:
        draftUsage.proposalCount > 0 ? "draft_proposal" : shadow.costCohort,
    })
    .onConflictDoNothing({ target: minkUsageLedger.runId });
  // Returned so the caller can FOLD the run's band against what proposals in
  // this run already reserved, rather than stacking the two (metering.ts's
  // minkRunCreditCharge). Re-reading it afterwards would be a second query for
  // a number this function has already fetched.
  return draftUsage.chargedCredits;
}
