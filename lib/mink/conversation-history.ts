import "server-only";

// History endpoints must not load run execution, draft actions or email tooling.
import { and, desc, eq, gt, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  minkConversations,
  minkFeedback,
  minkMessages,
  minkRuns,
  minkToolCalls,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import { logError } from "@/lib/observability/logger";
import { likePattern } from "@/lib/pos/search";
import {
  prefixTsQuery,
  searchWords,
  type SearchWordLexemes,
} from "@/lib/search/prefix-search";
import {
  CHAT_ID_PATTERN,
  MINK_CONVERSATION_RETENTION_DAYS,
  MINK_HISTORY_PAGE_SIZE,
} from "./chat-session";
import {
  retireMinkConversation,
  type MinkRetireOutcome,
} from "./conversation-retire";
import { MinkRequestError } from "./errors";
import { MAX_RUN_BUDGET_MS } from "./tools/registry";
import type {
  MinkActorContext,
  MinkArtifact,
  MinkFeedbackIssue,
  MinkFeedbackRating,
} from "./types";

// ---------------------------------------------------------------------------
// ★★ MINK AI CHAT HISTORY (owner's decision, 25 Oct 2026, informed by the
// roughly 3-month window Shopify gives Sidekick's memory): every chat used in
// the last 90 days is listed, newest activity first, a page at a time, and
// searchable; a long chat shows its earlier messages on request; the merchant
// deletes any chat at any time. No count cap.
//   - `expires_at` is the SLIDING deletion time, last use + 90 days: a run
//     start (persistence.ts) and an open (`getMinkConversation`) move it.
//     Every reader keeps `expires_at > now()`, so a chat unused for 90 days
//     leaves History at once and the nightly sweep retires it
//     (conversation-retention.ts).
//   - Deleting goes through `retireMinkConversation` (conversation-retire.ts),
//     which keeps the record of anything approved or published.
// ---------------------------------------------------------------------------

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
 * The kept answer's marker as a LITERAL. ★ Not a bound parameter: the partial
 * index of migration 0249 (`mink_messages_kept_answer_idx`) serves this test
 * only when Postgres can see the value while planning, in any plan. Inside the
 * OR of the visibility rule the test can run as one lookup of every kept
 * answer, which without that index read every message of every store.
 */
const KEPT_ANSWER = sql.raw(
  `'${JSON.stringify({ [MINK_KEPT_ANSWER_MARKER]: true })}'::jsonb`,
);

/**
 * ★ A run that did not succeed is shown only when its failure record kept an
 * answer (the redesign card): its own messages then read as the turn they were,
 * the merchant's message and the card. The model's replay (persistence.ts
 * `startMinkRun`) still reads only runs that succeeded: the next turn learns
 * of the redesign from the flags-only reference the stream route adds.
 */
function keptAnswerOfRun(): SQL {
  return sql`exists (
    select 1 from ${minkMessages} as kept
    where kept.run_id = ${minkRuns.id}
      and kept.store_id = ${minkRuns.storeId}
      and kept.role = 'assistant'
      and kept.content_json @> ${KEPT_ANSWER}
  )`;
}

/** A message row's columns, as the visibility rule reads them. */
export interface MinkMessageColumns {
  id: SQLWrapper;
  storeId: SQLWrapper;
  conversationId: SQLWrapper;
  role: SQLWrapper;
  createdAt: SQLWrapper;
  contentJson: SQLWrapper;
}

/** The message alias `m` of History's raw queries. */
const MESSAGE_M: MinkMessageColumns = {
  id: sql.raw("m.id"),
  storeId: sql.raw("m.store_id"),
  conversationId: sql.raw("m.conversation_id"),
  role: sql.raw("m.role"),
  createdAt: sql.raw("m.created_at"),
  contentJson: sql.raw("m.content_json"),
};

/**
 * ★ A stopped question ASKED AGAIN: the chat's next question begins with its
 * words, and that question's run was answered or stopped in turn. A spoken
 * question the server stopped is asked again joined to the words that
 * followed it (mink-voice-mode.ts), and the live thread then shows only the
 * joined question (mink-ai.ts `replaceUnanswered`); this keeps a reload, an
 * open from History and search the same.
 */
function askedAgainLater(message: MinkMessageColumns): SQL {
  return sql`exists (
    select 1
      from (
        select next_question.run_id,
               next_question.content_json ->> 'text' as text
          from public.mink_messages next_question
         where next_question.store_id = ${message.storeId}
           and next_question.conversation_id = ${message.conversationId}
           and next_question.role = 'user'
           and (next_question.created_at, next_question.id) > (${message.createdAt}, ${message.id})
         order by next_question.created_at, next_question.id
         limit 1
      ) asked
      join public.mink_runs asked_run
        on asked_run.id = asked.run_id and asked_run.store_id = ${message.storeId}
     where (asked_run.status = 'succeeded' or asked_run.stop_requested_at is not null)
       and starts_with(asked.text, ${message.contentJson} ->> 'text')
  )`;
}

/**
 * ★★ THE ONE VISIBILITY RULE for a chat's thread, its search matches and its
 * search snippets, so a result never opens onto a chat without the words that
 * matched. A message is shown when its run:
 *   - succeeded;
 *   - failed or was stopped, but its failure record kept an answer (the
 *     storefront redesign card, B4): the merchant's message and the card;
 *   - was STOPPED by the merchant (`stop_requested_at`, run-stop.ts): only
 *     the merchant's own message, so a chat whose only question was stopped
 *     never opens empty from History, as ChatGPT keeps a stopped question;
 *     unless that question was asked again (`askedAgainLater`), when only the
 *     question asked again shows. A stopped run stores no answer (migration
 *     0244), and the model's replay (persistence.ts `startMinkRun`) still
 *     reads only runs that succeeded, so the words are shown, never sent to
 *     Mink again.
 * Any other failed run stays hidden, as before; its messages are deleted with
 * the chat.
 * ⚠ `keptAnswerOfRun()` renders `"mink_runs"."id"`, so `mink_runs` stays
 *   UNALIASED wherever this is used (with an alias Postgres refuses the
 *   statement: invalid reference to FROM-clause entry). `message` is the
 *   message row's columns (the table itself, or `MESSAGE_M`).
 */
export function visibleMinkRun(message: MinkMessageColumns): SQL {
  return sql`(
    ${minkRuns.status} = 'succeeded'
    or (${minkRuns.status} in ('failed', 'cancelled') and ${keptAnswerOfRun()})
    or (
      ${minkRuns.status} in ('failed', 'cancelled')
      and ${minkRuns.stopRequestedAt} is not null
      and ${message.role} = 'user'
      and not ${askedAgainLater(message)}
    )
  )`;
}

/**
 * `now()` plus the retention window: the deletion time a use sets. ★ The one
 * definition for the run start (persistence.ts) and the open (below).
 */
export function minkRetentionDeadline(): SQL {
  return sql`now() + make_interval(days => ${sql.raw(
    String(Math.trunc(MINK_CONVERSATION_RETENTION_DAYS)),
  )})`;
}

export interface MinkStoredMessage {
  role: "user" | "assistant";
  text: string;
}

export interface MinkConversationSummary {
  id: string;
  title: string;
  lastMessageAt: string;
  createdAt: string;
  /** A finished storefront redesign card is in this chat (the delete dialog says so). */
  hasRedesignCard: boolean;
  /** Search only: the newest matching VISIBLE message's words, matches wrapped in « and ». */
  snippet?: string | null;
  /** Search only: that message's id, so opening the result can scroll to it. */
  matchMessageId?: string | null;
}

export interface MinkConversationPage {
  conversations: MinkConversationSummary[];
  /** The next page's cursor, or null on the last page. */
  nextCursor: string | null;
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
  /** Asks for the messages before these, or null when there are none. */
  earlierCursor: string | null;
}

// ---------------------------------------------------------------------------
// Cursors. ★ One opaque codec for the list, search and earlier messages: the
// last row's timestamp, as POSTGRES wrote it (lib/db/pg-types.ts keeps the
// text, microseconds included, so it round-trips exactly through
// ::timestamptz; a JavaScript Date would drop the microseconds and skip or
// repeat rows), and its id. Never the merchant's words. The client never
// looks inside one.
// ---------------------------------------------------------------------------

const CURSOR_MAX_LENGTH = 200;
const CURSOR_CHARACTERS = /^[A-Za-z0-9_-]+$/;
const CURSOR_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2}){0,2}|Z)$/;

export interface HistoryCursor {
  at: string;
  id: string;
}

export function encodeHistoryCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), "utf8").toString("base64url");
}

/** The cursor's position, or null for the first page. Anything else is refused. */
export function decodeHistoryCursor(
  cursor: string | null | undefined,
): HistoryCursor | null {
  if (cursor === null || cursor === undefined || cursor === "") return null;
  if (
    typeof cursor !== "string" ||
    cursor.length > CURSOR_MAX_LENGTH ||
    !CURSOR_CHARACTERS.test(cursor)
  )
    throw invalidCursor();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string" ||
    !CURSOR_TIMESTAMP.test(value[0]) ||
    !CHAT_ID_PATTERN.test(value[1])
  )
    throw invalidCursor();
  return { at: value[0], id: value[1] };
}

function invalidCursor(): MinkRequestError {
  return new MinkRequestError(
    "invalid_cursor",
    "That list of chats is out of date. Close and reopen your chats.",
    400,
  );
}

/**
 * `isFinishedRevampVersion` (revamp/contract.ts) in SQL: a redesign card in
 * the chat that still offers review, Publish or Undo.
 */
function hasRedesignCard(chat: "c" | "p"): SQL {
  const alias = sql.raw(chat);
  return sql`exists (
    select 1 from public.mink_revamps v
     where v.conversation_id = ${alias}.id and v.store_id = ${alias}.store_id
       and (v.status = 'ready'
            or (v.status = 'superseded' and v.applied_at is not null))
  )`;
}

const PAGE_LIMIT = sql.raw(String(MINK_HISTORY_PAGE_SIZE + 1));

/**
 * One History page: the actor's listed chats (active, not expired), newest
 * activity first. ★ `store_id` and `admin_id` always come from the
 * server-derived actor. A row past the page means there is a next page.
 */
export function historyPageQuery(input: {
  storeId: string;
  adminId: string;
  cursor: HistoryCursor | null;
}): SQL {
  return sql`
    select c.id, c.title,
           c.last_message_at as "lastMessageAt", c.created_at as "createdAt",
           ${hasRedesignCard("c")} as "hasRedesignCard"
      from public.mink_conversations c
     where c.store_id = ${input.storeId} and c.admin_id = ${input.adminId}
       and c.status = 'active' and c.expires_at > now()
       ${pageAfter(input.cursor)}
     order by c.last_message_at desc, c.id desc
     limit ${PAGE_LIMIT}
  `;
}

function pageAfter(cursor: HistoryCursor | null): SQL {
  return cursor
    ? sql`and (c.last_message_at, c.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
    : sql``;
}

const HEADLINE_OPTIONS =
  "MaxFragments=1, MaxWords=14, MinWords=6, StartSel=«, StopSel=», FragmentDelimiter=…";

/**
 * The lexemes Postgres's own text-search parser makes of each searched word:
 * the parser that built the message index (migration 0249), so an email, a
 * phone number, "98765-43210" or an Indic word with a zero-width joiner is
 * cut exactly as it was in the messages. `word` comes back lower-cased by
 * Postgres, as the index's lexemes are.
 */
export function searchLexemesQuery(words: readonly string[]): SQL {
  return sql`
    select w.ord::int as ord, lower(w.word) as word,
           array(select l.lexeme from unnest(to_tsvector('simple', w.word)) as l
                  order by l.lexeme) as lexemes
      from unnest(${sql.param(words)}::text[]) with ordinality as w(word, ord)
     order by w.ord
  `;
}

/**
 * Search: the actor's listed chats whose title holds every word (ILIKE, any
 * script) or one of whose VISIBLE messages holds every word (the GIN index of
 * migration 0249), newest activity first, with the newest matching visible
 * message as the snippet.
 * ★★ WHAT IS SEARCHED IS WHAT THE CHAT SHOWS: the index and the snippet read
 *   `public.mink_message_search_text`, a merchant's message without the
 *   attachment suffix the thread turns into a file card (its marker sentence
 *   and JSON: a file's address, a document's reading), and an answer whole.
 * ★★ ONE STORE'S MATCHES, NEVER ITS MESSAGES: the index holds each message's
 *   store as a lexeme of its own (`public.mink_message_search_store`), so the
 *   index alone finds this store's matches and the cost follows how many there
 *   are. Hence `hits` never says `m.store_id = ...`: with that, the planner
 *   could read every message of the store and parse each one, the 1-second
 *   search a two-letter prefix took. The runs are tied to the store instead
 *   (and a message's run is in its own store: the (run_id, store_id) foreign
 *   key). `hits` keeps each chat's newest matching visible message, so the
 *   snippet never reads a chat again.
 * ★ `hits` spans the store (all its admins) but is only joined to this
 *   admin's own rows, so no other admin's words can surface.
 * ⚠ `patterns` is never empty: ILIKE ALL over an empty array is true.
 */
export function historySearchQuery(input: {
  storeId: string;
  adminId: string;
  cursor: HistoryCursor | null;
  tsquery: string;
  patterns: string[];
}): SQL {
  if (input.patterns.length === 0)
    throw new Error("History search needs at least one word");
  return sql`
    with hits as (
      select distinct on (m.conversation_id)
             m.conversation_id, m.id as message_id
        from public.mink_messages m
        join public.mink_runs
          on mink_runs.id = m.run_id
         and mink_runs.store_id = ${input.storeId}
         and ${visibleMinkRun(MESSAGE_M)}
       where public.mink_message_search_vector(m.store_id, m.role, m.content_json)
             @@ (${input.tsquery}::tsquery && public.mink_message_search_store(${input.storeId}::uuid))
       order by m.conversation_id, m.created_at desc, m.id desc
    ), page as (
      select c.id, c.store_id, c.title, c.last_message_at, c.created_at,
             h.message_id
        from public.mink_conversations c
        left join hits h on h.conversation_id = c.id
       where c.store_id = ${input.storeId} and c.admin_id = ${input.adminId}
         and c.status = 'active' and c.expires_at > now()
         ${pageAfter(input.cursor)}
         and (c.title ilike all (${sql.param(input.patterns)}::text[])
              or h.message_id is not null)
       order by c.last_message_at desc, c.id desc
       limit ${PAGE_LIMIT}
    )
    select p.id, p.title,
           p.last_message_at as "lastMessageAt", p.created_at as "createdAt",
           ${hasRedesignCard("p")} as "hasRedesignCard",
           case when m.id is null then null
                else ts_headline('simple',
                       public.mink_message_search_text(m.role, m.content_json),
                       ${input.tsquery}::tsquery, ${HEADLINE_OPTIONS})
           end as snippet,
           m.id as "matchMessageId"
      from page p
      left join public.mink_messages m
        on m.id = p.message_id and m.store_id = p.store_id
     order by p.last_message_at desc, p.id desc
  `;
}

type HistoryRow = {
  id: string;
  title: string;
  lastMessageAt: string;
  createdAt: string;
  hasRedesignCard: unknown;
  snippet?: unknown;
  matchMessageId?: unknown;
};

function toHistoryPage(
  rows: HistoryRow[],
  search: boolean,
): MinkConversationPage {
  const page = rows.slice(0, MINK_HISTORY_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    conversations: page.map((row) => ({
      id: row.id,
      title: row.title,
      lastMessageAt: row.lastMessageAt,
      createdAt: row.createdAt,
      hasRedesignCard: row.hasRedesignCard === true,
      ...(search
        ? {
            snippet: typeof row.snippet === "string" ? row.snippet : null,
            matchMessageId:
              typeof row.matchMessageId === "string"
                ? row.matchMessageId
                : null,
          }
        : {}),
    })),
    nextCursor:
      rows.length > MINK_HISTORY_PAGE_SIZE && last
        ? encodeHistoryCursor(last.lastMessageAt, last.id)
        : null,
  };
}

export async function listMinkConversations(
  actor: MinkActorContext,
  options: { cursor?: string | null } = {},
): Promise<MinkConversationPage> {
  const cursor = decodeHistoryCursor(options.cursor);
  const result = await withService((db) =>
    db.execute(
      historyPageQuery({
        storeId: actor.storeId,
        adminId: actor.adminId,
        cursor,
      }),
    ),
  );
  return toHistoryPage(result.rows as HistoryRow[], false);
}

/** How long one History search may run before it is stopped. */
export const MINK_HISTORY_SEARCH_TIMEOUT = "5s";

/**
 * Search the actor's listed chats. ★ ONE SEARCH AT A TIME PER ADMIN: behind
 * Google's load balancer an aborted browser fetch never reaches Cloud Run
 * (migration 0244's header), so typing could otherwise leave several of one
 * admin's searches running at once, each holding one of the web instance's
 * five pool connections. A second search while one runs answers
 * `history_search_busy` (409) without querying, and the client tries again.
 * The route's rate limit bounds the rate; this bounds the concurrency, and
 * the statement timeout bounds each search.
 */
export async function searchMinkConversations(
  actor: MinkActorContext,
  options: { query: string; cursor?: string | null },
): Promise<MinkConversationPage> {
  const cursor = decodeHistoryCursor(options.cursor);
  const words = searchWords(options.query);
  if (words.length === 0) return { conversations: [], nextCursor: null };
  return withService(async (db) => {
    await db.execute(
      sql`set local statement_timeout = ${sql.raw(`'${MINK_HISTORY_SEARCH_TIMEOUT}'`)}`,
    );
    const lock = await db.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`mink-history-search:${actor.storeId}:${actor.adminId}`}, 0)) as locked`,
    );
    if ((lock.rows[0] as { locked?: unknown } | undefined)?.locked !== true) {
      throw new MinkRequestError(
        "history_search_busy",
        "Still searching your chats. Try again in a moment.",
        409,
      );
    }
    // ★ The message index is the only fast way in, and the planner cannot
    //   tell: it prices every message the index finds as parsed again, so for
    //   a word most messages hold, in a store that holds most of the table,
    //   it reads the whole table and parses every message instead (measured
    //   1.3 s against 20 ms). Every table this search reads has an index for
    //   it. JIT goes too: it never pays off for a search, and a plan priced
    //   with a disabled scan would start it. Both for this transaction only.
    await db.execute(
      sql`select set_config('enable_seqscan', 'off', true), set_config('jit', 'off', true)`,
    );
    const lexemes = await db.execute(searchLexemesQuery(words));
    const tsquery = prefixTsQuery(
      (lexemes.rows as { word: unknown; lexemes: unknown }[]).map(
        (row): SearchWordLexemes => ({
          word: String(row.word),
          lexemes: Array.isArray(row.lexemes) ? row.lexemes.map(String) : [],
        }),
      ),
    );
    if (!tsquery) return { conversations: [], nextCursor: null };
    const result = await db.execute(
      historySearchQuery({
        storeId: actor.storeId,
        adminId: actor.adminId,
        cursor,
        tsquery,
        patterns: words.map(likePattern),
      }),
    );
    return toHistoryPage(result.rows as HistoryRow[], true);
  });
}

export async function getMinkConversation(
  actor: MinkActorContext,
  conversationId: string,
  options: { before?: string | null } = {},
): Promise<MinkConversationDetail> {
  const before = decodeHistoryCursor(options.before);
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

    // ★★ OPENING A CHAT IS USING IT (owner's decision D1): it is kept 90 days
    //   from now. At most one write an hour per chat (reloads, earlier pages
    //   and the kept-card checks all read it); `updated_at` records content
    //   changes and is left alone.
    await db
      .update(minkConversations)
      .set({ expiresAt: minkRetentionDeadline() })
      .where(
        and(
          eq(minkConversations.id, conversationId),
          eq(minkConversations.storeId, actor.storeId),
          eq(minkConversations.adminId, actor.adminId),
          eq(minkConversations.status, "active"),
          sql`${minkConversations.expiresAt} < ${minkRetentionDeadline()} - interval '1 hour'`,
        ),
      );

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
          visibleMinkRun(minkMessages),
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
          before
            ? sql`(${minkMessages.createdAt}, ${minkMessages.id}) < (${before.at}::timestamptz, ${before.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(minkMessages.createdAt), desc(minkMessages.id))
      .limit(MINK_HISTORY_MESSAGE_LIMIT + 1);

    // Newest first: a row past the limit means earlier messages exist, and
    // the next page starts below the oldest one returned.
    const page = rows.slice(0, MINK_HISTORY_MESSAGE_LIMIT);
    const oldest = page[page.length - 1];
    return {
      ...conversation,
      messages: page.reverse().flatMap(toConversationMessage),
      earlierCursor:
        rows.length > MINK_HISTORY_MESSAGE_LIMIT && oldest
          ? encodeHistoryCursor(oldest.createdAt, oldest.id)
          : null,
    };
  });
}

/**
 * A storefront revamp still being made (queued, running) or whose card is
 * ready: the card lives in its conversation, as an answer of the run that
 * started it, and its draft belongs to that run. Read by the failure record's
 * kept card (persistence.ts, B4).
 */
export const MINK_LIVE_REVAMP_STATUSES = ["queued", "running", "ready"];

/**
 * ★★ A CHAT WHOSE STOREFRONT REDESIGN IS STILL BEING MADE IS NOT RETIRED, by
 * the merchant's delete below or by the sweep (conversation-retention.ts):
 * a queued or running redesign of the chat, or a queued or running refinement
 * of one of them (the shape lib/media/image-usage.ts reads). It lasts minutes
 * and its card can stop it. A READY card no longer holds the chat (owner's
 * decision D2): it goes with the chat, and what was applied stays.
 * `storeId` and `conversationId` are values or, for the sweep, the outer
 * row's columns.
 */
export function buildingRevampOfConversation(
  storeId: SQLWrapper | string,
  conversationId: SQLWrapper | string,
): SQL {
  return sql`
    select 1
      from public.mink_revamps v
     where v.store_id = ${storeId}
       and v.conversation_id = ${conversationId}
       and (
         v.status in ('queued', 'running')
         or exists (
           select 1 from public.mink_revamps child
            where child.store_id = v.store_id
              and child.parent_id = v.id
              and child.status in ('queued', 'running')
         )
       )
  `;
}

const CONVERSATION_HAS_REDESIGN =
  "A storefront redesign from this chat is still being made. Wait for it to finish, or stop it from its card, then delete this chat.";

/**
 * Delete one of the actor's chats. ★ Through `retireMinkConversation`: an
 * ordinary chat is deleted; a redesign never applied is stripped and goes
 * with it; a chat holding the record of an approved or published change is
 * REDUCED, its words gone and the record kept. Refused only while a reply
 * runs or a redesign is still being made.
 */
export async function deleteMinkConversation(
  actor: MinkActorContext,
  conversationId: string,
): Promise<MinkRetireOutcome> {
  // ★★ B7: a run left "running" by a server that stopped blocked this delete
  //   for ever. A dead one is closed first, each through the stream route's
  //   own failure record, so its drafts, credits and redesign follow the
  //   normal rules; a run still within its limit keeps the chat busy below.
  await closeDeadRunsOfConversation(actor, conversationId);
  return withService(async (db) => {
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
      sql`select exists (${buildingRevampOfConversation(actor.storeId, conversationId)}) as building`,
    );
    if (
      (revamp.rows[0] as { building?: unknown } | undefined)?.building === true
    ) {
      throw new MinkRequestError(
        "conversation_has_redesign",
        CONVERSATION_HAS_REDESIGN,
        409,
      );
    }
    // ★ No expiry filter: a merchant may delete their own chat from a list
    //   loaded just before it expired.
    const owned = await db
      .select({ id: minkConversations.id })
      .from(minkConversations)
      .where(
        and(
          eq(minkConversations.id, conversationId),
          eq(minkConversations.storeId, actor.storeId),
          eq(minkConversations.adminId, actor.adminId),
          eq(minkConversations.status, "active"),
        ),
      )
      .for("update")
      .limit(1);
    if (!owned[0]) {
      throw new MinkRequestError(
        "conversation_not_found",
        "That Mink AI conversation is no longer available.",
        404,
      );
    }
    return retireMinkConversation(db, {
      storeId: actor.storeId,
      conversationId,
    });
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
