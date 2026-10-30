import "server-only";

import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { isForeignKeyViolation, pgConstraint } from "@/lib/db/errors";
import { logWarn } from "@/lib/observability/logger";

// ---------------------------------------------------------------------------
// ★★ RETIRING A MINK AI CHAT: ONE FUNCTION FOR THE MERCHANT'S DELETE AND THE
// 90-DAY SWEEP (owner's decision, 25 Oct 2026; decisions D2, D3, D4, D7).
//
// A chat cascades to its runs and messages, runs to drafts, tool calls, usage
// rows, feedback and credit rows, drafts to approvals, and approvals to the
// action audit. So a plain DELETE erased the record of every change approved
// in the chat (the audit row is append-only only by convention) and failed
// outright for a chat whose draft became a blog post. Here:
//   1. lock the chat's approvals, drafts and redesigns, in the order every
//      Mink action takes them (approval, then draft, then the redesign row),
//      so an execution in flight finishes first, or finds its approval gone;
//   2. strip every redesign of the chat that was never applied: the
//      merchant's interview words, the requester's email, the snapshot, the
//      plan, the result and the raw error go; billing facts stay (D7);
//   2b. mark the chat's attached pictures for the purge (mink_attachments),
//      on both paths and before a delete could unlink them;
//   3. ask whether the chat holds a RECORD: an approval acted on (audited, or
//      any status but pending), a blog publication, an approval a campaign
//      names, or a redesign that was applied (or, as a guard, is still live);
//   4. none: DELETE the chat (in a savepoint; a foreign key this check does
//      not know yet makes it reduce instead). Records: REDUCE it in place:
//      every message, the feedback, unconfirmed previews, unused proposals
//      and the title go; the records and the runs behind them stay, under a
//      hidden row (status 'deleted'), for as long as the store exists.
//
// ★ The caller holds the chat's advisory lock (`mink-conversation:<id>`) and
//   has refused (merchant) or skipped (sweep) a chat with a running run or a
//   redesign still being made. Every statement is scoped by store and chat.
// ★ No import of drafts.ts or persistence.ts: History keeps its light import
//   graph (docs/local-dev-performance.md).
// ---------------------------------------------------------------------------

export type MinkRetireOutcome = "deleted" | "reduced";

/** The title a reduced chat keeps. Never shown: nothing lists a 'deleted' chat. */
export const MINK_REDUCED_CHAT_TITLE = "Deleted chat";

const DELETE_SAVEPOINT = "mink_retire_delete";

/**
 * What stripping a redesign that was never applied leaves of it (D7): the
 * merchant's interview words, the requester's email, the snapshot, the plan,
 * the result and the raw error go; ids, kind, status, `free`, credits, usage,
 * the error code, links and an unsettled photo claim stay. A ready card
 * becomes `superseded`. ★ One SET list for a chat's redesigns
 * (`retireMinkConversation`) and for the ones whose chat is already gone
 * (`stripOrphanedRedesignsQuery`).
 */
const STRIP_REDESIGN = sql`
       set status = case when v.status = 'ready' then 'superseded' else v.status end,
           request = jsonb_build_object('kind', v.kind),
           requester_email = null,
           snapshot = null, plan = null, error_detail = null,
           result = case when jsonb_typeof(v.result -> 'photoHold') = 'object'
                         then jsonb_build_object('photoHold', v.result -> 'photoHold')
                         else null end,
           draft_id = null, origin_run_id = null,
           lease_token = null, lease_until = null,
           updated_at = now()`;

/**
 * A redesign whose chat is already gone, never applied, finished, and not
 * yet stripped: anything `STRIP_REDESIGN` would still change.
 */
function orphanToStrip(alias: "o" | "v"): SQL {
  const r = sql.raw(alias);
  return sql`${r}.conversation_id is null
     and ${r}.applied_at is null
     and ${r}.status in ('ready', 'failed', 'cancelled', 'superseded')
     and (${r}.status = 'ready'
          or ${r}.request is distinct from jsonb_build_object('kind', ${r}.kind)
          or ${r}.requester_email is not null
          or ${r}.snapshot is not null or ${r}.plan is not null
          or ${r}.error_detail is not null
          or ${r}.draft_id is not null or ${r}.origin_run_id is not null
          or ${r}.lease_token is not null or ${r}.lease_until is not null
          or (${r}.result is not null
              and (jsonb_typeof(${r}.result -> 'photoHold') is distinct from 'object'
                   or ${r}.result - 'photoHold' <> '{}'::jsonb)))`;
}

/**
 * ★★ D7 FOR REDESIGNS WHOSE CHAT IS ALREADY GONE. Before this change a chat
 * was deleted with a failed, cancelled or replaced redesign nobody applied,
 * and the foreign key (ON DELETE SET NULL) kept that redesign with no chat:
 * the merchant's interview words, email, plan, snapshot and raw error, which
 * the chat-scoped strip below can never reach. The revision being replaced,
 * and any rollback, can still make more, so the nightly sweep
 * (conversation-retention.ts) strips up to `limit` of them EVERY night, not
 * once. Rows a job holds are left for another night (`skip locked`).
 */
export function stripOrphanedRedesignsQuery(limit: number): SQL {
  return sql`
    update public.mink_revamps v
      ${STRIP_REDESIGN}
     where v.id in (
       select o.id from public.mink_revamps o
        where ${orphanToStrip("o")}
        order by o.id
        limit ${limit}
          for update skip locked
     )
       and ${orphanToStrip("v")}
    returning v.id
  `;
}

export async function retireMinkConversation(
  db: Db,
  input: { storeId: string; conversationId: string },
): Promise<MinkRetireOutcome> {
  const { storeId: s, conversationId: c } = input;

  // 1. ★ Lock order = every execution's: an Undo locking two approvals of
  //    this chat in the other order can still deadlock with this, and
  //    Postgres stops one side within a second; nothing is half-done.
  await db.execute(sql`
    select a.id
      from public.mink_action_approvals a
      join public.mink_drafts d on d.id = a.draft_id and d.store_id = a.store_id
      join public.mink_runs r on r.id = d.run_id and r.store_id = d.store_id
     where r.store_id = ${s} and r.conversation_id = ${c}
     order by a.id
       for update of a
  `);
  await db.execute(sql`
    select d.id
      from public.mink_drafts d
      join public.mink_runs r on r.id = d.run_id and r.store_id = d.store_id
     where r.store_id = ${s} and r.conversation_id = ${c}
     order by d.id
       for update of d
  `);
  await db.execute(sql`
    select v.id
      from public.mink_revamps v
     where v.store_id = ${s} and v.conversation_id = ${c}
     order by v.id
       for update
  `);

  // 2. ★★ STRIP, NEVER DELETE, a redesign that was never applied. A ready or
  //    superseded free full redesign is what marks the store's free redesign
  //    as used (jobs.ts FREE_HOLDING_STATUSES): deleting it would give a
  //    second one. A refinement's parent cannot be deleted
  //    (mink_revamps_parent_check refuses the SET NULL). An unsettled photo
  //    claim (`result.photoHold`) must stay readable for
  //    settleFinishedPhotoHolds. A ready card becomes `superseded`, which
  //    frees its draft (mink_revamps_ready_check). An APPLIED redesign is the
  //    record and is untouched.
  await db.execute(sql`
    update public.mink_revamps v
      ${STRIP_REDESIGN}
     where v.store_id = ${s} and v.conversation_id = ${c}
       and v.applied_at is null
       and v.status in ('ready', 'failed', 'cancelled', 'superseded')
  `);

  // 2b. ★ The chat's attached pictures go with it (lib/mink/attachments.ts):
  //     marked here, in the retiring transaction, BEFORE a delete could set
  //     their chat to NULL (the foreign key's ON DELETE SET NULL would make
  //     this statement match nothing afterwards); the objects are deleted
  //     after commit (the merchant's delete schedules a purge) or tonight
  //     (the nightly purge). Both paths, delete and reduce, retire the chat,
  //     so both mark. One raw statement: no import of attachments.ts here.
  await db.execute(sql`
    update public.mink_attachments
       set discard_requested_at = now()
     where store_id = ${s} and conversation_id = ${c}
       and discard_requested_at is null
  `);

  // 3. ★ Every `exists` carries its own parentheses (the lesson of the old
  //    prune's `not exists select`, a syntax error only heavy users hit).
  //    A pending approval with no audit row is a preview nobody confirmed:
  //    not a record (D3).
  const check = await db.execute(sql`
    select exists (
      select 1
        from public.mink_runs r
        join public.mink_drafts d on d.run_id = r.id and d.store_id = r.store_id
       where r.store_id = ${s} and r.conversation_id = ${c}
         and (
           exists (select 1 from public.mink_action_approvals a
                    where a.draft_id = d.id and a.store_id = d.store_id
                      and (a.status <> 'pending'
                           or exists (select 1 from public.mink_action_audit x
                                       where x.approval_id = a.id and x.store_id = a.store_id)))
           or exists (select 1 from public.mink_blog_publications p
                       where p.draft_id = d.id and p.store_id = d.store_id)
           or exists (select 1 from public.mink_action_approvals a
                        join public.email_campaigns e
                          on e.mink_approval_id = a.id and e.store_id = a.store_id
                       where a.draft_id = d.id and a.store_id = d.store_id)
         )
      union all
      select 1
        from public.mink_revamps v
       where v.conversation_id = ${c} and v.store_id = ${s}
         and (v.applied_at is not null or v.status in ('queued', 'running', 'ready'))
    ) as holds
  `);
  const holds = (check.rows[0] as { holds?: unknown } | undefined)?.holds;

  if (holds !== true) {
    // 4a. No record: the cascade removes messages, runs, tool calls, usage
    //     rows, feedback, drafts, unconfirmed approvals, versions and credit
    //     rows; a stripped redesign row stays (its chat, run and draft links
    //     set null).
    await db.execute(sql.raw(`SAVEPOINT ${DELETE_SAVEPOINT}`));
    try {
      await db.execute(sql`
        delete from public.mink_conversations
         where store_id = ${s} and id = ${c}
      `);
      await db.execute(sql.raw(`RELEASE SAVEPOINT ${DELETE_SAVEPOINT}`));
      return "deleted";
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error;
      await db.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${DELETE_SAVEPOINT}`));
      await db.execute(sql.raw(`RELEASE SAVEPOINT ${DELETE_SAVEPOINT}`));
      // ★ A record kind the check above does not know: kept, never lost.
      //   Content-free: ids and the constraint's name.
      logWarn("mink.retire: delete refused, reducing", {
        storeId: s,
        conversationId: c,
        constraint: pgConstraint(error) ?? null,
      });
    }
  }

  // 4b. REDUCE: the chat's words go; what was approved or published stays.
  await db.execute(sql`
    delete from public.mink_messages
     where store_id = ${s} and conversation_id = ${c}
  `);
  await db.execute(sql`
    delete from public.mink_feedback f
     using public.mink_runs r
     where f.run_id = r.id and f.store_id = r.store_id
       and r.store_id = ${s} and r.conversation_id = ${c}
  `);
  // Previews never confirmed (D3): pending, never audited, named by nothing.
  // ★ The lock in step 1 means an execution of one either finished before
  //   (no longer pending) or will find it gone.
  await db.execute(sql`
    delete from public.mink_action_approvals a
     using public.mink_drafts d, public.mink_runs r
     where a.draft_id = d.id and a.store_id = d.store_id
       and d.run_id = r.id and d.store_id = r.store_id
       and r.store_id = ${s} and r.conversation_id = ${c}
       and a.status = 'pending'
       and not exists (select 1 from public.mink_action_audit x
                        where x.approval_id = a.id and x.store_id = a.store_id)
       and not exists (select 1 from public.mink_blog_publications p
                        where p.approval_id = a.id and p.store_id = a.store_id)
       and not exists (select 1 from public.email_campaigns e
                        where e.mink_approval_id = a.id and e.store_id = a.store_id)
       and not exists (select 1 from public.mink_action_approvals child
                        where child.source_approval_id = a.id
                          and child.store_id = a.store_id)
  `);
  // Proposals that back nothing kept. ★ A card's draft has its redesign's id
  //   (jobs.ts madeCardSql), so `v.id = d.id` keeps it ONLY while that
  //   redesign is applied or still live: a stripped card's draft goes.
  await db.execute(sql`
    delete from public.mink_drafts d
     using public.mink_runs r
     where r.id = d.run_id and r.store_id = d.store_id
       and r.store_id = ${s} and r.conversation_id = ${c}
       and not exists (select 1 from public.mink_action_approvals a
                        where a.draft_id = d.id and a.store_id = d.store_id)
       and not exists (select 1 from public.mink_blog_publications p
                        where p.draft_id = d.id and p.store_id = d.store_id)
       and not exists (select 1 from public.mink_revamps v
                        where v.store_id = d.store_id
                          and (v.draft_id = d.id or v.id = d.id)
                          and (v.applied_at is not null
                               or v.status in ('queued', 'running', 'ready')))
  `);
  // Runs that now hold nothing: no draft, no credit row (a kept draft's credit
  // row can sit on another run after discardBesideCard), no redesign started.
  // Their tool calls and usage rows go with them; the store's balance lives
  // in tables no Mink row cascades into.
  await db.execute(sql`
    delete from public.mink_runs r
     where r.store_id = ${s} and r.conversation_id = ${c}
       and not exists (select 1 from public.mink_drafts d
                        where d.run_id = r.id and d.store_id = r.store_id)
       and not exists (select 1 from public.mink_draft_credit_usage u
                        where u.run_id = r.id and u.store_id = r.store_id)
       and not exists (select 1 from public.mink_revamps v
                        where v.origin_run_id = r.id and v.store_id = r.store_id)
  `);
  // A dashboard address can carry a searched name.
  await db.execute(sql`
    update public.mink_runs
       set current_path = null
     where store_id = ${s} and conversation_id = ${c}
       and current_path is not null
  `);
  await db.execute(sql`
    update public.mink_conversations
       set status = 'deleted', title = ${MINK_REDUCED_CHAT_TITLE},
           summary_json = null, summarized_message_count = 0,
           retention_failed_at = null, updated_at = now()
     where store_id = ${s} and id = ${c}
  `);
  return "reduced";
}
