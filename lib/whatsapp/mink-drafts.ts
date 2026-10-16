import "server-only";

import { and, desc, eq, sql, type SQL } from "drizzle-orm";
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
//
// ★★ THE CLAIM IS A LEASE, NOT A ROW LOCK (migration 0211). It used to be a
// `select … for update` that changed nothing, and the lock ended when the
// claiming transaction committed, BEFORE the message went to Meta. A second
// Send (another person, another tab, or a Send on a `helps` row whose
// automatic send was still in flight) then found the draft still pending,
// got the same credit source back and sent it again: one charge, two
// messages. The claim now writes `sending_started_at`, and a second claim
// finds the draft taken until the send settles (sent, released after a
// refusal) or the lease runs out (a send that died).
//
// ★ A DRAFT A PERSON HAS ALREADY ANSWERED IS NOT SENDABLE. A reply from the
// dashboard, the WhatsApp Business app or a staff template after the
// customer's message makes Mink's draft for that message moot: the card is
// not shown and the claim refuses it. Phone-app replies never discard drafts
// on their own, so this check is what keeps their stale cards away.
// ---------------------------------------------------------------------------

/** How long a Send holds a draft. Long enough for one send to Meta and its
 *  filing; an older lease belongs to a send that died, and the draft can be
 *  claimed again. */
export const MINK_SEND_LEASE_MINUTES = 2;

/**
 * SQL: has a person on the team answered this conversation since `after`?
 * A person is a dashboard or WhatsApp Business app message, or any outbound
 * row a staff member sent (a template reply carries sent_by_admin_id).
 * Automatic replies, order updates and Mink's own answers are not; a send
 * Meta refused answered nobody, so it does not count either. The away
 * message's rule (answer-automatically.ts), widened to staff templates.
 */
function personRepliedSql(storeId: SQL, conversationId: SQL, after: SQL): SQL {
  return sql`exists (
    select 1 from public.whatsapp_messages m
     where m.store_id = ${storeId}
       and m.conversation_id = ${conversationId}
       and m.direction = 'out'
       and (m.source in ('dashboard', 'phone_app') or m.sent_by_admin_id is not null)
       and m.status is distinct from 'failed'
       and m.sent_at > ${after}
  )`;
}

/** The columns of one answer row, as SQL: the aliased `a` of an UPDATE, or
 *  the table's own columns in a select. */
interface AnswerRowSql {
  storeId: SQL;
  conversationId: SQL;
  messageId: SQL;
  createdAt: SQL;
  sendingStartedAt: SQL;
}

const aliasedRow = (): AnswerRowSql => ({
  storeId: sql`a.store_id`,
  conversationId: sql`a.conversation_id`,
  messageId: sql`a.message_id`,
  createdAt: sql`a.created_at`,
  sendingStartedAt: sql`a.sending_started_at`,
});

/** SQL: a person replied after the customer's message this row answers (or,
 *  when that message is gone, after the row was written). */
function answeredByPersonSql(row: AnswerRowSql): SQL {
  return personRepliedSql(
    row.storeId,
    row.conversationId,
    sql`coalesce(
      (select q.sent_at from public.whatsapp_messages q
        where q.id = ${row.messageId} and q.store_id = ${row.storeId}),
      ${row.createdAt})`,
  );
}

/** SQL: the row holds a send lease that has not run out. */
function leaseLiveSql(row: AnswerRowSql): SQL {
  return sql`(${row.sendingStartedAt} is not null
    and ${row.sendingStartedAt} >= now() - make_interval(mins => ${MINK_SEND_LEASE_MINUTES}))`;
}

/**
 * Has a person on the team replied since the customer's message? Asked by
 * customer-facing Mink after its model call, which takes seconds: an answer
 * on top of a person's reply is the customer answered twice.
 */
export async function personRepliedSince(
  db: Db,
  input: { storeId: string; conversationId: string; messageId: string },
): Promise<boolean> {
  const res = await db.execute(sql`
    select ${personRepliedSql(
      sql`${input.storeId}::uuid`,
      sql`${input.conversationId}::uuid`,
      sql`(select q.sent_at from public.whatsapp_messages q
            where q.id = ${input.messageId}::uuid
              and q.store_id = ${input.storeId}::uuid)`,
    )} as replied
  `);
  return (res.rows[0] as { replied?: boolean } | undefined)?.replied === true;
}

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

/**
 * The draft a thread shows: the newest pending one, if any. None while it is
 * being sent (its lease is live), and none once a person has answered the
 * message it was written for: either way a Send on it would answer twice.
 */
export async function loadMinkDraft(
  storeId: string,
  conversationId: string,
): Promise<InboxMinkDraft | null> {
  const rows = await withService((db) => {
    const a = whatsappMinkAnswers;
    const cols: AnswerRowSql = {
      storeId: sql`${a.storeId}`,
      conversationId: sql`${a.conversationId}`,
      messageId: sql`${a.messageId}`,
      createdAt: sql`${a.createdAt}`,
      sendingStartedAt: sql`${a.sendingStartedAt}`,
    };
    return db
      .select({
        id: a.id,
        answer: a.answer,
        reason: a.reason,
        facts: a.facts,
        mode: a.mode,
        creditSource: a.creditSource,
        createdAt: a.createdAt,
        // ★ The same two rules the claim applies, read here so the card a
        // person sees never offers a Send the claim would then refuse.
        sending: sql<boolean>`${leaseLiveSql(cols)}`,
        answered: sql<boolean>`${answeredByPersonSql(cols)}`,
      })
      .from(a)
      .where(
        and(
          eq(a.storeId, storeId),
          eq(a.conversationId, conversationId),
          eq(a.outcome, "draft"),
        ),
      )
      .orderBy(desc(a.createdAt))
      .limit(1);
  });
  const row = rows[0];
  if (!row || !row.answer || row.sending === true || row.answered === true) {
    return null;
  }
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
 * Take one pending draft for sending: a conditional UPDATE that writes the
 * send lease, so only one caller can hold it. Null when it is gone (sent,
 * discarded, or answered by a person since) or somebody else is sending it
 * right now; the caller reports that rather than sending twice.
 *
 * The lease ends with `markMinkAnswerSent` (sent), `releaseMinkDraftClaim`
 * (Meta definitely refused it) or, after a send whose outcome is unknown, by
 * running out: a draft that may already have reached the customer stays
 * taken for MINK_SEND_LEASE_MINUTES rather than being free to send again.
 */
export async function claimMinkDraft(
  db: Db,
  input: { storeId: string; conversationId: string; draftId: string },
): Promise<{ id: string; charged: boolean } | null> {
  const a = aliasedRow();
  const res = await db.execute(sql`
    update public.whatsapp_mink_answers a
       set sending_started_at = now()
     where a.id = ${input.draftId}::uuid
       and a.store_id = ${input.storeId}::uuid
       and a.conversation_id = ${input.conversationId}::uuid
       and a.outcome = 'draft'
       and not ${leaseLiveSql(a)}
       and not ${answeredByPersonSql(a)}
     returning a.id, a.credit_source
  `);
  const row = res.rows[0] as
    | { id: string; credit_source: string | null }
    | undefined;
  return row ? { id: row.id, charged: row.credit_source !== null } : null;
}

/**
 * Give a claimed draft back: the send was refused, so nothing reached the
 * customer and the draft can be sent again (the charge, if one was taken,
 * stays on the row, so that send is free). Only a draft still pending.
 */
export async function releaseMinkDraftClaim(
  db: Db,
  input: { storeId: string; answerId: string },
): Promise<void> {
  await db.execute(sql`
    update public.whatsapp_mink_answers
       set sending_started_at = null
     where id = ${input.answerId}::uuid
       and store_id = ${input.storeId}::uuid
       and outcome = 'draft'
  `);
}

/**
 * Record that a draft went out, and as what. Only a row still pending moves:
 * a draft that was discarded meanwhile, or already recorded as sent, keeps
 * what it says. The send lease ends with it.
 */
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
      sendingStartedAt: null,
    })
    .where(
      and(
        eq(whatsappMinkAnswers.id, input.answerId),
        eq(whatsappMinkAnswers.storeId, input.storeId),
        eq(whatsappMinkAnswers.outcome, "draft"),
      ),
    );
}

/**
 * Discard the pending drafts of a conversation: the one named, or every one
 * (a person replied by hand, so a draft for an earlier message is moot).
 * Returns how many were discarded.
 *
 * ★ A draft somebody is sending right now (a live lease) is left alone: it
 * may already be on its way to the customer, and the send that holds it
 * records what happened. Its lease runs out within minutes either way.
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
  const a = aliasedRow();
  const res = await db.execute(sql`
    update public.whatsapp_mink_answers a
       set outcome = 'discarded',
           reason = ${input.reason},
           resolved_at = now(),
           sending_started_at = null
     where a.store_id = ${input.storeId}::uuid
       and a.conversation_id = ${input.conversationId}::uuid
       and a.outcome = 'draft'
       and not ${leaseLiveSql(a)}
       ${input.draftId ? sql`and a.id = ${input.draftId}::uuid` : sql``}
     returning a.id
  `);
  return res.rows.length;
}
