import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { stores, whatsappMinkAnswers } from "@/drizzle/schema";
import { getMinkConfig } from "@/lib/mink/config";
import { getMinkCreditCycle } from "@/lib/ai/quota";
import { aiAllowanceFor, effectivePlan } from "@/lib/plans";
import { getPlanAllowancesLive } from "@/lib/plans/allowances";
import { MINK_ANSWER_CREDITS } from "./auto-reply-settings";
import type { InboxMinkDraft } from "./inbox-types";

// ---------------------------------------------------------------------------
// The whatsapp_mink_answers ledger: the draft a thread shows, the claim that
// lets one person send it, and the ONE credit charge (plan §19.6) that both
// the automatic send and the staff Send button go through. Database-only, so
// the inbox actions can use it without pulling the model and the facts
// readers into their bundle.
//
// ★ THE CHARGE IS KEYED ON THE ANSWER ROW. consume_mink_whatsapp_answer locks
// the row and answers an already-charged id with what it was charged, so a
// send retried after a failed Meta call cannot take a second credit, and a
// draft a person sends after the automatic send failed is not charged again.
//
// ★ IT FAILS CLOSED. A store that cannot cover one credit gets 'insufficient'
// and the customer gets a person: never an answer billed later.
// ---------------------------------------------------------------------------

export interface MinkChargeContext {
  period: string;
  /** Null means the plan is unmetered. */
  planCap: number | null;
}

/** The cycle and cap a charge is taken against, read live. */
export async function minkChargeContext(
  storeId: string,
): Promise<MinkChargeContext> {
  const config = getMinkConfig();
  const [cycle, allowances, storeRows] = await Promise.all([
    getMinkCreditCycle(storeId),
    getPlanAllowancesLive(),
    withService((db) =>
      db
        .select({
          plan: stores.plan,
          plan_expires_at: stores.planExpiresAt,
          comp_plan: stores.compPlan,
          comp_expires_at: stores.compExpiresAt,
        })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1),
    ),
  ]);
  const plan = effectivePlan(storeRows[0] ?? {});
  return {
    period: cycle.period,
    planCap: aiAllowanceFor(plan, config.chargeCredits, allowances),
  };
}

/**
 * How many credits the store can still spend this cycle (included plus
 * top-ups), or null when the plan is unmetered. Asked BEFORE a model call so
 * a store with nothing left costs nothing and gets the human path.
 */
export async function minkCreditHeadroom(
  storeId: string,
  ctx: MinkChargeContext,
): Promise<number | null> {
  if (ctx.planCap === null) return null;
  return withService(async (db) => {
    const res = await db.execute(sql`
      select
        greatest(${ctx.planCap}::int - coalesce((
          select used from public.ai_usage
          where store_id = ${storeId}::uuid and period = ${ctx.period}
        ), 0), 0)
        + coalesce((
          select balance from public.ai_credit_balances
          where store_id = ${storeId}::uuid
        ), 0) as remaining
    `);
    return Number(
      (res.rows[0] as { remaining?: number | string } | undefined)?.remaining ??
        0,
    );
  });
}

/**
 * Take the credit for one answer. Returns the credit source, or
 * 'insufficient' when the store cannot cover it (nothing is written then).
 * Idempotent per answer id.
 */
export async function chargeMinkAnswer(
  db: Db,
  input: { answerId: string; storeId: string; ctx: MinkChargeContext },
): Promise<string> {
  const res = await db.execute(sql`
    select public.consume_mink_whatsapp_answer(
      p_answer => ${input.answerId}::uuid,
      p_store => ${input.storeId}::uuid,
      p_period => ${input.ctx.period},
      p_plan_cap => ${input.ctx.planCap},
      p_credits => ${MINK_ANSWER_CREDITS}
    ) as source
  `);
  const source = (res.rows[0] as { source?: string } | undefined)?.source;
  if (!source) throw new Error("Mink WhatsApp charge returned nothing");
  return source;
}

function factsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((f): f is string => typeof f === "string").slice(0, 8)
    : [];
}

/** The draft a thread shows: the newest pending one, if any. */
export async function loadMinkDraft(
  storeId: string,
  conversationId: string,
): Promise<InboxMinkDraft | null> {
  const rows = await withService((db) =>
    db
      .select({
        id: whatsappMinkAnswers.id,
        answer: whatsappMinkAnswers.answer,
        reason: whatsappMinkAnswers.reason,
        facts: whatsappMinkAnswers.facts,
        mode: whatsappMinkAnswers.mode,
        creditSource: whatsappMinkAnswers.creditSource,
        createdAt: whatsappMinkAnswers.createdAt,
      })
      .from(whatsappMinkAnswers)
      .where(
        and(
          eq(whatsappMinkAnswers.storeId, storeId),
          eq(whatsappMinkAnswers.conversationId, conversationId),
          eq(whatsappMinkAnswers.outcome, "draft"),
        ),
      )
      .orderBy(desc(whatsappMinkAnswers.createdAt))
      .limit(1),
  );
  const row = rows[0];
  if (!row || !row.answer) return null;
  return {
    id: row.id,
    text: row.answer,
    reason: row.reason,
    facts: factsOf(row.facts),
    mode: row.mode === "helps" ? "helps" : "drafts",
    charged: row.creditSource !== null,
    createdAt: row.createdAt,
  };
}

/**
 * Lock one pending draft for sending. Null when it is not pending any more
 * (sent or discarded by somebody else), which the caller reports rather than
 * sending twice.
 */
export async function claimMinkDraft(
  db: Db,
  input: { storeId: string; conversationId: string; draftId: string },
): Promise<{ id: string; charged: boolean } | null> {
  const res = await db.execute(sql`
    select id, credit_source
      from public.whatsapp_mink_answers
     where id = ${input.draftId}::uuid
       and store_id = ${input.storeId}::uuid
       and conversation_id = ${input.conversationId}::uuid
       and outcome = 'draft'
     for update
  `);
  const row = res.rows[0] as
    | { id: string; credit_source: string | null }
    | undefined;
  return row ? { id: row.id, charged: row.credit_source !== null } : null;
}

/** Record that a draft went out, and as what. */
export async function markMinkAnswerSent(
  db: Db,
  input: {
    storeId: string;
    answerId: string;
    answer: string;
    sentMessageId: string | null;
    sentByAdminId: string | null;
  },
): Promise<void> {
  await db
    .update(whatsappMinkAnswers)
    .set({
      outcome: "sent",
      answer: input.answer,
      sentMessageId: input.sentMessageId,
      sentByAdminId: input.sentByAdminId,
      resolvedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(whatsappMinkAnswers.id, input.answerId),
        eq(whatsappMinkAnswers.storeId, input.storeId),
      ),
    );
}

/**
 * Discard the pending drafts of a conversation: the one named, or every one
 * (a person replied by hand, so a draft for an earlier message is moot).
 * Returns how many were discarded.
 */
export async function discardMinkDrafts(
  db: Db,
  input: {
    storeId: string;
    conversationId: string;
    reason: string;
    draftId?: string;
  },
): Promise<number> {
  const res = await db.execute(sql`
    update public.whatsapp_mink_answers
       set outcome = 'discarded',
           reason = ${input.reason},
           resolved_at = now()
     where store_id = ${input.storeId}::uuid
       and conversation_id = ${input.conversationId}::uuid
       and outcome = 'draft'
       ${input.draftId ? sql`and id = ${input.draftId}::uuid` : sql``}
     returning id
  `);
  return res.rows.length;
}
